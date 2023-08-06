const express = require('express');
const app = express();
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();
const expressHbs = require('express-handlebars');
const fs = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

cloudinary.config({
	cloud_name: process.env.CLOUD_NAME,
	api_key: process.env.API_KEY,
	api_secret: process.env.API_SECRET,
});

// multer storage preferences
const storage = new multer.diskStorage({
	// files are uploaded to /uploads
	destination: path.resolve(__dirname, '.', 'uploads'),
	filename: function (req, file, callback) {
		callback(null, file.originalname);
	},
});

const upload = multer({
	storage: storage,

	// filter for only allowing images
	fileFilter: (req, file, cb) => {
		if (
			file.mimetype == 'image/png' ||
			file.mimetype == 'image/jpeg' ||
			file.mimetype == 'image/webp' ||
			file.mimetype == 'image/svg+xml'
		) {
			return cb(null, true);
		} else {
			cb(new Error('Only image files are allowed!'), false);
		}
	},
}).array('file');

// function for accessing folders from cloudinary
const getFolders = () => {
	console.log('Started working on getting folders.');

	// empty array and object to store folder names
	const a = [];
	const folderObject = { folders: [] };

	// every folder from cloudinary is pushed to an array from root folders to sub folders
	cloudinary.api.root_folders().then((data) => {
		a.push(data.folders);
		for (let i = 0; i < data.folders.length; i++) {
			cloudinary.api.sub_folders(data.folders[i].path).then((subdata) => {
				a.push(subdata.folders);
			});
		}
		const myTimeout = setTimeout(() => {
			for (let i = 0; i < a.length; i++) {
				for (let j = 0; j < a[i].length; j++) {
					folderObject.folders.push(a[i][j]);
				}
			}

			// folder names are sotred in a JSON file
			const json = JSON.stringify(folderObject.folders);
			fs.writeFile('folder.json', json, (err) => {
				if (err) {
					throw err;
				}
				console.log('JSON data is saved.');
			});
		}, 30000);
	});
};

app.engine(
	'handlebars',
	expressHbs.engine({
		layoutsDir: `${__dirname}/views/layouts`,
		partialsDir: `${__dirname}/views/partials`,
	})
);
app.set('view engine', 'handlebars');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(__dirname + '/uploads'));
app.use(express.static(__dirname + '/after_sharp'));

app.get('/', (req, res) => {
	res.render('home'), {
		layout: 'main',
	}
});

app.get('/cloudinary', async (req, res) => {
	//JSON folder file is read
	fs.readFile('folder.json', 'utf-8', (err, data) => {
		if (err) {
		console.log(err);
		}

		// the data from the JSON file is written to a folder array
		const folder = JSON.parse(data.toString());

		res.render('cloudinary', {
			layout: 'main',
			folder: folder,
		});
	});

	// /after_sharp folder is deleted to not occupy space
	fs.rmSync('./after_sharp', { recursive: true, force: true });
});

app.post('/cloudinary', upload, async (req, res) => {
	// /after_sharp folder is created if it doesn't exist
	if (!fs.existsSync('./after_sharp')) {
		fs.mkdirSync('./after_sharp');
	}

	// each image is checked by it's mimetype, then they are compressed and are sent to /after_sharp folder
	for (let i = 0; i < req.files?.length; i++) {
		if (req.files[i].mimetype == 'image/webp') {
			await sharp(req.files[i]?.path)
				.webp({ quality: 40, chromaSubsampling: '4:4:4' })
				.toFormat('jpeg')
				.toFile(path.resolve(req.files[i]?.destination, '../after_sharp', req.files[i]?.filename));
		} else if (
			req.files[i].mimetype == 'image/jpeg' ||
			req.files[i].mimetype == 'image/png' ||
			req.files[i].mimetype == 'image/svg+xml'
		) {
			await sharp(req.files[i]?.path)
				.jpeg({ quality: 40, chromaSubsampling: '4:4:4', mozjpeg: true })
				.toFile(path.resolve(req.files[i]?.destination, '../after_sharp', req.files[i]?.filename));
		}

		// the upload folder is cleared
		fs.unlinkSync(req.files[i].path);

		// preferences for Cloudinary
		const cloudinaryOptions = {
			folder: req.body.folder,
			use_filename: false,
			unique_filename: true,
		};

		if (req.body.keepFilename == 'true') {
			cloudinaryOptions.use_filename = true;
		}

		// images are uploaded to Cloudinary
		cloudinary.uploader.upload(`./after_sharp/${req.files[i]?.filename}`, cloudinaryOptions, (err, res) => {
			if (err) {
				console.log('error in uploader: ' + err);
			}
		});
	}

	// 1 second delay to prevent an error
	setTimeout(() => {
		res.redirect('/cloudinary');
	}, 1000);
});

