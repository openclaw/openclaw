import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { i as isCronSessionKey, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { i as resolveMainSessionKey, n as resolveAgentMainSessionKey, t as canonicalizeMainSessionAlias } from "./main-session-D3q_5w0B.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { o as isAudioFileName } from "./mime-DppuT-pZ.js";
import { s as resolveMirroredTranscriptText } from "./transcript-BA0Ngd-A.js";
import { a as isSilentReplyText, c as stripSilentToken, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripLeadingSilentToken } from "./tokens-CFv3Qu_v.js";
import { n as sleepWithAbort } from "./backoff-BQ4uO4hX.js";
import { a as hasReplyPayloadContent } from "./payload-BDV15CYA.js";
import { s as retireSessionMcpRuntime } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { o as normalizeTargetForProvider } from "./target-id-resolution-DVSHqxJ3.js";
import { s as projectOutboundPayloadPlanForMirror, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { r as shouldAttemptTtsPayload } from "./tts-config-WOpwhkHq.js";
import "./inbound.runtime-C3rfaBNA.js";
import { n as pickLastNonEmptyTextFromPayloads, r as pickSummaryFromOutput } from "./helpers-CdmKDEvq.js";
import { _ as resolveDeliveryTarget, l as hasScheduledNextRunAtMs } from "./jobs-CYMnCvkL.js";
import { t as createCronExecutionId } from "./run-id-BEdij8BZ.js";
import { n as isLikelyInterimCronMessage, t as expectsSubagentFollowup } from "./subagent-followup-hints-Q6xOcQiu.js";
//#region src/cron/isolated-agent/delivery-dispatch.ts
function normalizeDeliveryTarget(channel, to) {
	const toTrimmed = to.trim();
	return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}
function normalizeSilentReplyText(text) {
	if (!text) return {
		text,
		strippedTrailingSilentToken: false
	};
	if (isSilentReplyText(text, "NO_REPLY")) return {
		text: void 0,
		strippedTrailingSilentToken: false
	};
	let next = text;
	const hasLeadingSilentToken = startsWithSilentToken(next, SILENT_REPLY_TOKEN);
	if (hasLeadingSilentToken) next = stripLeadingSilentToken(next, SILENT_REPLY_TOKEN);
	let strippedTrailingSilentToken = false;
	if (hasLeadingSilentToken || next.toLowerCase().includes("NO_REPLY".toLowerCase())) {
		const trimmedBefore = next.trim();
		const stripped = stripSilentToken(next, SILENT_REPLY_TOKEN);
		strippedTrailingSilentToken = stripped !== trimmedBefore;
		next = stripped;
	}
	if (!next.trim() || isSilentReplyText(next, "NO_REPLY")) return {
		text: void 0,
		strippedTrailingSilentToken
	};
	return {
		text: next,
		strippedTrailingSilentToken
	};
}
function resolveCronDeliveryBestEffort(job) {
	return job.delivery?.bestEffort === true;
}
const TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS = [
	/\berrorcode=unavailable\b/i,
	/\bstatus\s*[:=]\s*"?unavailable\b/i,
	/\bUNAVAILABLE\b/,
	/no active .* listener/i,
	/gateway not connected/i,
	/gateway closed \(1006/i,
	/gateway timeout/i,
	/\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i
];
const PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS = [
	/unsupported channel/i,
	/unknown channel/i,
	/chat not found/i,
	/user not found/i,
	/bot.*not.*member/i,
	/bot was blocked by the user/i,
	/forbidden: bot was kicked/i,
	/recipient is not a valid/i,
	/outbound not configured for channel/i
];
const STALE_CRON_DELIVERY_MAX_START_DELAY_MS = 180 * 6e4;
const gatewayCallRuntimeLoader = createLazyImportLoader(() => import("./call.runtime.js"));
const deliveryOutboundRuntimeLoader = createLazyImportLoader(() => import("./delivery-outbound.runtime.js"));
const outboundSessionRuntimeLoader = createLazyImportLoader(() => import("./outbound-session-D3n_36eJ.js"));
const transcriptRuntimeLoader = createLazyImportLoader(() => import("./transcript.runtime.js"));
const deliverySubagentRegistryRuntimeLoader = createLazyImportLoader(() => import("./delivery-subagent-registry.runtime.js"));
const deliveryLoggerRuntimeLoader = createLazyImportLoader(() => import("./delivery-logger.runtime.js"));
const subagentFollowupRuntimeLoader = createLazyImportLoader(() => import("./subagent-followup.runtime.js"));
const ttsRuntimeLoader = createLazyImportLoader(() => import("./tts.runtime-hD3depa3.js"));
const COMPLETED_DIRECT_CRON_DELIVERIES = /* @__PURE__ */ new Map();
async function loadGatewayCallRuntime() {
	return await gatewayCallRuntimeLoader.load();
}
async function loadDeliveryOutboundRuntime() {
	return await deliveryOutboundRuntimeLoader.load();
}
async function loadOutboundSessionRuntime() {
	return await outboundSessionRuntimeLoader.load();
}
async function loadTranscriptRuntime() {
	return await transcriptRuntimeLoader.load();
}
async function loadDeliverySubagentRegistryRuntime() {
	return await deliverySubagentRegistryRuntimeLoader.load();
}
async function loadDeliveryLoggerRuntime() {
	return await deliveryLoggerRuntimeLoader.load();
}
async function loadSubagentFollowupRuntime() {
	return await subagentFollowupRuntimeLoader.load();
}
async function loadTtsRuntime() {
	return await ttsRuntimeLoader.load();
}
async function logCronDeliveryWarn(message) {
	const { logWarn } = await loadDeliveryLoggerRuntime();
	logWarn(message);
}
async function logCronDeliveryError(message) {
	const { logError } = await loadDeliveryLoggerRuntime();
	logError(message);
}
async function cleanupDirectCronSession(params) {
	if (!params.job.deleteAfterRun) return;
	if (!isCronSessionKey(params.agentSessionKey)) return;
	try {
		const { callGateway } = await loadGatewayCallRuntime();
		await callGateway({
			method: "sessions.delete",
			params: {
				key: params.agentSessionKey,
				deleteTranscript: true,
				emitLifecycleHooks: false
			},
			timeoutMs: 1e4
		});
	} catch {
		await retireSessionMcpRuntime({
			sessionId: params.sessionId,
			reason: params.retireReason
		});
	}
}
function logCronDeliveryErrorDeferred(message) {
	loadDeliveryLoggerRuntime().then(({ logError }) => {
		logError(message);
	});
}
function cloneDeliveryResults(results) {
	return results.map((result) => ({
		...result,
		...result.meta ? { meta: { ...result.meta } } : {}
	}));
}
function pruneCompletedDirectCronDeliveries(now) {
	const ttlMs = process.env.OPENCLAW_TEST_FAST === "1" ? 6e4 : 1440 * 60 * 1e3;
	for (const [key, entry] of COMPLETED_DIRECT_CRON_DELIVERIES) if (now - entry.ts >= ttlMs) COMPLETED_DIRECT_CRON_DELIVERIES.delete(key);
	const maxEntries = 2e3;
	if (COMPLETED_DIRECT_CRON_DELIVERIES.size <= maxEntries) return;
	const entries = [...COMPLETED_DIRECT_CRON_DELIVERIES.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
	const toDelete = COMPLETED_DIRECT_CRON_DELIVERIES.size - maxEntries;
	for (let i = 0; i < toDelete; i += 1) {
		const oldest = entries[i];
		if (!oldest) break;
		COMPLETED_DIRECT_CRON_DELIVERIES.delete(oldest[0]);
	}
}
function resolveCronDeliveryScheduledAtMs(params) {
	const scheduledAt = params.job.state?.nextRunAtMs;
	return hasScheduledNextRunAtMs(scheduledAt) ? scheduledAt : params.runStartedAt;
}
function resolveCronDeliveryStartDelayMs(params) {
	return params.runStartedAt - resolveCronDeliveryScheduledAtMs(params);
}
function isStaleCronDelivery(params) {
	return resolveCronDeliveryStartDelayMs(params) > STALE_CRON_DELIVERY_MAX_START_DELAY_MS;
}
function rememberCompletedDirectCronDelivery(idempotencyKey, results) {
	const now = Date.now();
	COMPLETED_DIRECT_CRON_DELIVERIES.set(idempotencyKey, {
		ts: now,
		results: cloneDeliveryResults(results)
	});
	pruneCompletedDirectCronDeliveries(now);
}
function getCompletedDirectCronDelivery(idempotencyKey) {
	pruneCompletedDirectCronDeliveries(Date.now());
	const cached = COMPLETED_DIRECT_CRON_DELIVERIES.get(idempotencyKey);
	if (!cached) return;
	return cloneDeliveryResults(cached.results);
}
async function maybeApplyTtsToCronPayloads(params) {
	if (!shouldAttemptTtsPayload({
		cfg: params.cfg,
		ttsAuto: params.ttsAuto,
		agentId: params.agentId,
		channelId: params.delivery.channel,
		accountId: params.delivery.accountId
	})) return params.payloads;
	const { maybeApplyTtsToPayload } = await loadTtsRuntime();
	return await Promise.all(params.payloads.map((payload) => maybeApplyTtsToPayload({
		payload,
		cfg: params.cfg,
		channel: params.delivery.channel,
		kind: "final",
		ttsAuto: params.ttsAuto,
		agentId: params.agentId,
		accountId: params.delivery.accountId
	})));
}
function buildDirectCronDeliveryIdempotencyKey(params) {
	const executionId = createCronExecutionId(params.jobId, params.runStartedAt);
	const threadId = params.delivery.threadId == null || params.delivery.threadId === "" ? "" : stringifyRouteThreadId(params.delivery.threadId) ?? "";
	const accountId = params.delivery.accountId?.trim() ?? "";
	const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
	return `cron-direct-delivery:v1:${executionId}:${params.delivery.channel}:${accountId}:${normalizedTo}:${threadId}`;
}
function shouldQueueCronAwareness(params) {
	return params.job.sessionTarget === "isolated" && !params.deliveryBestEffort && params.delivery.mode === "explicit";
}
function resolveCronAwarenessMainSessionKey(params) {
	return params.cfg.session?.scope === "global" ? resolveMainSessionKey(params.cfg) : resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});
}
function isSameSessionKey(left, right) {
	const normalizedLeft = normalizeOptionalString(left);
	const normalizedRight = normalizeOptionalString(right);
	return normalizedLeft != null && normalizedLeft === normalizedRight;
}
function resolveCronAwarenessText(params) {
	if (params.outboundPayloads?.length) {
		const projectedText = resolveDirectCronTranscriptMirrorText(projectDeliveredDirectCronPayloadsForMirror(params.outboundPayloads));
		if (projectedText) return projectedText;
	}
	return params.deliveryPayloads ? pickLastNonEmptyTextFromPayloads(params.deliveryPayloads) : normalizeOptionalString(params.outputText) ?? normalizeOptionalString(params.synthesizedText);
}
async function queueCronAwarenessSystemEvent(params) {
	const text = resolveCronAwarenessText(params);
	if (!text) return;
	try {
		const { enqueueSystemEvent } = await loadDeliveryOutboundRuntime();
		enqueueSystemEvent(text, {
			sessionKey: resolveCronAwarenessMainSessionKey({
				cfg: params.cfg,
				agentId: params.agentId
			}),
			contextKey: params.deliveryIdempotencyKey
		});
	} catch (err) {
		await logCronDeliveryWarn(`[cron:${params.jobId}] failed to queue isolated cron awareness for the main session: ${formatErrorMessage(err)}`);
	}
}
function isCustomCronSessionTarget(sessionTarget) {
	return typeof sessionTarget === "string" && sessionTarget.startsWith("session:");
}
function buildDirectCronTranscriptMirrorPayloads(payloads) {
	return payloads.map((payload) => {
		const spokenText = normalizeOptionalString(payload.spokenText);
		if (!spokenText) return payload;
		const mediaUrls = [payload.mediaUrl, ...payload.mediaUrls ?? []].filter((url) => Boolean(url) && !isAudioFileName(url));
		const { mediaUrl: _mediaUrl, mediaUrls: _mediaUrls, audioAsVoice: _audioAsVoice, spokenText: _spokenText, ...rest } = payload;
		return {
			...rest,
			text: spokenText,
			...mediaUrls.length ? { mediaUrls } : {}
		};
	});
}
function resolveDirectCronTranscriptMirrorText(params) {
	const text = normalizeOptionalString(params.text);
	const mediaText = resolveMirroredTranscriptText({ mediaUrls: params.mediaUrls }) ?? void 0;
	if (text && mediaText) return `${text}\n${mediaText}`;
	if (text || mediaText) return text ?? mediaText;
}
function pickDirectCronMirrorPayloadText(payload) {
	return normalizeOptionalString(payload.hookContent) ?? normalizeOptionalString(payload.text);
}
function isTtsAudioMirrorOnly(params) {
	return (params.payload.audioAsVoice === true || !!params.payload.hookContent) && isAudioFileName(params.mediaUrl);
}
function projectDeliveredDirectCronPayloadsForMirror(payloads) {
	const textParts = [];
	const mediaUrls = [];
	for (const payload of payloads) {
		const text = pickDirectCronMirrorPayloadText(payload);
		if (text) textParts.push(text);
		for (const mediaUrl of payload.mediaUrls) {
			if (isTtsAudioMirrorOnly({
				payload,
				mediaUrl
			})) continue;
			mediaUrls.push(mediaUrl);
		}
	}
	return {
		text: textParts.join("\n"),
		mediaUrls
	};
}
function canonicalizeDirectCronRouteSessionKey(params) {
	const sessionKey = params.sessionKey.trim();
	const canonical = canonicalizeMainSessionAlias({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey
	});
	if (canonical !== sessionKey) return canonical;
	const thread = parseThreadSessionSuffix(sessionKey);
	if (!thread.baseSessionKey || !thread.threadId) return sessionKey;
	const canonicalBase = canonicalizeMainSessionAlias({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: thread.baseSessionKey
	});
	if (canonicalBase === thread.baseSessionKey || canonicalBase === "global") return sessionKey;
	return `${canonicalBase}:thread:${thread.threadId}`;
}
async function resolveDirectCronDeliverySessionKey(params) {
	if (isCustomCronSessionTarget(params.job.sessionTarget)) return params.agentSessionKey;
	try {
		const { resolveOutboundSessionRoute, ensureOutboundSessionEntry } = await loadOutboundSessionRuntime();
		const route = await resolveOutboundSessionRoute({
			cfg: params.cfg,
			channel: params.delivery.channel,
			agentId: params.agentId,
			accountId: params.delivery.accountId,
			target: params.delivery.to,
			currentSessionKey: params.agentSessionKey,
			threadId: params.delivery.threadId
		});
		const routeSessionKey = route?.sessionKey?.trim();
		if (!route || !routeSessionKey) return params.agentSessionKey;
		const canonicalRouteSessionKey = canonicalizeDirectCronRouteSessionKey({
			cfg: params.cfg,
			agentId: params.agentId,
			sessionKey: routeSessionKey
		});
		const canonicalRouteBaseSessionKey = canonicalizeDirectCronRouteSessionKey({
			cfg: params.cfg,
			agentId: params.agentId,
			sessionKey: route.baseSessionKey
		});
		const canonicalRoute = canonicalRouteSessionKey === route.sessionKey && canonicalRouteBaseSessionKey === route.baseSessionKey ? route : {
			...route,
			sessionKey: canonicalRouteSessionKey,
			baseSessionKey: canonicalRouteBaseSessionKey
		};
		await ensureOutboundSessionEntry({
			cfg: params.cfg,
			channel: params.delivery.channel,
			accountId: params.delivery.accountId,
			route: canonicalRoute
		});
		return canonicalRouteSessionKey;
	} catch (err) {
		await logCronDeliveryWarn(`[cron:${params.job.id}] failed to resolve destination session for direct delivery mirror: ${formatErrorMessage(err)}`);
		return params.agentSessionKey;
	}
}
async function appendDirectCronDeliveryTranscriptMirror(params) {
	if (!params.mirror.text && !params.mirror.mediaUrls?.length) return;
	try {
		const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
		const result = await appendAssistantMessageToSessionTranscript(params.mirror);
		if (!result.ok) await logCronDeliveryWarn(`[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${result.reason}`);
	} catch (err) {
		await logCronDeliveryWarn(`[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${formatErrorMessage(err)}`);
	}
}
function summarizeDirectCronDeliveryError(error) {
	if (error instanceof Error) return error.message || "error";
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) || String(error);
	} catch {
		return String(error);
	}
}
function isTransientDirectCronDeliveryError(error) {
	const message = summarizeDirectCronDeliveryError(error);
	if (!message) return false;
	if (PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) return false;
	return TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}
