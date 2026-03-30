import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { t as normalizeChatType } from "./chat-type-CEMQNtWX.js";
import { n as resolveConversationLabel } from "./conversation-label-wj_GYn69.js";

//#region src/auto-reply/reply/inbound-text.ts
function normalizeInboundTextNewlines(input) {
	return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

//#endregion
//#region src/auto-reply/reply/inbound-context.ts
var inbound_context_exports = /* @__PURE__ */ __exportAll({ finalizeInboundContext: () => finalizeInboundContext });
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
function normalizeTextField(value) {
	if (typeof value !== "string") return;
	return normalizeInboundTextNewlines(value);
}
function normalizeMediaType(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function countMediaEntries(ctx) {
	const pathCount = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths.length : 0;
	const urlCount = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls.length : 0;
	const single = ctx.MediaPath || ctx.MediaUrl ? 1 : 0;
	return Math.max(pathCount, urlCount, single);
}
function finalizeInboundContext(ctx, opts = {}) {
	const normalized = ctx;
	normalized.Body = normalizeInboundTextNewlines(typeof normalized.Body === "string" ? normalized.Body : "");
	normalized.RawBody = normalizeTextField(normalized.RawBody);
	normalized.CommandBody = normalizeTextField(normalized.CommandBody);
	normalized.Transcript = normalizeTextField(normalized.Transcript);
	normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
	normalized.ThreadHistoryBody = normalizeTextField(normalized.ThreadHistoryBody);
	if (Array.isArray(normalized.UntrustedContext)) normalized.UntrustedContext = normalized.UntrustedContext.map((entry) => normalizeInboundTextNewlines(entry)).filter((entry) => Boolean(entry));
	const chatType = normalizeChatType(normalized.ChatType);
	if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) normalized.ChatType = chatType;
	normalized.BodyForAgent = normalizeInboundTextNewlines(opts.forceBodyForAgent ? normalized.Body : normalized.BodyForAgent ?? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body);
	normalized.BodyForCommands = normalizeInboundTextNewlines(opts.forceBodyForCommands ? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body : normalized.BodyForCommands ?? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body);
	const explicitLabel = normalized.ConversationLabel?.trim();
	if (opts.forceConversationLabel || !explicitLabel) {
		const resolved = resolveConversationLabel(normalized)?.trim();
		if (resolved) normalized.ConversationLabel = resolved;
	} else normalized.ConversationLabel = explicitLabel;
	normalized.CommandAuthorized = normalized.CommandAuthorized === true;
	const mediaCount = countMediaEntries(normalized);
	if (mediaCount > 0) {
		const mediaType = normalizeMediaType(normalized.MediaType);
		const normalizedMediaTypes = (Array.isArray(normalized.MediaTypes) ? normalized.MediaTypes : void 0)?.map((entry) => normalizeMediaType(entry));
		let mediaTypesFinal;
		if (normalizedMediaTypes && normalizedMediaTypes.length > 0) {
			const filled = normalizedMediaTypes.slice();
			while (filled.length < mediaCount) filled.push(void 0);
			mediaTypesFinal = filled.map((entry) => entry ?? DEFAULT_MEDIA_TYPE);
		} else if (mediaType) {
			mediaTypesFinal = [mediaType];
			while (mediaTypesFinal.length < mediaCount) mediaTypesFinal.push(DEFAULT_MEDIA_TYPE);
		} else mediaTypesFinal = Array.from({ length: mediaCount }, () => DEFAULT_MEDIA_TYPE);
		normalized.MediaTypes = mediaTypesFinal;
		normalized.MediaType = mediaType ?? mediaTypesFinal[0] ?? DEFAULT_MEDIA_TYPE;
	}
	return normalized;
}

//#endregion
export { inbound_context_exports as n, normalizeInboundTextNewlines as r, finalizeInboundContext as t };