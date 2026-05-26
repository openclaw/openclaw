import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as writeExternalFileWithinRoot } from "./fs-safe-CV86zY9G.js";
import { r as readRegularFile } from "./regular-file-DaVeNX32.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as withTempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { _ as mediaKindFromMime } from "./mime-DppuT-pZ.js";
import { x as MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS, y as runFfmpeg } from "./media-services-CLFjOJQs.js";
import { f as saveMediaStream, u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { i as withTempDownloadPath } from "./temp-download-b1j3o1mX.js";
import "./temp-path-DllZid8c.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import "./media-runtime-BheBFFxc.js";
import "./media-store-3-Nw2YTP.js";
import "./media-mime-j2Nhr7Df.js";
import "./text-chunking-C154U6-i.js";
import "./security-runtime-CcSekjBd.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import { i as resolveReceiveIdType, r as normalizeFeishuTarget } from "./targets-BVM6OB3d.js";
import { l as resolveFeishuRuntimeAccount, m as isRecord$1, u as createFeishuApiError, v as requestFeishuApi } from "./accounts-Djfj3q-S.js";
import { i as toFeishuSendResult, r as resolveFeishuReceiptKind, t as assertFeishuMessageApiSuccess } from "./send-result-D6azRnOt.js";
import { t as getFeishuRuntime } from "./runtime-CjGuNoJc.js";
import { r as createFeishuClient } from "./client-Cl7PkrEA.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
//#region extensions/feishu/src/external-keys.ts
const CONTROL_CHARS_RE = /\p{Cc}/u;
const MAX_EXTERNAL_KEY_LENGTH = 512;
function normalizeFeishuExternalKey(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) return;
	if (CONTROL_CHARS_RE.test(normalized)) return;
	if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) return;
	return normalized;
}
//#endregion
//#region extensions/feishu/src/send-target.ts
function resolveFeishuSendTarget(params) {
	const target = params.to.trim();
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const client = createFeishuClient(account);
	const receiveId = normalizeFeishuTarget(target);
	if (!receiveId) throw new Error(`Invalid Feishu target: ${params.to}`);
	return {
		client,
		receiveId,
		receiveIdType: resolveReceiveIdType(target.replace(/^(feishu|lark):/i, ""))
	};
}
//#endregion
//#region extensions/feishu/src/media.ts
const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 12e4;
const FEISHU_VOICE_FILE_NAME = "voice.ogg";
const FEISHU_VOICE_SAMPLE_RATE_HZ = 48e3;
const FEISHU_VOICE_BITRATE = "64k";
const FEISHU_TRANSCODABLE_AUDIO_EXTS = new Set([
	".aac",
	".aiff",
	".alac",
	".amr",
	".caf",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".wav",
	".webm",
	".wma"
]);
function createConfiguredFeishuMediaClient(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	return {
		account,
		client: createFeishuClient({
			...account,
			httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS
		})
	};
}
function asHeaderMap(value) {
	if (!value) return;
	const entries = Object.entries(value);
	if (entries.every(([, entry]) => typeof entry === "string" || Array.isArray(entry))) return Object.fromEntries(entries);
}
function extractFeishuUploadKey(response, params) {
	if (!response) throw new Error(`${params.errorPrefix}: empty response`);
	const wrappedResponse = response;
	if (wrappedResponse.code !== void 0 && wrappedResponse.code !== 0) throw new Error(`${params.errorPrefix}: ${wrappedResponse.msg || `code ${wrappedResponse.code}`}`);
	const key = params.key === "image_key" ? wrappedResponse.image_key ?? wrappedResponse.data?.image_key : wrappedResponse.file_key ?? wrappedResponse.data?.file_key;
	if (!key) throw new Error(`${params.errorPrefix}: no ${params.key} returned`);
	return key;
}
function readHeaderValue(headers, name) {
	if (!headers) return;
	for (const [key, value] of Object.entries(headers)) {
		if (normalizeLowercaseStringOrEmpty(key) !== normalizeLowercaseStringOrEmpty(name)) continue;
		if (typeof value === "string" && value.trim()) return value.trim();
		if (Array.isArray(value)) {
			const first = value.find((entry) => typeof entry === "string" && entry.trim());
			if (typeof first === "string") return first.trim();
		}
	}
}
function readHttpStatusFromError(error) {
	if (!error || typeof error !== "object") return;
	const response = error.response;
	if (response && typeof response === "object") {
		const status = response.status;
		if (typeof status === "number") return status;
	}
	const status = error.status;
	return typeof status === "number" ? status : void 0;
}
function isHttpStatusError(error, status) {
	return readHttpStatusFromError(error) === status;
}
function containsEastAsianScript(value) {
	return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}