function resolveDirectCronRetryDelaysMs() {
	return [
		5e3,
		1e4,
		2e4
	];
}
async function retryTransientDirectCronDelivery(params) {
	const retryDelaysMs = resolveDirectCronRetryDelaysMs();
	let retryIndex = 0;
	for (;;) {
		if (params.signal?.aborted) throw new Error("cron delivery aborted");
		try {
			return await params.run();
		} catch (err) {
			const delayMs = retryDelaysMs[retryIndex];
			if (delayMs == null || !isTransientDirectCronDeliveryError(err) || params.signal?.aborted) throw err;
			const nextAttempt = retryIndex + 2;
			const maxAttempts = retryDelaysMs.length + 1;
			await logCronDeliveryWarn(`[cron:${params.jobId}] transient direct announce delivery failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1e3)}s: ${summarizeDirectCronDeliveryError(err)}`);
			retryIndex += 1;
			await sleepWithAbort(delayMs, params.signal);
		}
	}
}
async function dispatchCronDelivery(params) {
	const sourceDeliverySatisfied = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
	const verifiedMessageToolDelivery = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
	let summary = params.summary;
	let outputText = params.outputText;
	let synthesizedText = params.synthesizedText;
	let deliveryPayloads = params.deliveryPayloads;
	let delivered = verifiedMessageToolDelivery;
	let deliveryAttempted = verifiedMessageToolDelivery;
	let directCronSessionDeleted = false;
	const formatDeliveryTargetError = (error) => params.sourceDeliveryOutcome.unverifiedMessageToolDelivery ? `${error}; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target` : error;
	const failDeliveryTarget = (error) => params.withRunSession({
		status: "error",
		error: formatDeliveryTargetError(error),
		errorKind: "delivery-target",
		summary,
		outputText,
		deliveryAttempted,
		...params.telemetry
	});
	const cleanupDirectCronSessionIfNeeded = async () => {
		if (directCronSessionDeleted) return;
		directCronSessionDeleted = true;
		await cleanupDirectCronSession({
			job: params.job,
			agentSessionKey: params.agentSessionKey,
			sessionId: params.sessionId,
			retireReason: "cron-delete-after-run-fallback"
		});
	};
	const finishSilentReplyDelivery = async () => {
		deliveryAttempted = true;
		await cleanupDirectCronSessionIfNeeded();
		return params.withRunSession({
			status: "ok",
			summary,
			outputText,
			delivered: false,
			deliveryAttempted: true,
			...params.telemetry
		});
	};
	const deliverViaDirect = async (delivery, options) => {
		const { buildOutboundSessionContext, createOutboundSendDeps, resolveAgentOutboundIdentity, sendDurableMessageBatch } = await loadDeliveryOutboundRuntime();
		const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
		const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
			jobId: params.job.id,
			runStartedAt: params.runStartedAt,
			delivery
		});
		try {
			const normalizedPayloads = (deliveryPayloads.length > 0 ? deliveryPayloads : synthesizedText ? [{ text: synthesizedText }] : []).map((p) => {
				if (!p.text) return p;
				const normalized = normalizeSilentReplyText(p.text);
				return Object.assign({}, p, { text: normalized.strippedTrailingSilentToken ? void 0 : normalized.text });
			}).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
			if (normalizedPayloads.length === 0) return await finishSilentReplyDelivery();
			if (params.isAborted()) return params.withRunSession({
				status: "error",
				error: params.abortReason(),
				deliveryAttempted,
				...params.telemetry
			});
			if (params.deliveryRequested && isStaleCronDelivery({
				job: params.job,
				runStartedAt: params.runStartedAt
			})) {
				deliveryAttempted = true;
				const nowMs = Date.now();
				const scheduledAtMs = resolveCronDeliveryScheduledAtMs({
					job: params.job,
					runStartedAt: params.runStartedAt
				});
				const startDelayMs = resolveCronDeliveryStartDelayMs({
					job: params.job,
					runStartedAt: params.runStartedAt
				});
				await logCronDeliveryWarn(`[cron:${params.job.id}] skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 6e4)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 6e4)}m`);
				return params.withRunSession({
					status: "ok",
					summary,
					outputText,
					deliveryAttempted,
					delivered: false,
					...params.telemetry
				});
			}
			const payloadsForDelivery = (await maybeApplyTtsToCronPayloads({
				cfg: params.cfgWithAgentDefaults,
				payloads: normalizedPayloads,
				delivery,
				agentId: params.agentId,
				ttsAuto: params.ttsAuto
			})).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
			if (payloadsForDelivery.length === 0) return await finishSilentReplyDelivery();
			deliveryAttempted = true;
			if (getCompletedDirectCronDelivery(deliveryIdempotencyKey)) {
				delivered = true;
				return null;
			}
			const deliverySessionKey = await resolveDirectCronDeliverySessionKey({
				cfg: params.cfgWithAgentDefaults,
				job: params.job,
				agentId: params.agentId,
				agentSessionKey: params.agentSessionKey,
				delivery
			});
			const deliverySession = buildOutboundSessionContext({
				cfg: params.cfgWithAgentDefaults,
				agentId: params.agentId,
				sessionKey: deliverySessionKey
			});
			const mirrorTargetsAwarenessMainSession = isSameSessionKey(deliverySessionKey, resolveCronAwarenessMainSessionKey({
				cfg: params.cfgWithAgentDefaults,
				agentId: params.agentId
			}));
			let hadPartialFailure = false;
			const attemptedPayloadsForMirror = [];
			const onError = params.deliveryBestEffort ? (err, _payload) => {
				hadPartialFailure = true;
				logCronDeliveryErrorDeferred(`[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`);
			} : void 0;
			const runDelivery = async () => {
				attemptedPayloadsForMirror.length = 0;
				const send = await sendDurableMessageBatch({
					cfg: params.cfgWithAgentDefaults,
					channel: delivery.channel,
					to: delivery.to,
					accountId: delivery.accountId,
					threadId: delivery.threadId,
					payloads: payloadsForDelivery,
					session: deliverySession,
					identity,
					bestEffort: params.deliveryBestEffort,
					durability: params.deliveryBestEffort ? "best_effort" : "required",
					deps: createOutboundSendDeps(params.deps),
					signal: params.abortSignal,
					onError,
					onPayload: (payload) => {
						attemptedPayloadsForMirror.push(payload);
					},
					skipQueue: true
				});
				if (send.status === "failed" || !params.deliveryBestEffort && send.status === "partial_failed") throw send.error;
				if (send.status === "partial_failed") hadPartialFailure = true;
				return send.status === "sent" || send.status === "partial_failed" ? send.results : [];
			};
			const deliveryResults = options?.retryTransient ? await retryTransientDirectCronDelivery({
				jobId: params.job.id,
				signal: params.abortSignal,
				run: runDelivery
			}) : await runDelivery();
			delivered = deliveryResults.length > 0 && !hadPartialFailure;
			const shouldQueueAwarenessForDelivery = shouldQueueCronAwareness({
				job: params.job,
				delivery,
				deliveryBestEffort: params.deliveryBestEffort
			});
			const awarenessText = shouldQueueAwarenessForDelivery ? resolveCronAwarenessText({
				outputText,
				synthesizedText,
				deliveryPayloads: payloadsForDelivery,
				outboundPayloads: attemptedPayloadsForMirror
			}) : void 0;
			const deliveryWillReachAwarenessMainSession = mirrorTargetsAwarenessMainSession && shouldQueueAwarenessForDelivery && !!awarenessText;
			const mirrorWouldBypassIsolatedAwarenessPolicy = mirrorTargetsAwarenessMainSession && params.job.sessionTarget === "isolated" && delivery.mode !== "explicit";
			if (delivered && !deliveryWillReachAwarenessMainSession && !mirrorWouldBypassIsolatedAwarenessPolicy) {
				const mirrorText = resolveDirectCronTranscriptMirrorText(attemptedPayloadsForMirror.length > 0 ? projectDeliveredDirectCronPayloadsForMirror(attemptedPayloadsForMirror) : projectOutboundPayloadPlanForMirror(createOutboundPayloadPlan(buildDirectCronTranscriptMirrorPayloads(payloadsForDelivery), {
					cfg: params.cfgWithAgentDefaults,
					sessionKey: deliverySessionKey,
					surface: delivery.channel
				})));
				const transcriptMirror = {
					sessionKey: deliverySessionKey,
					agentId: params.agentId,
					text: mirrorText,
					mediaUrls: void 0,
					storePath: resolveStorePath(params.cfgWithAgentDefaults.session?.store, { agentId: resolveAgentIdFromSessionKey(deliverySessionKey) }),
					idempotencyKey: deliveryIdempotencyKey,
					config: params.cfgWithAgentDefaults
				};
				await appendDirectCronDeliveryTranscriptMirror({
					job: params.job,
					mirror: transcriptMirror
				});
			}
			if (delivered && shouldQueueAwarenessForDelivery) await queueCronAwarenessSystemEvent({
				cfg: params.cfgWithAgentDefaults,
				jobId: params.job.id,
				agentId: params.agentId,
				deliveryIdempotencyKey,
				outputText,
				synthesizedText,
				deliveryPayloads: payloadsForDelivery,
				outboundPayloads: attemptedPayloadsForMirror
			});
			if (delivered) rememberCompletedDirectCronDelivery(deliveryIdempotencyKey, deliveryResults);
			return null;
		} catch (err) {
			if (!params.deliveryBestEffort) return params.withRunSession({
				status: "error",
				summary,
				outputText,
				error: String(err),
				deliveryAttempted,
				...params.telemetry
			});
			await logCronDeliveryError(`[cron:${params.job.id}] delivery failed (bestEffort): ${formatErrorMessage(err)}`);
			return null;
		}
	};
	const deliverViaDirectAndCleanup = async (delivery, options) => {
		try {
			return await deliverViaDirect(delivery, options);
		} finally {
			await cleanupDirectCronSessionIfNeeded();
		}
	};
	const finalizeTextDelivery = async (delivery) => {
		if (!synthesizedText) return null;
		const initialSynthesizedText = synthesizedText.trim();
		const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
		const subagentRegistryRuntime = await loadDeliverySubagentRegistryRuntime();
		const subagentFollowupSessionKey = params.runSessionKey;
		let activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(subagentFollowupSessionKey);
		const shouldCheckCompletedDescendants = activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText);
		const subagentFollowupRuntime = shouldCheckCompletedDescendants || activeSubagentRuns > 0 || expectedSubagentFollowup ? await loadSubagentFollowupRuntime() : void 0;
		const completedDescendantReply = shouldCheckCompletedDescendants ? await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
			sessionKey: subagentFollowupSessionKey,
			runStartedAt: params.runStartedAt
		}) : void 0;
		const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
		if (!params.deliveryBestEffort && (activeSubagentRuns > 0 || expectedSubagentFollowup)) {
			let finalReply = await subagentFollowupRuntime?.waitForDescendantSubagentSummary({
				sessionKey: subagentFollowupSessionKey,
				initialReply: initialSynthesizedText,
				timeoutMs: params.timeoutMs,
				observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup
			});
			activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(subagentFollowupSessionKey);
			if (!finalReply && activeSubagentRuns === 0) finalReply = await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
				sessionKey: subagentFollowupSessionKey,
				runStartedAt: params.runStartedAt
			});
			if (finalReply && activeSubagentRuns === 0) {
				outputText = finalReply;
				summary = pickSummaryFromOutput(finalReply) ?? summary;
				synthesizedText = finalReply;
				deliveryPayloads = [{ text: finalReply }];
			}
		} else if (completedDescendantReply) {
			outputText = completedDescendantReply;
			summary = pickSummaryFromOutput(completedDescendantReply) ?? summary;
			synthesizedText = completedDescendantReply;
			deliveryPayloads = [{ text: completedDescendantReply }];
		}
		if (!params.deliveryBestEffort && activeSubagentRuns > 0) {
			deliveryAttempted = true;
			return params.withRunSession({
				status: "ok",
				summary,
				outputText,
				deliveryAttempted,
				...params.telemetry
			});
		}
		if (hadDescendants && synthesizedText.trim() === initialSynthesizedText && isLikelyInterimCronMessage(initialSynthesizedText) && !isSilentReplyText(initialSynthesizedText, "NO_REPLY")) {
			deliveryAttempted = true;
			return params.withRunSession({
				status: "ok",
				summary,
				outputText,
				deliveryAttempted,
				...params.telemetry
			});
		}
		const normalizedSynthesizedText = normalizeSilentReplyText(synthesizedText);
		if (normalizedSynthesizedText.text === void 0 || normalizedSynthesizedText.strippedTrailingSilentToken) return await finishSilentReplyDelivery();
		synthesizedText = normalizedSynthesizedText.text;
		outputText = synthesizedText;
		if (params.isAborted()) return params.withRunSession({
			status: "error",
			error: params.abortReason(),
			deliveryAttempted,
			...params.telemetry
		});
		return await deliverViaDirectAndCleanup(delivery, { retryTransient: true });
	};
	if (params.deliveryRequested && !params.skipHeartbeatDelivery && !sourceDeliverySatisfied) {
		if (!params.resolvedDelivery.ok) {
			if (!params.deliveryBestEffort) return {
				result: failDeliveryTarget(params.resolvedDelivery.error.message),
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
			await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
			return {
				result: params.withRunSession({
					status: "ok",
					summary,
					outputText,
					deliveryAttempted,
					...params.telemetry
				}),
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		}
		if (params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null) {
			const directResult = await deliverViaDirectAndCleanup(params.resolvedDelivery);
			if (directResult) return {
				result: directResult,
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		} else {
			const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
			if (finalizedTextResult) return {
				result: finalizedTextResult,
				delivered,
				deliveryAttempted,
				summary,
				outputText,
				synthesizedText,
				deliveryPayloads
			};
		}
	}
	return {
		delivered,
		deliveryAttempted,
		summary,
		outputText,
		synthesizedText,
		deliveryPayloads
	};
}
//#endregion
export { cleanupDirectCronSession, dispatchCronDelivery, resolveCronDeliveryBestEffort, resolveDeliveryTarget };
