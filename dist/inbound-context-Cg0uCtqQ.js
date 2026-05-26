import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { t as resolveConversationLabel } from "./conversation-label-CQhOGKqx.js";
import { s as resolveCommandTurnContext } from "./command-turn-context-BiMylvBj.js";
import { n as sanitizeInboundSystemTags, t as normalizeInboundTextNewlines } from "./inbound-text-C0MN-1wo.js";
//#region src/auto-reply/reply/inbound-context.ts
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
function normalizeTextField(value) {
	if (typeof value !== "string") return;
	return sanitizeInboundSystemTags(normalizeInboundTextNewlines(value));
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
	normalized.Body = sanitizeInboundSystemTags(normalizeInboundTextNewlines(typeof normalized.Body === "string" ? normalized.Body : ""));
	normalized.RawBody = normalizeTextField(normalized.RawBody);
	normalized.CommandBody = normalizeTextField(normalized.CommandBody);
	normalized.Transcript = normalizeTextField(normalized.Transcript);
	normalized.ThreadStarterBody = normalizeTextField(normalized.ThreadStarterBody);
	normalized.ThreadHistoryBody = normalizeTextField(normalized.ThreadHistoryBody);
	if (Array.isArray(normalized.UntrustedContext)) normalized.UntrustedContext = normalized.UntrustedContext.map((entry) => sanitizeInboundSystemTags(normalizeInboundTextNewlines(entry))).filter((entry) => Boolean(entry));
	const chatType = normalizeChatType(normalized.ChatType);
	if (chatType && (opts.forceChatType || normalized.ChatType !== chatType)) normalized.ChatType = chatType;
	normalized.BodyForAgent = sanitizeInboundSystemTags(normalizeInboundTextNewlines(opts.forceBodyForAgent ? normalized.Body : normalized.BodyForAgent ?? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body));
	normalized.BodyForCommands = sanitizeInboundSystemTags(normalizeInboundTextNewlines(opts.forceBodyForCommands ? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body : normalized.BodyForCommands ?? normalized.CommandBody ?? normalized.RawBody ?? normalized.Body));
	const explicitLabel = normalizeOptionalString(normalized.ConversationLabel);
	if (opts.forceConversationLabel || !explicitLabel) {
		const resolved = normalizeOptionalString(resolveConversationLabel(normalized));
		if (resolved) normalized.ConversationLabel = resolved;
	} else normalized.ConversationLabel = explicitLabel;
	normalized.CommandAuthorized = normalized.CommandAuthorized === true;
	normalized.CommandTurn = resolveCommandTurnContext(normalized);
	if (normalized.CommandTurn.source === "native" || normalized.CommandTurn.source === "text") {
		normalized.CommandSource = normalized.CommandTurn.source;
		normalized.CommandAuthorized = normalized.CommandTurn.authorized;
	} else normalized.CommandSource = void 0;
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
export { finalizeInboundContext as t };
