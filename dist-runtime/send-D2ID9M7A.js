import { bs as withTempDownloadPath, po as createFeishuClient, yo as resolveFeishuAccount } from "./auth-profiles-CuJtivJK.js";
import { d as mediaKindFromMime } from "./mime-33LCeGh-.js";
import { a as resolveReceiveIdType, i as normalizeFeishuTarget, t as getFeishuRuntime } from "./runtime-DJop-aJ1.js";
import fs from "fs";
import path from "path";
//#region extensions/feishu/src/external-keys.ts
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_EXTERNAL_KEY_LENGTH = 512;
function normalizeFeishuExternalKey(value) {
	if (typeof value !== "string") {return;}
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) {return;}
	if (CONTROL_CHARS_RE.test(normalized)) {return;}
	if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {return;}
	return normalized;
}
//#endregion
//#region extensions/feishu/src/send-result.ts
function assertFeishuMessageApiSuccess(response, errorPrefix) {
	if (response.code !== 0) {throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);}
}
function toFeishuSendResult(response, chatId) {
	return {
		messageId: response.data?.message_id ?? "unknown",
		chatId
	};
}
//#endregion
//#region extensions/feishu/src/send-target.ts
function resolveFeishuSendTarget(params) {
	const target = params.to.trim();
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const client = createFeishuClient(account);
	const receiveId = normalizeFeishuTarget(target);
	if (!receiveId) {throw new Error(`Invalid Feishu target: ${params.to}`);}
	return {
		client,
		receiveId,
		receiveIdType: resolveReceiveIdType(target.replace(/^(feishu|lark):/i, ""))
	};
}
//#endregion
//#region extensions/feishu/src/media.ts
const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 12e4;
function createConfiguredFeishuMediaClient(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	return {
		account,
		client: createFeishuClient({
			...account,
			httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS
		})
	};
}
function extractFeishuUploadKey(response, params) {
	const responseAny = response;
	if (responseAny.code !== void 0 && responseAny.code !== 0) {throw new Error(`${params.errorPrefix}: ${responseAny.msg || `code ${responseAny.code}`}`);}
	const key = responseAny[params.key] ?? responseAny.data?.[params.key];
	if (!key) {throw new Error(`${params.errorPrefix}: no ${params.key} returned`);}
	return key;
}
function readHeaderValue(headers, name) {
	if (!headers) {return;}
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== target) {continue;}
		if (typeof value === "string" && value.trim()) {return value.trim();}
		if (Array.isArray(value)) {
			const first = value.find((entry) => typeof entry === "string" && entry.trim());
			if (typeof first === "string") {return first.trim();}
		}
	}
}
function decodeDispositionFileName(value) {
	const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) {try {
		return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
	} catch {
		return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
	}}
	return value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
}
function extractFeishuDownloadMetadata(response) {
	const responseAny = response;
	const headers = responseAny.headers ?? responseAny.header;
	const contentType = readHeaderValue(headers, "content-type") ?? (typeof responseAny.contentType === "string" ? responseAny.contentType : void 0) ?? (typeof responseAny.mime_type === "string" ? responseAny.mime_type : void 0) ?? (typeof responseAny.data?.contentType === "string" ? responseAny.data.contentType : void 0) ?? (typeof responseAny.data?.mime_type === "string" ? responseAny.data.mime_type : void 0);
	const disposition = readHeaderValue(headers, "content-disposition");
	return {
		contentType,
		fileName: (disposition ? decodeDispositionFileName(disposition) : void 0) ?? (typeof responseAny.file_name === "string" ? responseAny.file_name : void 0) ?? (typeof responseAny.fileName === "string" ? responseAny.fileName : void 0) ?? (typeof responseAny.data?.file_name === "string" ? responseAny.data.file_name : void 0) ?? (typeof responseAny.data?.fileName === "string" ? responseAny.data.fileName : void 0)
	};
}
async function readFeishuResponseBuffer(params) {
	const { response } = params;
	const responseAny = response;
	if (responseAny.code !== void 0 && responseAny.code !== 0) {throw new Error(`${params.errorPrefix}: ${responseAny.msg || `code ${responseAny.code}`}`);}
	if (Buffer.isBuffer(response)) {return response;}
	if (response instanceof ArrayBuffer) {return Buffer.from(response);}
	if (responseAny.data && Buffer.isBuffer(responseAny.data)) {return responseAny.data;}
	if (responseAny.data instanceof ArrayBuffer) {return Buffer.from(responseAny.data);}
	if (typeof responseAny.getReadableStream === "function") {
		const stream = responseAny.getReadableStream();
		const chunks = [];
		for await (const chunk of stream) {chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));}
		return Buffer.concat(chunks);
	}
	if (typeof responseAny.writeFile === "function") {return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
		await responseAny.writeFile(tmpPath);
		return await fs.promises.readFile(tmpPath);
	});}
	if (typeof responseAny[Symbol.asyncIterator] === "function") {
		const chunks = [];
		for await (const chunk of responseAny) {chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));}
		return Buffer.concat(chunks);
	}
	if (typeof responseAny.read === "function") {
		const chunks = [];
		for await (const chunk of responseAny) {chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));}
		return Buffer.concat(chunks);
	}
	const types = Object.keys(responseAny).map((k) => `${k}: ${typeof responseAny[k]}`).join(", ");
	throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${types}]`);
}
/**
* Download a message resource (file/image/audio/video) from Feishu.
* Used for downloading files, audio, and video from messages.
*/
async function downloadMessageResourceFeishu(params) {
	const { cfg, messageId, fileKey, type, accountId } = params;
	const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
	if (!normalizedFileKey) {throw new Error("Feishu message resource download failed: invalid file_key");}
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	const response = await client.im.messageResource.get({
		path: {
			message_id: messageId,
			file_key: normalizedFileKey
		},
		params: { type }
	});
	return {
		buffer: await readFeishuResponseBuffer({
			response,
			tmpDirPrefix: "openclaw-feishu-resource-",
			errorPrefix: "Feishu message resource download failed"
		}),
		...extractFeishuDownloadMetadata(response)
	};
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
	const imageData = typeof image === "string" ? fs.createReadStream(image) : image;
	return { imageKey: extractFeishuUploadKey(await client.im.image.create({ data: {
		image_type: imageType,
		image: imageData
	} }), {
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
	return fileName.replace(/[\x00-\x1F\x7F\r\n"\\]/g, "_");
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
	const fileData = typeof file === "string" ? fs.createReadStream(file) : file;
	const safeFileName = sanitizeFileNameForUpload(fileName);
	return { fileKey: extractFeishuUploadKey(await client.im.file.create({ data: {
		file_type: fileType,
		file_name: safeFileName,
		file: fileData,
		...duration !== void 0 && { duration }
	} }), {
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
		const response = await client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: "image",
				...replyInThread ? { reply_in_thread: true } : {}
			}
		});
		assertFeishuMessageApiSuccess(response, "Feishu image reply failed");
		return toFeishuSendResult(response, receiveId);
	}
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: "image"
		}
	});
	assertFeishuMessageApiSuccess(response, "Feishu image send failed");
	return toFeishuSendResult(response, receiveId);
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
		const response = await client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: msgType,
				...replyInThread ? { reply_in_thread: true } : {}
			}
		});
		assertFeishuMessageApiSuccess(response, "Feishu file reply failed");
		return toFeishuSendResult(response, receiveId);
	}
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: msgType
		}
	});
	assertFeishuMessageApiSuccess(response, "Feishu file send failed");
	return toFeishuSendResult(response, receiveId);
}
/**
* Helper to detect file type from extension
*/
function detectFileType(fileName) {
	switch (path.extname(fileName).toLowerCase()) {
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
	const ext = path.extname(fileName).toLowerCase();
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
	].includes(ext) || mimeKind === "image") {return { msgType: "image" };}
	if (ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus") {return {
		fileType: "opus",
		msgType: "audio"
	};}
	if ([
		".mp4",
		".mov",
		".avi"
	].includes(ext) || contentType === "video/mp4" || contentType === "video/quicktime" || contentType === "video/x-msvideo") {return {
		fileType: "mp4",
		msgType: "media"
	};}
	const fileType = detectFileType(fileName);
	return {
		fileType,
		msgType: fileType === "stream" ? "file" : fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file"
	};
}
/**
* Upload and send media (image or file) from URL, local path, or buffer.
* When mediaUrl is a local path, mediaLocalRoots (from core outbound context)
* must be passed so loadWebMedia allows the path (post CVE-2026-26321).
*/
async function sendMediaFeishu(params) {
	const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, replyInThread, accountId, mediaLocalRoots } = params;
	const account = resolveFeishuAccount({
		cfg,
		accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
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
	} else {throw new Error("Either mediaUrl or mediaBuffer must be provided");}
	const routing = resolveFeishuOutboundMediaKind({
		fileName: name,
		contentType
	});
	if (routing.msgType === "image") {
		const { imageKey } = await uploadImageFeishu({
			cfg,
			image: buffer,
			accountId
		});
		return sendImageFeishu({
			cfg,
			to,
			imageKey,
			replyToMessageId,
			replyInThread,
			accountId
		});
	} else {
		const { fileKey } = await uploadFileFeishu({
			cfg,
			file: buffer,
			fileName: name,
			fileType: routing.fileType ?? "stream",
			accountId
		});
		return sendFileFeishu({
			cfg,
			to,
			fileKey,
			msgType: routing.msgType,
			replyToMessageId,
			replyInThread,
			accountId
		});
	}
}
//#endregion
//#region extensions/feishu/src/mention.ts
/**
* Escape regex metacharacters so user-controlled mention fields are treated literally.
*/
function escapeRegExp(input) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Extract mention targets from message event (excluding the bot itself)
*/
function extractMentionTargets(event, botOpenId) {
	return (event.message.mentions ?? []).filter((m) => {
		if (botOpenId && m.id.open_id === botOpenId) {return false;}
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
	if (mentions.length === 0) {return false;}
	const isDirectMessage = event.message.chat_type !== "group";
	const hasOtherMention = mentions.some((m) => m.id.open_id !== botOpenId);
	if (isDirectMessage) {return hasOtherMention;}
	else {return mentions.some((m) => m.id.open_id === botOpenId) && hasOtherMention;}
}
/**
* Extract message body from text (remove @ placeholders)
*/
function extractMessageBody(text, allMentionKeys) {
	let result = text;
	for (const key of allMentionKeys) {result = result.replace(new RegExp(escapeRegExp(key), "g"), "");}
	return result.replace(/\s+/g, " ").trim();
}
/**
* Format @mention for text message
*/
function formatMentionForText(target) {
	return `<at user_id="${target.openId}">${target.name}</at>`;
}
/**
* Format @everyone for text message
*/
function formatMentionAllForText() {
	return `<at user_id="all">Everyone</at>`;
}
/**
* Format @mention for card message (lark_md)
*/
function formatMentionForCard(target) {
	return `<at id=${target.openId}></at>`;
}
/**
* Format @everyone for card message
*/
function formatMentionAllForCard() {
	return `<at id=all></at>`;
}
/**
* Build complete message with @mentions (text format)
*/
function buildMentionedMessage(targets, message) {
	if (targets.length === 0) {return message;}
	return `${targets.map((t) => formatMentionForText(t)).join(" ")} ${message}`;
}
/**
* Build card content with @mentions (Markdown format)
*/
function buildMentionedCardContent(targets, message) {
	if (targets.length === 0) {return message;}
	return `${targets.map((t) => formatMentionForCard(t)).join(" ")} ${message}`;
}
//#endregion
//#region extensions/feishu/src/post.ts
const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+\-!|>~])/g;
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
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
	if (!style) {return false;}
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
	const style = isRecord(element.style) ? element.style : void 0;
	if (isStyleEnabled(style, "code")) {return wrapInlineCode(text);}
	let rendered = escapeMarkdownText(text);
	if (!rendered) {return "";}
	if (isStyleEnabled(style, "bold")) {rendered = `**${rendered}**`;}
	if (isStyleEnabled(style, "italic")) {rendered = `*${rendered}*`;}
	if (isStyleEnabled(style, "underline")) {rendered = `<u>${rendered}</u>`;}
	if (isStyleEnabled(style, "strikethrough") || isStyleEnabled(style, "line_through") || isStyleEnabled(style, "lineThrough")) {rendered = `~~${rendered}~~`;}
	return rendered;
}
function renderLinkElement(element) {
	const href = toStringOrEmpty(element.href).trim();
	const text = toStringOrEmpty(element.text) || href;
	if (!text) {return "";}
	if (!href) {return escapeMarkdownText(text);}
	return `[${escapeMarkdownText(text)}](${href})`;
}
function renderMentionElement(element) {
	const mention = toStringOrEmpty(element.user_name) || toStringOrEmpty(element.user_id) || toStringOrEmpty(element.open_id);
	if (!mention) {return "";}
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
	if (!isRecord(element)) {return escapeMarkdownText(toStringOrEmpty(element));}
	switch (toStringOrEmpty(element.tag).toLowerCase()) {
		case "text": return renderTextElement(element);
		case "a": return renderLinkElement(element);
		case "at":
			{
				const normalizedMention = normalizeFeishuExternalKey(toStringOrEmpty(element.open_id) || toStringOrEmpty(element.user_id));
				if (normalizedMention) {mentionedOpenIds.push(normalizedMention);}
			}
			return renderMentionElement(element);
		case "img": {
			const imageKey = normalizeFeishuExternalKey(toStringOrEmpty(element.image_key));
			if (imageKey) {imageKeys.push(imageKey);}
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
	if (!isRecord(candidate) || !Array.isArray(candidate.content)) {return null;}
	return {
		title: toStringOrEmpty(candidate.title),
		content: candidate.content
	};
}
function resolveLocalePayload(candidate) {
	const direct = toPostPayload(candidate);
	if (direct) {return direct;}
	if (!isRecord(candidate)) {return null;}
	for (const value of Object.values(candidate)) {
		const localePayload = toPostPayload(value);
		if (localePayload) {return localePayload;}
	}
	return null;
}
function resolvePostPayload(parsed) {
	const direct = toPostPayload(parsed);
	if (direct) {return direct;}
	if (!isRecord(parsed)) {return null;}
	const wrappedPost = resolveLocalePayload(parsed.post);
	if (wrappedPost) {return wrappedPost;}
	return resolveLocalePayload(parsed);
}
function parsePostContent(content) {
	try {
		const payload = resolvePostPayload(JSON.parse(content));
		if (!payload) {return {
			textContent: FALLBACK_POST_TEXT,
			imageKeys: [],
			mediaKeys: [],
			mentionedOpenIds: []
		};}
		const imageKeys = [];
		const mediaKeys = [];
		const mentionedOpenIds = [];
		const paragraphs = [];
		for (const paragraph of payload.content) {
			if (!Array.isArray(paragraph)) {continue;}
			let renderedParagraph = "";
			for (const element of paragraph) {renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);}
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
	if (response.code !== void 0 && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {return true;}
	const msg = response.msg?.toLowerCase() ?? "";
	return msg.includes("withdrawn") || msg.includes("not found");
}
/** Check whether a thrown error indicates a withdrawn/not-found reply target. */
function isWithdrawnReplyError(err) {
	if (typeof err !== "object" || err === null) {return false;}
	const code = err.code;
	if (typeof code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {return true;}
	const response = err.response;
	if (typeof response?.data?.code === "number" && WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)) {return true;}
	return false;
}
/** Send a direct message as a fallback when a reply target is unavailable. */
async function sendFallbackDirect(client, params, errorPrefix) {
	const response = await client.im.message.create({
		params: { receive_id_type: params.receiveIdType },
		data: {
			receive_id: params.receiveId,
			content: params.content,
			msg_type: params.msgType
		}
	});
	assertFeishuMessageApiSuccess(response, errorPrefix);
	return toFeishuSendResult(response, params.receiveId);
}
async function sendReplyOrFallbackDirect(client, params) {
	if (!params.replyToMessageId) {return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);}
	const threadReplyFallbackError = params.replyInThread ? /* @__PURE__ */ new Error("Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.") : null;
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
		if (!isWithdrawnReplyError(err)) {throw err;}
		if (threadReplyFallbackError) {throw threadReplyFallbackError;}
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	if (shouldFallbackFromReplyTarget(response)) {
		if (threadReplyFallbackError) {throw threadReplyFallbackError;}
		return sendFallbackDirect(client, params.directParams, params.directErrorPrefix);
	}
	assertFeishuMessageApiSuccess(response, params.replyErrorPrefix);
	return toFeishuSendResult(response, params.directParams.receiveId);
}
function parseInteractiveCardContent(parsed) {
	if (!parsed || typeof parsed !== "object") {return "[Interactive Card]";}
	const candidate = parsed;
	const elements = Array.isArray(candidate.elements) ? candidate.elements : Array.isArray(candidate.body?.elements) ? candidate.body.elements : null;
	if (!elements) {return "[Interactive Card]";}
	const texts = [];
	for (const element of elements) {
		if (!element || typeof element !== "object") {continue;}
		const item = element;
		if (item.tag === "div" && typeof item.text?.content === "string") {
			texts.push(item.text.content);
			continue;
		}
		if (item.tag === "markdown" && typeof item.content === "string") {texts.push(item.content);}
	}
	return texts.join("\n").trim() || "[Interactive Card]";
}
function parseFeishuMessageContent(rawContent, msgType) {
	if (!rawContent) {return "";}
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
	if (msgType === "post") {return parsePostContent(rawContent).textContent;}
	if (msgType === "interactive") {return parseInteractiveCardContent(parsed);}
	if (typeof parsed === "string") {return parsed;}
	const genericText = parsed?.text;
	if (typeof genericText === "string" && genericText.trim()) {return genericText;}
	const genericTitle = parsed?.title;
	if (typeof genericTitle === "string" && genericTitle.trim()) {return genericTitle;}
	return `[${msgType || "unknown"} message]`;
}
function parseFeishuMessageItem(item, fallbackMessageId) {
	const msgType = item.msg_type ?? "text";
	const rawContent = item.body?.content ?? "";
	return {
		messageId: item.message_id ?? fallbackMessageId ?? "",
		chatId: item.chat_id ?? "",
		chatType: item.chat_type === "group" || item.chat_type === "private" || item.chat_type === "p2p" ? item.chat_type : void 0,
		senderId: item.sender?.id,
		senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : void 0,
		senderType: item.sender?.sender_type,
		content: parseFeishuMessageContent(rawContent, msgType),
		contentType: msgType,
		createTime: item.create_time ? parseInt(String(item.create_time), 10) : void 0,
		threadId: item.thread_id || void 0
	};
}
/**
* Get a message by its ID.
* Useful for fetching quoted/replied message content.
*/
async function getMessageFeishu(params) {
	const { cfg, messageId, accountId } = params;
	const account = resolveFeishuAccount({
		cfg,
		accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const client = createFeishuClient(account);
	try {
		const response = await client.im.message.get({ path: { message_id: messageId } });
		if (response.code !== 0) {return null;}
		const rawItem = response.data?.items?.[0] ?? response.data;
		const item = rawItem && (rawItem.body !== void 0 || rawItem.message_id !== void 0) ? rawItem : null;
		if (!item) {return null;}
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
	const account = resolveFeishuAccount({
		cfg,
		accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const response = await createFeishuClient(account).im.message.list({ params: {
		container_id_type: "thread",
		container_id: threadId,
		sort_type: "ByCreateTimeDesc",
		page_size: Math.min(limit + 1, 50)
	} });
	if (response.code !== 0) {throw new Error(`Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`);}
	const items = response.data?.items ?? [];
	const results = [];
	for (const item of items) {
		if (currentMessageId && item.message_id === currentMessageId) {continue;}
		if (rootMessageId && item.message_id === rootMessageId) {continue;}
		const parsed = parseFeishuMessageItem(item);
		results.push({
			messageId: parsed.messageId,
			senderId: parsed.senderId,
			senderType: parsed.senderType,
			content: parsed.content,
			contentType: parsed.contentType,
			createTime: parsed.createTime
		});
		if (results.length >= limit) {break;}
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
	const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	});
	let rawText = text ?? "";
	if (mentions && mentions.length > 0) {rawText = buildMentionedMessage(mentions, rawText);}
	const { content, msgType } = buildFeishuPostMessagePayload({ messageText: getFeishuRuntime().channel.text.convertMarkdownTables(rawText, tableMode) });
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
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
	const { cfg, to, card, replyToMessageId, replyInThread, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify(card);
	return sendReplyOrFallbackDirect(client, {
		replyToMessageId,
		replyInThread,
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
	const account = resolveFeishuAccount({
		cfg,
		accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	if ((typeof text === "string" && text.trim().length > 0) === Boolean(card)) {throw new Error("Feishu edit requires exactly one of text or card.");}
	const client = createFeishuClient(account);
	if (card) {
		const content = JSON.stringify(card);
		const response = await client.im.message.patch({
			path: { message_id: messageId },
			data: { content }
		});
		if (response.code !== 0) {throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);}
		return {
			messageId,
			contentType: "interactive"
		};
	}
	const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "feishu"
	});
	const payload = buildFeishuPostMessagePayload({ messageText: getFeishuRuntime().channel.text.convertMarkdownTables(text, tableMode) });
	const response = await client.im.message.patch({
		path: { message_id: messageId },
		data: { content: payload.content }
	});
	if (response.code !== 0) {throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);}
	return {
		messageId,
		contentType: "post"
	};
}
async function updateCardFeishu(params) {
	const { cfg, messageId, card, accountId } = params;
	const account = resolveFeishuAccount({
		cfg,
		accountId
	});
	if (!account.configured) {throw new Error(`Feishu account "${account.accountId}" not configured`);}
	const client = createFeishuClient(account);
	const content = JSON.stringify(card);
	const response = await client.im.message.patch({
		path: { message_id: messageId },
		data: { content }
	});
	if (response.code !== 0) {throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);}
}
/**
* Build a Feishu interactive card with markdown content.
* Cards render markdown properly (code blocks, tables, links, etc.)
* Uses schema 2.0 format for proper markdown rendering.
*/
function buildMarkdownCard(text) {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		body: { elements: [{
			tag: "markdown",
			content: text
		}] }
	};
}
function resolveFeishuCardTemplate(template) {
	const normalized = template?.trim().toLowerCase();
	if (!normalized || !FEISHU_CARD_TEMPLATES.has(normalized)) {return;}
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
		config: { wide_screen_mode: true },
		body: { elements }
	};
	if (options?.header) {card.header = {
		title: {
			tag: "plain_text",
			content: options.header.title
		},
		template: resolveFeishuCardTemplate(options.header.template) ?? "blue"
	};}
	return card;
}
/**
* Send a message as a structured card with optional header and note.
*/
async function sendStructuredCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId, header, note } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) {cardText = buildMentionedCardContent(mentions, text);}
	return sendCardFeishu({
		cfg,
		to,
		card: buildStructuredCard(cardText, {
			header,
			note
		}),
		replyToMessageId,
		replyInThread,
		accountId
	});
}
/**
* Send a message as a markdown card (interactive message).
* This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
*/
async function sendMarkdownCardFeishu(params) {
	const { cfg, to, text, replyToMessageId, replyInThread, mentions, accountId } = params;
	let cardText = text;
	if (mentions && mentions.length > 0) {cardText = buildMentionedCardContent(mentions, text);}
	return sendCardFeishu({
		cfg,
		to,
		card: buildMarkdownCard(cardText),
		replyToMessageId,
		replyInThread,
		accountId
	});
}
//#endregion
export { sendMediaFeishu as C, normalizeFeishuExternalKey as E, sendImageFeishu as S, uploadImageFeishu as T, formatMentionForCard as _, sendCardFeishu as a, downloadMessageResourceFeishu as b, sendStructuredCardFeishu as c, buildMentionedCardContent as d, buildMentionedMessage as f, formatMentionAllForText as g, formatMentionAllForCard as h, resolveFeishuCardTemplate as i, updateCardFeishu as l, extractMessageBody as m, getMessageFeishu as n, sendMarkdownCardFeishu as o, extractMentionTargets as p, listFeishuThreadMessages as r, sendMessageFeishu as s, editMessageFeishu as t, parsePostContent as u, formatMentionForText as v, uploadFileFeishu as w, sendFileFeishu as x, isMentionForwardRequest as y };