app.get('/cloudinary/reloadFolders', (req, res) => {
	getFolders();
	res.redirect('/cloudinary');
});

app.get('/azure', async (req, res) => {
	if (!AZURE_STORAGE_CONNECTION_STRING) {
		throw Error('Azure Storage Connection string not found');
	}
	// Azure Storage connection
	const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

	// empty array for container names
	const containers = [];

	// container names are obtained and are stored in containers array
	let i = 0;
	for await (const container of blobServiceClient.listContainers()) {
		containers[i] = container.name;
		i++;
	}

	res.render('azure', {
		layout: 'main',
		container: containers,
	});

	// /after_sharp folder is deleted
	fs.rmSync('./after_sharp', { recursive: true, force: true });
});

app.post('/azure', upload, async (req, res) => {
	// /after_sharp folder is created if it doesn't exist
	if (!fs.existsSync('./after_sharp')) {
		fs.mkdirSync('./after_sharp');
	}

	// Azure Storage connection
	const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
	// container name is obtained from front-end
	const containerName = req.body.container;
	// if the container doesn't exist it is created
	await blobServiceClient.getContainerClient(containerName).createIfNotExists();
	const containerClient = await blobServiceClient.getContainerClient(containerName);

	// each image is checked by it's mimetype, then they are compressed and are sent to /after_sharp folder
	for (let i = 0; i < req.files?.length; i++) {
		if (req.files[i].mimetype == 'image/webp') {
			await sharp(req.files[i]?.path)
				.webp({ quality: 40, chromaSubsampling: '4:4:4' })
				.toFormat('jpeg')
				.toFile(path.resolve(req.files[i]?.destination, '../after_sharp', req.files[i]?.filename));
		} else if (
			req.files[i].mimetype == 'image/jpeg' ||
			req.files[i].mimetype == 'image/png' ||
			req.files[i].mimetype == 'image/svg+xml'
		) {
			await sharp(req.files[i]?.path)
				.jpeg({ quality: 40, chromaSubsampling: '4:4:4', mozjpeg: true })
				.toFile(path.resolve(req.files[i]?.destination, '../after_sharp', req.files[i]?.filename));
		}
		// uploads folder is cleared
		fs.unlinkSync(req.files[i].path);

		//blobName variable is given the file's name
		const blobName = req.files[i].filename;
		const blockBlobClient = containerClient.getBlockBlobClient(blobName);
		// blob is uploaded to Azure Storage
		const uploadBlobResponse = await blockBlobClient.uploadFile(`./after_sharp/${req.files[i]?.filename}`);
		console.log(`Blob was uploaded successfully. requestId: ${uploadBlobResponse.requestId}`);
	}

	console.log('\nListing blobs...');

	// List the blob(s) in the container.
	for await (const blob of containerClient.listBlobsFlat()) {
		// Get Blob Client from name, to get the URL
		const tempBlockBlobClient = containerClient.getBlockBlobClient(blob.name);

		// Display blob name and URL
		console.log(`\n\tname: ${blob.name}\n\tURL: ${tempBlockBlobClient.url}\n`);
	}

	res.redirect('/azure');
});

app.post('/azure/tier', async (req, res) => {
	//Azure Storage connection
	const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
	// container name from the front-end
	const containerName = req.body.container;
	const containerClient = blobServiceClient.getContainerClient(containerName);

	// every blob in the container is obtained, then their tier is set to the selected tier from front-end
	for await (const blob of containerClient.listBlobsFlat()) {
		containerClient.getBlockBlobClient(blob.name).setAccessTier(req.body.tier);
	}
	res.redirect('/azure');
});

const port = 4000;

app.listen(port, () => {
	getFolders();
	setInterval(getFolders, 3600000);
	console.log('Server started on port: ' + port);
});
