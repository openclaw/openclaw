import { n as createLazyPromiseLoader } from "./lazy-promise-SFT4i6yI.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C5ctwRKD.js";
import { i as runExec } from "./exec-DusmGtXL.js";
import { r as withTempWorkspace } from "./private-temp-workspace-CS7i2diZ.js";
//#region src/media/image-ops.ts
const IMAGE_REDUCE_QUALITY_STEPS = [
	85,
	75,
	65,
	55,
	45,
	35
];
const MAX_IMAGE_INPUT_PIXELS = 25e6;
const MEDIA_UNDERSTANDING_CORE_PLUGIN_ID = "media-understanding-core";
const MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT = "image-ops.js";
function buildImageResizeSideGrid(maxSide, sideStart) {
	return [
		sideStart,
		1800,
		1600,
		1400,
		1200,
		1e3,
		800
	].map((value) => Math.min(maxSide, value)).filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx).toSorted((a, b) => b - a);
}
function isBun() {
	return typeof process.versions.bun === "string";
}
function prefersSips() {
	return process.env.OPENCLAW_IMAGE_BACKEND === "sips" || process.env.OPENCLAW_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin";
}
function isMediaAttachmentImageOps(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.getImageMetadata === "function" && typeof candidate.normalizeExifOrientation === "function" && typeof candidate.resizeToJpeg === "function" && typeof candidate.convertHeicToJpeg === "function" && typeof candidate.hasAlphaChannel === "function" && typeof candidate.resizeToPng === "function";
}
const mediaAttachmentImageOpsLoader = createLazyPromiseLoader(async () => {
	const { loadBundledPluginPublicArtifactModuleSync } = await import("./public-surface-loader-BS29dNdK.js");
	const ops = loadBundledPluginPublicArtifactModuleSync({
		dirName: MEDIA_UNDERSTANDING_CORE_PLUGIN_ID,
		artifactBasename: MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT
	}).createMediaAttachmentImageOps?.({ maxInputPixels: MAX_IMAGE_INPUT_PIXELS });
	if (!isMediaAttachmentImageOps(ops)) throw new Error("Media understanding core did not expose image ops");
	return ops;
});
async function loadMediaAttachmentImageOps() {
	return await mediaAttachmentImageOpsLoader.load();
}
function isPositiveImageDimension(value) {
	return Number.isInteger(value) && value > 0;
}
function buildImageMetadata(width, height) {
	if (!isPositiveImageDimension(width) || !isPositiveImageDimension(height)) return null;
	return {
		width,
		height
	};
}
function readPngMetadata(buffer) {
	if (buffer.length < 24) return null;
	if (buffer[0] !== 137 || buffer[1] !== 80 || buffer[2] !== 78 || buffer[3] !== 71 || buffer[4] !== 13 || buffer[5] !== 10 || buffer[6] !== 26 || buffer[7] !== 10 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
	return buildImageMetadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}
function readGifMetadata(buffer) {
	if (buffer.length < 10) return null;
	const signature = buffer.toString("ascii", 0, 6);
	if (signature !== "GIF87a" && signature !== "GIF89a") return null;
	return buildImageMetadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}
function readWebpMetadata(buffer) {
	if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
	const chunkType = buffer.toString("ascii", 12, 16);
	if (chunkType === "VP8X") {
		if (buffer.length < 30) return null;
		return buildImageMetadata(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
	}
	if (chunkType === "VP8 ") {
		if (buffer.length < 30) return null;
		return buildImageMetadata(buffer.readUInt16LE(26) & 16383, buffer.readUInt16LE(28) & 16383);
	}
	if (chunkType === "VP8L") {
		if (buffer.length < 25 || buffer[20] !== 47) return null;
		const bits = buffer[21] | buffer[22] << 8 | buffer[23] << 16 | buffer[24] << 24;
		return buildImageMetadata((bits & 16383) + 1, (bits >> 14 & 16383) + 1);
	}
	return null;
}
function readJpegMetadata(buffer) {
	if (buffer.length < 4 || buffer[0] !== 255 || buffer[1] !== 216) return null;
	let offset = 2;
	while (offset + 8 < buffer.length) {
		while (offset < buffer.length && buffer[offset] === 255) offset++;
		if (offset >= buffer.length) return null;
		const marker = buffer[offset];
		offset++;
		if (marker === 216 || marker === 217) continue;
		if (marker === 1 || marker >= 208 && marker <= 215) continue;
		if (offset + 1 >= buffer.length) return null;
		const segmentLength = buffer.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
		if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
			if (segmentLength < 7 || offset + 6 >= buffer.length) return null;
			return buildImageMetadata(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
		}
		offset += segmentLength;
	}
	return null;
}
function readImageMetadataFromHeader(buffer) {
	return readPngMetadata(buffer) ?? readGifMetadata(buffer) ?? readWebpMetadata(buffer) ?? readJpegMetadata(buffer);
}
function countImagePixels(meta) {
	const pixels = meta.width * meta.height;
	return Number.isSafeInteger(pixels) ? pixels : null;
}
function exceedsImagePixelLimit(meta) {
	return meta.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / meta.height);
}
function createImagePixelLimitError(meta) {
	const pixelCount = countImagePixels(meta);
	const detail = pixelCount === null ? `${meta.width}x${meta.height}` : `${meta.width}x${meta.height} (${pixelCount} pixels)`;
	return /* @__PURE__ */ new Error(`Image dimensions exceed the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit: ${detail}`);
}
function validateImagePixelLimit(meta) {
	if (exceedsImagePixelLimit(meta)) throw createImagePixelLimitError(meta);
	return meta;
}
async function readImageMetadataForLimit(buffer) {
	return readImageMetadataFromHeader(buffer);
}
async function assertImagePixelLimit(buffer) {
	const meta = await readImageMetadataForLimit(buffer);
	if (!meta) {
		if (prefersSips()) throw new Error("Unable to determine image dimensions; refusing to process");
		return;
	}
	validateImagePixelLimit(meta);
}
/**
* Reads EXIF orientation from JPEG buffer.
* Returns orientation value 1-8, or null if not found/not JPEG.
*
* EXIF orientation values:
* 1 = Normal, 2 = Flip H, 3 = Rotate 180, 4 = Flip V,
* 5 = Rotate 270 CW + Flip H, 6 = Rotate 90 CW, 7 = Rotate 90 CW + Flip H, 8 = Rotate 270 CW
*/
function readJpegExifOrientation(buffer) {
	if (buffer.length < 2 || buffer[0] !== 255 || buffer[1] !== 216) return null;
	let offset = 2;
	while (offset < buffer.length - 4) {
		if (buffer[offset] !== 255) {
			offset++;
			continue;
		}
		const marker = buffer[offset + 1];
		if (marker === 255) {
			offset++;
			continue;
		}
		if (marker === 225) {
			const exifStart = offset + 4;
			if (buffer.length > exifStart + 6 && buffer.toString("ascii", exifStart, exifStart + 4) === "Exif" && buffer[exifStart + 4] === 0 && buffer[exifStart + 5] === 0) {
				const tiffStart = exifStart + 6;
				if (buffer.length < tiffStart + 8) return null;
				const isLittleEndian = buffer.toString("ascii", tiffStart, tiffStart + 2) === "II";
				const readU16 = (pos) => isLittleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
				const readU32 = (pos) => isLittleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);
				const ifd0Start = tiffStart + readU32(tiffStart + 4);
				if (buffer.length < ifd0Start + 2) return null;
				const numEntries = readU16(ifd0Start);
				for (let i = 0; i < numEntries; i++) {
					const entryOffset = ifd0Start + 2 + i * 12;
					if (buffer.length < entryOffset + 12) break;
					if (readU16(entryOffset) === 274) {
						const value = readU16(entryOffset + 8);
						return value >= 1 && value <= 8 ? value : null;
					}
				}
			}
			return null;
		}
		if (marker >= 224 && marker <= 239) {
			const segmentLength = buffer.readUInt16BE(offset + 2);
			offset += 2 + segmentLength;
			continue;
		}
		if (marker === 192 || marker === 218) break;
		offset++;
	}
	return null;
}
async function withImageTemp(fn) {
	return await withTempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "openclaw-img-"
	}, fn);
}
async function sipsMetadataFromBuffer(buffer) {
	return await withImageTemp(async (workspace) => {
		const { stdout } = await runExec("/usr/bin/sips", [
			"-g",
			"pixelWidth",
			"-g",
			"pixelHeight",
			await workspace.write("in.img", buffer)
		], {
			timeoutMs: 1e4,
			maxBuffer: 512 * 1024
		});
		const w = stdout.match(/pixelWidth:\s*([0-9]+)/);
		const h = stdout.match(/pixelHeight:\s*([0-9]+)/);
		if (!w?.[1] || !h?.[1]) return null;
		const width = Number.parseInt(w[1], 10);
		const height = Number.parseInt(h[1], 10);
		if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
		if (width <= 0 || height <= 0) return null;
		return {
			width,
			height
		};
	});
}
async function sipsResizeToJpeg(params) {
	return await withImageTemp(async (workspace) => {
		const input = await workspace.write("in.img", params.buffer);
		const output = workspace.path("out.jpg");
		await runExec("/usr/bin/sips", [
			"-Z",
			String(Math.max(1, Math.round(params.maxSide))),
			"-s",
			"format",
			"jpeg",
			"-s",
			"formatOptions",
			String(Math.max(1, Math.min(100, Math.round(params.quality)))),
			input,
			"--out",
			output
		], {
			timeoutMs: 2e4,
			maxBuffer: 1024 * 1024
		});
		return await workspace.read("out.jpg");
	});
}
async function sipsConvertToJpeg(buffer) {
	return await withImageTemp(async (workspace) => {
		await runExec("/usr/bin/sips", [
			"-s",
			"format",
			"jpeg",
			await workspace.write("in.heic", buffer),
			"--out",
			workspace.path("out.jpg")
		], {
			timeoutMs: 2e4,
			maxBuffer: 1024 * 1024
		});
		return await workspace.read("out.jpg");
	});
}
async function getImageMetadata(buffer) {
	const metadataForLimit = await readImageMetadataForLimit(buffer).catch(() => null);
	if (metadataForLimit) try {
		return validateImagePixelLimit(metadataForLimit);
	} catch {
		return null;
	}
	if (prefersSips()) return await sipsMetadataFromBuffer(buffer).catch(() => null);
	try {
		const meta = await (await loadMediaAttachmentImageOps()).getImageMetadata(buffer);
		return meta ? validateImagePixelLimit(meta) : null;
	} catch {
		return null;
	}
}
/**
* Applies rotation/flip to image buffer using sips based on EXIF orientation.
*/
async function sipsApplyOrientation(buffer, orientation) {
	const ops = [];
	switch (orientation) {
		case 2:
			ops.push("-f", "horizontal");
			break;
		case 3:
			ops.push("-r", "180");
			break;
		case 4:
			ops.push("-f", "vertical");
			break;
		case 5:
			ops.push("-r", "270", "-f", "horizontal");
			break;
		case 6:
			ops.push("-r", "90");
			break;
		case 7:
			ops.push("-r", "90", "-f", "horizontal");
			break;
		case 8:
			ops.push("-r", "270");
			break;
		default: return buffer;
	}
	return await withImageTemp(async (workspace) => {
		const input = await workspace.write("in.jpg", buffer);
		const output = workspace.path("out.jpg");
		await runExec("/usr/bin/sips", [
			...ops,
			input,
			"--out",
			output
		], {
			timeoutMs: 2e4,
			maxBuffer: 1024 * 1024
		});
		return await workspace.read("out.jpg");
	});
}
/**
* Normalizes EXIF orientation in an image buffer.
* Returns the buffer with correct pixel orientation (rotated if needed).
* Falls back to original buffer if normalization fails.
*/
async function normalizeExifOrientation(buffer) {
	await assertImagePixelLimit(buffer);
	if (prefersSips()) try {
		const orientation = readJpegExifOrientation(buffer);
		if (!orientation || orientation === 1) return buffer;
		return await sipsApplyOrientation(buffer, orientation);
	} catch {
		return buffer;
	}
	try {
		return await (await loadMediaAttachmentImageOps()).normalizeExifOrientation(buffer);
	} catch {
		return buffer;
	}
}
async function resizeToJpeg(params) {
	await assertImagePixelLimit(params.buffer);
	if (prefersSips()) {
		const normalized = await normalizeExifOrientationSips(params.buffer);
		if (params.withoutEnlargement !== false) {
			const meta = await getImageMetadata(normalized);
			if (meta) {
				const maxDim = Math.max(meta.width, meta.height);
				if (maxDim > 0 && maxDim <= params.maxSide) return await sipsResizeToJpeg({
					buffer: normalized,
					maxSide: maxDim,
					quality: params.quality
				});
			}
		}
		return await sipsResizeToJpeg({
			buffer: normalized,
			maxSide: params.maxSide,
			quality: params.quality
		});
	}
	return await (await loadMediaAttachmentImageOps()).resizeToJpeg(params);
}
async function convertHeicToJpeg(buffer) {
	await assertImagePixelLimit(buffer);
	if (prefersSips()) return await sipsConvertToJpeg(buffer);
	const ops = await loadMediaAttachmentImageOps();
	try {
		return await ops.convertHeicToJpeg(buffer);
	} catch (error) {
		if (process.platform !== "darwin") throw error;
		return await sipsConvertToJpeg(buffer);
	}
}
/**
* Checks if an image has an alpha channel (transparency).
* Returns true if the image has alpha, false otherwise.
*/
async function hasAlphaChannel(buffer) {
	await assertImagePixelLimit(buffer);
	try {
		return await (await loadMediaAttachmentImageOps()).hasAlphaChannel(buffer);
	} catch {
		return false;
	}
}
/**
* Resizes an image to PNG format, preserving alpha channel (transparency).
* Falls back to the media attachments plugin only (no sips fallback for PNG with alpha).
*/
async function resizeToPng(params) {
	await assertImagePixelLimit(params.buffer);
	return await (await loadMediaAttachmentImageOps()).resizeToPng(params);
}
async function optimizeImageToPng(buffer, maxBytes) {
	const sides = [
		2048,
		1536,
		1280,
		1024,
		800
	];
	const compressionLevels = [
		6,
		7,
		8,
		9
	];
	let smallest = null;
	for (const side of sides) for (const compressionLevel of compressionLevels) try {
		const out = await resizeToPng({
			buffer,
			maxSide: side,
			compressionLevel,
			withoutEnlargement: true
		});
		const size = out.length;
		if (!smallest || size < smallest.size) smallest = {
			buffer: out,
			size,
			resizeSide: side,
			compressionLevel
		};
		if (size <= maxBytes) return {
			buffer: out,
			optimizedSize: size,
			resizeSide: side,
			compressionLevel
		};
	} catch {}
	if (smallest) return {
		buffer: smallest.buffer,
		optimizedSize: smallest.size,
		resizeSide: smallest.resizeSide,
		compressionLevel: smallest.compressionLevel
	};
	throw new Error("Failed to optimize PNG image");
}
/**
* Internal sips-only EXIF normalization (no sharp fallback).
* Used by resizeToJpeg to normalize before sips resize.
*/
async function normalizeExifOrientationSips(buffer) {
	try {
		const orientation = readJpegExifOrientation(buffer);
		if (!orientation || orientation === 1) return buffer;
		return await sipsApplyOrientation(buffer, orientation);
	} catch {
		return buffer;
	}
}
//#endregion
export { getImageMetadata as a, optimizeImageToPng as c, convertHeicToJpeg as i, resizeToJpeg as l, MAX_IMAGE_INPUT_PIXELS as n, hasAlphaChannel as o, buildImageResizeSideGrid as r, normalizeExifOrientation as s, IMAGE_REDUCE_QUALITY_STEPS as t, resizeToPng as u };
