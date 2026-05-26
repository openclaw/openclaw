import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { i as resolveUserTimezone } from "./date-time-D7najZvu.js";
import { n as formatZonedTimestamp, r as resolveTimezone, t as formatUtcTimestamp } from "./format-datetime-DO2rqkXr.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
//#region src/channels/sender-label.ts
function normalizeSenderLabelParams(params) {
	return {
		name: normalizeOptionalString(params.name),
		username: normalizeOptionalString(params.username),
		tag: normalizeOptionalString(params.tag),
		e164: normalizeOptionalString(params.e164),
		id: normalizeOptionalString(params.id)
	};
}
function resolveSenderLabel(params) {
	const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);
	const display = name ?? username ?? tag ?? "";
	const idPart = e164 ?? id ?? "";
	if (display && idPart && display !== idPart) return `${display} (${idPart})`;
	return display || idPart || null;
}
//#endregion
//#region src/auto-reply/envelope.ts
function sanitizeEnvelopeHeaderPart(value) {
	return value.replace(/\r\n|\r|\n/g, " ").replaceAll("[", "(").replaceAll("]", ")").replace(/\s+/g, " ").trim();
}
function resolveEnvelopeFormatOptions(cfg) {
	const defaults = cfg?.agents?.defaults;
	return {
		timezone: defaults?.envelopeTimezone,
		includeTimestamp: defaults?.envelopeTimestamp !== "off",
		includeElapsed: defaults?.envelopeElapsed !== "off",
		userTimezone: defaults?.userTimezone
	};
}
function normalizeEnvelopeOptions(options) {
	const includeTimestamp = options?.includeTimestamp !== false;
	const includeElapsed = options?.includeElapsed !== false;
	return {
		timezone: normalizeOptionalString(options?.timezone) || "local",
		includeTimestamp,
		includeElapsed,
		userTimezone: options?.userTimezone
	};
}
function resolveEnvelopeTimezone(options) {
	const trimmed = options.timezone?.trim();
	if (!trimmed) return { mode: "local" };
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered === "utc" || lowered === "gmt") return { mode: "utc" };
	if (lowered === "local" || lowered === "host") return { mode: "local" };
	if (lowered === "user") return {
		mode: "iana",
		timeZone: resolveUserTimezone(options.userTimezone)
	};
	const explicit = resolveTimezone(trimmed);
	return explicit ? {
		mode: "iana",
		timeZone: explicit
	} : { mode: "utc" };
}
function formatEnvelopeTimestamp(ts, options) {
	if (!ts) return;
	const resolved = normalizeEnvelopeOptions(options);
	if (!resolved.includeTimestamp) return;
	const date = ts instanceof Date ? ts : new Date(ts);
	if (Number.isNaN(date.getTime())) return;
	const zone = resolveEnvelopeTimezone(resolved);
	const weekday = (() => {
		try {
			if (zone.mode === "utc") return new Intl.DateTimeFormat("en-US", {
				timeZone: "UTC",
				weekday: "short"
			}).format(date);
			if (zone.mode === "local") return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
			return new Intl.DateTimeFormat("en-US", {
				timeZone: zone.timeZone,
				weekday: "short"
			}).format(date);
		} catch {
			return;
		}
	})();
	const formatted = zone.mode === "utc" ? formatUtcTimestamp(date) : zone.mode === "local" ? formatZonedTimestamp(date) : formatZonedTimestamp(date, { timeZone: zone.timeZone });
	if (!formatted) return;
	return weekday ? `${weekday} ${formatted}` : formatted;
}
function formatAgentEnvelope(params) {
	const parts = [sanitizeEnvelopeHeaderPart(normalizeOptionalString(params.channel) || "Channel")];
	const resolved = normalizeEnvelopeOptions(params.envelope);
	let elapsed;
	if (resolved.includeElapsed && params.timestamp && params.previousTimestamp) {
		const elapsedMs = (params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp) - (params.previousTimestamp instanceof Date ? params.previousTimestamp.getTime() : params.previousTimestamp);
		elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? formatTimeAgo(elapsedMs, { suffix: false }) : void 0;
	}
	const from = normalizeOptionalString(params.from);
	if (from) {
		const fromLabel = sanitizeEnvelopeHeaderPart(from);
		parts.push(elapsed ? `${fromLabel} +${elapsed}` : fromLabel);
	} else if (elapsed) parts.push(`+${elapsed}`);
	const host = normalizeOptionalString(params.host);
	if (host) parts.push(sanitizeEnvelopeHeaderPart(host));
	const ip = normalizeOptionalString(params.ip);
	if (ip) parts.push(sanitizeEnvelopeHeaderPart(ip));
	const ts = formatEnvelopeTimestamp(params.timestamp, resolved);
	if (ts) parts.push(ts);
	return `${`[${parts.join(" ")}]`} ${params.body}`;
}
function formatInboundEnvelope(params) {
	const chatType = normalizeChatType(params.chatType);
	const isDirect = !chatType || chatType === "direct";
	const resolvedSenderRaw = normalizeOptionalString(params.senderLabel) || resolveSenderLabel(params.sender ?? {});
	const resolvedSender = resolvedSenderRaw ? sanitizeEnvelopeHeaderPart(resolvedSenderRaw) : "";
	const body = isDirect && params.fromMe ? `(self): ${params.body}` : !isDirect && resolvedSender ? `${resolvedSender}: ${params.body}` : params.body;
	return formatAgentEnvelope({
		channel: params.channel,
		from: params.from,
		timestamp: params.timestamp,
		previousTimestamp: params.previousTimestamp,
		envelope: params.envelope,
		body
	});
}
function formatInboundFromLabel(params) {
	if (params.isGroup) {
		const label = normalizeOptionalString(params.groupLabel) || params.groupFallback || "Group";
		const id = params.groupId?.trim();
		return id ? `${label} id:${id}` : label;
	}
	const directLabel = params.directLabel.trim();
	const directId = params.directId?.trim();
	if (!directId || directId === directLabel) return directLabel;
	return `${directLabel} id:${directId}`;
}
//#endregion
export { resolveEnvelopeFormatOptions as a, formatInboundFromLabel as i, formatEnvelopeTimestamp as n, resolveSenderLabel as o, formatInboundEnvelope as r, formatAgentEnvelope as t };