function recoverUtf8FileNameFromLatin1Header(value) {
	const recovered = Buffer.from(value, "latin1").toString("utf8");
	if (recovered !== value && !recovered.includes("�") && containsEastAsianScript(recovered)) return recovered;
	return value;
}
function decodeDispositionFileName(value) {
	const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) try {
		return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
	} catch {
		return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
	}
	const plainFileName = value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
	return plainFileName ? recoverUtf8FileNameFromLatin1Header(plainFileName) : void 0;
}
function extractFeishuDownloadMetadata(response) {
	const responseWithOptionalFields = response;
	const headers = asHeaderMap(responseWithOptionalFields.headers) ?? asHeaderMap(responseWithOptionalFields.header);
	const contentType = readHeaderValue(headers, "content-type") ?? responseWithOptionalFields.contentType ?? responseWithOptionalFields.mime_type ?? responseWithOptionalFields.data?.contentType ?? responseWithOptionalFields.data?.mime_type;
	const disposition = readHeaderValue(headers, "content-disposition");
	return {
		contentType,
		fileName: (disposition ? decodeDispositionFileName(disposition) : void 0) ?? responseWithOptionalFields.file_name ?? responseWithOptionalFields.fileName ?? responseWithOptionalFields.data?.file_name ?? responseWithOptionalFields.data?.fileName
	};
}
function mediaLimitError(maxBytes) {
	return /* @__PURE__ */ new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
}
async function saveFeishuResponseMedia(params) {
	const { response, maxBytes, contentType, fileName } = params;
	if (Buffer.isBuffer(response)) return saveMediaBuffer(response, contentType, "inbound", maxBytes, fileName);
	if (response instanceof ArrayBuffer) return saveMediaBuffer(Buffer.from(response), contentType, "inbound", maxBytes, fileName);
	const responseWithOptionalFields = response;
	if (responseWithOptionalFields.code !== void 0 && responseWithOptionalFields.code !== 0) throw new Error(`${params.errorPrefix}: ${responseWithOptionalFields.msg || `code ${responseWithOptionalFields.code}`}`);
	if (responseWithOptionalFields.data && Buffer.isBuffer(responseWithOptionalFields.data)) return saveMediaBuffer(responseWithOptionalFields.data, contentType, "inbound", maxBytes, fileName);
	if (responseWithOptionalFields.data instanceof ArrayBuffer) return saveMediaBuffer(Buffer.from(responseWithOptionalFields.data), contentType, "inbound", maxBytes, fileName);
	if (typeof response.getReadableStream === "function") return saveMediaStream(response.getReadableStream(), contentType, "inbound", maxBytes, fileName);
	if (typeof response.writeFile === "function") return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
		await response.writeFile(tmpPath);
		if ((await fs.promises.stat(tmpPath)).size > maxBytes) throw mediaLimitError(maxBytes);
		return await saveMediaStream(fs.createReadStream(tmpPath), contentType, "inbound", maxBytes, fileName);
	});
	if (responseWithOptionalFields[Symbol.asyncIterator]) return saveMediaStream(responseWithOptionalFields, contentType, "inbound", maxBytes, fileName);
	if (response instanceof Readable) return saveMediaStream(response, contentType, "inbound", maxBytes, fileName);
	const keys = Object.keys(response);
	throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${keys.join(", ")}]`);
}
async function saveMessageResourceWithType(params) {
	const response = await params.client.im.messageResource.get({
		path: {
			message_id: params.messageId,
			file_key: params.fileKey
		},
		params: { type: params.type }
	});
	const meta = extractFeishuDownloadMetadata(response);
	return {
		saved: await saveFeishuResponseMedia({
			response,
			tmpDirPrefix: "openclaw-feishu-resource-",
			errorPrefix: "Feishu message resource download failed",
			maxBytes: params.maxBytes,
			contentType: meta.contentType,
			fileName: meta.fileName ?? params.originalFilename
		}),
		...meta
	};
}
async function saveMessageResourceFeishu(params) {
	const { cfg, messageId, fileKey, type, accountId, maxBytes, originalFilename } = params;
	const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
	if (!normalizedFileKey) throw new Error("Feishu message resource download failed: invalid file_key");
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	try {
		return await saveMessageResourceWithType({
			client,
			messageId,
			fileKey: normalizedFileKey,
			type,
			maxBytes,
			originalFilename
		});
	} catch (err) {
		if (type !== "file" || !isHttpStatusError(err, 502)) throw err;
		try {
			return await saveMessageResourceWithType({
				client,
				messageId,
				fileKey: normalizedFileKey,
				type: "media",
				maxBytes,
				originalFilename
			});
		} catch {
			throw err;
		}
	}
}
/**
* Upload an image to Feishu and get an image_key for sending.
* Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
*/
async function uploadImageFeishu(params) {
	const { cfg, image, imageType = "message", accountId } = params;
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	const imageData = typeof image === "string" ? (await readRegularFile({ filePath: image })).buffer : image;
	return { imageKey: extractFeishuUploadKey(await requestFeishuApi(() => client.im.image.create({ data: {
		image_type: imageType,
		image: imageData
	} }), "Feishu image upload failed", { includeNestedErrorLogId: true }), {
		key: "image_key",
		errorPrefix: "Feishu image upload failed"
	}) };
}
/**
* Sanitize a filename for safe use in Feishu multipart/form-data uploads.
* Strips control characters and multipart-injection vectors (CWE-93) while
* preserving the original UTF-8 display name (Chinese, emoji, etc.).
*
* Previous versions percent-encoded non-ASCII characters, but the Feishu
* `im.file.create` API uses `file_name` as a literal display name — it does
* NOT decode percent-encoding — so encoded filenames appeared as garbled text
* in chat (regression in v2026.3.2).
*/
function sanitizeFileNameForUpload(fileName) {
	return fileName.replace(/[\p{Cc}"\\]/gu, "_");
}
/**
* Upload a file to Feishu and get a file_key for sending.
* Max file size: 30MB
*/
async function uploadFileFeishu(params) {
	const { cfg, file, fileName, fileType, duration, accountId } = params;
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	const fileData = typeof file === "string" ? (await readRegularFile({ filePath: file })).buffer : file;
	const safeFileName = sanitizeFileNameForUpload(fileName);
	return { fileKey: extractFeishuUploadKey(await requestFeishuApi(() => client.im.file.create({ data: {
		file_type: fileType,
		file_name: safeFileName,
		file: fileData,
		...duration !== void 0 && { duration }
	} }), "Feishu file upload failed", { includeNestedErrorLogId: true }), {
		key: "file_key",
		errorPrefix: "Feishu file upload failed"
	}) };
}
/**
* Send an image message using an image_key
*/
async function sendImageFeishu(params) {
	const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify({ image_key: imageKey });
	if (replyToMessageId) {
		const response = await requestFeishuApi(() => client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: "image",
				...replyInThread ? { reply_in_thread: true } : {}
			}
		}), "Feishu image reply failed", { includeNestedErrorLogId: true });
		assertFeishuMessageApiSuccess(response, "Feishu image reply failed");
		return toFeishuSendResult(response, receiveId, "media");
	}
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: "image"
		}
	}), "Feishu image send failed", { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, "Feishu image send failed");
	return toFeishuSendResult(response, receiveId, "media");
}
/**
* Send a file message using a file_key
*/
async function sendFileFeishu(params) {
	const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
	const msgType = params.msgType ?? "file";
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify({ file_key: fileKey });
	if (replyToMessageId) {
		const response = await requestFeishuApi(() => client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: msgType,
				...replyInThread ? { reply_in_thread: true } : {}
			}
		}), "Feishu file reply failed", { includeNestedErrorLogId: true });
		assertFeishuMessageApiSuccess(response, "Feishu file reply failed");
		return toFeishuSendResult(response, receiveId, resolveFeishuReceiptKind(msgType));
	}
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: msgType
		}
	}), "Feishu file send failed", { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, "Feishu file send failed");
	return toFeishuSendResult(response, receiveId, resolveFeishuReceiptKind(msgType));
}
/**
* Helper to detect file type from extension
*/
function detectFileType(fileName) {
	switch (normalizeLowercaseStringOrEmpty(path.extname(fileName))) {
		case ".opus":
		case ".ogg": return "opus";
		case ".mp4":
		case ".mov":
		case ".avi": return "mp4";
		case ".pdf": return "pdf";
		case ".doc":
		case ".docx": return "doc";
		case ".xls":
		case ".xlsx": return "xls";
		case ".ppt":
		case ".pptx": return "ppt";
		default: return "stream";
	}
}
function resolveFeishuOutboundMediaKind(params) {
	const { fileName, contentType } = params;
	const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
	const mimeKind = mediaKindFromMime(contentType);
	if ([
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".ico",
		".tiff"
	].includes(ext) || mimeKind === "image") return { msgType: "image" };
	if (ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus") return {
		fileType: "opus",
		msgType: "audio"
	};
	if ([
		".mp4",
		".mov",
		".avi"
	].includes(ext) || contentType === "video/mp4" || contentType === "video/quicktime" || contentType === "video/x-msvideo") return {
		fileType: "mp4",
		msgType: "media"
	};
	const fileType = detectFileType(fileName);
	return {
		fileType,
		msgType: fileType === "stream" ? "file" : fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file"
	};
}
function isFeishuNativeVoiceAudio(params) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
	const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
	return ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus";
}
function normalizeMediaNameForExtension(raw) {
	try {
		return new URL(raw).pathname;
	} catch {
		return raw.split(/[?#]/, 1)[0] ?? raw;
	}
}
function shouldSuppressFeishuTextForVoiceMedia(params) {
	if (params.audioAsVoice === true) return true;
	if (params.fileName && isFeishuNativeVoiceAudio({
		fileName: params.fileName,
		contentType: params.contentType
	})) return true;
	if (!params.mediaUrl) return false;
	return isFeishuNativeVoiceAudio({
		fileName: normalizeMediaNameForExtension(params.mediaUrl),
		contentType: params.contentType
	});
}
function isLikelyTranscodableAudio(params) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
	const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
	return FEISHU_TRANSCODABLE_AUDIO_EXTS.has(ext) || mediaKindFromMime(contentType) === "audio";
}
async function transcodeToFeishuVoiceOpus(params) {
	return await withTempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "feishu-voice-"
	}, async (workspace) => {
		const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
		const inputExt = ext && ext.length <= 12 ? ext : ".audio";
		const inputPath = await workspace.write(`input${inputExt}`, params.buffer);
		await writeExternalFileWithinRoot({
			rootDir: workspace.dir,
			path: FEISHU_VOICE_FILE_NAME,
			write: async (outputPath) => {
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
					String(FEISHU_VOICE_SAMPLE_RATE_HZ),
					"-ac",
					"1",
					"-c:a",
					"libopus",
					"-b:a",
					FEISHU_VOICE_BITRATE,
					"-f",
					"ogg",
					outputPath
				]);
			}
		});
		return {
			buffer: await workspace.read(FEISHU_VOICE_FILE_NAME),
			fileName: FEISHU_VOICE_FILE_NAME,
			contentType: "audio/ogg"
		};
	});
}
async function prepareFeishuVoiceMedia(params) {
	if (isFeishuNativeVoiceAudio(params)) return params;
	if (params.audioAsVoice !== true || !isLikelyTranscodableAudio(params)) return params;
	try {
		return await transcodeToFeishuVoiceOpus(params);
	} catch (err) {
		console.warn(`[feishu] audioAsVoice transcode failed; sending ${params.fileName} as a file attachment:`, err);
		return params;
	}
}
/**
* Upload and send media (image or file) from URL, local path, or buffer.
* When mediaUrl is a local path, mediaLocalRoots (from core outbound context)
* must be passed so loadWebMedia allows the path (post CVE-2026-26321).
*/
async function sendMediaFeishu(params) {
	const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, replyInThread, accountId, mediaLocalRoots, audioAsVoice } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;
	let buffer;
	let name;
	let contentType;
	if (mediaBuffer) {
		buffer = mediaBuffer;
		name = fileName ?? "file";
	} else if (mediaUrl) {
		const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
			maxBytes: mediaMaxBytes,
			optimizeImages: false,
			localRoots: mediaLocalRoots?.length ? mediaLocalRoots : void 0
		});
		buffer = loaded.buffer;
		name = fileName ?? loaded.fileName ?? "file";
		contentType = loaded.contentType;
	} else throw new Error("Either mediaUrl or mediaBuffer must be provided");
	const prepared = await prepareFeishuVoiceMedia({
		buffer,
		fileName: name,
		contentType,
		audioAsVoice
	});
	buffer = prepared.buffer;
	name = prepared.fileName;
	contentType = prepared.contentType;
	const routing = resolveFeishuOutboundMediaKind({
		fileName: name,
		contentType
	});
	const voiceIntentDegradedToFile = audioAsVoice === true && routing.msgType !== "audio";
	if (routing.msgType === "image") {
		const { imageKey } = await uploadImageFeishu({
			cfg,
			image: buffer,
			accountId
		});
		return {
			...await sendImageFeishu({
				cfg,
				to,
				imageKey,
				replyToMessageId,
				replyInThread,
				accountId
			}),
			...voiceIntentDegradedToFile ? { voiceIntentDegradedToFile: true } : {}
		};
	}
	const { fileKey } = await uploadFileFeishu({
		cfg,
		file: buffer,
		fileName: name,
		fileType: routing.fileType ?? "stream",
		accountId
	});
	return {
		...await sendFileFeishu({
			cfg,
			to,
			fileKey,
			msgType: routing.msgType,
			replyToMessageId,
			replyInThread,
			accountId
		}),
		...voiceIntentDegradedToFile ? { voiceIntentDegradedToFile: true } : {}
	};
}
//#endregion
//#region extensions/feishu/src/types.ts
function isFeishuGroupChatType(chatType) {
	return chatType === "group" || chatType === "topic_group";
}
//#endregion
//#region extensions/feishu/src/mention.ts
function isFeishuBroadcastMention(mention) {
	const normalizedKey = mention.key?.trim().toLowerCase();
	if (normalizedKey === "@all" || normalizedKey === "@_all") return true;
	return [
		mention.id?.open_id,
		mention.id?.user_id,
		mention.id?.union_id
	].some((id) => id?.trim().toLowerCase() === "all");
}
/**
* Extract mention targets from message event (excluding the bot itself)
*/
function extractMentionTargets(event, botOpenId) {
	return (event.message.mentions ?? []).filter((m) => {
		if (isFeishuBroadcastMention(m)) return false;
		if (botOpenId && m.id.open_id === botOpenId) return false;
		return !!m.id.open_id;
	}).map((m) => ({
		openId: m.id.open_id,
		name: m.name,
		key: m.key
	}));
}
/**
* Check if message is a mention forward request
* Rules:
* - Group: message mentions bot + at least one other user
* - DM: message mentions any user (no need to mention bot)
*/
function isMentionForwardRequest(event, botOpenId) {
	const mentions = event.message.mentions ?? [];
	if (mentions.length === 0) return false;
	const isDirectMessage = !isFeishuGroupChatType(event.message.chat_type);
	const userMentions = mentions.filter((m) => !isFeishuBroadcastMention(m));
	const hasOtherMention = userMentions.some((m) => m.id.open_id !== botOpenId);
	if (isDirectMessage) return hasOtherMention;
	return userMentions.some((m) => m.id.open_id === botOpenId) && hasOtherMention;
}
/**
* Format @mention for text message
*/
function formatMentionForText(target) {
	return `<at user_id="${target.openId}">${target.name}</at>`;
}
/**
* Format @mention for card message (lark_md)
*/
function formatMentionForCard(target) {
	return `<at id=${target.openId}></at>`;
}
/**
* Build complete message with @mentions (text format)
*/
function buildMentionedMessage(targets, message) {
	if (targets.length === 0) return message;
	return `${targets.map((t) => formatMentionForText(t)).join(" ")} ${message}`;
}
/**
* Build card content with @mentions (Markdown format)
*/
function buildMentionedCardContent(targets, message) {
	if (targets.length === 0) return message;
	return `${targets.map((t) => formatMentionForCard(t)).join(" ")} ${message}`;
}
//#endregion
//#region extensions/feishu/src/post.ts
const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+\-!|>~])/g;
function toStringOrEmpty(value) {
	return typeof value === "string" ? value : "";
}
function escapeMarkdownText(text) {
	return text.replace(MARKDOWN_SPECIAL_CHARS, "\\$1");
}
function toBoolean(value) {
	return value === true || value === 1 || value === "true";
}
function isStyleEnabled(style, key) {
	if (!style) return false;
	return toBoolean(style[key]);
}
function wrapInlineCode(text) {
	const maxRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(maxRun + 1);
	return `${fence}${text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
}
function sanitizeFenceLanguage(language) {
	return language.trim().replace(/[^A-Za-z0-9_+#.-]/g, "");
}
function renderTextElement(element) {
	const text = toStringOrEmpty(element.text);
	const style = isRecord$1(element.style) ? element.style : void 0;
	if (isStyleEnabled(style, "code")) return wrapInlineCode(text);
	let rendered = escapeMarkdownText(text);
	if (!rendered) return "";
	if (isStyleEnabled(style, "bold")) rendered = `**${rendered}**`;
	if (isStyleEnabled(style, "italic")) rendered = `*${rendered}*`;
	if (isStyleEnabled(style, "underline")) rendered = `<u>${rendered}</u>`;
	if (isStyleEnabled(style, "strikethrough") || isStyleEnabled(style, "line_through") || isStyleEnabled(style, "lineThrough")) rendered = `~~${rendered}~~`;
	return rendered;
}
function renderLinkElement(element) {
	const href = toStringOrEmpty(element.href).trim();
	const text = toStringOrEmpty(element.text) || href;
	if (!text) return "";
	if (!href) return escapeMarkdownText(text);
	return `[${escapeMarkdownText(text)}](${href})`;
}
function renderMentionElement(element) {
	const mention = toStringOrEmpty(element.user_name) || toStringOrEmpty(element.user_id) || toStringOrEmpty(element.open_id);
	if (!mention) return "";
	return `@${escapeMarkdownText(mention)}`;
}
function renderEmotionElement(element) {
	return escapeMarkdownText(toStringOrEmpty(element.emoji) || toStringOrEmpty(element.text) || toStringOrEmpty(element.emoji_type));
}
function renderCodeBlockElement(element) {
	const language = sanitizeFenceLanguage(toStringOrEmpty(element.language) || toStringOrEmpty(element.lang));
	const code = (toStringOrEmpty(element.text) || toStringOrEmpty(element.content)).replace(/\r\n/g, "\n");
	return `\`\`\`${language}\n${code}${code.endsWith("\n") ? "" : "\n"}\`\`\``;
}
function renderElement(element, imageKeys, mediaKeys, mentionedOpenIds) {
	if (!isRecord$1(element)) return escapeMarkdownText(toStringOrEmpty(element));
	switch (normalizeLowercaseStringOrEmpty(toStringOrEmpty(element.tag))) {
		case "text": return renderTextElement(element);
		case "a": return renderLinkElement(element);
		case "at":
			{
				const normalizedMention = normalizeFeishuExternalKey(toStringOrEmpty(element.open_id) || toStringOrEmpty(element.user_id));
				if (normalizedMention) mentionedOpenIds.push(normalizedMention);
			}
			return renderMentionElement(element);
		case "img": {
			const imageKey = normalizeFeishuExternalKey(toStringOrEmpty(element.image_key));
			if (imageKey) imageKeys.push(imageKey);
			return "![image]";
		}
		case "media": {
			const fileKey = normalizeFeishuExternalKey(toStringOrEmpty(element.file_key));
			if (fileKey) {
				const fileName = toStringOrEmpty(element.file_name) || void 0;
				mediaKeys.push({
					fileKey,
					fileName
				});
			}
			return "[media]";
		}
		case "emotion": return renderEmotionElement(element);
		case "md":
		case "lark_md": return toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
		case "br": return "\n";
		case "hr": return "\n\n---\n\n";
		case "code": {
			const code = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
			return code ? wrapInlineCode(code) : "";
		}
		case "code_block":
		case "pre": return renderCodeBlockElement(element);
		default: return escapeMarkdownText(toStringOrEmpty(element.text));
	}
}
function toPostPayload(candidate) {
	if (!isRecord$1(candidate) || !Array.isArray(candidate.content)) return null;
	return {
		title: toStringOrEmpty(candidate.title),
		content: candidate.content
	};
}
function resolveLocalePayload(candidate) {
	const direct = toPostPayload(candidate);
	if (direct) return direct;
	if (!isRecord$1(candidate)) return null;
	for (const value of Object.values(candidate)) {
		const localePayload = toPostPayload(value);
		if (localePayload) return localePayload;
	}
	return null;
}
function resolvePostPayload(parsed) {
	const direct = toPostPayload(parsed);
	if (direct) return direct;
	if (!isRecord$1(parsed)) return null;
	const wrappedPost = resolveLocalePayload(parsed.post);
	if (wrappedPost) return wrappedPost;
	return resolveLocalePayload(parsed);
}
function parsePostContent(content) {
	try {
		const payload = resolvePostPayload(JSON.parse(content));
		if (!payload) return {
			textContent: FALLBACK_POST_TEXT,
			imageKeys: [],
			mediaKeys: [],
			mentionedOpenIds: []
		};
		const imageKeys = [];
		const mediaKeys = [];
		const mentionedOpenIds = [];
		const paragraphs = [];
		for (const paragraph of payload.content) {
			if (!Array.isArray(paragraph)) continue;
			let renderedParagraph = "";
			for (const element of paragraph) renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);
			paragraphs.push(renderedParagraph);
		}
		return {
			textContent: [escapeMarkdownText(payload.title.trim()), paragraphs.join("\n").trim()].filter(Boolean).join("\n\n").trim() || FALLBACK_POST_TEXT,
			imageKeys,
			mediaKeys,
			mentionedOpenIds
		};
	} catch {
		return {
			textContent: FALLBACK_POST_TEXT,
			imageKeys: [],
			mediaKeys: [],
			mentionedOpenIds: []
		};
	}
}
//#endregion
//#region extensions/feishu/src/send.ts
const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
const INTERACTIVE_CARD_FALLBACK_TEXT = "[Interactive Card]";
const POST_FALLBACK_TEXT = "[Rich text message]";
const FEISHU_CARD_TEMPLATES = new Set([
	"blue",
	"green",
	"red",
	"orange",
	"purple",
	"indigo",
	"wathet",
	"turquoise",
	"yellow",
	"grey",
	"carmine",
	"violet",
	"lime"
]);
function shouldFallbackFromReplyTarget(response) {
	if (response.code !== void 0 && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) return true;
	const msg = normalizeLowercaseStringOrEmpty(response.msg);
	return msg.includes("withdrawn") || msg.includes("not found");
}
/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err) {
	if (typeof err !== "object" || err === null) return false;
	const code = err.code;
	if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) return true;
	const response = err.response;
	if (typeof response?.data?.code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)) return true;
	return false;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(client, params, errorPrefix) {
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: params.receiveIdType },
		data: {
			receive_id: params.receiveId,
			content: params.content,
			msg_type: params.msgType
		}
	}), errorPrefix, { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, errorPrefix);
	return toFeishuSendResult(response, params.receiveId, resolveFeishuReceiptKind(params.msgType));
}
async function sendReplyOrFallbackDirect(client, params) {
	if (!params.replyToMessageId) return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	const replyTargetFallbackError = params.replyInThread && params.allowTopLevelReplyFallback !== true ? /* @__PURE__ */ new Error("Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.") : null;
	let response;
	try {
		response = await client.im.message.reply({
			path: { message_id: params.replyToMessageId },
			data: {
				content: params.content,
				msg_type: params.msgType,
				...params.replyInThread ? { reply_in_thread: true } : {}
			}
		});
	} catch (err) {
		if (!isWithdrawnReplyError(err)) throw createFeishuApiError(err, params.replyErrorPrefix, { includeNestedErrorLogId: true });
		if (replyTargetFallbackError) throw replyTargetFallbackError;
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	if (shouldFallbackFromReplyTarget(response)) {
		if (replyTargetFallbackError) throw replyTargetFallbackError;
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
	return toFeishuSendResult(response, params.directParams.receiveId, resolveFeishuReceiptKind(params.msgType));
}
function normalizeCardTemplateVariable(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
}
function readCardTemplateVariables(parsed) {
	const variables = /* @__PURE__ */ new Map();
	for (const source of [parsed.template_variable, parsed.template_variables]) {
		if (!isRecord(source)) continue;
		for (const [key, value] of Object.entries(source)) {
			const normalized = normalizeCardTemplateVariable(value);
			if (normalized !== void 0) variables.set(key, normalized);
		}
	}
	return variables;
}
function applyCardTemplateVariables(text, variables) {
	if (variables.size === 0) return text;
	return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
		const variableName = typeof a === "string" ? a : b;
		return variables.get(variableName) ?? match;
	});
}
function extractInteractiveElementText(element, variables) {
	if (!isRecord(element)) return;
	const tag = typeof element.tag === "string" ? element.tag : "";
	const text = isRecord(element.text) ? element.text : void 0;
	if (tag === "div" && typeof text?.content === "string") return applyCardTemplateVariables(text.content, variables);
	if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") return applyCardTemplateVariables(element.content, variables);
	if (tag === "plain_text" && typeof element.content === "string") return applyCardTemplateVariables(element.content, variables);
}
function extractInteractiveElementsText(elements, variables) {
	const texts = [];
	for (const element of elements) {
		const text = extractInteractiveElementText(element, variables);
		if (text !== void 0) texts.push(text);
	}
	return texts.join("\n").trim();
}
function readInteractiveElementArrays(parsed) {
	const body = isRecord(parsed.body) ? parsed.body : void 0;
	const elementArrays = [];
	for (const candidate of [parsed.elements, body?.elements]) if (Array.isArray(candidate)) elementArrays.push(candidate);
	for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
		if (!isRecord(candidate)) continue;
		for (const localeElements of Object.values(candidate)) if (Array.isArray(localeElements)) elementArrays.push(localeElements);
	}
	return elementArrays;
}
function parseInteractivePostFallback(parsed) {
	const textContent = parsePostContent(JSON.stringify(parsed)).textContent.trim();
	return textContent && textContent !== POST_FALLBACK_TEXT ? textContent : void 0;
}
function parseInteractiveCardContent(parsed) {
	if (!isRecord(parsed)) return INTERACTIVE_CARD_FALLBACK_TEXT;
	const variables = readCardTemplateVariables(parsed);
	for (const elements of readInteractiveElementArrays(parsed)) {
		const text = extractInteractiveElementsText(elements, variables);
		if (text) return text;
	}
	return parseInteractivePostFallback(parsed) ?? INTERACTIVE_CARD_FALLBACK_TEXT;
}
function parseFeishuMessageContent(rawContent, msgType) {
	if (!rawContent) return "";
	let parsed;
	try {
		parsed = JSON.parse(rawContent);
	} catch {
		return rawContent;
	}
	if (msgType === "text") {
		const text = parsed?.text;
		return typeof text === "string" ? text : "[Text message]";
	}
	if (msgType === "post") return parsePostContent(rawContent).textContent;
	if (msgType === "interactive") return parseInteractiveCardContent(parsed);
	if (typeof parsed === "string") return parsed;
	const genericText = parsed?.text;
	if (typeof genericText === "string" && genericText.trim()) return genericText;
	const genericTitle = parsed?.title;
	if (typeof genericTitle === "string" && genericTitle.trim()) return genericTitle;
	return `[${msgType || "unknown"} message]`;
}
function parseFeishuMessageItem(item, fallbackMessageId) {
	const msgType = item.msg_type ?? "text";
	const rawContent = item.body?.content ?? "";
	return {
		messageId: item.message_id ?? fallbackMessageId ?? "",
		chatId: item.chat_id ?? "",
		chatType: item.chat_type === "group" || item.chat_type === "topic_group" || item.chat_type === "private" || item.chat_type === "p2p" ? item.chat_type : void 0,
		senderId: item.sender?.id,
		senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : void 0,
		senderType: item.sender?.sender_type,
		content: parseFeishuMessageContent(rawContent, msgType),
		contentType: msgType,
		createTime: item.create_time ? Number.parseInt(item.create_time, 10) : void 0,
		threadId: item.thread_id || void 0
	};
}
/**
* Get a message by its ID.
* Useful for fetching quoted/replied message content.
*/
async function getMessageFeishu(params) {
	const { cfg, messageId, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const client = createFeishuClient(account);
	try {
		const response = await client.im.message.get({ path: { message_id: messageId } });
		if (response.code !== 0) return null;
		const rawItem = response.data?.items?.[0] ?? response.data;
		const item = rawItem && (rawItem.body !== void 0 || rawItem.message_id !== void 0) ? rawItem : null;
		if (!item) return null;
		return parseFeishuMessageItem(item, messageId);
	} catch {
		return null;
	}
}
/**
* List messages in a Feishu thread (topic).
* Uses container_id_type=thread to directly query thread messages,
* which includes both the root message and all replies (including bot replies).
*/
async function listFeishuThreadMessages(params) {
	const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const response = await createFeishuClient(account).im.message.list({ params: {
		container_id_type: "thread",
		container_id: threadId,
		sort_type: "ByCreateTimeDesc",
		page_size: Math.min(limit + 1, 50)
	} });
	if (response.code !== 0) throw new Error(`Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`);
	const items = response.data?.items ?? [];
	const results = [];
	for (const item of items) {
		if (currentMessageId && item.message_id === currentMessageId) continue;
		if (rootMessageId && item.message_id === rootMessageId) continue;
		const parsed = parseFeishuMessageItem(item);
		results.push({
			messageId: parsed.messageId,
			senderId: parsed.senderId,
			senderType: parsed.senderType,
			content: parsed.content,
			contentType: parsed.contentType,
			createTime: parsed.createTime
		});
		if (results.length >= limit) break;
	}
	results.reverse();
	return results;
}
function buildFeishuPostMessagePayload(params) {
	const { messageText } = params;
	return {
		content: JSON.stringify({ zh_cn: { content: [[{
			tag: "md",
			text: messageText
		}]] } }),
		msgType: "post"
	};
}
async function sendMessageFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	});
	let rawText = text ?? "";
	if (mentions && mentions.length > 0) rawText = buildMentionedMessage(mentions, rawText);
	const { content, msgType } = buildFeishuPostMessagePayload({ messageText: convertMarkdownTables(rawText, tableMode) });
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		content,
		msgType,
		directParams: {
			receiveId,
			receiveIdType,
			content,
			msgType
		},
		directErrorPrefix: "Feishu send failed",
		replyErrorPrefix: "Feishu reply failed"
	});
}
async function sendCardFeishu(params) {
	const { cfg, to, card, replyToMessageId, replyInThread, allowTopLevelReplyFallback, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify(card);
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		content,
		msgType: "interactive",
		directParams: {
			receiveId,
			receiveIdType,
			content,
			msgType: "interactive"
		},
		directErrorPrefix: "Feishu card send failed",
		replyErrorPrefix: "Feishu card reply failed"
	});
}
async function editMessageFeishu(params) {
	const { cfg, messageId, text, card, accountId } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	if ((typeof text === "string" && text.trim().length > 0) === Boolean(card)) throw new Error("Feishu edit requires exactly one of text or card.");
	const client = createFeishuClient(account);
	if (card) {
		const content = JSON.stringify(card);
		const response = await client.im.message.patch({
			path: { message_id: messageId },
			data: { content }
		});
		if (response.code !== 0) throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
		return {
			messageId,
			contentType: "interactive"
		};
	}
	const payload = buildFeishuPostMessagePayload({ messageText: convertMarkdownTables(text, resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	})) });
	const response = await client.im.message.patch({
		path: { message_id: messageId },
		data: { content: payload.content }
	});
	if (response.code !== 0) throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
	return {
		messageId,
		contentType: "post"
	};
}
/**
* Build a Feishu interactive card with markdown content.
* Cards render markdown properly (code blocks, tables, links, etc.)
* Uses schema 2.0 format for proper markdown rendering.
*/
function buildMarkdownCard(text) {
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		body: { elements: [{
			tag: "markdown",
			content: text
		}] }
	};
}
function resolveFeishuCardTemplate(template) {
	const normalized = normalizeOptionalLowercaseString(template);
	if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) return;
	return normalized;
}
/**
* Build a Feishu interactive card with optional header and note footer.
* When header/note are omitted, behaves identically to buildMarkdownCard.
*/
function buildStructuredCard(text, options) {
	const elements = [{
		tag: "markdown",
		content: text
	}];
	if (options?.note) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "markdown",
			content: `<font color='grey'>${options.note}</font>`
		});
	}
	const card = {
		schema: "2.0",
		config: { width_mode: "fill" },
		body: { elements }
	};
	if (options?.header) card.header = {
		title: {
			tag: "plain_text",
			content: options.header.title
		},
		template: resolveFeishuCardTemplate(options.header.template) ?? "blue"
	};
	return card;
}
/**
* Send a message as a structured card with optional header and note.
*/
async function sendStructuredCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId, header, note } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) cardText = buildMentionedCardContent(mentions, text);
	return sendCardFeishu({
		cfg,
		to,
		card: buildStructuredCard(cardText, {
			header,
			note
		}),
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		accountId
	});
}
/**
* Send a message as a markdown card (interactive message).
* This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
*/
async function sendMarkdownCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, allowTopLevelReplyFallback, mentions, accountId } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) cardText = buildMentionedCardContent(mentions, text);
	return sendCardFeishu({
		cfg,
		to,
		card: buildMarkdownCard(cardText),
		replyToMessageId,
		replyInThread,
		allowTopLevelReplyFallback,
		accountId
	});
}
//#endregion
export { normalizeFeishuExternalKey as _, sendCardFeishu as a, sendStructuredCardFeishu as c, isFeishuBroadcastMention as d, isMentionForwardRequest as f, shouldSuppressFeishuTextForVoiceMedia as g, sendMediaFeishu as h, resolveFeishuCardTemplate as i, parsePostContent as l, saveMessageResourceFeishu as m, getMessageFeishu as n, sendMarkdownCardFeishu as o, isFeishuGroupChatType as p, listFeishuThreadMessages as r, sendMessageFeishu as s, editMessageFeishu as t, extractMentionTargets as u };
