import { f as readStringValue } from "./string-coerce-DyL154ka.js";
import { s as redactSensitiveText, t as getDefaultRedactPatterns } from "./redact-ok5Q8nmw.js";
import { l as stringifyNonErrorCause } from "./errors-b3ZrCRlt.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as isVerbose } from "./global-state-BAD7XgmL.js";
import "./globals-YU5FjfZK.js";
import { l as shouldLogSubsystemToConsole } from "./console-BAPPAj56.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { t as getGatewayWsLogStyle } from "./ws-logging-zK0zdycs.js";
import chalk from "chalk";
//#region src/gateway/ws-log.ts
const LOG_VALUE_LIMIT = 240;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WS_LOG_REDACT_OPTIONS = {
	mode: "tools",
	patterns: getDefaultRedactPatterns()
};
const wsInflightCompact = /* @__PURE__ */ new Map();
let wsLastCompactConnId;
const wsInflightOptimized = /* @__PURE__ */ new Map();
const wsInflightSince = /* @__PURE__ */ new Map();
const wsLog = createSubsystemLogger("gateway/ws");
const WS_META_SKIP_KEYS = new Set([
	"connId",
	"id",
	"method",
	"ok",
	"event"
]);
function collectWsRestMeta(meta) {
	const restMeta = [];
	if (!meta) return restMeta;
	for (const [key, value] of Object.entries(meta)) {
		if (value === void 0) continue;
		if (WS_META_SKIP_KEYS.has(key)) continue;
		restMeta.push(`${chalk.dim(key)}=${formatForLog(value)}`);
	}
	return restMeta;
}
function buildWsHeadline(params) {
	if ((params.kind === "req" || params.kind === "res") && params.method) return chalk.bold(params.method);
	if (params.kind === "event" && params.event) return chalk.bold(params.event);
}
function buildWsStatusToken(kind, ok) {
	if (kind !== "res" || ok === void 0) return;
	return ok ? chalk.greenBright("✓") : chalk.redBright("✗");
}
function logWsInfoLine(params) {
	const tokens = [
		params.prefix,
		params.statusToken,
		params.headline,
		params.durationToken,
		...params.restMeta,
		...params.trailing
	].filter((t) => Boolean(t));
	wsLog.info(tokens.join(" "));
}
function shouldLogWs() {
	return shouldLogSubsystemToConsole("gateway/ws");
}
function shortId(value) {
	const s = value.trim();
	if (UUID_RE.test(s)) return `${s.slice(0, 8)}…${s.slice(-4)}`;
	if (s.length <= 24) return s;
	return `${s.slice(0, 12)}…${s.slice(-4)}`;
}
function formatForLog(value) {
	try {
		if (value instanceof Error) {
			const combined = renderErrorChainForLog(value);
			if (combined) {
				const redacted = redactSensitiveText(combined, WS_LOG_REDACT_OPTIONS);
				return redacted.length > LOG_VALUE_LIMIT ? `${redacted.slice(0, LOG_VALUE_LIMIT)}...` : redacted;
			}
		}
		if (value && typeof value === "object") {
			const rec = value;
			if (typeof rec.message === "string" && rec.message.trim()) {
				const name = typeof rec.name === "string" ? rec.name.trim() : "";
				const code = typeof rec.code === "string" || typeof rec.code === "number" ? String(rec.code) : "";
				const parts = [name, rec.message.trim()].filter(Boolean);
				if (code) parts.push(`code=${code}`);
				const combined = redactSensitiveText(parts.join(": ").trim(), WS_LOG_REDACT_OPTIONS);
				return combined.length > LOG_VALUE_LIMIT ? `${combined.slice(0, LOG_VALUE_LIMIT)}...` : combined;
			}
		}
		const str = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
		if (!str) return "";
		const redacted = redactSensitiveText(str, WS_LOG_REDACT_OPTIONS);
		return redacted.length > LOG_VALUE_LIMIT ? `${redacted.slice(0, LOG_VALUE_LIMIT)}...` : redacted;
	} catch {
		return String(value);
	}
}
function renderSingleErrorForLog(error) {
	const parts = [];
	if (error.name) parts.push(error.name);
	if (error.message) parts.push(error.message);
	const codeValue = error.code;
	const code = typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : "";
	if (code) parts.push(`code=${code}`);
	return parts.filter(Boolean).join(": ").trim();
}
function renderErrorChainForLog(error) {
	const segments = [renderSingleErrorForLog(error)];
	let current = error.cause;
	let depth = 0;
	while (current !== void 0 && current !== null && depth < 8) {
		if (current instanceof Error) {
			segments.push(renderSingleErrorForLog(current));
			current = current.cause;
		} else {
			segments.push(stringifyNonErrorCause(current));
			current = void 0;
		}
		depth += 1;
	}
	return segments.filter(Boolean).join(" <- ");
}
function compactPreview(input, maxLen = 160) {
	const oneLine = input.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}
