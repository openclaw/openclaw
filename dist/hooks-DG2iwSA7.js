import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as safeEqualSecret } from "./secret-equal-DDhtiQsP.js";
import { _ as resolveRequestClientIp } from "./net-DCUMtgJy.js";
import { a as createAuthRateLimiter, o as normalizeRateLimitClientIp, r as AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH } from "./auth-rate-limit-DA3xJNFz.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { i as resolveMainSessionKey, n as resolveAgentMainSessionKey } from "./main-session-D3q_5w0B.js";
import { l as resolveMainSessionKeyFromConfig } from "./sessions-CQHHcgC_.js";
import { o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { c as resolveHookExternalContentSource } from "./external-content-BWPoz0BU.js";
import { n as sanitizeInboundSystemTags } from "./inbound-text-C0MN-1wo.js";
import { n as DEDUPE_TTL_MS, t as DEDUPE_MAX } from "./server-constants-BGwLM6XN.js";
import { a as isHookAgentAllowed, c as normalizeHookDispatchSessionKey, d as readJsonBody, f as resolveHookChannel, g as resolveHookTargetAgentId, h as resolveHookSessionKey, i as getHookSessionKeyPrefixError, l as normalizeHookHeaders, m as resolveHookIdempotencyKey, n as getHookAgentPolicyError, o as isSessionKeyAllowedByPrefix, p as resolveHookDeliver, r as getHookChannelError, s as normalizeAgentPayload, t as extractHookToken, u as normalizeWakePayload, v as applyHookMappings } from "./hooks-BrCZyF5b.js";
import { createHash, randomUUID } from "node:crypto";
//#region src/gateway/server/hooks-request-handler.ts
const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 6e4;
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function resolveMappedHookExternalContentSource(params) {
	const payloadSource = typeof params.payload.source === "string" ? params.payload.source.trim().toLowerCase() : "";
	if (params.subPath === "gmail" || payloadSource === "gmail") return "gmail";
	return resolveHookExternalContentSource(params.sessionKey) ?? "webhook";
}
function createHooksRequestHandler(opts) {
	const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
	const hookReplayCache = /* @__PURE__ */ new Map();
	const hookAuthLimiter = createAuthRateLimiter({
		maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
		windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
		lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
		exemptLoopback: false,
		pruneIntervalMs: 0
	});
	const resolveHookClientKey = (req) => {
		const clientIpConfig = getClientIpConfig?.();
		return normalizeRateLimitClientIp(resolveRequestClientIp(req, clientIpConfig?.trustedProxies, clientIpConfig?.allowRealIpFallback === true) ?? req.socket?.remoteAddress);
	};
	const pruneHookReplayCache = (now) => {
		const cutoff = now - DEDUPE_TTL_MS;
		for (const [key, entry] of hookReplayCache) if (entry.ts < cutoff) hookReplayCache.delete(key);
		while (hookReplayCache.size > DEDUPE_MAX) {
			const oldestKey = hookReplayCache.keys().next().value;
			if (!oldestKey) break;
			hookReplayCache.delete(oldestKey);
		}
	};
	const buildHookReplayCacheKey = (params) => {
		const idem = params.idempotencyKey?.trim();
		if (!idem) return;
		const tokenFingerprint = createHash("sha256").update(params.token ?? "", "utf8").digest("hex");
		const idempotencyFingerprint = createHash("sha256").update(idem, "utf8").digest("hex");
		return `${tokenFingerprint}:${createHash("sha256").update(JSON.stringify({
			pathKey: params.pathKey,
			dispatchScope: params.dispatchScope
		}), "utf8").digest("hex")}:${idempotencyFingerprint}`;
	};
	const resolveCachedHookRunId = (key, now) => {
		if (!key) return;
		pruneHookReplayCache(now);
		const cached = hookReplayCache.get(key);
		if (!cached) return;
		hookReplayCache.delete(key);
		hookReplayCache.set(key, cached);
		return cached.runId;
	};
	const rememberHookRunId = (key, runId, now) => {
		if (!key) return;
		hookReplayCache.delete(key);
		hookReplayCache.set(key, {
			ts: now,
			runId
		});
		pruneHookReplayCache(now);
	};
	return async (req, res) => {
		const hooksConfig = getHooksConfig();
		if (!hooksConfig) return false;
		const url = new URL(req.url ?? "/", "http://localhost");
		const basePath = hooksConfig.basePath;
		if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return false;
		if (url.searchParams.has("token")) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).");
			return true;
		}
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Method Not Allowed");
			return true;
		}
		const token = extractHookToken(req);
		const clientKey = resolveHookClientKey(req);
		if (!safeEqualSecret(token, hooksConfig.token)) {
			const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
			if (!throttle.allowed) {
				const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1e3) : 1;
				res.statusCode = 429;
				res.setHeader("Retry-After", String(retryAfter));
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Too Many Requests");
				logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
				return true;
			}
			hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
			res.statusCode = 401;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Unauthorized");
			return true;
		}
		hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
		const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
		if (!subPath) {
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
			return true;
		}
		const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
		if (!body.ok) {
			sendJson(res, body.error === "payload too large" ? 413 : body.error === "request body timeout" ? 408 : 400, {
				ok: false,
				error: body.error
			});
			return true;
		}
		const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
		const headers = normalizeHookHeaders(req);
		const idempotencyKey = resolveHookIdempotencyKey({
			payload,
			headers
		});
		const now = Date.now();
		if (subPath === "wake") {
			const normalized = normalizeWakePayload(payload);
			if (!normalized.ok) {
				sendJson(res, 400, {
					ok: false,
					error: normalized.error
				});
				return true;
			}
			dispatchWakeHook(normalized.value);
			sendJson(res, 200, {
				ok: true,
				mode: normalized.value.mode
			});
			return true;
		}
		if (subPath === "agent") {
			const normalized = normalizeAgentPayload(payload);
			if (!normalized.ok) {
				sendJson(res, 400, {
					ok: false,
					error: normalized.error
				});
				return true;
			}
			if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
				sendJson(res, 400, {
					ok: false,
					error: getHookAgentPolicyError()
				});
				return true;
			}
			const sessionKey = resolveHookSessionKey({
				hooksConfig,
				source: "request",
				sessionKey: normalized.value.sessionKey
			});
			if (!sessionKey.ok) {
				sendJson(res, 400, {
					ok: false,
					error: sessionKey.error
				});
				return true;
			}
			const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
			const replayKey = buildHookReplayCacheKey({
				pathKey: "agent",
				token,
				idempotencyKey,
				dispatchScope: {
					agentId: targetAgentId ?? null,
					sessionKey: normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
					message: normalized.value.message,
					name: normalized.value.name,
					wakeMode: normalized.value.wakeMode,
					deliver: normalized.value.deliver,
					channel: normalized.value.channel,
					to: normalized.value.to ?? null,
					model: normalized.value.model ?? null,
					thinking: normalized.value.thinking ?? null,
					timeoutSeconds: normalized.value.timeoutSeconds ?? null
				}
			});
			const cachedRunId = resolveCachedHookRunId(replayKey, now);
			if (cachedRunId) {
				sendJson(res, 200, {
					ok: true,
					runId: cachedRunId
				});
				return true;
			}
			const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
				sessionKey: sessionKey.value,
				targetAgentId
			});
			const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
			if (allowedPrefixes && !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)) {
				sendJson(res, 400, {
					ok: false,
					error: getHookSessionKeyPrefixError(allowedPrefixes)
				});
				return true;
			}
			const runId = dispatchAgentHook({
				...normalized.value,
				idempotencyKey,
				sessionKey: normalizedDispatchSessionKey,
				sourcePath: `${basePath}/agent`,
				agentId: targetAgentId,
				externalContentSource: "webhook"
			});
			rememberHookRunId(replayKey, runId, now);
			sendJson(res, 200, {
				ok: true,
				runId
			});
			return true;
		}
		if (hooksConfig.mappings.length > 0) try {
			const mapped = await applyHookMappings(hooksConfig.mappings, {
				payload,
				headers,
				url,
				path: subPath
			});
			if (mapped) {
				if (!mapped.ok) {
					sendJson(res, 400, {
						ok: false,
						error: mapped.error
					});
					return true;
				}
				if (mapped.action === null) {
					res.statusCode = 204;
					res.end();
					return true;
				}
				if (mapped.action.kind === "wake") {
					dispatchWakeHook({
						text: mapped.action.text,
						mode: mapped.action.mode
					});
					sendJson(res, 200, {
						ok: true,
						mode: mapped.action.mode
					});
					return true;
				}
				const channel = resolveHookChannel(mapped.action.channel);
				if (!channel) {
					sendJson(res, 400, {
						ok: false,
						error: getHookChannelError()
					});
					return true;
				}
				if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
					sendJson(res, 400, {
						ok: false,
						error: getHookAgentPolicyError()
					});
					return true;
				}
				const sessionKey = resolveHookSessionKey({
					hooksConfig,
					source: mapped.action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
					sessionKey: mapped.action.sessionKey
				});
				if (!sessionKey.ok) {
					sendJson(res, 400, {
						ok: false,
						error: sessionKey.error
					});
					return true;
				}
				const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
				const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
					sessionKey: sessionKey.value,
					targetAgentId
				});
				const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
				if (allowedPrefixes && !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)) {
					sendJson(res, 400, {
						ok: false,
						error: getHookSessionKeyPrefixError(allowedPrefixes)
					});
					return true;
				}
				const replayKey = buildHookReplayCacheKey({
					pathKey: subPath || "mapping",
					token,
					idempotencyKey,
					dispatchScope: {
						agentId: targetAgentId ?? null,
						sessionKey: mapped.action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
						message: mapped.action.message,
						name: mapped.action.name ?? "Hook",
						wakeMode: mapped.action.wakeMode,
						deliver: resolveHookDeliver(mapped.action.deliver),
						channel,
						to: mapped.action.to ?? null,
						model: mapped.action.model ?? null,
						thinking: mapped.action.thinking ?? null,
						timeoutSeconds: mapped.action.timeoutSeconds ?? null
					}
				});
				const cachedRunId = resolveCachedHookRunId(replayKey, now);
				if (cachedRunId) {
					sendJson(res, 200, {
						ok: true,
						runId: cachedRunId
					});
					return true;
				}
				const runId = dispatchAgentHook({
					message: mapped.action.message,
					name: mapped.action.name ?? "Hook",
					idempotencyKey,
					agentId: targetAgentId,
					wakeMode: mapped.action.wakeMode,
					sessionKey: normalizedDispatchSessionKey,
					sourcePath: `${basePath}/${subPath}`,
					deliver: resolveHookDeliver(mapped.action.deliver),
					channel,
					to: mapped.action.to,
					model: mapped.action.model,
					thinking: mapped.action.thinking,
					timeoutSeconds: mapped.action.timeoutSeconds,
					allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
					externalContentSource: resolveMappedHookExternalContentSource({
						subPath,
						payload,
						sessionKey: sessionKey.value
					})
				});
				rememberHookRunId(replayKey, runId, now);
				sendJson(res, 200, {
					ok: true,
					runId
				});
				return true;
			}
		} catch (err) {
			logHooks.warn(`hook mapping failed: ${String(err)}`);
			sendJson(res, 500, {
				ok: false,
				error: "hook mapping failed"
			});
			return true;
		}
		res.statusCode = 404;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end("Not Found");
		return true;
	};
}
//#endregion
//#region src/gateway/server/hooks.ts
function resolveHookEventSessionKey(params) {
	return params.agentId ? resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	}) : resolveMainSessionKey(params.cfg);
}
function shouldAnnounceHookRunResult(params) {
	if (params.result.status !== "ok") return true;
	return params.deliver && params.result.delivered !== true && params.result.deliveryAttempted !== true;
}
function resolveHookRunSummary(result) {
	return (result.status !== "ok" ? normalizeOptionalString(result.diagnostics?.summary) : void 0) || normalizeOptionalString(result.summary) || normalizeOptionalString(result.error) || result.status;
}
function sanitizeHookConsoleValue(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	return Array.from(normalized, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? " " : char;
	}).join("").replace(/\s+/gu, " ").trim().slice(0, 500);
}
function formatHookRunWarningConsoleMessage(params) {
	const parts = ["hook agent run returned non-ok status", `status=${sanitizeHookConsoleValue(params.status) ?? "unknown"}`];
	const model = sanitizeHookConsoleValue(params.model);
	if (model) parts.push(`model=${model}`);
	const summary = sanitizeHookConsoleValue(params.summary);
	if (summary) parts.push(`summary=${summary}`);
	return parts.join(" ");
}
function createGatewayHooksRequestHandler(params) {
	const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;
	const dispatchWakeHook = (value) => {
		const sessionKey = resolveMainSessionKeyFromConfig();
		enqueueSystemEvent(value.text, { sessionKey });
		if (value.mode === "now") requestHeartbeat({
			source: "hook",
			intent: "immediate",
			reason: "hook:wake"
		});
	};
	const dispatchAgentHook = (value) => {
		const sessionKey = value.sessionKey;
		const safeName = sanitizeInboundSystemTags(value.name);
		const jobId = randomUUID();
		const runId = randomUUID();
		const now = Date.now();
		const delivery = value.deliver ? {
			mode: "announce",
			channel: value.channel,
			to: value.to
		} : { mode: "none" };
		const job = {
			id: jobId,
			agentId: value.agentId,
			name: safeName,
			enabled: true,
			createdAtMs: now,
			updatedAtMs: now,
			schedule: {
				kind: "at",
				at: new Date(now).toISOString()
			},
			sessionTarget: "isolated",
			wakeMode: value.wakeMode,
			payload: {
				kind: "agentTurn",
				message: value.message,
				model: value.model,
				thinking: value.thinking,
				timeoutSeconds: value.timeoutSeconds,
				allowUnsafeExternalContent: value.allowUnsafeExternalContent,
				externalContentSource: value.externalContentSource
			},
			delivery,
			state: { nextRunAtMs: now }
		};
		let hookEventSessionKey;
		(async () => {
			try {
				const cfg = getRuntimeConfig();
				hookEventSessionKey = resolveHookEventSessionKey({
					cfg,
					agentId: value.agentId
				});
				const { runCronIsolatedAgentTurn } = await import("./isolated-agent-C-9F319F.js");
				const result = await runCronIsolatedAgentTurn({
					cfg,
					deps,
					job,
					message: value.message,
					sessionKey,
					lane: "cron"
				});
				const summary = resolveHookRunSummary(result);
				const prefix = result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
				const shouldAnnounce = shouldAnnounceHookRunResult({
					deliver: value.deliver,
					result
				});
				if (result.status !== "ok") logHooks.warn("hook agent run returned non-ok status", {
					sourcePath: value.sourcePath,
					name: safeName,
					runId,
					jobId,
					agentId: value.agentId,
					sessionKey,
					status: result.status,
					model: value.model,
					summary,
					consoleMessage: formatHookRunWarningConsoleMessage({
						status: result.status,
						model: value.model,
						summary
					})
				});
				if (shouldAnnounce) {
					const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
					enqueueSystemEvent(`${prefix}: ${summary}`.trim(), { sessionKey: eventSessionKey });
					if (value.wakeMode === "now") requestHeartbeat({
						source: "hook",
						intent: "immediate",
						reason: `hook:${jobId}`
					});
				} else if (result.status === "ok" && !value.deliver) logHooks.info("hook agent run completed without announcement", {
					sourcePath: value.sourcePath,
					name: safeName,
					runId,
					jobId,
					agentId: value.agentId,
					sessionKey,
					completedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			} catch (err) {
				logHooks.warn(`hook agent failed: ${String(err)}`);
				enqueueSystemEvent(`Hook ${safeName} (error): ${String(err)}`, { sessionKey: hookEventSessionKey ?? resolveMainSessionKeyFromConfig() });
				if (value.wakeMode === "now") requestHeartbeat({
					source: "hook",
					intent: "immediate",
					reason: `hook:${jobId}:error`
				});
			}
		})();
		return runId;
	};
	return createHooksRequestHandler({
		getHooksConfig,
		bindHost,
		port,
		logHooks,
		getClientIpConfig,
		dispatchAgentHook,
		dispatchWakeHook
	});
}
//#endregion
export { createGatewayHooksRequestHandler };
