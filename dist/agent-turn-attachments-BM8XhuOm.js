import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { l as mimeTypeFromFilePath } from "./mime-DppuT-pZ.js";
function isRemotePath(value) {
	if (/^[a-z]:[\\/]/i.test(value)) return false;
	try {
		return new URL(value).protocol !== "file:";
	} catch {
		return false;
	}
}
function resolveHistoryImageContentType(media) {
	const contentType = normalizeOptionalString(media.contentType);
	if (contentType?.startsWith("image/")) return contentType;
	return mimeTypeFromFilePath(normalizeOptionalString(media.path));
}
function isHistoryImageMedia(media) {
	if (media.kind === "image") return true;
	return Boolean(resolveHistoryImageContentType(media)?.startsWith("image/"));
}
function resolveTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveHistoryEntries(ctx) {
	return Array.isArray(ctx.InboundHistory) ? ctx.InboundHistory : [];
}
function resolveRecentInboundHistoryImages(params) {
	const nowMs = params.nowMs ?? resolveTimestamp(params.ctx.Timestamp) ?? Date.now();
	const ttlMs = params.ttlMs ?? 18e5;
	const limit = Math.max(0, params.limit ?? 4);
	if (limit === 0) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const entries = resolveHistoryEntries(params.ctx);
	for (let index = entries.length - 1; index >= 0 && out.length < limit; index -= 1) {
		const entry = entries[index];
		const timestamp = resolveTimestamp(entry?.timestamp);
		if (timestamp === void 0 || Math.abs(nowMs - timestamp) > ttlMs) continue;
		const mediaEntries = Array.isArray(entry.media) ? entry.media : [];
		for (let mediaIndex = mediaEntries.length - 1; mediaIndex >= 0 && out.length < limit; mediaIndex -= 1) {
			const media = mediaEntries[mediaIndex];
			if (!media || !isHistoryImageMedia(media)) continue;
			const mediaPath = normalizeOptionalString(media.path);
			if (!mediaPath || isRemotePath(mediaPath)) continue;
			const contentType = resolveHistoryImageContentType(media);
			if (!contentType?.startsWith("image/")) continue;
			const messageId = normalizeOptionalString(media.messageId) ?? entry.messageId;
			const key = [messageId ?? "", mediaPath].join("\0");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				path: mediaPath,
				contentType,
				sender: entry.sender,
				...messageId ? { messageId } : {}
			});
		}
	}
	return out.toReversed();
}
function appendRecentHistoryImageContext(params) {
	if (params.images.length === 0) return params.promptText;
	const notes = params.images.map((image, index) => {
		const message = image.messageId ? `, message ${image.messageId}` : "";
		return `[Recent image ${index + 1} from ${image.sender}${message}, attached as media.]`;
	});
	return [params.promptText, notes.join("\n")].filter((part) => part.trim().length > 0).join("\n\n");
}
//#endregion
//#region src/auto-reply/reply/inbound-media.ts
function hasNormalizedStringEntry(values) {
	return Array.isArray(values) && values.some((value) => normalizeOptionalString(value));
}
function hasInboundMedia(ctx) {
	return Boolean(ctx.StickerMediaIncluded || ctx.Sticker || normalizeOptionalString(ctx.MediaPath) || normalizeOptionalString(ctx.MediaUrl) || hasNormalizedStringEntry(ctx.MediaPaths) || hasNormalizedStringEntry(ctx.MediaUrls) || Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length > 0);
}
//#endregion
//#region src/auto-reply/reply/agent-turn-attachments.ts
const agentTurnMediaRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-media.runtime.js"));
function loadAgentTurnMediaRuntime() {
	return agentTurnMediaRuntimeLoader.load();
}
const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1e3;
function isImageAgentTurnAttachment(attachment) {
	return attachment.mime?.startsWith("image/") === true;
}
function hasInboundHistoryMedia(ctx) {
	return Array.isArray(ctx.InboundHistory) && ctx.InboundHistory.some((entry) => Array.isArray(entry.media) && entry.media.length > 0);
}
async function resolveAgentTurnAttachments(params) {
	const includeRecentHistoryImages = params.includeRecentHistoryImages ?? true;
	if (!hasInboundMedia(params.ctx) && !(includeRecentHistoryImages && hasInboundHistoryMedia(params.ctx))) return {
		attachments: [],
		recentHistoryImages: []
	};
	const runtime = params.runtime ?? await loadAgentTurnMediaRuntime();
	const currentAttachments = runtime.normalizeAttachments(params.ctx).map((attachment) => normalizeOptionalString(attachment.path) ? Object.assign({}, attachment, { url: void 0 }) : attachment);
	const recentHistoryImages = includeRecentHistoryImages ? resolveRecentInboundHistoryImages({ ctx: params.ctx }) : [];
	const firstHistoryAttachmentIndex = currentAttachments.reduce((maxIndex, attachment) => Number.isFinite(attachment.index) ? Math.max(maxIndex, attachment.index) : maxIndex, -1) + 1;
	const historyAttachments = recentHistoryImages.map((image, index) => ({
		path: image.path,
		mime: image.contentType,
		index: firstHistoryAttachmentIndex + index
	}));
	const historyAttachmentByIndex = new Map(historyAttachments.map((attachment, index) => [attachment.index, recentHistoryImages[index]]));
	const mediaAttachments = [...currentAttachments, ...historyAttachments];
	const cache = new runtime.MediaAttachmentCache(mediaAttachments, { localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
		cfg: params.cfg,
		ctx: params.ctx
	}) });
	const results = [];
	const resolvedHistoryImages = [];
	const resolveImageAttachment = async (attachment) => {
		const mediaType = attachment.mime ?? "application/octet-stream";
		if (!isImageAgentTurnAttachment(attachment)) return false;
		if (!normalizeOptionalString(attachment.path)) return false;
		try {
			const { buffer } = await cache.getBuffer({
				attachmentIndex: attachment.index,
				maxBytes: AGENT_TURN_ATTACHMENT_MAX_BYTES,
				timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS
			});
			results.push({
				mediaType,
				data: buffer.toString("base64")
			});
			const historyImage = historyAttachmentByIndex.get(attachment.index);
			if (historyImage) resolvedHistoryImages.push(historyImage);
			return true;
		} catch (error) {
			if (runtime.isMediaUnderstandingSkipError(error)) logVerbose(`agent-turn-attachments: skipping attachment #${attachment.index + 1} (${error.reason})`);
			else {
				const errorName = error instanceof Error ? error.name : typeof error;
				logVerbose(`agent-turn-attachments: failed to read attachment #${attachment.index + 1} (${errorName})`);
			}
			return false;
		}
	};
	let currentImageResolved = false;
	const hasCurrentMedia = currentAttachments.length > 0;
	const hasCurrentImageCandidate = currentAttachments.some(isImageAgentTurnAttachment);
	for (const attachment of currentAttachments) currentImageResolved = await resolveImageAttachment(attachment) || currentImageResolved;
	if (includeRecentHistoryImages && !currentImageResolved && (!hasCurrentMedia || hasCurrentImageCandidate)) for (const attachment of historyAttachments) await resolveImageAttachment(attachment);
	return {
		attachments: results,
		recentHistoryImages: resolvedHistoryImages
	};
}
function resolveInlineAgentImageAttachments(images) {
	if (!Array.isArray(images)) return [];
	return images.map((image) => ({
		mediaType: image.mimeType,
		data: image.data
	})).filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}
//#endregion
export { appendRecentHistoryImageContext as a, hasInboundMedia as i, resolveAgentTurnAttachments as n, resolveInlineAgentImageAttachments as r, loadAgentTurnMediaRuntime as t };
