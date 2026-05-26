import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
//#region src/auto-reply/reply/directive-parsing.ts
function skipDirectiveArgPrefix(raw) {
	let i = 0;
	const len = raw.length;
	while (i < len && /\s/.test(raw[i])) i += 1;
	if (raw[i] === ":") {
		i += 1;
		while (i < len && /\s/.test(raw[i])) i += 1;
	}
	return i;
}
function takeDirectiveToken(raw, startIndex) {
	let i = startIndex;
	const len = raw.length;
	while (i < len && /\s/.test(raw[i])) i += 1;
	if (i >= len) return {
		token: null,
		nextIndex: i
	};
	const start = i;
	while (i < len && !/\s/.test(raw[i])) i += 1;
	if (start === i) return {
		token: null,
		nextIndex: i
	};
	const token = raw.slice(start, i);
	while (i < len && /\s/.test(raw[i])) i += 1;
	return {
		token,
		nextIndex: i
	};
}
//#endregion
//#region src/auto-reply/reply/queue/normalize.ts
function normalizeQueueMode(raw) {
	const cleaned = normalizeOptionalLowercaseString(raw);
	if (!cleaned) return;
	if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") return "interrupt";
	if (cleaned === "steer" || cleaned === "steering") return "steer";
	if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") return "followup";
	if (cleaned === "collect" || cleaned === "coalesce") return "collect";
}
function normalizePersistedQueueMode(raw) {
	const normalized = normalizeQueueMode(raw);
	if (normalized) return normalized;
	const cleaned = normalizeOptionalLowercaseString(raw);
	if (cleaned === "queue" || cleaned === "queued") return "steer";
	if (cleaned === "steer+backlog" || cleaned === "steer-backlog" || cleaned === "steer_backlog") return "followup";
}
function normalizeQueueDropPolicy(raw) {
	const cleaned = normalizeOptionalLowercaseString(raw);
	if (!cleaned) return;
	if (cleaned === "old" || cleaned === "oldest") return "old";
	if (cleaned === "new" || cleaned === "newest") return "new";
	if (cleaned === "summarize" || cleaned === "summary") return "summarize";
}
//#endregion
//#region src/auto-reply/reply/queue/directive.ts
function parseQueueDebounce(raw) {
	if (!raw) return;
	try {
		const parsed = parseDurationMs(raw.trim(), { defaultUnit: "ms" });
		if (!parsed || parsed < 0) return;
		return Math.round(parsed);
	} catch {
		return;
	}
}
function parseQueueCap(raw) {
	if (!raw) return;
	const num = Number(raw);
	if (!Number.isFinite(num)) return;
	const cap = Math.floor(num);
	if (cap < 1) return;
	return cap;
}
function parseQueueDirectiveArgs(raw) {
	const len = raw.length;
	let i = skipDirectiveArgPrefix(raw);
	let consumed = i;
	let queueMode;
	let queueReset = false;
	let rawMode;
	let debounceMs;
	let cap;
	let dropPolicy;
	let rawDebounce;
	let rawCap;
	let rawDrop;
	let hasOptions = false;
	const takeToken = () => {
		const res = takeDirectiveToken(raw, i);
		i = res.nextIndex;
		return res.token;
	};
	for (;;) {
		if (i >= len) break;
		const token = takeToken();
		if (!token) break;
		const lowered = normalizeOptionalLowercaseString(token);
		if (!lowered) break;
		if (lowered === "default" || lowered === "reset" || lowered === "clear") {
			queueReset = true;
			consumed = i;
			break;
		}
		if (lowered.startsWith("debounce:") || lowered.startsWith("debounce=")) {
			rawDebounce = token.split(/[:=]/)[1] ?? "";
			debounceMs = parseQueueDebounce(rawDebounce);
			hasOptions = true;
			consumed = i;
			continue;
		}
		if (lowered.startsWith("cap:") || lowered.startsWith("cap=")) {
			rawCap = token.split(/[:=]/)[1] ?? "";
			cap = parseQueueCap(rawCap);
			hasOptions = true;
			consumed = i;
			continue;
		}
		if (lowered.startsWith("drop:") || lowered.startsWith("drop=")) {
			rawDrop = token.split(/[:=]/)[1] ?? "";
			dropPolicy = normalizeQueueDropPolicy(rawDrop);
			hasOptions = true;
			consumed = i;
			continue;
		}
		const mode = normalizeQueueMode(token);
		if (mode) {
			queueMode = mode;
			rawMode = token;
			consumed = i;
			continue;
		}
		if (consumed === skipDirectiveArgPrefix(raw) && !queueReset && !hasOptions) {
			rawMode = token;
			consumed = i;
		}
		break;
	}
	return {
		consumed,
		queueMode,
		queueReset,
		rawMode,
		debounceMs,
		cap,
		dropPolicy,
		rawDebounce,
		rawCap,
		rawDrop,
		hasOptions
	};
}
function extractQueueDirective(body) {
	if (!body) return {
		cleaned: "",
		hasDirective: false,
		queueReset: false,
		hasOptions: false
	};
	const match = /(?:^|\s)\/queue(?=$|\s|:)/i.exec(body);
	if (!match) return {
		cleaned: body.trim(),
		hasDirective: false,
		queueReset: false,
		hasOptions: false
	};
	const start = match.index + match[0].indexOf("/queue");
	const argsStart = start + 6;
	const parsed = parseQueueDirectiveArgs(body.slice(argsStart));
	return {
		cleaned: `${body.slice(0, start)} ${body.slice(argsStart + parsed.consumed)}`.replace(/\s+/g, " ").trim(),
		queueMode: parsed.queueMode,
		queueReset: parsed.queueReset,
		rawMode: parsed.rawMode,
		debounceMs: parsed.debounceMs,
		cap: parsed.cap,
		dropPolicy: parsed.dropPolicy,
		rawDebounce: parsed.rawDebounce,
		rawCap: parsed.rawCap,
		rawDrop: parsed.rawDrop,
		hasDirective: true,
		hasOptions: parsed.hasOptions
	};
}
//#endregion
export { skipDirectiveArgPrefix as a, normalizeQueueMode as i, normalizePersistedQueueMode as n, takeDirectiveToken as o, normalizeQueueDropPolicy as r, extractQueueDirective as t };
