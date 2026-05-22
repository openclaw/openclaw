import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { d as sanitizeUserFacingText } from "./sanitize-user-facing-text-DF4us71R.js";
import { a as isSilentReplyText, c as stripLeadingSilentToken, l as stripSilentToken, o as startsWithSilentToken, r as isSilentReplyPayloadText } from "./tokens-dY63daNF.js";
import { u as stripHeartbeatToken } from "./heartbeat-Dwk0vIKl.js";
import { a as hasReplyPayloadContent } from "./payload-CB-WF17a.js";
import { n as resolveResponsePrefixTemplate } from "./response-prefix-template-BWAEmxHI.js";
//#region src/auto-reply/reply/cot-frame.ts
const COT_FRAME_PREFIX_RE = /^\s*\[([^\]\r\n]{1,80})\]/u;
const DEFAULT_INTERNAL_FRAME_PREFIXES = [
	"analysis",
	"chain of thought",
	"cot",
	"internal",
	"private",
	"reasoning",
	"scratchpad",
	"thinking",
	"thought"
];
const COMMON_VISIBLE_LABELS = new Set([
	"assistant",
	"info",
	"system",
	"todo",
	"tool",
	"user"
]);
function normalizeFrameLabel(label) {
	return label.trim().replace(/[\s_-]+/g, " ").toLowerCase();
}
function labelMatchesPrefix(label, prefix) {
	return label === prefix || label.startsWith(`${prefix} `) || label.startsWith(`${prefix}:`) || label.startsWith(`${prefix} -`);
}
function hasCotFramePrefix(text, options = {}) {
	if (!text) return false;
	const match = COT_FRAME_PREFIX_RE.exec(text);
	if (!match) return false;
	const label = normalizeFrameLabel(match[1] ?? "");
	if (!label || COMMON_VISIBLE_LABELS.has(label)) return false;
	if (options.speakerLabels?.some((speakerLabel) => normalizeFrameLabel(speakerLabel) === label)) return true;
	return DEFAULT_INTERNAL_FRAME_PREFIXES.some((prefix) => labelMatchesPrefix(label, prefix));
}
//#endregion
//#region src/auto-reply/reply/normalize-reply.ts
function normalizeReplyPayload(payload, opts = {}) {
	const applyChannelTransforms = opts.applyChannelTransforms ?? true;
	const hasContent = (text) => hasReplyPayloadContent({
		...payload,
		text
	}, { trimText: true });
	const trimmed = normalizeOptionalString(payload.text) ?? "";
	if (!hasContent(trimmed)) {
		opts.onSkip?.("empty");
		return null;
	}
	const silentToken = opts.silentToken ?? "NO_REPLY";
	let text = payload.text ?? void 0;
	if (text && isSilentReplyPayloadText(text, silentToken)) {
		if (!hasContent("")) {
			opts.onSkip?.("silent");
			return null;
		}
		text = "";
	}
	if (text && !isSilentReplyText(text, silentToken)) {
		const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
		if (hasLeadingSilentToken) text = stripLeadingSilentToken(text, silentToken);
		if (hasLeadingSilentToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
			text = stripSilentToken(text, silentToken);
			if (!hasContent(text)) {
				opts.onSkip?.("silent");
				return null;
			}
		}
	}
	if (text && hasCotFramePrefix(text)) {
		if (!hasContent("")) {
			opts.onSkip?.("silent");
			return null;
		}
		text = "";
	}
	if (text && !trimmed) text = "";
	if ((opts.stripHeartbeat ?? true) && text?.includes("HEARTBEAT_OK")) {
		const stripped = stripHeartbeatToken(text, { mode: "message" });
		if (stripped.didStrip) opts.onHeartbeatStrip?.();
		if (stripped.shouldSkip && !hasContent(stripped.text)) {
			opts.onSkip?.("heartbeat");
			return null;
		}
		text = stripped.text;
	}
	if (text) text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
	if (!hasContent(text)) {
		opts.onSkip?.("empty");
		return null;
	}
	let enrichedPayload = {
		...payload,
		text
	};
	if (applyChannelTransforms && opts.transformReplyPayload) {
		enrichedPayload = opts.transformReplyPayload(enrichedPayload) ?? enrichedPayload;
		text = enrichedPayload.text;
	}
	const effectivePrefix = opts.responsePrefixContext ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext) : opts.responsePrefix;
	if (effectivePrefix && text && text.trim() !== "HEARTBEAT_OK" && !text.startsWith(effectivePrefix)) text = `${effectivePrefix} ${text}`;
	enrichedPayload = {
		...enrichedPayload,
		text
	};
	return enrichedPayload;
}
//#endregion
export { hasCotFramePrefix as n, normalizeReplyPayload as t };
