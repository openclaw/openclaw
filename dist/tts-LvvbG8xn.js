import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as writeExternalFileWithinRoot } from "./fs-safe-CV86zY9G.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./security-runtime-CcSekjBd.js";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
//#region extensions/microsoft/tts.ts
async function loadDefaultEdgeTTSDeps() {
	const { EdgeTTS } = await import("node-edge-tts");
	return { EdgeTTS };
}
function isMissingOutputFileError(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function readOutputSize(outputPath) {
	try {
		return statSync(outputPath).size;
	} catch (error) {
		if (isMissingOutputFileError(error)) return 0;
		throw error;
	}
}
function inferEdgeExtension(outputFormat) {
	const normalized = normalizeLowercaseStringOrEmpty(outputFormat);
	if (normalized.includes("webm")) return ".webm";
	if (normalized.includes("ogg")) return ".ogg";
	if (normalized.includes("opus")) return ".opus";
	if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) return ".wav";
	return ".mp3";
}
async function edgeTTS(params, deps) {
	const { text, outputPath, config, timeoutMs } = params;
	if (text.trim().length === 0) throw new Error("Microsoft TTS text cannot be empty");
	const tts = new (deps ?? await (loadDefaultEdgeTTSDeps())).EdgeTTS({
		voice: config.voice,
		lang: config.lang,
		outputFormat: config.outputFormat,
		saveSubtitles: config.saveSubtitles,
		proxy: config.proxy,
		rate: config.rate,
		pitch: config.pitch,
		volume: config.volume,
		timeout: config.timeoutMs ?? timeoutMs
	});
	for (let attempt = 0; attempt < 2; attempt += 1) if (await writeEdgeTtsOutput({
		outputPath,
		ttsPromise: async (tempPath) => {
			await tts.ttsPromise(text, tempPath);
		}
	}) > 0) return;
	throw new Error("Edge TTS produced empty audio file after retry");
}
async function writeEdgeTtsOutput(params) {
	const rootDir = path.dirname(params.outputPath);
	await mkdir(rootDir, { recursive: true });
	let outputSize = 0;
	await writeExternalFileWithinRoot({
		rootDir,
		path: path.basename(params.outputPath),
		write: async (tempPath) => {
			await params.ttsPromise(tempPath);
			outputSize = readOutputSize(tempPath);
			if (outputSize === 0) writeFileSync(tempPath, "");
		}
	});
	return outputSize;
}
//#endregion
export { inferEdgeExtension as n, edgeTTS as t };