function summarizeAgentEventForWsLog(payload) {
	if (!payload || typeof payload !== "object") return {};
	const rec = payload;
	const runId = readStringValue(rec.runId);
	const stream = readStringValue(rec.stream);
	const seq = typeof rec.seq === "number" ? rec.seq : void 0;
	const sessionKey = readStringValue(rec.sessionKey);
	const data = rec.data && typeof rec.data === "object" ? rec.data : void 0;
	const extra = {};
	if (runId) extra.run = shortId(runId);
	if (sessionKey) {
		const parsed = parseAgentSessionKey(sessionKey);
		if (parsed) {
			extra.agent = parsed.agentId;
			extra.session = parsed.rest;
		} else extra.session = sessionKey;
	}
	if (stream) extra.stream = stream;
	if (seq !== void 0) extra.aseq = seq;
	if (!data) return extra;
	if (stream === "assistant") {
		const text = readStringValue(data.text);
		if (text?.trim()) extra.text = compactPreview(text);
		const mediaCount = resolveSendableOutboundReplyParts({ mediaUrls: Array.isArray(data.mediaUrls) ? data.mediaUrls : void 0 }).mediaCount;
		if (mediaCount > 0) extra.media = mediaCount;
		return extra;
	}
	if (stream === "tool") {
		const phase = readStringValue(data.phase);
		const name = readStringValue(data.name);
		if (phase || name) extra.tool = `${phase ?? "?"}:${name ?? "?"}`;
		const toolCallId = readStringValue(data.toolCallId);
		if (toolCallId) extra.call = shortId(toolCallId);
		const meta = readStringValue(data.meta);
		if (meta?.trim()) extra.meta = meta;
		if (typeof data.isError === "boolean") extra.err = data.isError;
		return extra;
	}
	if (stream === "lifecycle") {
		const phase = typeof data.phase === "string" ? data.phase : void 0;
		if (phase) extra.phase = phase;
		if (typeof data.aborted === "boolean") extra.aborted = data.aborted;
		const error = typeof data.error === "string" ? data.error : void 0;
		if (error?.trim()) extra.error = compactPreview(error, 120);
		return extra;
	}
	const reason = typeof data.reason === "string" ? data.reason : void 0;
	if (reason?.trim()) extra.reason = reason;
	return extra;
}
function logWs(direction, kind, meta) {
	if (!shouldLogSubsystemToConsole("gateway/ws")) return;
	const style = getGatewayWsLogStyle();
	if (!isVerbose()) {
		logWsOptimized(direction, kind, meta);
		return;
	}
	if (style === "compact" || style === "auto") {
		logWsCompact(direction, kind, meta);
		return;
	}
	const now = Date.now();
	const connId = typeof meta?.connId === "string" ? meta.connId : void 0;
	const id = typeof meta?.id === "string" ? meta.id : void 0;
	const method = typeof meta?.method === "string" ? meta.method : void 0;
	const ok = typeof meta?.ok === "boolean" ? meta.ok : void 0;
	const event = typeof meta?.event === "string" ? meta.event : void 0;
	const inflightKey = connId && id ? `${connId}:${id}` : void 0;
	if (direction === "in" && kind === "req" && inflightKey) wsInflightSince.set(inflightKey, now);
	const durationMs = direction === "out" && kind === "res" && inflightKey ? (() => {
		const startedAt = wsInflightSince.get(inflightKey);
		if (startedAt === void 0) return;
		wsInflightSince.delete(inflightKey);
		return now - startedAt;
	})() : void 0;
	const dirArrow = direction === "in" ? "←" : "→";
	const prefix = `${(direction === "in" ? chalk.greenBright : chalk.cyanBright)(dirArrow)} ${chalk.bold(kind)}`;
	const headline = buildWsHeadline({
		kind,
		method,
		event
	});
	const statusToken = buildWsStatusToken(kind, ok);
	const durationToken = typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : void 0;
	const restMeta = collectWsRestMeta(meta);
	const trailing = [];
	if (connId) trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
	if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);
	logWsInfoLine({
		prefix,
		statusToken,
		headline,
		durationToken,
		restMeta,
		trailing
	});
}
function logWsOptimized(direction, kind, meta) {
	const connId = typeof meta?.connId === "string" ? meta.connId : void 0;
	const id = typeof meta?.id === "string" ? meta.id : void 0;
	const ok = typeof meta?.ok === "boolean" ? meta.ok : void 0;
	const method = typeof meta?.method === "string" ? meta.method : void 0;
	const inflightKey = connId && id ? `${connId}:${id}` : void 0;
	if (direction === "in" && kind === "req" && inflightKey) {
		wsInflightOptimized.set(inflightKey, Date.now());
		if (wsInflightOptimized.size > 2e3) wsInflightOptimized.clear();
		return;
	}
	if (kind === "parse-error") {
		const errorMsg = typeof meta?.error === "string" ? formatForLog(meta.error) : void 0;
		wsLog.warn([
			`${chalk.redBright("✗")} ${chalk.bold("parse-error")}`,
			errorMsg ? `${chalk.dim("error")}=${errorMsg}` : void 0,
			`${chalk.dim("conn")}=${chalk.gray(shortId(connId ?? "?"))}`
		].filter((t) => Boolean(t)).join(" "));
		return;
	}
	if (direction !== "out" || kind !== "res") return;
	const startedAt = inflightKey ? wsInflightOptimized.get(inflightKey) : void 0;
	if (inflightKey) wsInflightOptimized.delete(inflightKey);
	const durationMs = typeof startedAt === "number" ? Date.now() - startedAt : void 0;
	if (!(ok === false || typeof durationMs === "number" && durationMs >= 50)) return;
	const statusToken = buildWsStatusToken("res", ok);
	const durationToken = typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : void 0;
	const restMeta = collectWsRestMeta(meta);
	logWsInfoLine({
		prefix: `${chalk.yellowBright("⇄")} ${chalk.bold("res")}`,
		statusToken,
		headline: method ? chalk.bold(method) : void 0,
		durationToken,
		restMeta,
		trailing: [connId ? `${chalk.dim("conn")}=${chalk.gray(shortId(connId))}` : "", id ? `${chalk.dim("id")}=${chalk.gray(shortId(id))}` : ""].filter(Boolean)
	});
}
function logWsCompact(direction, kind, meta) {
	const now = Date.now();
	const connId = typeof meta?.connId === "string" ? meta.connId : void 0;
	const id = typeof meta?.id === "string" ? meta.id : void 0;
	const method = typeof meta?.method === "string" ? meta.method : void 0;
	const ok = typeof meta?.ok === "boolean" ? meta.ok : void 0;
	const inflightKey = connId && id ? `${connId}:${id}` : void 0;
	if (kind === "req" && direction === "in" && inflightKey) {
		wsInflightCompact.set(inflightKey, {
			ts: now,
			method,
			meta
		});
		return;
	}
	const compactArrow = (() => {
		if (kind === "req" || kind === "res") return "⇄";
		return direction === "in" ? "←" : "→";
	})();
	const prefix = `${(kind === "req" || kind === "res" ? chalk.yellowBright : direction === "in" ? chalk.greenBright : chalk.cyanBright)(compactArrow)} ${chalk.bold(kind)}`;
	const statusToken = buildWsStatusToken(kind, ok);
	const startedAt = kind === "res" && direction === "out" && inflightKey ? wsInflightCompact.get(inflightKey)?.ts : void 0;
	if (kind === "res" && direction === "out" && inflightKey) wsInflightCompact.delete(inflightKey);
	const durationToken = typeof startedAt === "number" ? chalk.dim(`${now - startedAt}ms`) : void 0;
	const headline = buildWsHeadline({
		kind,
		method,
		event: typeof meta?.event === "string" ? meta.event : void 0
	});
	const restMeta = collectWsRestMeta(meta);
	const trailing = [];
	if (connId && connId !== wsLastCompactConnId) {
		trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
		wsLastCompactConnId = connId;
	}
	if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);
	logWsInfoLine({
		prefix,
		statusToken,
		headline,
		durationToken,
		restMeta,
		trailing
	});
}
//#endregion
export { summarizeAgentEventForWsLog as i, logWs as n, shouldLogWs as r, formatForLog as t };
