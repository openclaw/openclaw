import { createRequire } from "node:module";
import path from "node:path";
//#region extensions/document-extract/document-extractor.ts
const CANVAS_MODULE = "@napi-rs/canvas";
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
const MAX_EXTRACTED_TEXT_CHARS = 2e5;
const MAX_RENDER_DIMENSION = 1e4;
const require = createRequire(import.meta.url);
let canvasModulePromise = null;
let pdfJsModulePromise = null;
let pdfJsStandardFontDataPath = null;
async function loadCanvasModule() {
	if (!canvasModulePromise) canvasModulePromise = import(CANVAS_MODULE).catch((err) => {
		canvasModulePromise = null;
		throw new Error("Optional dependency @napi-rs/canvas is required for PDF image extraction", { cause: err });
	});
	return canvasModulePromise;
}
async function loadPdfJsModule() {
	if (!pdfJsModulePromise) pdfJsModulePromise = import(PDFJS_MODULE).catch((err) => {
		pdfJsModulePromise = null;
		throw new Error("Optional dependency pdfjs-dist is required for PDF extraction", { cause: err });
	});
	return pdfJsModulePromise;
}
function resolvePdfJsStandardFontDataPath() {
	if (!pdfJsStandardFontDataPath) {
		const pdfJsPackageJsonPath = require.resolve("pdfjs-dist/package.json");
		pdfJsStandardFontDataPath = path.join(path.dirname(pdfJsPackageJsonPath), "standard_fonts") + "/";
	}
	return pdfJsStandardFontDataPath;
}
function appendTextWithinLimit(parts, pageText, currentLength) {
	if (!pageText) return currentLength;
	const remaining = MAX_EXTRACTED_TEXT_CHARS - currentLength;
	if (remaining <= 0) return currentLength;
	const nextText = pageText.length > remaining ? pageText.slice(0, remaining) : pageText;
	parts.push(nextText);
	return currentLength + nextText.length;
}
function resolveRenderPlan(viewport, remainingPixels) {
	if (remainingPixels <= 0 || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null;
	const pagePixels = Math.max(1, viewport.width * viewport.height);
	const maxScale = Math.min(1, Math.sqrt(remainingPixels / pagePixels), MAX_RENDER_DIMENSION / viewport.width, MAX_RENDER_DIMENSION / viewport.height);
	if (!Number.isFinite(maxScale) || maxScale <= 0) return null;
	let best = null;
	let low = 0;
	let high = maxScale;
	for (let i = 0; i < 32; i += 1) {
		const scale = (low + high) / 2;
		const width = Math.max(1, Math.ceil(viewport.width * scale));
		const height = Math.max(1, Math.ceil(viewport.height * scale));
		const pixels = width * height;
		if (width <= MAX_RENDER_DIMENSION && height <= MAX_RENDER_DIMENSION && pixels <= remainingPixels) {
			best = {
				scale,
				width,
				height,
				pixels
			};
			low = scale;
		} else high = scale;
	}
	return best;
}
async function extractPdfContent(request) {
	const pdf = await (await loadPdfJsModule()).getDocument({
		data: new Uint8Array(request.buffer),
		disableWorker: true,
		standardFontDataUrl: resolvePdfJsStandardFontDataPath()
	}).promise;
	const effectivePages = request.pageNumbers ? request.pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, request.maxPages) : Array.from({ length: Math.min(pdf.numPages, request.maxPages) }, (_, i) => i + 1);
	const textParts = [];
	let extractedTextLength = 0;
	for (const pageNum of effectivePages) {
		const pageText = (await (await pdf.getPage(pageNum)).getTextContent()).items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ");
		if (pageText) {
			extractedTextLength = appendTextWithinLimit(textParts, pageText, extractedTextLength);
			if (extractedTextLength >= MAX_EXTRACTED_TEXT_CHARS) break;
		}
	}
	const text = textParts.join("\n\n");
	if (text.trim().length >= request.minTextChars) return {
		text,
		images: []
	};
	let canvasModule;
	try {
		canvasModule = await loadCanvasModule();
	} catch (err) {
		request.onImageExtractionError?.(err);
		return {
			text,
			images: []
		};
	}
	const images = [];
	let remainingPixels = Math.max(1, Math.floor(request.maxPixels));
	for (const pageNum of effectivePages) {
		if (remainingPixels <= 0) break;
		const page = await pdf.getPage(pageNum);
		const plan = resolveRenderPlan(page.getViewport({ scale: 1 }), remainingPixels);
		if (!plan) break;
		const scaled = page.getViewport({ scale: plan.scale });
		const canvas = canvasModule.createCanvas(plan.width, plan.height);
		await page.render({
			canvas,
			viewport: scaled
		}).promise;
		const png = canvas.toBuffer("image/png");
		images.push({
			type: "image",
			data: png.toString("base64"),
			mimeType: "image/png"
		});
		remainingPixels -= plan.pixels;
	}
	return {
		text,
		images
	};
}
function createPdfDocumentExtractor() {
	return {
		id: "pdf",
		label: "PDF",
		mimeTypes: ["application/pdf"],
		autoDetectOrder: 10,
		extract: extractPdfContent
	};
}
//#endregion
export { createPdfDocumentExtractor };
