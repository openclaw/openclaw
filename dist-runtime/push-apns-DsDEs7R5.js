import { n as redactSensitiveText, t as getDefaultRedactPatterns } from "./redact-qojvLPM7.js";
import { i as isVerbose, r as init_globals } from "./globals-B6h30oSy.js";
import { i as init_paths, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { a as init_console, l as shouldLogSubsystemToConsole, n as init_subsystem, t as createSubsystemLogger } from "./subsystem-CZwunM2N.js";
import { Di as sniffMimeFromBase64 } from "./auth-profiles-DAOR1fRn.js";
import { U as estimateBase64DecodedBytes } from "./plugins-allowlist-E4LSkJ7R.js";
import { s as init_session_key, w as parseAgentSessionKey } from "./session-key-B-Mu-04L.js";
import { i as writeJsonAtomic, n as init_json_files, r as readJsonFile, t as createAsyncLock } from "./json-files-Ci9Yrixm.js";
import { on as signDevicePayload, rn as loadOrCreateDeviceIdentity } from "./method-scopes-CLHNYIU6.js";
import { URL } from "node:url";
import path from "node:path";
import chalk from "chalk";
import { createHash, createPrivateKey, sign } from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
//#region src/gateway/ws-logging.ts
let gatewayWsLogStyle = "auto";
function setGatewayWsLogStyle(style) {
	gatewayWsLogStyle = style;
}
function getGatewayWsLogStyle() {
	return gatewayWsLogStyle;
}
//#endregion
//#region src/gateway/ws-log.ts
init_globals();
init_console();
init_subsystem();
init_session_key();
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
			const parts = [];
			if (value.name) parts.push(value.name);
			if (value.message) parts.push(value.message);
			const code = "code" in value && (typeof value.code === "string" || typeof value.code === "number") ? String(value.code) : "";
			if (code) parts.push(`code=${code}`);
			const combined = parts.filter(Boolean).join(": ").trim();
			if (combined) return combined.length > LOG_VALUE_LIMIT ? `${combined.slice(0, LOG_VALUE_LIMIT)}...` : combined;
		}
		if (value && typeof value === "object") {
			const rec = value;
			if (typeof rec.message === "string" && rec.message.trim()) {
				const name = typeof rec.name === "string" ? rec.name.trim() : "";
				const code = typeof rec.code === "string" || typeof rec.code === "number" ? String(rec.code) : "";
				const parts = [name, rec.message.trim()].filter(Boolean);
				if (code) parts.push(`code=${code}`);
				const combined = parts.join(": ").trim();
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
function compactPreview(input, maxLen = 160) {
	const oneLine = input.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}
function summarizeAgentEventForWsLog(payload) {
	if (!payload || typeof payload !== "object") return {};
	const rec = payload;
	const runId = typeof rec.runId === "string" ? rec.runId : void 0;
	const stream = typeof rec.stream === "string" ? rec.stream : void 0;
	const seq = typeof rec.seq === "number" ? rec.seq : void 0;
	const sessionKey = typeof rec.sessionKey === "string" ? rec.sessionKey : void 0;
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
		const text = typeof data.text === "string" ? data.text : void 0;
		if (text?.trim()) extra.text = compactPreview(text);
		const mediaUrls = Array.isArray(data.mediaUrls) ? data.mediaUrls : void 0;
		if (mediaUrls && mediaUrls.length > 0) extra.media = mediaUrls.length;
		return extra;
	}
	if (stream === "tool") {
		const phase = typeof data.phase === "string" ? data.phase : void 0;
		const name = typeof data.name === "string" ? data.name : void 0;
		if (phase || name) extra.tool = `${phase ?? "?"}:${name ?? "?"}`;
		const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : void 0;
		if (toolCallId) extra.call = shortId(toolCallId);
		const meta = typeof data.meta === "string" ? data.meta : void 0;
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
//#region src/gateway/chat-attachments.ts
function normalizeMime(mime) {
	if (!mime) return;
	return mime.split(";")[0]?.trim().toLowerCase() || void 0;
}
function isImageMime(mime) {
	return typeof mime === "string" && mime.startsWith("image/");
}
function isValidBase64(value) {
	return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function normalizeAttachment(att, idx, opts) {
	const mime = att.mimeType ?? "";
	const content = att.content;
	const label = att.fileName || att.type || `attachment-${idx + 1}`;
	if (typeof content !== "string") throw new Error(`attachment ${label}: content must be base64 string`);
	if (opts.requireImageMime && !mime.startsWith("image/")) throw new Error(`attachment ${label}: only image/* supported`);
	let base64 = content.trim();
	if (opts.stripDataUrlPrefix) {
		const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
		if (dataUrlMatch) base64 = dataUrlMatch[1];
	}
	return {
		label,
		mime,
		base64
	};
}
function validateAttachmentBase64OrThrow(normalized, opts) {
	if (!isValidBase64(normalized.base64)) throw new Error(`attachment ${normalized.label}: invalid base64 content`);
	const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
	if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) throw new Error(`attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`);
	return sizeBytes;
}
/**
* Parse attachments and extract images as structured content blocks.
* Returns the message text and an array of image content blocks
* compatible with Claude API's image format.
*/
async function parseMessageWithAttachments(message, attachments, opts) {
	const maxBytes = opts?.maxBytes ?? 5e6;
	const log = opts?.log;
	if (!attachments || attachments.length === 0) return {
		message,
		images: []
	};
	const images = [];
	for (const [idx, att] of attachments.entries()) {
		if (!att) continue;
		const normalized = normalizeAttachment(att, idx, {
			stripDataUrlPrefix: true,
			requireImageMime: false
		});
		validateAttachmentBase64OrThrow(normalized, { maxBytes });
		const { base64: b64, label, mime } = normalized;
		const providedMime = normalizeMime(mime);
		const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
		if (sniffedMime && !isImageMime(sniffedMime)) {
			log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
			continue;
		}
		if (!sniffedMime && !isImageMime(providedMime)) {
			log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
			continue;
		}
		if (sniffedMime && providedMime && sniffedMime !== providedMime) log?.warn(`attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`);
		images.push({
			type: "image",
			data: b64,
			mimeType: sniffedMime ?? providedMime ?? mime
		});
	}
	return {
		message,
		images
	};
}
//#endregion
//#region src/gateway/server-methods/attachment-normalize.ts
function normalizeRpcAttachmentsToChatAttachments(attachments) {
	return attachments?.map((a) => ({
		type: typeof a?.type === "string" ? a.type : void 0,
		mimeType: typeof a?.mimeType === "string" ? a.mimeType : void 0,
		fileName: typeof a?.fileName === "string" ? a.fileName : void 0,
		content: typeof a?.content === "string" ? a.content : ArrayBuffer.isView(a?.content) ? Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength).toString("base64") : a?.content instanceof ArrayBuffer ? Buffer.from(a.content).toString("base64") : void 0
	})).filter((a) => a.content) ?? [];
}
//#endregion
//#region src/infra/push-apns.relay.ts
const DEFAULT_APNS_RELAY_TIMEOUT_MS = 1e4;
const GATEWAY_DEVICE_ID_HEADER = "x-openclaw-gateway-device-id";
const GATEWAY_SIGNATURE_HEADER = "x-openclaw-gateway-signature";
const GATEWAY_SIGNED_AT_HEADER = "x-openclaw-gateway-signed-at-ms";
function normalizeNonEmptyString$1(value) {
	const trimmed = value?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}
function normalizeTimeoutMs(value) {
	const raw = typeof value === "number" ? value : typeof value === "string" ? value.trim() : void 0;
	if (raw === void 0 || raw === "") return DEFAULT_APNS_RELAY_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_APNS_RELAY_TIMEOUT_MS;
	return Math.max(1e3, Math.trunc(parsed));
}
function readAllowHttp(value) {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}
function isLoopbackRelayHostname(hostname) {
	const normalized = hostname.trim().toLowerCase();
	return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
function parseReason$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function buildRelayGatewaySignaturePayload(params) {
	return [
		"openclaw-relay-send-v1",
		params.gatewayDeviceId.trim(),
		String(Math.trunc(params.signedAtMs)),
		params.bodyJson
	].join("\n");
}
function resolveApnsRelayConfigFromEnv(env = process.env, gatewayConfig) {
	const configuredRelay = gatewayConfig?.push?.apns?.relay;
	const envBaseUrl = normalizeNonEmptyString$1(env.OPENCLAW_APNS_RELAY_BASE_URL);
	const configBaseUrl = normalizeNonEmptyString$1(configuredRelay?.baseUrl);
	const baseUrl = envBaseUrl ?? configBaseUrl;
	const baseUrlSource = envBaseUrl ? "OPENCLAW_APNS_RELAY_BASE_URL" : "gateway.push.apns.relay.baseUrl";
	if (!baseUrl) return {
		ok: false,
		error: "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL"
	};
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
		if (!parsed.hostname) throw new Error("host required");
		if (parsed.protocol === "http:" && !readAllowHttp(env.OPENCLAW_APNS_RELAY_ALLOW_HTTP)) throw new Error("http relay URLs require OPENCLAW_APNS_RELAY_ALLOW_HTTP=true (development only)");
		if (parsed.protocol === "http:" && !isLoopbackRelayHostname(parsed.hostname)) throw new Error("http relay URLs are limited to loopback hosts");
		if (parsed.username || parsed.password) throw new Error("userinfo is not allowed");
		if (parsed.search || parsed.hash) throw new Error("query and fragment are not allowed");
		return {
			ok: true,
			value: {
				baseUrl: parsed.toString().replace(/\/+$/, ""),
				timeoutMs: normalizeTimeoutMs(env.OPENCLAW_APNS_RELAY_TIMEOUT_MS ?? configuredRelay?.timeoutMs)
			}
		};
	} catch (err) {
		return {
			ok: false,
			error: `invalid ${baseUrlSource} (${baseUrl}): ${err instanceof Error ? err.message : String(err)}`
		};
	}
}
async function sendApnsRelayRequest(params) {
	const response = await fetch(`${params.relayConfig.baseUrl}/v1/push/send`, {
		method: "POST",
		redirect: "manual",
		headers: {
			authorization: `Bearer ${params.sendGrant}`,
			"content-type": "application/json",
			[GATEWAY_DEVICE_ID_HEADER]: params.gatewayDeviceId,
			[GATEWAY_SIGNATURE_HEADER]: params.signature,
			[GATEWAY_SIGNED_AT_HEADER]: String(params.signedAtMs)
		},
		body: params.bodyJson,
		signal: AbortSignal.timeout(params.relayConfig.timeoutMs)
	});
	if (response.status >= 300 && response.status < 400) return {
		ok: false,
		status: response.status,
		reason: "RelayRedirectNotAllowed",
		environment: "production"
	};
	let json = null;
	try {
		json = await response.json();
	} catch {
		json = null;
	}
	const body = json && typeof json === "object" && !Array.isArray(json) ? json : {};
	const status = typeof body.status === "number" && Number.isFinite(body.status) ? Math.trunc(body.status) : response.status;
	return {
		ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
		status,
		apnsId: parseReason$1(body.apnsId),
		reason: parseReason$1(body.reason),
		environment: "production",
		tokenSuffix: parseReason$1(body.tokenSuffix)
	};
}
async function sendApnsRelayPush(params) {
	const sender = params.requestSender ?? sendApnsRelayRequest;
	const gatewayIdentity = params.gatewayIdentity ?? loadOrCreateDeviceIdentity();
	const signedAtMs = Date.now();
	const bodyJson = JSON.stringify({
		relayHandle: params.relayHandle,
		pushType: params.pushType,
		priority: Number(params.priority),
		payload: params.payload
	});
	const signature = signDevicePayload(gatewayIdentity.privateKeyPem, buildRelayGatewaySignaturePayload({
		gatewayDeviceId: gatewayIdentity.deviceId,
		signedAtMs,
		bodyJson
	}));
	return await sender({
		relayConfig: params.relayConfig,
		sendGrant: params.sendGrant,
		relayHandle: params.relayHandle,
		gatewayDeviceId: gatewayIdentity.deviceId,
		signature,
		signedAtMs,
		bodyJson,
		pushType: params.pushType,
		priority: params.priority,
		payload: params.payload
	});
}
//#endregion
//#region src/infra/push-apns.ts
init_paths();
init_json_files();
const APNS_STATE_FILENAME = "push/apns-registrations.json";
const APNS_JWT_TTL_MS = 3e3 * 1e3;
const DEFAULT_APNS_TIMEOUT_MS = 1e4;
const MAX_NODE_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APNS_TOKEN_HEX_LENGTH = 512;
const MAX_RELAY_IDENTIFIER_LENGTH = 256;
const MAX_SEND_GRANT_LENGTH = 1024;
const withLock = createAsyncLock();
let cachedJwt = null;
function resolveApnsRegistrationPath(baseDir) {
	const root = baseDir ?? resolveStateDir();
	return path.join(root, APNS_STATE_FILENAME);
}
function normalizeNodeId(value) {
	return value.trim();
}
function isValidNodeId(value) {
	return value.length > 0 && value.length <= MAX_NODE_ID_LENGTH;
}
function normalizeApnsToken(value) {
	return value.trim().replace(/[<>\s]/g, "").toLowerCase();
}
function normalizeRelayHandle(value) {
	return value.trim();
}
function normalizeInstallationId(value) {
	return value.trim();
}
function validateRelayIdentifier(value, fieldName, maxLength = MAX_RELAY_IDENTIFIER_LENGTH) {
	if (!value) throw new Error(`${fieldName} required`);
	if (value.length > maxLength) throw new Error(`${fieldName} too long`);
	if (/[^\x21-\x7e]/.test(value)) throw new Error(`${fieldName} invalid`);
	return value;
}
function normalizeTopic(value) {
	return value.trim();
}
function isValidTopic(value) {
	return value.length > 0 && value.length <= MAX_TOPIC_LENGTH;
}
function normalizeTokenDebugSuffix(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase().replace(/[^0-9a-z]/g, "");
	return normalized.length > 0 ? normalized.slice(-8) : void 0;
}
function isLikelyApnsToken(value) {
	return value.length <= MAX_APNS_TOKEN_HEX_LENGTH && /^[0-9a-f]{32,}$/i.test(value);
}
function parseReason(body) {
	const trimmed = body.trim();
	if (!trimmed) return;
	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason.trim() : trimmed.slice(0, 200);
	} catch {
		return trimmed.slice(0, 200);
	}
}
function toBase64UrlBytes(value) {
	return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function toBase64UrlJson(value) {
	return toBase64UrlBytes(Buffer.from(JSON.stringify(value)));
}
function getJwtCacheKey(auth) {
	const keyHash = createHash("sha256").update(auth.privateKey).digest("hex");
	return `${auth.teamId}:${auth.keyId}:${keyHash}`;
}
function getApnsBearerToken(auth, nowMs = Date.now()) {
	const cacheKey = getJwtCacheKey(auth);
	if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowMs < cachedJwt.expiresAtMs) return cachedJwt.token;
	const iat = Math.floor(nowMs / 1e3);
	const signingInput = `${toBase64UrlJson({
		alg: "ES256",
		kid: auth.keyId,
		typ: "JWT"
	})}.${toBase64UrlJson({
		iss: auth.teamId,
		iat
	})}`;
	const token = `${signingInput}.${toBase64UrlBytes(sign("sha256", Buffer.from(signingInput, "utf8"), {
		key: createPrivateKey(auth.privateKey),
		dsaEncoding: "ieee-p1363"
	}))}`;
	cachedJwt = {
		cacheKey,
		token,
		expiresAtMs: nowMs + APNS_JWT_TTL_MS
	};
	return token;
}
function normalizePrivateKey(value) {
	return value.trim().replace(/\\n/g, "\n");
}
function normalizeNonEmptyString(value) {
	const trimmed = value?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}
function normalizeDistribution(value) {
	if (typeof value !== "string") return null;
	return value.trim().toLowerCase() === "official" ? "official" : null;
}
function normalizeDirectRegistration(record) {
	if (typeof record.nodeId !== "string" || typeof record.token !== "string") return null;
	const nodeId = normalizeNodeId(record.nodeId);
	const token = normalizeApnsToken(record.token);
	const topic = normalizeTopic(typeof record.topic === "string" ? record.topic : "");
	const environment = normalizeApnsEnvironment(record.environment) ?? "sandbox";
	const updatedAtMs = typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs) ? Math.trunc(record.updatedAtMs) : 0;
	if (!isValidNodeId(nodeId) || !isValidTopic(topic) || !isLikelyApnsToken(token)) return null;
	return {
		nodeId,
		transport: "direct",
		token,
		topic,
		environment,
		updatedAtMs
	};
}
function normalizeRelayRegistration(record) {
	if (typeof record.nodeId !== "string" || typeof record.relayHandle !== "string" || typeof record.sendGrant !== "string" || typeof record.installationId !== "string") return null;
	const nodeId = normalizeNodeId(record.nodeId);
	const relayHandle = normalizeRelayHandle(record.relayHandle);
	const sendGrant = record.sendGrant.trim();
	const installationId = normalizeInstallationId(record.installationId);
	const topic = normalizeTopic(typeof record.topic === "string" ? record.topic : "");
	const environment = normalizeApnsEnvironment(record.environment);
	const distribution = normalizeDistribution(record.distribution);
	const updatedAtMs = typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs) ? Math.trunc(record.updatedAtMs) : 0;
	if (!isValidNodeId(nodeId) || !relayHandle || !sendGrant || !installationId || !isValidTopic(topic) || environment !== "production" || distribution !== "official") return null;
	return {
		nodeId,
		transport: "relay",
		relayHandle,
		sendGrant,
		installationId,
		topic,
		environment,
		distribution,
		updatedAtMs,
		tokenDebugSuffix: normalizeTokenDebugSuffix(record.tokenDebugSuffix)
	};
}
function normalizeStoredRegistration(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const candidate = record;
	if ((typeof candidate.transport === "string" ? candidate.transport.trim().toLowerCase() : "direct") === "relay") return normalizeRelayRegistration(candidate);
	return normalizeDirectRegistration(candidate);
}
async function loadRegistrationsState(baseDir) {
	const existing = await readJsonFile(resolveApnsRegistrationPath(baseDir));
	if (!existing || typeof existing !== "object") return { registrationsByNodeId: {} };
	const registrations = existing.registrationsByNodeId && typeof existing.registrationsByNodeId === "object" && !Array.isArray(existing.registrationsByNodeId) ? existing.registrationsByNodeId : {};
	const normalized = {};
	for (const [nodeId, record] of Object.entries(registrations)) {
		const registration = normalizeStoredRegistration(record);
		if (registration) {
			const normalizedNodeId = normalizeNodeId(nodeId);
			normalized[isValidNodeId(normalizedNodeId) ? normalizedNodeId : registration.nodeId] = registration;
		}
	}
	return { registrationsByNodeId: normalized };
}
async function persistRegistrationsState(state, baseDir) {
	await writeJsonAtomic(resolveApnsRegistrationPath(baseDir), state, {
		mode: 384,
		ensureDirMode: 448,
		trailingNewline: true
	});
}
function normalizeApnsEnvironment(value) {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "sandbox" || normalized === "production") return normalized;
	return null;
}
async function registerApnsRegistration(params) {
	const nodeId = normalizeNodeId(params.nodeId);
	const topic = normalizeTopic(params.topic);
	if (!isValidNodeId(nodeId)) throw new Error("nodeId required");
	if (!isValidTopic(topic)) throw new Error("topic required");
	return await withLock(async () => {
		const state = await loadRegistrationsState(params.baseDir);
		const updatedAtMs = Date.now();
		let next;
		if (params.transport === "relay") {
			const relayHandle = validateRelayIdentifier(normalizeRelayHandle(params.relayHandle), "relayHandle");
			const sendGrant = validateRelayIdentifier(params.sendGrant.trim(), "sendGrant", MAX_SEND_GRANT_LENGTH);
			const installationId = validateRelayIdentifier(normalizeInstallationId(params.installationId), "installationId");
			const environment = normalizeApnsEnvironment(params.environment);
			const distribution = normalizeDistribution(params.distribution);
			if (environment !== "production") throw new Error("relay registrations must use production environment");
			if (distribution !== "official") throw new Error("relay registrations must use official distribution");
			next = {
				nodeId,
				transport: "relay",
				relayHandle,
				sendGrant,
				installationId,
				topic,
				environment,
				distribution,
				updatedAtMs,
				tokenDebugSuffix: normalizeTokenDebugSuffix(params.tokenDebugSuffix)
			};
		} else {
			const token = normalizeApnsToken(params.token);
			const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";
			if (!isLikelyApnsToken(token)) throw new Error("invalid APNs token");
			next = {
				nodeId,
				transport: "direct",
				token,
				topic,
				environment,
				updatedAtMs
			};
		}
		state.registrationsByNodeId[nodeId] = next;
		await persistRegistrationsState(state, params.baseDir);
		return next;
	});
}
async function loadApnsRegistration(nodeId, baseDir) {
	const normalizedNodeId = normalizeNodeId(nodeId);
	if (!normalizedNodeId) return null;
	return (await loadRegistrationsState(baseDir)).registrationsByNodeId[normalizedNodeId] ?? null;
}
function isSameApnsRegistration(a, b) {
	if (a.nodeId !== b.nodeId || a.transport !== b.transport || a.topic !== b.topic || a.environment !== b.environment || a.updatedAtMs !== b.updatedAtMs) return false;
	if (a.transport === "direct" && b.transport === "direct") return a.token === b.token;
	if (a.transport === "relay" && b.transport === "relay") return a.relayHandle === b.relayHandle && a.sendGrant === b.sendGrant && a.installationId === b.installationId && a.distribution === b.distribution && a.tokenDebugSuffix === b.tokenDebugSuffix;
	return false;
}
async function clearApnsRegistrationIfCurrent(params) {
	const normalizedNodeId = normalizeNodeId(params.nodeId);
	if (!normalizedNodeId) return false;
	return await withLock(async () => {
		const state = await loadRegistrationsState(params.baseDir);
		const current = state.registrationsByNodeId[normalizedNodeId];
		if (!current || !isSameApnsRegistration(current, params.registration)) return false;
		delete state.registrationsByNodeId[normalizedNodeId];
		await persistRegistrationsState(state, params.baseDir);
		return true;
	});
}
function shouldInvalidateApnsRegistration(result) {
	if (result.status === 410) return true;
	return result.status === 400 && result.reason?.trim() === "BadDeviceToken";
}
function shouldClearStoredApnsRegistration(params) {
	if (params.registration.transport !== "direct") return false;
	if (params.overrideEnvironment && params.overrideEnvironment !== params.registration.environment) return false;
	return shouldInvalidateApnsRegistration(params.result);
}
async function resolveApnsAuthConfigFromEnv(env = process.env) {
	const teamId = normalizeNonEmptyString(env.OPENCLAW_APNS_TEAM_ID);
	const keyId = normalizeNonEmptyString(env.OPENCLAW_APNS_KEY_ID);
	if (!teamId || !keyId) return {
		ok: false,
		error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID"
	};
	const inlineKeyRaw = normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_P8) ?? normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY);
	if (inlineKeyRaw) return {
		ok: true,
		value: {
			teamId,
			keyId,
			privateKey: normalizePrivateKey(inlineKeyRaw)
		}
	};
	const keyPath = normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_PATH);
	if (!keyPath) return {
		ok: false,
		error: "APNs private key missing: set OPENCLAW_APNS_PRIVATE_KEY_P8 or OPENCLAW_APNS_PRIVATE_KEY_PATH"
	};
	try {
		return {
			ok: true,
			value: {
				teamId,
				keyId,
				privateKey: normalizePrivateKey(await fs.readFile(keyPath, "utf8"))
			}
		};
	} catch (err) {
		return {
			ok: false,
			error: `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${keyPath}): ${err instanceof Error ? err.message : String(err)}`
		};
	}
}
async function sendApnsRequest(params) {
	const authority = params.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
	const body = JSON.stringify(params.payload);
	const requestPath = `/3/device/${params.token}`;
	return await new Promise((resolve, reject) => {
		const client = http2.connect(authority);
		let settled = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			client.destroy();
			reject(err);
		};
		const finish = (result) => {
			if (settled) return;
			settled = true;
			client.close();
			resolve(result);
		};
		client.once("error", (err) => fail(err));
		const req = client.request({
			":method": "POST",
			":path": requestPath,
			authorization: `bearer ${params.bearerToken}`,
			"apns-topic": params.topic,
			"apns-push-type": params.pushType,
			"apns-priority": params.priority,
			"apns-expiration": "0",
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body).toString()
		});
		let statusCode = 0;
		let apnsId;
		let responseBody = "";
		req.setEncoding("utf8");
		req.setTimeout(params.timeoutMs, () => {
			req.close(http2.constants.NGHTTP2_CANCEL);
			fail(/* @__PURE__ */ new Error(`APNs request timed out after ${params.timeoutMs}ms`));
		});
		req.on("response", (headers) => {
			const statusHeader = headers[":status"];
			statusCode = typeof statusHeader === "number" ? statusHeader : Number(statusHeader ?? 0);
			const idHeader = headers["apns-id"];
			if (typeof idHeader === "string" && idHeader.trim().length > 0) apnsId = idHeader.trim();
		});
		req.on("data", (chunk) => {
			if (typeof chunk === "string") responseBody += chunk;
		});
		req.on("end", () => {
			finish({
				status: statusCode,
				apnsId,
				body: responseBody
			});
		});
		req.on("error", (err) => fail(err));
		req.end(body);
	});
}
function resolveApnsTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1e3, Math.trunc(timeoutMs)) : DEFAULT_APNS_TIMEOUT_MS;
}
function resolveDirectSendContext(params) {
	const token = normalizeApnsToken(params.registration.token);
	if (!isLikelyApnsToken(token)) throw new Error("invalid APNs token");
	const topic = normalizeTopic(params.registration.topic);
	if (!isValidTopic(topic)) throw new Error("topic required");
	return {
		token,
		topic,
		environment: params.registration.environment,
		bearerToken: getApnsBearerToken(params.auth)
	};
}
function toPushMetadata(params) {
	return {
		kind: params.kind,
		nodeId: params.nodeId,
		ts: Date.now(),
		...params.reason ? { reason: params.reason } : {}
	};
}
function resolveRegistrationDebugSuffix(registration, relayResult) {
	if (registration.transport === "direct") return registration.token.slice(-8);
	return relayResult?.tokenSuffix ?? registration.tokenDebugSuffix ?? registration.relayHandle.slice(-8);
}
function toPushResult(params) {
	const response = "body" in params.response ? {
		ok: params.response.status === 200,
		status: params.response.status,
		apnsId: params.response.apnsId,
		reason: parseReason(params.response.body),
		environment: params.registration.environment,
		tokenSuffix: params.tokenSuffix
	} : params.response;
	return {
		ok: response.ok,
		status: response.status,
		apnsId: response.apnsId,
		reason: response.reason,
		tokenSuffix: params.tokenSuffix ?? resolveRegistrationDebugSuffix(params.registration, "tokenSuffix" in response ? response : void 0),
		topic: params.registration.topic,
		environment: params.registration.transport === "relay" ? "production" : response.environment,
		transport: params.registration.transport
	};
}
async function sendDirectApnsPush(params) {
	const { token, topic, environment, bearerToken } = resolveDirectSendContext({
		auth: params.auth,
		registration: params.registration
	});
	const response = await (params.requestSender ?? sendApnsRequest)({
		token,
		topic,
		environment,
		bearerToken,
		payload: params.payload,
		timeoutMs: resolveApnsTimeoutMs(params.timeoutMs),
		pushType: params.pushType,
		priority: params.priority
	});
	return toPushResult({
		registration: params.registration,
		response,
		tokenSuffix: token.slice(-8)
	});
}
async function sendRelayApnsPush(params) {
	const response = await sendApnsRelayPush({
		relayConfig: params.relayConfig,
		sendGrant: params.registration.sendGrant,
		relayHandle: params.registration.relayHandle,
		payload: params.payload,
		pushType: params.pushType,
		priority: params.priority,
		gatewayIdentity: params.gatewayIdentity,
		requestSender: params.requestSender
	});
	return toPushResult({
		registration: params.registration,
		response
	});
}
function createAlertPayload(params) {
	return {
		aps: {
			alert: {
				title: params.title,
				body: params.body
			},
			sound: "default"
		},
		openclaw: toPushMetadata({
			kind: "push.test",
			nodeId: params.nodeId
		})
	};
}
function createBackgroundPayload(params) {
	return {
		aps: { "content-available": 1 },
		openclaw: toPushMetadata({
			kind: "node.wake",
			reason: params.wakeReason ?? "node.invoke",
			nodeId: params.nodeId
		})
	};
}
async function sendApnsAlert(params) {
	const payload = createAlertPayload({
		nodeId: params.nodeId,
		title: params.title,
		body: params.body
	});
	if (params.registration.transport === "relay") {
		const relayParams = params;
		return await sendRelayApnsPush({
			relayConfig: relayParams.relayConfig,
			registration: relayParams.registration,
			payload,
			pushType: "alert",
			priority: "10",
			gatewayIdentity: relayParams.relayGatewayIdentity,
			requestSender: relayParams.relayRequestSender
		});
	}
	const directParams = params;
	return await sendDirectApnsPush({
		auth: directParams.auth,
		registration: directParams.registration,
		payload,
		timeoutMs: directParams.timeoutMs,
		requestSender: directParams.requestSender,
		pushType: "alert",
		priority: "10"
	});
}
async function sendApnsBackgroundWake(params) {
	const payload = createBackgroundPayload({
		nodeId: params.nodeId,
		wakeReason: params.wakeReason
	});
	if (params.registration.transport === "relay") {
		const relayParams = params;
		return await sendRelayApnsPush({
			relayConfig: relayParams.relayConfig,
			registration: relayParams.registration,
			payload,
			pushType: "background",
			priority: "5",
			gatewayIdentity: relayParams.relayGatewayIdentity,
			requestSender: relayParams.relayRequestSender
		});
	}
	const directParams = params;
	return await sendDirectApnsPush({
		auth: directParams.auth,
		registration: directParams.registration,
		payload,
		timeoutMs: directParams.timeoutMs,
		requestSender: directParams.requestSender,
		pushType: "background",
		priority: "5"
	});
}
//#endregion
export { resolveApnsAuthConfigFromEnv as a, shouldClearStoredApnsRegistration as c, parseMessageWithAttachments as d, formatForLog as f, setGatewayWsLogStyle as g, summarizeAgentEventForWsLog as h, registerApnsRegistration as i, resolveApnsRelayConfigFromEnv as l, shouldLogWs as m, loadApnsRegistration as n, sendApnsAlert as o, logWs as p, normalizeApnsEnvironment as r, sendApnsBackgroundWake as s, clearApnsRegistrationIfCurrent as t, normalizeRpcAttachmentsToChatAttachments as u };
