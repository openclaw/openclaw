import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey, h as scopeLegacySessionKeyToAgent, l as normalizeAgentId, o as classifySessionKeyShape, s as isUnscopedSessionKeySentinel } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { a as routeLogsToStderr } from "./console-BAPPAj56.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import { l as isGatewayTransportError, r as callGateway, u as randomIdempotencyKey } from "./call-t1U2G3yY.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { r as resolveSessionKeyForRequest, t as buildExplicitSessionIdSessionKey } from "./session-DUinUmLM.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { t as agentCommand } from "./agent-command-QBBzz2Au.js";
import "./agent-DBVvbEwY.js";
import { randomUUID } from "node:crypto";
//#region src/commands/agent-via-gateway.ts
const NO_GATEWAY_TIMEOUT_MS = 2147e6;
const EMBEDDED_FALLBACK_META = {
	transport: "embedded",
	fallbackFrom: "gateway"
};
const GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX = "gateway-fallback-";
const GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [
	1e3,
	2e3,
	5e3,
	1e4,
	15e3
];
const AGENT_CLI_SIGNALS = ["SIGINT", "SIGTERM"];
const GATEWAY_ABORT_RETRY_DELAYS_MS = [
	50,
	150,
	300,
	600
];
const GATEWAY_ABORT_REQUEST_TIMEOUT_MS = 2e3;
const AGENT_CLI_SIGNAL_EXIT_CODES = {
	SIGINT: 130,
	SIGTERM: 143
};
function protectJsonStdout(opts) {
	if (opts.json === true) routeLogsToStderr();
}
function parseTimeoutSeconds(opts) {
	const raw = opts.timeout !== void 0 ? Number.parseInt(opts.timeout, 10) : opts.cfg.agents?.defaults?.timeoutSeconds ?? 600;
	if (Number.isNaN(raw) || raw < 0) throw new Error(`Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.`);
	return raw;
}
function formatPayloadForLog(payload) {
	const parts = resolveSendableOutboundReplyParts({
		text: payload.text,
		mediaUrls: payload.mediaUrls,
		mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : void 0
	});
	const lines = [];
	if (parts.text) lines.push(parts.text.trimEnd());
	for (const url of parts.mediaUrls) lines.push(`MEDIA:${url}`);
	return lines.join("\n").trimEnd();
}
function isGatewayAgentTimeoutError(err) {
	if (isGatewayTransportError(err)) return err.kind === "timeout";
	return err instanceof Error && err.message.includes("gateway request timeout for agent");
}
function isGatewayAgentEmbeddedFallbackError(err) {
	return isGatewayTransportError(err);
}
function isTransientGatewayAgentConnectClose(err) {
	if (!isGatewayTransportError(err) || err.kind !== "closed") return false;
	const code = typeof err.code === "number" ? err.code : void 0;
	const reason = normalizeOptionalString(err.reason);
	return code === 1e3 && (!reason || reason === "no close reason");
}
function validateExplicitSessionKeyForDispatch(opts) {
	const sessionKey = opts.sessionKey?.trim();
	if (!sessionKey) return;
	if (classifySessionKeyShape(sessionKey) === "malformed_agent") throw new Error(`Invalid --session-key "${sessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`);
	const agentIdRaw = opts.agent?.trim() || void 0;
	if (!agentIdRaw || classifySessionKeyShape(sessionKey) !== "agent") return;
	const agentId = normalizeAgentId(agentIdRaw);
	const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);
	if (sessionAgentId !== agentId) throw new Error(`Agent id "${agentIdRaw}" does not match session key agent "${sessionAgentId}".`);
}
function normalizeSessionKeyOptsForDispatch(opts) {
	const rawSessionKey = opts.sessionKey?.trim();
	const isLegacySessionKey = rawSessionKey && classifySessionKeyShape(rawSessionKey) === "legacy_or_alias";
	const agentIdRaw = opts.agent?.trim();
	const shouldScopeDefaultAgentKey = isLegacySessionKey && !agentIdRaw && !isUnscopedSessionKeySentinel(rawSessionKey);
	const cfg = isLegacySessionKey && (agentIdRaw || shouldScopeDefaultAgentKey) ? getRuntimeConfig() : void 0;
	const sessionKey = scopeLegacySessionKeyToAgent({
		agentId: agentIdRaw ?? (shouldScopeDefaultAgentKey ? resolveDefaultAgentId(cfg) : void 0),
		sessionKey: opts.sessionKey,
		mainKey: cfg?.session?.mainKey
	});
	if (sessionKey === opts.sessionKey) return opts;
	return {
		...opts,
		sessionKey
	};
}
function isAbortError(err) {
	return err instanceof Error && err.name === "AbortError";
}
function readAcceptedRunContext(payload) {
	if (!payload || typeof payload !== "object") return {};
	const runId = payload.runId;
	const sessionKey = payload.sessionKey;
	if (payload.status !== "accepted") return {};
	return {
		runId: typeof runId === "string" && runId.trim() ? runId.trim() : void 0,
		sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : void 0
	};
}
function createAgentCliSignalBridge(processLike = process) {
	const controller = new AbortController();
	let receivedSignal;
	const handlers = /* @__PURE__ */ new Map();
	const detachHandlers = () => {
		for (const [signal, handler] of handlers) processLike.off(signal, handler);
		handlers.clear();
	};
	for (const signal of AGENT_CLI_SIGNALS) {
		const handler = () => {
			receivedSignal = signal;
			if (!controller.signal.aborted) {
				controller.abort();
				detachHandlers();
			}
		};
		handlers.set(signal, handler);
		processLike.on(signal, handler);
	}
	return {
		signal: controller.signal,
		getReceivedSignal: () => receivedSignal,
		dispose: detachHandlers
	};
}
function isAgentCliProcessLike(value) {
	return Boolean(value) && typeof value === "object" && typeof value.on === "function" && typeof value.off === "function";
}
function resolveAgentCliProcessLike(deps) {
	if (!deps || !Object.prototype.hasOwnProperty.call(deps, "process")) return process;
	const processLike = deps.process;
	return isAgentCliProcessLike(processLike) ? processLike : process;
}
function createAbortDelayError() {
	const err = /* @__PURE__ */ new Error("gateway agent retry aborted");
	err.name = "AbortError";
	return err;
}
function delayMs(ms, signal) {
	if (signal?.aborted) return Promise.reject(createAbortDelayError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortDelayError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function isConfirmedChatAbortResponseForRun(value, runId) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const response = value;
	if (response.aborted !== true) return false;
	if (response.runIds === void 0) return true;
	return Array.isArray(response.runIds) && response.runIds.includes(runId);
}
async function abortAcceptedGatewayAgentRunWithRequest(params) {
	if (!params.signal || !params.runId || !params.sessionKey) return false;
	try {
		if (isConfirmedChatAbortResponseForRun(await params.request("chat.abort", {
			sessionKey: params.sessionKey,
			runId: params.runId
		}, { timeoutMs: GATEWAY_ABORT_REQUEST_TIMEOUT_MS }), params.runId)) return true;
		if (params.logFailure !== false) params.runtime.error?.(`Interrupted by ${params.signal}; Gateway run ${params.runId} was not confirmed aborted.`);
		return false;
	} catch (err) {
		if (params.logFailure !== false) params.runtime.error?.(`Interrupted by ${params.signal}; failed to abort Gateway run ${params.runId}: ${String(err)}`);
		return false;
	}
}
async function abortAcceptedGatewayAgentRunWithGatewayCall(params) {
	const request = async (method, requestParams, opts) => await callGateway({
		method,
		params: requestParams,
		timeoutMs: opts?.timeoutMs ?? void 0,
		expectFinal: opts?.expectFinal,
		...params.gatewayIdentity
	});
	for (const [attempt, retryDelayMs] of [...GATEWAY_ABORT_RETRY_DELAYS_MS, 0].entries()) {
		const isFinalAttempt = attempt === GATEWAY_ABORT_RETRY_DELAYS_MS.length;
		if (await abortAcceptedGatewayAgentRunWithRequest({
			runId: params.runId,
			sessionKey: params.sessionKey,
			signal: params.signal,
			runtime: params.runtime,
			request,
			logFailure: isFinalAttempt
		}) || isFinalAttempt) return;
		await delayMs(retryDelayMs);
	}
}
async function abortAcceptedGatewayAgentRunOnActiveConnection(params) {
	for (const [attempt, retryDelayMs] of [...GATEWAY_ABORT_RETRY_DELAYS_MS, 0].entries()) {
		const isFinalAttempt = attempt === GATEWAY_ABORT_RETRY_DELAYS_MS.length;
		const aborted = await abortAcceptedGatewayAgentRunWithRequest({
			runId: params.runId,
			sessionKey: params.sessionKey,
			signal: params.signal,
			runtime: params.runtime,
			request: params.request,
			logFailure: false
		});
		if (aborted || isFinalAttempt) return aborted;
		await delayMs(retryDelayMs);
	}
	return false;
}
function exitForReceivedSignal(signal, runtime) {
	if (!signal) return false;
	runtime.exit(AGENT_CLI_SIGNAL_EXIT_CODES[signal]);
	return true;
}
function returnAfterSignalExit(value, signal, runtime) {
	return exitForReceivedSignal(signal, runtime) ? void 0 : value;
}
function createGatewayTimeoutFallbackSessionId() {
	return `${GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX}${randomUUID()}`;
}
function createGatewayTimeoutFallbackSession(agentId) {
	const sessionId = createGatewayTimeoutFallbackSessionId();
	return {
		sessionId,
		sessionKey: buildExplicitSessionIdSessionKey({
			sessionId,
			agentId
		})
	};
}
function resolveAgentIdForGatewayTimeoutFallback(opts) {
	const explicitSessionKey = opts.sessionKey?.trim();
	if (classifySessionKeyShape(explicitSessionKey) === "agent") return resolveAgentIdFromSessionKey(explicitSessionKey);
	if (isUnscopedSessionKeySentinel(explicitSessionKey)) return resolveDefaultAgentId(getRuntimeConfig());
	const agentIdRaw = opts.agent?.trim();
	if (agentIdRaw) return normalizeAgentId(agentIdRaw);
	if (!opts.to && !opts.sessionId) return;
	const resolvedSessionKey = resolveSessionKeyForRequest({
		cfg: getRuntimeConfig(),
		to: opts.to,
		sessionId: opts.sessionId
	}).sessionKey;
	return classifySessionKeyShape(resolvedSessionKey) === "agent" ? resolveAgentIdFromSessionKey(resolvedSessionKey) : void 0;
}
function buildGatewayJsonResponse(response) {
	const deliveryStatus = response.result?.deliveryStatus;
	if (deliveryStatus === void 0) return response;
	return {
		...response,
		deliveryStatus
	};
}
function isInFlightGatewayAgentResponse(response) {
	return response.status === "in_flight";
}
function formatInFlightGatewayAgentMessage(response) {
	return response.runId ? `Agent run ${response.runId} is already in flight; not starting a duplicate run.` : "Agent run is already in flight; not starting a duplicate run.";
}
async function agentViaGatewayCommand(opts, runtime, signalBridge) {
	protectJsonStdout(opts);
	const body = (opts.message ?? "").trim();
	const explicitSessionKey = opts.sessionKey?.trim();
	if (!body) throw new Error(`Missing message. Use ${formatCliCommand("openclaw agent --message \"...\" --agent <id>")} or pass --to/--session-key/--session-id for an existing conversation.`);
	if (!opts.to && !opts.sessionId && !opts.agent && !explicitSessionKey) throw new Error(`No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. Run ${formatCliCommand("openclaw agents list")} to see agents.`);
	const cfg = getRuntimeConfig();
	const agentIdRaw = opts.agent?.trim();
	const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : void 0;
	if (agentId) {
		if (!listAgentIds(cfg).includes(agentId)) throw new Error(`Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	}
	const timeoutSeconds = parseTimeoutSeconds({
		cfg,
		timeout: opts.timeout
	});
	const gatewayTimeoutMs = timeoutSeconds === 0 ? NO_GATEWAY_TIMEOUT_MS : Math.max(1e4, (timeoutSeconds + 30) * 1e3);
	const sessionKey = resolveSessionKeyForRequest({
		cfg,
		agentId,
		to: opts.to,
		sessionId: opts.sessionId,
		sessionKey: explicitSessionKey
	}).sessionKey;
	const channel = normalizeMessageChannel(opts.channel);
	const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();
	const modelOverride = normalizeOptionalString(opts.model);
	const gatewayIdentity = Boolean(modelOverride) ? {
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		scopes: [ADMIN_SCOPE]
	} : {
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		mode: GATEWAY_CLIENT_MODES.CLI
	};
	let acceptedRunId = idempotencyKey;
	let acceptedSessionKey = sessionKey;
	let acceptedGatewayRun = false;
	let activeConnectionAbortAttempted = false;
	let activeConnectionAbortSucceeded = false;
	let response;
	try {
		response = await withProgress({
			label: "Waiting for agent reply…",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await callGateway({
			method: "agent",
			params: {
				message: body,
				agentId,
				model: modelOverride,
				to: opts.to,
				replyTo: opts.replyTo,
				sessionId: opts.sessionId,
				sessionKey,
				thinking: opts.thinking,
				deliver: Boolean(opts.deliver),
				channel,
				replyChannel: opts.replyChannel,
				replyAccountId: opts.replyAccount,
				bestEffortDeliver: opts.bestEffortDeliver,
				timeout: timeoutSeconds,
				lane: opts.lane,
				extraSystemPrompt: opts.extraSystemPrompt,
				idempotencyKey
			},
			expectFinal: true,
			timeoutMs: gatewayTimeoutMs,
			signal: signalBridge.signal,
			onAccepted: (payload) => {
				acceptedGatewayRun = true;
				const accepted = readAcceptedRunContext(payload);
				acceptedRunId = accepted.runId ?? acceptedRunId;
				acceptedSessionKey = accepted.sessionKey ?? acceptedSessionKey;
			},
			onSignalAbort: async (request) => {
				activeConnectionAbortAttempted = true;
				activeConnectionAbortSucceeded = await abortAcceptedGatewayAgentRunOnActiveConnection({
					runId: acceptedRunId,
					sessionKey: acceptedSessionKey,
					signal: signalBridge.getReceivedSignal(),
					runtime,
					request
				});
			},
			...gatewayIdentity
		}));
	} catch (err) {
		if (isAbortError(err) && !activeConnectionAbortSucceeded && (acceptedGatewayRun || activeConnectionAbortAttempted)) await abortAcceptedGatewayAgentRunWithGatewayCall({
			runId: acceptedRunId,
			sessionKey: acceptedSessionKey,
			signal: signalBridge.getReceivedSignal(),
			runtime,
			gatewayIdentity
		});
		throw err;
	}
	if (opts.json) {
		writeRuntimeJson(runtime, buildGatewayJsonResponse(response));
		return response;
	}
	const payloads = (response?.result)?.payloads ?? [];
	if (isInFlightGatewayAgentResponse(response)) {
		runtime.error?.(formatInFlightGatewayAgentMessage(response));
		return response;
	}
	if (payloads.length === 0) {
		if (response?.status !== "ok") runtime.log(response?.summary ? response.summary : "No reply from agent.");
		return response;
	}
	for (const payload of payloads) {
		const out = formatPayloadForLog(payload);
		if (out) runtime.log(out);
	}
	return response;
}
async function agentViaGatewayCommandWithTransientRetries(opts, runtime, signalBridge) {
	for (const [attempt, retryDelayMs] of [...GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS, 0].entries()) try {
		return await agentViaGatewayCommand(opts, runtime, signalBridge);
	} catch (err) {
		if (isAbortError(err)) throw err;
		if (attempt === GATEWAY_TRANSIENT_CONNECT_RETRY_DELAYS_MS.length || !isTransientGatewayAgentConnectClose(err)) throw err;
		runtime.error?.(`Gateway agent connection closed during handshake; retrying in ${retryDelayMs}ms before embedded fallback.`);
		await delayMs(retryDelayMs, signalBridge.signal);
	}
	throw new Error("Gateway agent retry loop exhausted unexpectedly.");
}
async function agentCliCommand(opts, runtime, deps) {
	protectJsonStdout(opts);
	const dispatchOpts = normalizeSessionKeyOptsForDispatch(opts);
	validateExplicitSessionKeyForDispatch(dispatchOpts);
	const gatewayDispatchOpts = dispatchOpts.runId ? dispatchOpts : {
		...dispatchOpts,
		runId: randomIdempotencyKey()
	};
	const signalBridge = createAgentCliSignalBridge(resolveAgentCliProcessLike(deps));
	const localOpts = {
		...gatewayDispatchOpts,
		agentId: gatewayDispatchOpts.agent,
		replyAccountId: gatewayDispatchOpts.replyAccount,
		cleanupBundleMcpOnRunEnd: true,
		cleanupCliLiveSessionOnRunEnd: true,
		abortSignal: signalBridge.signal
	};
	try {
		if (dispatchOpts.local === true) return returnAfterSignalExit(await agentCommand(localOpts, runtime, deps), signalBridge.getReceivedSignal(), runtime);
		try {
			return returnAfterSignalExit(await agentViaGatewayCommandWithTransientRetries(gatewayDispatchOpts, runtime, signalBridge), signalBridge.getReceivedSignal(), runtime);
		} catch (err) {
			if (isAbortError(err)) {
				if (exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) return;
				throw err;
			}
			if (isGatewayAgentTimeoutError(err)) {
				const fallbackSession = createGatewayTimeoutFallbackSession(resolveAgentIdForGatewayTimeoutFallback(dispatchOpts));
				runtime.error?.(`EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session ${fallbackSession.sessionId}: ${String(err)}`);
				return returnAfterSignalExit(await agentCommand({
					...localOpts,
					sessionId: fallbackSession.sessionId,
					sessionKey: fallbackSession.sessionKey,
					runId: fallbackSession.sessionId,
					resultMetaOverrides: {
						...EMBEDDED_FALLBACK_META,
						fallbackReason: "gateway_timeout",
						fallbackSessionId: fallbackSession.sessionId,
						fallbackSessionKey: fallbackSession.sessionKey
					}
				}, runtime, deps), signalBridge.getReceivedSignal(), runtime);
			}
			if (!isGatewayAgentEmbeddedFallbackError(err)) throw err;
			runtime.error?.(`EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: ${String(err)}`);
			return returnAfterSignalExit(await agentCommand({
				...localOpts,
				resultMetaOverrides: EMBEDDED_FALLBACK_META
			}, runtime, deps), signalBridge.getReceivedSignal(), runtime);
		}
	} catch (err) {
		if (isAbortError(err) && exitForReceivedSignal(signalBridge.getReceivedSignal(), runtime)) return;
		throw err;
	} finally {
		signalBridge.dispose();
	}
}
//#endregion
export { agentCliCommand };
