import { _ as sleep } from "../../utils-CCskKJVV.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-D6cD8elg.js";
import { c as stripToolCallXmlTags, r as sanitizeAssistantVisibleTextWithProfile, t as sanitizeAssistantVisibleText } from "../../assistant-visible-text-Cgh2zC6g.js";
import "../../temp-path-D5yZLChq.js";
import { f as MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS, u as runFfmpeg } from "../../runner.entries-AcpqMe0-.js";
import { t as sanitizeForPlainText } from "../../sanitize-text-C3nayDuc.js";
import "../../outbound-runtime-73MBmy8y.js";
import "../../media-runtime-CfGiZyk2.js";
import { t as formatError } from "./session-errors-Xu9_CeUR.js";
import "./text-runtime-fYotdU4s.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region extensions/whatsapp/src/outbound-media-contract.ts
const WHATSAPP_VOICE_FILE_NAME = "voice.ogg";
const WHATSAPP_VOICE_SAMPLE_RATE_HZ = 48e3;
const WHATSAPP_VOICE_BITRATE = "64k";
const WHATSAPP_VOICE_MIMETYPE = "audio/ogg; codecs=opus";
function stripWhatsAppPluralToolXml(text) {
	return stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true });
}
function finalizeWhatsAppVisibleText(text) {
	return sanitizeForPlainText(stripWhatsAppPluralToolXml(text));
}
function normalizeWhatsAppPayloadText(text) {
	return finalizeWhatsAppVisibleText(sanitizeAssistantVisibleText(text ?? "")).trimStart();
}
function stripLeadingBlankLines(text) {
	return text.replace(/^(?:[ \t]*\r?\n)+/, "");
}
function normalizeWhatsAppPayloadTextPreservingIndentation(text) {
	const normalized = stripLeadingBlankLines(finalizeWhatsAppVisibleText(sanitizeAssistantVisibleTextWithProfile(stripLeadingBlankLines(text ?? ""), "history")));
	return normalized.trim() ? normalized : "";
}
function resolveWhatsAppOutboundMediaUrls(payload) {
	const orderedMediaUrls = [payload.mediaUrl?.trim(), ...(payload.mediaUrls ? [...payload.mediaUrls] : []).map((entry) => entry.trim()).filter((entry) => Boolean(entry))].filter((entry) => Boolean(entry));
	return Array.from(new Set(orderedMediaUrls));
}
function normalizeWhatsAppOutboundPayload(payload, options) {
	const mediaUrls = resolveWhatsAppOutboundMediaUrls(payload);
	const normalizeText = options?.normalizeText ?? normalizeWhatsAppPayloadText;
	return {
		...payload,
		text: normalizeText(payload.text),
		mediaUrl: mediaUrls[0],
		mediaUrls: mediaUrls.length > 0 ? mediaUrls : void 0
	};
}
function normalizeWhatsAppLoadedMedia(media, mediaUrl) {
	const kind = media.kind === "image" || media.kind === "audio" || media.kind === "video" ? media.kind : "document";
	const mimetype = kind === "audio" && isWhatsAppNativeVoiceAudio({
		contentType: media.contentType,
		mediaUrl
	}) ? WHATSAPP_VOICE_MIMETYPE : media.contentType ?? "application/octet-stream";
	const fileName = kind === "document" ? media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "file" : void 0;
	return {
		buffer: media.buffer,
		kind,
		mimetype,
		...fileName ? { fileName } : {}
	};
}
async function prepareWhatsAppOutboundMedia(media, mediaUrl) {
	const normalized = normalizeWhatsAppLoadedMedia(media, mediaUrl);
	if (normalized.kind !== "audio") return normalized;
	if (isWhatsAppNativeVoiceAudio({
		contentType: media.contentType,
		fileName: media.fileName,
		mediaUrl
	})) return normalized;
	return {
		buffer: await transcodeToWhatsAppVoiceOpus({
			buffer: media.buffer,
			fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio"
		}),
		kind: "audio",
		mimetype: WHATSAPP_VOICE_MIMETYPE
	};
}
function normalizeContentType(value) {
	return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
function isWhatsAppNativeVoiceAudio(params) {
	const contentType = normalizeContentType(params.contentType);
	if (contentType === "audio/ogg" || contentType === "audio/opus") return true;
	const fileName = params.fileName ?? deriveWhatsAppDocumentFileName(params.mediaUrl) ?? "";
	const ext = path.extname(fileName).toLowerCase();
	return ext === ".ogg" || ext === ".opus";
}
async function transcodeToWhatsAppVoiceOpus(params) {
	const tempRoot = resolvePreferredOpenClawTmpDir();
	await fs.mkdir(tempRoot, {
		recursive: true,
		mode: 448
	});
	const tempDir = await fs.mkdtemp(path.join(tempRoot, "whatsapp-voice-"));
	try {
		const ext = path.extname(params.fileName).toLowerCase();
		const inputExt = ext && ext.length <= 12 ? ext : ".audio";
		const inputPath = path.join(tempDir, `input${inputExt}`);
		const outputPath = path.join(tempDir, WHATSAPP_VOICE_FILE_NAME);
		await fs.writeFile(inputPath, params.buffer, { mode: 384 });
		await runFfmpeg([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-sn",
			"-dn",
			"-t",
			String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
			"-ar",
			String(WHATSAPP_VOICE_SAMPLE_RATE_HZ),
			"-ac",
			"1",
			"-c:a",
			"libopus",
			"-b:a",
			WHATSAPP_VOICE_BITRATE,
			outputPath
		]);
		return await fs.readFile(outputPath);
	} finally {
		await fs.rm(tempDir, {
			recursive: true,
			force: true
		});
	}
}
function deriveWhatsAppDocumentFileName(mediaUrl) {
	if (!mediaUrl) return;
	try {
		const parsed = new URL(mediaUrl);
		const fileName = path.posix.basename(parsed.pathname);
		return fileName ? decodeURIComponent(fileName) : void 0;
	} catch {
		return (mediaUrl.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).pop() || void 0;
	}
}
function isRetryableWhatsAppOutboundError(error) {
	return /closed|reset|timed\s*out|disconnect/i.test(formatError(error));
}
async function sendWhatsAppOutboundWithRetry(params) {
	const maxAttempts = params.maxAttempts ?? 3;
	let lastError;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) try {
		return await params.send();
	} catch (error) {
		lastError = error;
		const errorText = formatError(error);
		const isLastAttempt = attempt === maxAttempts;
		if (!isRetryableWhatsAppOutboundError(error) || isLastAttempt) throw error;
		const backoffMs = 500 * attempt;
		await params.onRetry?.({
			attempt,
			maxAttempts,
			backoffMs,
			error,
			errorText
		});
		await sleep(backoffMs);
	}
	throw lastError;
}
//#endregion
export { resolveWhatsAppOutboundMediaUrls as a, prepareWhatsAppOutboundMedia as i, normalizeWhatsAppPayloadText as n, sendWhatsAppOutboundWithRetry as o, normalizeWhatsAppPayloadTextPreservingIndentation as r, normalizeWhatsAppOutboundPayload as t };
