import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { n as defaultRuntime } from "./runtime-Vyd5gFd2.js";
import { o as emitContinuationQueueDrainSpan } from "./continuation-tracer-BoLshHwS.js";
import { c as peekSystemEventEntries, t as consumeSelectedSystemEventEntries } from "./system-events-DLH2vbkB.js";
import { i as resolveUserTimezone } from "./date-time-285IirSy.js";
import { t as buildChannelSummary } from "./channel-summary-CPgbT6Td.js";
import { n as formatZonedTimestamp, r as resolveTimezone, t as formatUtcTimestamp } from "./format-datetime-BeZZ4gQG.js";
import { i as isExecCompletionEvent } from "./heartbeat-events-filter-COZllKC_.js";
//#region src/auto-reply/reply/session-system-events.ts
const selectGenericSystemEvents = (events) => events.filter((event) => !isExecCompletionEvent(event.text));
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
	const systemLines = [];
	const queued = consumeSelectedSystemEventEntries(params.sessionKey, selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey)));
	const drainedContinuationCount = queued.filter((event) => event.text.startsWith("[continuation:")).length;
	const traceparent = queued.find((event) => event.traceparent)?.traceparent;
	emitContinuationQueueDrainSpan({
		drainedCount: queued.length,
		drainedContinuationCount,
		...traceparent ? { traceparent } : {},
		log: (message) => defaultRuntime.log(message)
	});
	systemLines.push(...queued.flatMap((event) => {
		const compacted = compactSystemEvent(event.text);
		if (!compacted) return [];
		const prefix = event.trusted === false ? "System (untrusted)" : "System";
		const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
		return compacted.split("\n").map((subline, index) => `${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
	}));
	if (params.isMainSession && params.isNewSession) {
		const summary = await buildChannelSummary(params.cfg);
		if (summary.length > 0) systemLines.unshift(...summary.flatMap((line) => line.split("\n").map((subline) => `System: ${subline}`)));
	}
	if (systemLines.length === 0) return;
	return systemLines.join("\n");
}
//#endregion
export { drainFormattedSystemEvents as t };
