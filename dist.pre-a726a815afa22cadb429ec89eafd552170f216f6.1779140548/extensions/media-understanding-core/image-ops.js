//#region extensions/media-understanding-core/image-ops.ts
const SHARP_MODULE = "sharp";
let sharpFactoryPromise = null;
function normalizeSharpFactory(mod) {
	const sharp = [
		mod.default,
		(mod.default ?? {})?.default,
		mod
	].find((candidate) => typeof candidate === "function");
	if (!sharp) throw new Error("Optional dependency sharp did not expose an image processor");
	return sharp;
}
async function loadSharp(maxInputPixels) {
	if (!sharpFactoryPromise) sharpFactoryPromise = import(SHARP_MODULE).then((mod) => {
		const sharp = normalizeSharpFactory(mod);
		return ((buffer, options) => sharp(buffer, {
			...options,
			failOnError: false,
			limitInputPixels: maxInputPixels
		}));
	}).catch((err) => {
		sharpFactoryPromise = null;
		throw new Error("Optional dependency sharp is required for image attachment processing", { cause: err });
	});
	return await sharpFactoryPromise;
}
function normalizeMaxInputPixels(value) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Media attachment image ops require a positive maxInputPixels budget");
	return value;
}
function normalizeMetadata(meta) {
	const width = meta.width ?? 0;
	const height = meta.height ?? 0;
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width <= 0 || height <= 0) return null;
	return {
		width,
		height
	};
}
function createMediaAttachmentImageOps(options) {
	const maxInputPixels = normalizeMaxInputPixels(options.maxInputPixels);
	return {
		async getImageMetadata(buffer) {
			return normalizeMetadata(await (await loadSharp(maxInputPixels))(buffer).metadata());
		},
		async normalizeExifOrientation(buffer) {
			return await (await loadSharp(maxInputPixels))(buffer).rotate().toBuffer();
		},
		async resizeToJpeg(params) {
			return await (await loadSharp(maxInputPixels))(params.buffer).rotate().resize({
				width: params.maxSide,
				height: params.maxSide,
				fit: "inside",
				withoutEnlargement: params.withoutEnlargement !== false
			}).jpeg({
				quality: params.quality,
				mozjpeg: true
			}).toBuffer();
		},
		async convertHeicToJpeg(buffer) {
			return await (await loadSharp(maxInputPixels))(buffer).jpeg({
				quality: 90,
				mozjpeg: true
			}).toBuffer();
		},
		async hasAlphaChannel(buffer) {
			const meta = await (await loadSharp(maxInputPixels))(buffer).metadata();
			return meta.hasAlpha || meta.channels === 4;
		},
		async resizeToPng(params) {
			const sharp = await loadSharp(maxInputPixels);
			const compressionLevel = params.compressionLevel ?? 6;
			return await sharp(params.buffer).rotate().resize({
				width: params.maxSide,
				height: params.maxSide,
				fit: "inside",
				withoutEnlargement: params.withoutEnlargement !== false
			}).png({ compressionLevel }).toBuffer();
		}
	};
}
//#endregion
export { createMediaAttachmentImageOps };
