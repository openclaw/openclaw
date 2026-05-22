import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import "./text-runtime-C_zPTqpT.js";
import { statSync } from "node:fs";
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
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await tts.ttsPromise(text, outputPath);
		if (readOutputSize(outputPath) > 0) return;
	}
	throw new Error("Edge TTS produced empty audio file after retry");
}
//#endregion
export { inferEdgeExtension as n, edgeTTS as t };
