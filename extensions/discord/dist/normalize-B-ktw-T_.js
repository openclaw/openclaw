import { buildMessagingTarget, parseMentionPrefixOrAtUserTarget, requireTargetKind } from "openclaw/plugin-sdk/messaging-targets";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
//#region extensions/discord/src/target-parsing.ts
function parseDiscordTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const userTarget = parseMentionPrefixOrAtUserTarget({
		raw: trimmed,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixes: [
			{
				prefix: "user:",
				kind: "user"
			},
			{
				prefix: "channel:",
				kind: "channel"
			},
			{
				prefix: "discord:",
				kind: "user"
			}
		],
		atUserPattern: /^\d+$/,
		atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)"
	});
	if (userTarget) return userTarget;
	if (/^\d+$/.test(trimmed)) {
		if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
		throw new Error(options.ambiguousMessage ?? `Ambiguous Discord recipient "${trimmed}". For DMs use "user:${trimmed}" or "<@${trimmed}>"; for channels use "channel:${trimmed}".`);
	}
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function resolveDiscordChannelId(raw) {
	return requireTargetKind({
		platform: "Discord",
		target: parseDiscordTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}
//#endregion
//#region extensions/discord/src/chunk.ts
const DEFAULT_MAX_CHARS = 2e3;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CJK_PUNCTUATION_BREAK_AFTER_RE = /[、。，．！？；：）］｝〉》」』】〕〗〙]/u;
function countLines(text) {
	if (!text) return 0;
	return text.split("\n").length;
}
function parseFenceLine(line) {
	const match = line.match(FENCE_RE);
	if (!match) return null;
	const indent = match[1] ?? "";
	const marker = match[2] ?? "";
	return {
		indent,
		markerChar: marker[0] ?? "`",
		markerLen: marker.length,
		openLine: line
	};
}
function closeFenceLine(openFence) {
	return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}
function closeFenceIfNeeded(text, openFence) {
	if (!openFence) return text;
	const closeLine = closeFenceLine(openFence);
	if (!text) return closeLine;
	if (!text.endsWith("\n")) return `${text}\n${closeLine}`;
	return `${text}${closeLine}`;
}
function isHighSurrogate(code) {
	return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
	return code >= 56320 && code <= 57343;
}
function clampToCodePointBoundary(text, index) {
	const boundary = Math.min(Math.max(0, index), text.length);
	if (boundary <= 0 || boundary >= text.length) return boundary;
	const previous = text.charCodeAt(boundary - 1);
	const next = text.charCodeAt(boundary);
	if (isHighSurrogate(previous) && isLowSurrogate(next)) return boundary > 1 ? boundary - 1 : boundary + 1;
	return boundary;
}
function findWhitespaceBreak(window) {
	for (let i = window.length - 1; i >= 0; i--) if (/\s/.test(window[i])) return i;
	return -1;
}
function findCjkPunctuationBreak(window) {
	for (let end = window.length; end > 0;) {
		const start = isLowSurrogate(window.charCodeAt(end - 1)) && end > 1 ? end - 2 : end - 1;
		const char = window.slice(start, end);
		if (start > 0 && CJK_PUNCTUATION_BREAK_AFTER_RE.test(char)) return end;
		end = start;
	}
	return -1;
}
function splitLongLine(line, maxChars, opts) {
	const limit = Math.max(1, Math.floor(maxChars));
	if (line.length <= limit) return [line];
	const out = [];
	let remaining = line;
	while (remaining.length > limit) {
		if (opts.preserveWhitespace) {
			const breakIdx = clampToCodePointBoundary(remaining, limit);
			out.push(remaining.slice(0, breakIdx));
			remaining = remaining.slice(breakIdx);
			continue;
		}
		const window = remaining.slice(0, limit);
		let breakIdx = findWhitespaceBreak(window);
		if (breakIdx <= 0) breakIdx = findCjkPunctuationBreak(window);
		if (breakIdx <= 0) breakIdx = clampToCodePointBoundary(remaining, limit);
		out.push(remaining.slice(0, breakIdx));
		remaining = remaining.slice(breakIdx);
	}
	if (remaining.length) out.push(remaining);
	return out;
}
/**
* Chunks outbound Discord text by both character count and (soft) line count,
* while keeping fenced code blocks balanced across chunks.
*/
function chunkDiscordText(text, opts = {}) {
	const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));
	const body = text ?? "";
	if (!body) return [];
	if (body.length <= maxChars && countLines(body) <= maxLines) return [body];
	const lines = body.split("\n");
	const chunks = [];
	let current = "";
	let currentLines = 0;
	let openFence = null;
	const flush = () => {
		if (!current) return;
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) chunks.push(payload);
		current = "";
		currentLines = 0;
		if (openFence) {
			current = openFence.openLine;
			currentLines = 1;
		}
	};
	for (const originalLine of lines) {
		const fenceInfo = parseFenceLine(originalLine);
		const wasInsideFence = openFence !== null;
		let nextOpenFence = openFence;
		if (fenceInfo) {
			if (!openFence) nextOpenFence = fenceInfo;
			else if (openFence.markerChar === fenceInfo.markerChar && fenceInfo.markerLen >= openFence.markerLen) nextOpenFence = null;
		}
		const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
		const reserveLines = nextOpenFence ? 1 : 0;
		const effectiveMaxChars = maxChars - reserveChars;
		const effectiveMaxLines = maxLines - reserveLines;
		const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
		const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
		const prefixLen = current.length > 0 ? current.length + 1 : 0;
		const segments = splitLongLine(originalLine, Math.max(1, charLimit - prefixLen), { preserveWhitespace: wasInsideFence });
		for (let segIndex = 0; segIndex < segments.length; segIndex++) {
			const segment = segments[segIndex];
			const isLineContinuation = segIndex > 0;
			const addition = `${isLineContinuation ? "" : current.length > 0 ? "\n" : ""}${segment}`;
			const nextLen = current.length + addition.length;
			const nextLines = currentLines + (isLineContinuation ? 0 : 1);
			if ((nextLen > charLimit || nextLines > lineLimit) && current.length > 0) flush();
			if (current.length > 0) {
				current += addition;
				if (!isLineContinuation) currentLines += 1;
			} else {
				current = segment;
				currentLines = 1;
			}
		}
		openFence = nextOpenFence;
	}
	if (current.length) {
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) chunks.push(payload);
	}
	return rebalanceReasoningItalics(text, chunks);
}
function chunkDiscordTextWithMode(text, opts) {
	if ((opts.chunkMode ?? "length") !== "newline") return chunkDiscordText(text, opts);
	const lineChunks = chunkMarkdownTextWithMode(text, Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)), "newline");
	const chunks = [];
	for (const line of lineChunks) {
		const nested = chunkDiscordText(line, opts);
		if (!nested.length && line) {
			chunks.push(line);
			continue;
		}
		chunks.push(...nested);
	}
	return chunks;
}
function rebalanceReasoningItalics(source, chunks) {
	if (chunks.length <= 1) return chunks;
	if (!(source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_"))) return chunks;
	const adjusted = [...chunks];
	for (let i = 0; i < adjusted.length; i++) {
		const isLast = i === adjusted.length - 1;
		const current = adjusted[i];
		if (!current.trimEnd().endsWith("_")) adjusted[i] = `${current}_`;
		if (isLast) break;
		const next = adjusted[i + 1];
		const leadingWhitespaceLen = next.length - next.trimStart().length;
		const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
		const nextBody = next.slice(leadingWhitespaceLen);
		if (!nextBody.startsWith("_")) adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
	}
	return adjusted;
}
//#endregion
//#region extensions/discord/src/normalize.ts
function normalizeDiscordMessagingTarget(raw) {
	return parseDiscordTarget(raw, { defaultKind: "channel" })?.normalized;
}
/**
* Normalize a Discord outbound target for delivery. Bare numeric IDs are
* prefixed with "channel:" to avoid the ambiguous-target error in
* parseDiscordTarget, unless the ID is explicitly configured as an allowed DM
* sender. All other formats pass through unchanged.
*/
function normalizeDiscordOutboundTarget(to, allowFrom) {
	const trimmed = to?.trim();
	if (!trimmed) return {
		ok: false,
		error: /* @__PURE__ */ new Error("Discord recipient is required. Use \"channel:<id>\" for channels or \"user:<id>\" for DMs.")
	};
	if (/^\d+$/.test(trimmed)) {
		if (allowFromContainsDiscordUserId(allowFrom, trimmed)) return {
			ok: true,
			to: `user:${trimmed}`
		};
		return {
			ok: true,
			to: `channel:${trimmed}`
		};
	}
	return {
		ok: true,
		to: trimmed
	};
}
function allowFromContainsDiscordUserId(allowFrom, userId) {
	const normalizedUserId = userId.trim();
	if (!normalizedUserId) return false;
	return (allowFrom ?? []).some((entry) => normalizeAllowFromDiscordUserId(entry) === normalizedUserId);
}
function normalizeAllowFromDiscordUserId(entry) {
	const trimmed = entry.trim().toLowerCase();
	if (!trimmed || trimmed === "*") return;
	const mentionMatch = /^<@!?(\d+)>$/.exec(trimmed);
	if (mentionMatch) return mentionMatch[1];
	const prefixedMatch = /^(?:discord:)?user:(\d+)$/.exec(trimmed);
	if (prefixedMatch) return prefixedMatch[1];
	const discordMatch = /^discord:(\d+)$/.exec(trimmed);
	if (discordMatch) return discordMatch[1];
	return /^\d+$/.test(trimmed) ? trimmed : void 0;
}
function looksLikeDiscordTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (/^<@!?\d+>$/.test(trimmed)) return true;
	if (/^(user|channel|discord):/i.test(trimmed)) return true;
	if (/^\d{6,}$/.test(trimmed)) return true;
	return false;
}
//#endregion
export { chunkDiscordTextWithMode as a, normalizeDiscordOutboundTarget as i, looksLikeDiscordTargetId as n, parseDiscordTarget as o, normalizeDiscordMessagingTarget as r, resolveDiscordChannelId as s, allowFromContainsDiscordUserId as t };
