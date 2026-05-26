import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { c as peekSystemEventEntries, t as consumeSelectedSystemEventEntries } from "./system-events-D_-_Inav.js";
import { i as resolveUserTimezone } from "./date-time-D45sDlB1.js";
import { n as formatZonedTimestamp, r as resolveTimezone, t as formatUtcTimestamp } from "./format-datetime-tv--XrND.js";
import { t as buildChannelSummary } from "./channel-summary-iTOiQw9w.js";
import { i as isExecCompletionEvent } from "./heartbeat-events-filter-CSt7zU2j.js";
//#region src/auto-reply/reply/session-system-events.ts
const selectGenericSystemEvents = (events) => {
	const selected = [];
	for (const event of events) if (!isExecCompletionEvent(event.text)) selected.push(event);
	return selected;
};
/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
async function drainFormattedSystemEvents(params) {
	const compactSystemEvent = (line) => {
		const trimmed = line.trim();
		if (!trimmed) return null;
		const lower = normalizeLowercaseStringOrEmpty(trimmed);
		if (lower.includes("reason periodic")) return null;
		if (lower.startsWith("read heartbeat.md")) return null;
		if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) return null;
		if (trimmed.startsWith("Node:")) return trimmed.replace(/ · last input [^·]+/i, "").trim();
		return trimmed;
	};
	const resolveSystemEventTimezone = (cfg) => {
		const raw = normalizeOptionalString(cfg.agents?.defaults?.envelopeTimezone);
		if (!raw) return { mode: "local" };
		const lowered = normalizeLowercaseStringOrEmpty(raw);
		if (lowered === "utc" || lowered === "gmt") return { mode: "utc" };
		if (lowered === "local" || lowered === "host") return { mode: "local" };
		if (lowered === "user") return {
			mode: "iana",
			timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone)
		};
		const explicit = resolveTimezone(raw);
		return explicit ? {
			mode: "iana",
			timeZone: explicit
		} : { mode: "local" };
	};
	const formatSystemEventTimestamp = (ts, cfg) => {
		const date = new Date(ts);
		if (Number.isNaN(date.getTime())) return "unknown-time";
		const zone = resolveSystemEventTimezone(cfg);
		if (zone.mode === "utc") return formatUtcTimestamp(date, { displaySeconds: true });
		if (zone.mode === "local") return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
		return formatZonedTimestamp(date, {
			timeZone: zone.timeZone,
			displaySeconds: true
		}) ?? "unknown-time";
	};
	const summaryLines = [];
	const systemLines = [];
	const queued = consumeSelectedSystemEventEntries(params.sessionKey, selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey)));
	for (const event of queued) {
		const compacted = compactSystemEvent(event.text);
		if (!compacted) continue;
		const prefix = event.trusted === false ? "System (untrusted)" : "System";
		const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
		let index = 0;
		for (const subline of compacted.split("\n")) {
			systemLines.push(`${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
			index += 1;
		}
	}
	if (params.isMainSession && params.isNewSession) {
		const summary = await buildChannelSummary(params.cfg);
		if (summary.length > 0) for (const line of summary) for (const subline of line.split("\n")) summaryLines.push(`System: ${subline}`);
	}
	if (summaryLines.length === 0 && systemLines.length === 0) return;
	return summaryLines.length > 0 ? [...summaryLines, ...systemLines].join("\n") : systemLines.join("\n");
}
//#endregion
export { drainFormattedSystemEvents as t };
