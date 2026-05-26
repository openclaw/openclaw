import { i as formatErrorMessage$1 } from "./errors-b3ZrCRlt.js";
import { n as detectMime } from "./mime-DppuT-pZ.js";
import { a as generateSecureUuid } from "./secure-random-BxnbXS5x.js";
import { n as readResponseWithLimit } from "./read-response-with-limit-S6PVjcFB.js";
import "./error-runtime-DGHc7DZw.js";
import { t as resolveFetch } from "./fetch-CN0jBepr.js";
import "./fetch-runtime-BTAr6cKn.js";
import "./core-kXuNbs5U.js";
import "./media-runtime-BheBFFxc.js";
import path from "node:path";
import fs from "node:fs/promises";
import WebSocket from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
import http from "node:http";
import https from "node:https";
//#region extensions/signal/src/client-container.ts
/**
* Signal client for bbernhard/signal-cli-rest-api container.
* Uses WebSocket for receiving messages and REST API for sending.
*
* This is a separate implementation from client.ts (native signal-cli)
* to keep the two modes cleanly isolated.
*/
const DEFAULT_TIMEOUT_MS$2 = 1e4;
const DEFAULT_ATTACHMENT_RESPONSE_MAX_BYTES = 1048576;
const CONTAINER_TEXT_STYLE_MARKERS = {
	BOLD: "**",
	ITALIC: "*",
	STRIKETHROUGH: "~",
	MONOSPACE: "`",
	SPOILER: "||"
};
function normalizeBaseUrl$1(url) {
	const trimmed = url.trim();
	if (!trimmed) throw new Error("Signal base URL is required");
	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	const parsed = new URL(withProtocol);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Signal base URL unsupported protocol: ${parsed.protocol}`);
	if (parsed.username || parsed.password) throw new Error("Signal base URL must not include credentials");
	const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}
async function fetchWithTimeout(url, init, timeoutMs) {
	const fetchImpl = resolveFetch();
	if (!fetchImpl) throw new Error("fetch is not available");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}
function normalizeMaxResponseBytes(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_ATTACHMENT_RESPONSE_MAX_BYTES;
	return Math.floor(value);
}
function readContentLength(res) {
	const raw = res.headers?.get("content-length");
	if (!raw) return;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
async function readCappedResponseBuffer(res, maxResponseBytes) {
	const contentLength = readContentLength(res);
	if (contentLength !== void 0 && contentLength > maxResponseBytes) throw new Error("Signal REST attachment exceeded size limit");
	return await readResponseWithLimit(res, maxResponseBytes, { onOverflow: () => /* @__PURE__ */ new Error("Signal REST attachment exceeded size limit") });
}
/**
* Check if bbernhard container REST API is available.
*/
async function containerCheck(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS$2, account) {
	const normalized = normalizeBaseUrl$1(baseUrl);
	try {
		const res = await fetchWithTimeout(`${normalized}/v1/about`, { method: "GET" }, timeoutMs);
		if (!res.ok) return {
			ok: false,
			status: res.status,
			error: `HTTP ${res.status}`
		};
		const receiveAccount = account?.trim();
		if (receiveAccount) return await containerReceiveCheck(normalized, receiveAccount, timeoutMs);
		return {
			ok: true,
			status: res.status,
			error: null
		};
	} catch (err) {
		return {
			ok: false,
			status: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function containerReceiveCheck(normalizedBaseUrl, account, timeoutMs) {
	const wsUrl = `${normalizedBaseUrl.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(account)}`;
	return new Promise((resolve) => {
		let settled = false;
		let ws;
		const timer = setTimeout(() => {
			settle({
				ok: false,
				status: null,
				error: "Signal container receive WebSocket timed out"
			});
			ws?.terminate();
		}, timeoutMs);
		timer.unref?.();
		const settle = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		try {
			ws = new WebSocket(wsUrl);
		} catch (err) {
			settle({
				ok: false,
				status: null,
				error: err instanceof Error ? err.message : String(err)
			});
			return;
		}
		ws.once("open", () => {
			settle({
				ok: true,
				status: 101,
				error: null
			});
			ws?.close();
		});
		ws.once("unexpected-response", (_request, response) => {
			settle({
				ok: false,
				status: response.statusCode ?? null,
				error: `Signal container receive endpoint did not upgrade to WebSocket (HTTP ${response.statusCode ?? "unknown"})`
			});
			ws?.terminate();
		});
		ws.once("error", (err) => {
			settle({
				ok: false,
				status: null,
				error: err instanceof Error ? err.message : String(err)
			});
		});
	});
}
/**
* Make a REST API request to bbernhard container.
*/
async function containerRestRequest(endpoint, opts, method = "GET", body) {
	const url = `${normalizeBaseUrl$1(opts.baseUrl)}${endpoint}`;
	const init = {
		method,
		headers: { "Content-Type": "application/json" }
	};
	if (body) init.body = JSON.stringify(body);
	const res = await fetchWithTimeout(url, init, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$2);
	if (res.status === 204) return;
	if (!res.ok) {
		const errorText = await res.text().catch(() => "");
		throw new Error(`Signal REST ${res.status}: ${errorText || res.statusText}`);
	}
	const text = await res.text();
	if (!text) return;
	return JSON.parse(text);
}
/**
* Fetch attachment binary from bbernhard container.
*/
async function containerFetchAttachment(attachmentId, opts) {
	const res = await fetchWithTimeout(`${normalizeBaseUrl$1(opts.baseUrl)}/v1/attachments/${encodeURIComponent(attachmentId)}`, { method: "GET" }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$2);
	if (!res.ok) return null;
	return readCappedResponseBuffer(res, normalizeMaxResponseBytes(opts.maxResponseBytes));
}
/**
* Stream messages using WebSocket from bbernhard container.
* The Promise resolves when the connection closes (for any reason).
* The caller (runSignalLoopAdapter) is responsible for reconnection.
*/
async function streamContainerEvents(params) {
	const normalized = normalizeBaseUrl$1(params.baseUrl);
	const wsUrl = `${normalized.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(params.account ?? "")}`;
	const redactedWsUrl = `${normalized.replace(/^http/, "ws")}/v1/receive/<redacted>`;
	const log = params.logger?.log ?? (() => {});
	const logError = params.logger?.error ?? (() => {});
	log(`[signal-ws] connecting to ${redactedWsUrl}`);
	return new Promise((resolve, reject) => {
		let ws;
		let resolved = false;
		let abortHandler;
		const cleanup = () => {
			if (resolved) return;
			resolved = true;
			if (abortHandler) {
				params.abortSignal?.removeEventListener("abort", abortHandler);
				abortHandler = void 0;
			}
		};
		try {
			ws = new WebSocket(wsUrl);
		} catch (err) {
			logError(`[signal-ws] failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`);
			reject(err);
			return;
		}
		ws.on("open", () => {
			log("[signal-ws] connected");
		});
		ws.on("message", (data) => {
			try {
				const text = data.toString();
				const envelope = JSON.parse(text);
				if (envelope) params.onEvent(envelope);
			} catch (err) {
				logError(`[signal-ws] parse error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		ws.on("error", (err) => {
			logError(`[signal-ws] error: ${err instanceof Error ? err.message : String(err)}`);
		});
		ws.on("close", (code, reason) => {
			log(`[signal-ws] closed (code=${code}, reason=${reason?.toString() || "no reason"})`);
			cleanup();
			resolve();
		});
		ws.on("ping", () => {
			log("[signal-ws] ping received");
		});
		ws.on("pong", () => {
			log("[signal-ws] pong received");
		});
		if (params.abortSignal) {
			abortHandler = () => {
				log("[signal-ws] aborted, closing connection");
				cleanup();
				ws.close();
				resolve();
			};
			params.abortSignal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}
/**
* Convert local file paths to base64 data URIs for the container REST API.
* The bbernhard container /v2/send only accepts `base64_attachments` (not file paths).
*/
async function filesToBase64DataUris(filePaths) {
	const results = [];
	for (const filePath of filePaths) {
		const buffer = await fs.readFile(filePath);
		const mime = await detectMime({
			buffer,
			filePath
		}) ?? "application/octet-stream";
		const filename = path.basename(filePath);
		const b64 = buffer.toString("base64");
		results.push(`data:${mime};filename=${filename};base64,${b64}`);
	}
	return results;
}
function escapeContainerStyledText(text) {
	return text.replace(/[*~`|]/g, (char) => `\\${char}`);
}
function renderContainerStyledText(text, styles) {
	const spans = styles.map((style) => {
		const marker = CONTAINER_TEXT_STYLE_MARKERS[style.style];
		if (!marker) return null;
		const start = Math.max(0, Math.min(style.start, text.length));
		const end = Math.max(start, Math.min(style.start + style.length, text.length));
		if (end <= start) return null;
		return {
			start,
			end,
			marker
		};
	}).filter((span) => span !== null);
	if (spans.length === 0) return text;
	const positions = [...new Set([
		0,
		text.length,
		...spans.flatMap((span) => [span.start, span.end])
	])].toSorted((a, b) => a - b);
	let rendered = "";
	for (let i = 0; i < positions.length; i += 1) {
		const pos = positions[i];
		for (const span of spans.filter((candidate) => candidate.end === pos).toSorted((a, b) => b.start - a.start)) rendered += span.marker;
		for (const span of spans.filter((candidate) => candidate.start === pos).toSorted((a, b) => b.end - a.end)) rendered += span.marker;
		const next = positions[i + 1];
		if (next !== void 0 && next > pos) rendered += escapeContainerStyledText(text.slice(pos, next));
	}
	return rendered;
}
function parseContainerSendTimestamp(raw) {
	if (raw == null) return;
	const timestamp = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
	if (!Number.isFinite(timestamp)) throw new Error("Signal REST send returned invalid timestamp");
	return timestamp;
}
/**
* Send message via bbernhard container REST API.
*/
async function containerSendMessage(params) {
	const payload = {
		message: params.message,
		number: params.account,
		recipients: params.recipients
	};
	if (params.textStyles && params.textStyles.length > 0) {
		payload.message = renderContainerStyledText(params.message, params.textStyles);
		payload["text_mode"] = "styled";
	}
	if (params.attachments && params.attachments.length > 0) payload.base64_attachments = await filesToBase64DataUris(params.attachments);
	const timestamp = parseContainerSendTimestamp((await containerRestRequest("/v2/send", {
		baseUrl: params.baseUrl,
		timeoutMs: params.timeoutMs
	}, "POST", payload))?.timestamp);
	return timestamp === void 0 ? {} : { timestamp };
}
/**
* Send typing indicator via bbernhard container REST API.
*/
async function containerSendTyping(params) {
	const method = params.stop ? "DELETE" : "PUT";
	await containerRestRequest(`/v1/typing-indicator/${encodeURIComponent(params.account)}`, {
		baseUrl: params.baseUrl,
		timeoutMs: params.timeoutMs
	}, method, { recipient: params.recipient });
	return true;
}
/**
* Send read receipt via bbernhard container REST API.
*/
async function containerSendReceipt(params) {
	await containerRestRequest(`/v1/receipts/${encodeURIComponent(params.account)}`, {
		baseUrl: params.baseUrl,
		timeoutMs: params.timeoutMs
	}, "POST", {
		recipient: params.recipient,
		timestamp: params.timestamp,
		receipt_type: params.type ?? "read"
	});
	return true;
}
/**
* Send a reaction to a message via bbernhard container REST API.
*/
async function containerSendReaction(params) {
	const payload = {
		recipient: params.recipient,
		reaction: params.emoji,
		target_author: params.targetAuthor,
		timestamp: params.targetTimestamp
	};
	if (params.groupId) payload.group_id = params.groupId;
	return await containerRestRequest(`/v1/reactions/${encodeURIComponent(params.account)}`, {
		baseUrl: params.baseUrl,
		timeoutMs: params.timeoutMs
	}, "POST", payload) ?? {};
}
/**
* Remove a reaction from a message via bbernhard container REST API.
*/
async function containerRemoveReaction(params) {
	const payload = {
		recipient: params.recipient,
		reaction: params.emoji,
		target_author: params.targetAuthor,
		timestamp: params.targetTimestamp
	};
	if (params.groupId) payload.group_id = params.groupId;
	return await containerRestRequest(`/v1/reactions/${encodeURIComponent(params.account)}`, {
		baseUrl: params.baseUrl,
		timeoutMs: params.timeoutMs
	}, "DELETE", payload) ?? {};
}
/**
* Strip the "uuid:" prefix that native signal-cli accepts but the container API rejects.
*/
function stripUuidPrefix(id) {
	return id.startsWith("uuid:") ? id.slice(5) : id;
}
/**
* Convert a group internal_id to the container-expected format.
* The bbernhard container expects groups as "group.{base64(internal_id)}".
*/
function formatGroupIdForContainer(groupId) {
	if (groupId.startsWith("group.")) return groupId;
	return `group.${Buffer.from(groupId).toString("base64")}`;
}
/**
* Drop-in replacement for native signalRpcRequest that translates
* JSON-RPC method + params into the equivalent container REST API calls.
* This keeps all container protocol details (uuid: stripping, group ID
* formatting, base64 attachments, text-style conversion) isolated here.
*/
async function containerRpcRequest(method, params, opts) {
	const p = params ?? {};
	switch (method) {
		case "send": {
			const recipients = (p.recipient ?? []).map(stripUuidPrefix);
			const usernames = (p.username ?? []).map(stripUuidPrefix);
			const groupId = p.groupId;
			const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : void 0;
			const finalRecipients = recipients.length > 0 ? recipients : usernames.length > 0 ? usernames : formattedGroupId ? [formattedGroupId] : [];
			const textStyles = p["text-style"]?.map((s) => {
				const [start, length, style] = s.split(":");
				return {
					start: Number(start),
					length: Number(length),
					style
				};
			});
			return await containerSendMessage({
				baseUrl: opts.baseUrl,
				account: p.account ?? "",
				recipients: finalRecipients,
				message: p.message ?? "",
				textStyles,
				attachments: p.attachments,
				timeoutMs: opts.timeoutMs
			});
		}
		case "sendTyping": {
			const recipient = stripUuidPrefix(p.recipient?.[0] ?? (p.groupId ? formatGroupIdForContainer(p.groupId) : ""));
			await containerSendTyping({
				baseUrl: opts.baseUrl,
				account: p.account ?? "",
				recipient,
				stop: p.stop,
				timeoutMs: opts.timeoutMs
			});
			return;
		}
		case "sendReceipt": {
			const recipient = stripUuidPrefix(p.recipient?.[0] ?? "");
			await containerSendReceipt({
				baseUrl: opts.baseUrl,
				account: p.account ?? "",
				recipient,
				timestamp: p.targetTimestamp,
				type: p.type,
				timeoutMs: opts.timeoutMs
			});
			return;
		}
		case "sendReaction": {
			const recipient = stripUuidPrefix(p.recipients?.[0] ?? "");
			const groupId = p.groupIds?.[0] ?? void 0;
			const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : void 0;
			const effectiveRecipient = formattedGroupId || recipient || "";
			const reactionParams = {
				baseUrl: opts.baseUrl,
				account: p.account ?? "",
				recipient: effectiveRecipient,
				emoji: p.emoji ?? "",
				targetAuthor: stripUuidPrefix(p.targetAuthor ?? recipient),
				targetTimestamp: p.targetTimestamp,
				groupId: formattedGroupId,
				timeoutMs: opts.timeoutMs
			};
			return await (p.remove ? containerRemoveReaction : containerSendReaction)(reactionParams);
		}
		case "getAttachment": {
			const attachmentId = p.id;
			const buffer = await containerFetchAttachment(attachmentId, {
				baseUrl: opts.baseUrl,
				timeoutMs: opts.timeoutMs,
				maxResponseBytes: opts.maxResponseBytes
			});
			if (!buffer) return { data: void 0 };
			return { data: buffer.toString("base64") };
		}
		case "version": return await containerRestRequest("/v1/about", {
			baseUrl: opts.baseUrl,
			timeoutMs: opts.timeoutMs
		});
		default: throw new Error(`Unsupported container RPC method: ${method}`);
	}
}
//#endregion
//#region extensions/signal/src/client.ts
const DEFAULT_TIMEOUT_MS$1 = 1e4;
const DEFAULT_SIGNAL_HTTP_RESPONSE_MAX_BYTES = 1048576;
const MAX_SIGNAL_SSE_BUFFER_BYTES = 1048576;
const MAX_SIGNAL_SSE_EVENT_DATA_BYTES = 1048576;
function createSignalSseAbortError() {
	const error = /* @__PURE__ */ new Error("Signal SSE aborted");
	error.name = "AbortError";
	return error;
}
function normalizeBaseUrl(url) {
	const trimmed = url.trim();
	if (!trimmed) throw new Error("Signal base URL is required");
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
	return `http://${trimmed}`.replace(/\/+$/, "");
}
function parseSignalBaseUrl(url) {
	const parsed = new URL(normalizeBaseUrl(url));
	if (parsed.username || parsed.password) throw new Error("Signal base URL must not include credentials");
	return parsed;
}
function resolveSignalEndpointUrl(baseUrl, pathname) {
	return new URL(pathname, parseSignalBaseUrl(baseUrl));
}
function parseSignalRpcResponse(text, status) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`Signal RPC returned malformed JSON (status ${status})`, { cause: err });
	}
	if (!parsed || typeof parsed !== "object") throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
	const rpc = parsed;
	const hasResult = Object.hasOwn(rpc, "result");
	if (!rpc.error && !hasResult) throw new Error(`Signal RPC returned invalid response envelope (status ${status})`);
	return rpc;
}
function assertSignalHttpProtocol(url, label) {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Signal ${label} unsupported protocol: ${url.protocol}`);
}
function normalizeSignalHttpResponseMaxBytes(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SIGNAL_HTTP_RESPONSE_MAX_BYTES;
	return Math.floor(value);
}
function normalizeSignalSseTimeoutMs(timeoutMs) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
	return timeoutMs;
}
function requestSignalHttpText(url, options) {
	assertSignalHttpProtocol(url, "HTTP");
	const client = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		let settled = false;
		let request;
		const deadline = setTimeout(() => {
			request?.destroy(/* @__PURE__ */ new Error(`Signal HTTP exceeded deadline after ${options.timeoutMs}ms`));
		}, options.timeoutMs);
		deadline.unref?.();
		const cleanup = () => {
			clearTimeout(deadline);
			request?.setTimeout(0);
		};
		const rejectOnce = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const resolveOnce = (response) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};
		const maxResponseBytes = normalizeSignalHttpResponseMaxBytes(options.maxResponseBytes);
		request = client.request(url, {
			method: options.method,
			headers: options.headers
		}, (res) => {
			const chunks = [];
			let totalBytes = 0;
			res.on("data", (chunk) => {
				const next = typeof chunk === "string" ? Buffer$1.from(chunk) : chunk;
				totalBytes += next.byteLength;
				if (totalBytes > maxResponseBytes) {
					const error = /* @__PURE__ */ new Error("Signal HTTP response exceeded size limit");
					request?.destroy(error);
					res.destroy(error);
					rejectOnce(error);
					return;
				}
				chunks.push(next);
			});
			res.on("error", rejectOnce);
			res.on("end", () => {
				resolveOnce({
					status: res.statusCode ?? 0,
					statusText: res.statusMessage || "error",
					text: Buffer$1.concat(chunks).toString("utf8")
				});
			});
		});
		request.setTimeout(options.timeoutMs, () => {
			request?.destroy(/* @__PURE__ */ new Error(`Signal HTTP timed out after ${options.timeoutMs}ms`));
		});
		request.on("error", rejectOnce);
		if (options.body !== void 0) request.write(options.body);
		request.end();
	});
}
async function signalRpcRequest$1(method, params, opts) {
	const id = generateSecureUuid();
	const body = JSON.stringify({
		jsonrpc: "2.0",
		method,
		params,
		id
	});
	const res = await requestSignalHttpText(resolveSignalEndpointUrl(opts.baseUrl, "/api/v1/rpc"), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": String(Buffer$1.byteLength(body))
		},
		body,
		timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS$1,
		maxResponseBytes: opts.maxResponseBytes
	});
	if (res.status === 201) return;
	if (!res.text) throw new Error(`Signal RPC empty response (status ${res.status})`);
	const parsed = parseSignalRpcResponse(res.text, res.status);
	if (parsed.error) {
		const code = parsed.error.code ?? "unknown";
		const msg = parsed.error.message ?? "Signal RPC error";
		throw new Error(`Signal RPC ${code}: ${msg}`);
	}
	return parsed.result;
}
async function signalCheck$1(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS$1) {
	try {
		const res = await requestSignalHttpText(resolveSignalEndpointUrl(baseUrl, "/api/v1/check"), {
			method: "GET",
			timeoutMs
		});
		if (res.status < 200 || res.status >= 300) return {
			ok: false,
			status: res.status,
			error: `HTTP ${res.status}`
		};
		return {
			ok: true,
			status: res.status,
			error: null
		};
	} catch (err) {
		return {
			ok: false,
			status: null,
			error: formatErrorMessage$1(err)
		};
	}
}
function openSignalEventStream(url, abortSignal, timeoutMs = DEFAULT_TIMEOUT_MS$1) {
	assertSignalHttpProtocol(url, "SSE");
	if (abortSignal?.aborted) throw createSignalSseAbortError();
	const client = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		let settled = false;
		let response;
		let onAbort = () => {};
		let request;
		const effectiveTimeoutMs = normalizeSignalSseTimeoutMs(timeoutMs);
		const headerDeadline = effectiveTimeoutMs === null ? void 0 : setTimeout(() => {
			const error = /* @__PURE__ */ new Error(`Signal SSE connection timed out after ${effectiveTimeoutMs}ms`);
			response?.destroy(error);
			request.destroy(error);
			rejectOnce(error);
		}, effectiveTimeoutMs);
		headerDeadline?.unref?.();
		const cleanup = () => {
			if (headerDeadline) clearTimeout(headerDeadline);
			abortSignal?.removeEventListener("abort", onAbort);
		};
		const rejectOnce = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		request = client.request(url, {
			method: "GET",
			headers: { Accept: "text/event-stream" }
		}, (res) => {
			const status = res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				res.resume();
				rejectOnce(/* @__PURE__ */ new Error(`Signal SSE failed (${status} ${res.statusMessage || "error"})`));
				return;
			}
			if (settled) {
				res.destroy();
				return;
			}
			if (headerDeadline) clearTimeout(headerDeadline);
			settled = true;
			response = res;
			resolve({
				response: res,
				cleanup
			});
		});
		onAbort = () => {
			const error = createSignalSseAbortError();
			response?.destroy(error);
			request.destroy(error);
			rejectOnce(error);
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		request.on("error", rejectOnce);
		request.end();
	});
}
async function streamSignalEvents$1(params) {
	const url = resolveSignalEndpointUrl(params.baseUrl, "/api/v1/events");
	if (params.account) url.searchParams.set("account", params.account);
	const { response, cleanup } = await openSignalEventStream(url, params.abortSignal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS$1);
	const decoder = new TextDecoder();
	let buffer = "";
	let bufferedBytes = 0;
	let currentEvent = {};
	let currentEventDataBytes = 0;
	const flushEvent = () => {
		if (!currentEvent.data && !currentEvent.event && !currentEvent.id) return;
		params.onEvent({
			event: currentEvent.event,
			data: currentEvent.data,
			id: currentEvent.id
		});
		currentEvent = {};
		currentEventDataBytes = 0;
	};
	const processLine = (line) => {
		if (line === "") {
			flushEvent();
			return;
		}
		if (line.startsWith(":")) return;
		const [rawField, ...rest] = line.split(":");
		const field = rawField.trim();
		const rawValue = rest.join(":");
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
		if (field === "event") currentEvent.event = value;
		else if (field === "data") {
			const segment = currentEvent.data ? `\n${value}` : value;
			currentEventDataBytes += Buffer$1.byteLength(segment, "utf8");
			if (currentEventDataBytes > MAX_SIGNAL_SSE_EVENT_DATA_BYTES) throw new Error("Signal SSE event data exceeded size limit");
			currentEvent.data = currentEvent.data ? `${currentEvent.data}${segment}` : segment;
		} else if (field === "id") currentEvent.id = value;
	};
	const drainCompleteLines = () => {
		let lineEnd = buffer.indexOf("\n");
		while (lineEnd !== -1) {
			let line = buffer.slice(0, lineEnd);
			buffer = buffer.slice(lineEnd + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			processLine(line);
			lineEnd = buffer.indexOf("\n");
		}
		bufferedBytes = Buffer$1.byteLength(buffer, "utf8");
	};
	try {
		for await (const chunk of response) {
			const value = typeof chunk === "string" ? Buffer$1.from(chunk) : chunk;
			bufferedBytes += value.byteLength;
			if (bufferedBytes > MAX_SIGNAL_SSE_BUFFER_BYTES) throw new Error("Signal SSE buffer exceeded size limit");
			buffer += decoder.decode(value, { stream: true });
			drainCompleteLines();
		}
		const tail = decoder.decode();
		if (tail) {
			buffer += tail;
			bufferedBytes = Buffer$1.byteLength(buffer, "utf8");
		}
		if (bufferedBytes > MAX_SIGNAL_SSE_BUFFER_BYTES) throw new Error("Signal SSE buffer exceeded size limit");
		drainCompleteLines();
	} finally {
		cleanup();
	}
	flushEvent();
}
//#endregion
//#region extensions/signal/src/client-adapter.ts
/**
* Signal client adapter - unified interface for both native signal-cli and bbernhard container.
*
* This adapter provides a single API that routes to the appropriate implementation
* based on the configured API mode. Exports mirror client.ts names so consumers
* only need to change their import path.
*/
const DEFAULT_TIMEOUT_MS = 1e4;
const MODE_CACHE_TTL_MS = 3e4;
const detectedModeCache = /* @__PURE__ */ new Map();
function resolveConfiguredApiMode(configured) {
	if (configured === "native" || configured === "container") return configured;
	return "auto";
}
function formatErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function resolveAutoProbeTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}
async function resolveAutoApiMode(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
	const cached = detectedModeCache.get(baseUrl);
	if (cached && cached.expiresAt > Date.now()) {
		if (cached.mode !== "container" || !options.requireContainerReceive || cached.receiveAccount === options.account) return cached.mode;
	}
	const detected = await detectSignalApiMode(baseUrl, timeoutMs, options);
	detectedModeCache.set(baseUrl, {
		mode: detected,
		expiresAt: Date.now() + MODE_CACHE_TTL_MS,
		...detected === "container" && options.requireContainerReceive && options.account ? { receiveAccount: options.account } : {}
	});
	return detected;
}
async function resolveApiModeForOperation(params) {
	const configured = resolveConfiguredApiMode(params.apiMode);
	if (configured === "native" || configured === "container") return configured;
	return resolveAutoApiMode(params.baseUrl, params.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
		account: params.account,
		requireContainerReceive: params.requireContainerReceive
	});
}
/**
* Detect which Signal API mode is available by probing endpoints.
* First endpoint to respond OK wins.
*/
async function detectSignalApiMode(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
	const nativePromise = signalCheck$1(baseUrl, timeoutMs).then((r) => r.ok ? "native" : Promise.reject(/* @__PURE__ */ new Error("native not ok")));
	const containerAccount = options.requireContainerReceive ? options.account?.trim() : void 0;
	const containerPromise = containerAccount ? containerCheck(baseUrl, timeoutMs, containerAccount).then((r) => r.ok ? "container" : Promise.reject(/* @__PURE__ */ new Error("container not ok"))) : options.requireContainerReceive ? Promise.reject(/* @__PURE__ */ new Error("container receive account required")) : containerCheck(baseUrl, timeoutMs).then((r) => r.ok ? "container" : Promise.reject(/* @__PURE__ */ new Error("container not ok")));
	try {
		return await Promise.any([nativePromise, containerPromise]);
	} catch {
		throw new Error(`Signal API not reachable at ${baseUrl}`);
	}
}
/**
* Drop-in replacement for native signalRpcRequest.
* Routes to native JSON-RPC or container REST based on config.
*/
async function signalRpcRequest(method, params, opts) {
	if (await resolveApiModeForOperation({
		baseUrl: opts.baseUrl,
		accountId: opts.accountId,
		account: typeof params?.account === "string" ? params.account : void 0,
		timeoutMs: opts.timeoutMs,
		apiMode: opts.apiMode
	}) === "native") return signalRpcRequest$1(method, params, opts);
	return containerRpcRequest(method, params, opts);
}
/**
* Drop-in replacement for native signalCheck.
*/
async function signalCheck(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
	const configured = resolveConfiguredApiMode(options.apiMode);
	const mode = configured === "auto" ? await resolveAutoApiMode(baseUrl, timeoutMs).catch((error) => {
		return {
			ok: false,
			status: null,
			error: formatErrorMessage(error)
		};
	}) : configured;
	if (typeof mode !== "string") return mode;
	if (mode === "container") return containerCheck(baseUrl, timeoutMs);
	return signalCheck$1(baseUrl, timeoutMs);
}
/**
* Drop-in replacement for native streamSignalEvents.
* Container mode uses WebSocket; native uses SSE.
*/
async function streamSignalEvents(params) {
	if (await resolveApiModeForOperation({
		baseUrl: params.baseUrl,
		accountId: params.accountId,
		account: params.account,
		requireContainerReceive: true,
		timeoutMs: resolveAutoProbeTimeoutMs(params.timeoutMs),
		apiMode: params.apiMode
	}) === "container") return streamContainerEvents({
		baseUrl: params.baseUrl,
		account: params.account,
		abortSignal: params.abortSignal,
		timeoutMs: params.timeoutMs,
		onEvent: (event) => params.onEvent({
			event: "receive",
			data: JSON.stringify(event)
		}),
		logger: params.logger
	});
	return streamSignalEvents$1({
		baseUrl: params.baseUrl,
		account: params.account,
		abortSignal: params.abortSignal,
		timeoutMs: params.timeoutMs,
		onEvent: (event) => params.onEvent(event)
	});
}
//#endregion
export { signalRpcRequest as n, streamSignalEvents as r, signalCheck as t };
