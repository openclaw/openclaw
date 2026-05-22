import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as isCronSessionKey } from "./session-key-utils-bmH32UOR.js";
import { n as normalizeAccountId } from "./account-id-9_btbLFO.js";
import { l as normalizeMainKey, u as resolveAgentIdFromSessionKey } from "./session-key-8g_Q03Po.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { i as getRuntimeConfig } from "./io-BTdvKaBm.js";
import "./config-DuPmRSz4.js";
import "./message-channel-core-B0llrko_.js";
import { c as isGatewayMessageChannel, r as isInternalMessageChannel, s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-TU1A55ap.js";
import { i as callGateway } from "./call-DDkJmLsy.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-DXf4X1LM.js";
import { i as resolveMainSessionKey } from "./main-session-DJ3ql58r.js";
import { h as stringifyRouteThreadId } from "./channel-route-xbmFitKi.js";
import { i as normalizeDeliveryContext, r as mergeDeliveryContext, t as deliveryContextFromSession } from "./delivery-context.shared-Cx37tn1U.js";
import { u as resolveStorePath } from "./paths-D2tVOYHR.js";
import { t as loadSessionStore } from "./store-load-6WUUNuxk.js";
import "./sessions-XMEnIfWG.js";
import { a as formatEmbeddedPiQueueFailureSummary, d as queueEmbeddedPiMessageWithOutcome, p as resolveActiveEmbeddedRunSessionId, s as isEmbeddedPiRunActive } from "./runs-YRsDmGSB.js";
import { a as getSubagentDepthFromSessionStore } from "./subagent-capabilities-C1Zvj0Es.js";
import { t as completionRequiresMessageToolDelivery } from "./completion-delivery-policy-CrFQx5o3.js";
import { n as resolveConversationDeliveryTarget } from "./delivery-context-BZNVS-89.js";
import { n as resolveRouteTargetForLoadedChannel } from "./target-parsing-loaded-DiVbjuMJ.js";
import "./message-CWhunGub.js";
import { n as resolvePiSteeringModeForQueueMode, r as resolveQueueSettings, t as isSteeringQueueMode } from "./queue-6v03PQCB.js";
import { t as resolveExternalBestEffortDeliveryTarget } from "./best-effort-delivery-CzB3LLpD.js";
import { r as normalizeConversationRef } from "./conversation-id-CrHDpSsl.js";
import { r as getSessionBindingService } from "./session-binding-service-D0ydi7vt.js";
import { t as resolveConversationIdFromTargets } from "./conversation-id-BJZlk1e0.js";
import { t as enqueueAnnounce } from "./subagent-announce-queue-BUfyTw2F.js";
//#region src/agents/pi-embedded-runner/delivery-evidence.ts
function hasNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function hasNonEmptyArray(value) {
	return Array.isArray(value) && value.length > 0;
}
function hasNonEmptyStringArray(value) {
	return Array.isArray(value) && value.some(hasNonEmptyString);
}
function hasPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function getGatewayAgentResult(response) {
	if (!response || typeof response !== "object" || !("result" in response)) return null;
	const result = response.result;
	if (!result || typeof result !== "object") return null;
	return result;
}
function hasVisibleAgentPayload(result, options = {}) {
	const payloads = result.payloads;
	if (!Array.isArray(payloads)) return false;
	return payloads.some((payload) => {
		if (!payload || typeof payload !== "object") return false;
		const record = payload;
		if (options.includeErrorPayloads === false && record.isError === true) return false;
		if (options.includeReasoningPayloads === false && record.isReasoning === true) return false;
		return Boolean(hasNonEmptyString(record.text) || hasNonEmptyString(record.mediaUrl) || hasNonEmptyStringArray(record.mediaUrls) || record.presentation || record.interactive || record.channelData);
	});
}
function hasMessagingToolDeliveryEvidence(result) {
	return result.didSendViaMessagingTool === true || hasCommittedMessagingToolDeliveryEvidence(result);
}
function hasCommittedMessagingToolDeliveryEvidence(result) {
	return hasNonEmptyStringArray(result.messagingToolSentTexts) || hasNonEmptyStringArray(result.messagingToolSentMediaUrls) || hasNonEmptyArray(result.messagingToolSentTargets);
}
function hasOutboundDeliveryEvidence(result) {
	return hasMessagingToolDeliveryEvidence(result) || hasPositiveNumber(result.successfulCronAdds) || hasPositiveNumber(result.meta?.toolSummary?.calls);
}
function getAgentCommandDeliveryFailure(result) {
	const status = result.deliveryStatus?.status;
	if (status !== "failed" && status !== "partial_failed") return;
	const message = result.deliveryStatus?.errorMessage;
	if (hasNonEmptyString(message)) return message;
	return status === "partial_failed" ? "agent delivery partially failed" : "agent delivery failed";
}
//#endregion
//#region src/shared/agent-run-status.ts
const NON_TERMINAL_AGENT_RUN_STATUSES = new Set([
	"accepted",
	"started",
	"in_flight"
]);
function isNonTerminalAgentRunStatus(status) {
	return typeof status === "string" && NON_TERMINAL_AGENT_RUN_STATUSES.has(status);
}
//#endregion
//#region src/agents/announce-idempotency.ts
function buildAnnounceIdFromChildRun(params) {
	return `v1:${params.childSessionKey}:${params.childRunId}`;
}
function buildAnnounceIdempotencyKey(announceId) {
	return `announce:${announceId}`;
}
function resolveQueueAnnounceId(params) {
	const announceId = params.announceId?.trim();
	if (announceId) return announceId;
	return `legacy:${params.sessionKey}:${params.enqueuedAt}`;
}
//#endregion
//#region src/infra/outbound/bound-delivery-router.ts
function isActiveBinding(record) {
	return record.status === "active";
}
function resolveBindingForRequester(requester, bindings) {
	const matchingChannelAccount = bindings.filter((entry) => {
		const conversation = normalizeConversationRef(entry.conversation);
		return conversation.channel === requester.channel && conversation.accountId === requester.accountId;
	});
	if (matchingChannelAccount.length === 0) return null;
	const exactConversation = matchingChannelAccount.find((entry) => normalizeConversationRef(entry.conversation).conversationId === requester.conversationId);
	if (exactConversation) return exactConversation;
	if (matchingChannelAccount.length === 1) return matchingChannelAccount[0] ?? null;
	return null;
}
function createBoundDeliveryRouter(service = getSessionBindingService()) {
	return { resolveDestination: (input) => {
		const targetSessionKey = input.targetSessionKey.trim();
		if (!targetSessionKey) return {
			binding: null,
			mode: "fallback",
			reason: "missing-target-session"
		};
		const activeBindings = service.listBySession(targetSessionKey).filter(isActiveBinding);
		if (activeBindings.length === 0) return {
			binding: null,
			mode: "fallback",
			reason: "no-active-binding"
		};
		if (!input.requester) {
			if (input.failClosed) return {
				binding: null,
				mode: "fallback",
				reason: "missing-requester"
			};
			if (activeBindings.length === 1) return {
				binding: activeBindings[0] ?? null,
				mode: "bound",
				reason: "single-active-binding"
			};
			return {
				binding: null,
				mode: "fallback",
				reason: "ambiguous-without-requester"
			};
		}
		const requester = normalizeConversationRef(input.requester);
		if (!requester.channel || !requester.conversationId) return {
			binding: null,
			mode: "fallback",
			reason: "invalid-requester"
		};
		const fromRequester = resolveBindingForRequester(requester, activeBindings);
		if (fromRequester) return {
			binding: fromRequester,
			mode: "bound",
			reason: "requester-match"
		};
		if (activeBindings.length === 1 && !input.failClosed) return {
			binding: activeBindings[0] ?? null,
			mode: "bound",
			reason: "single-active-binding-fallback"
		};
		return {
			binding: null,
			mode: "fallback",
			reason: "no-requester-match"
		};
	} };
}
//#endregion
//#region src/agents/subagent-announce-dispatch.ts
function mapQueueOutcomeToDeliveryResult(outcome) {
	if (outcome === "steered") return {
		delivered: true,
		path: "steered"
	};
	if (outcome === "queued") return {
		delivered: true,
		path: "queued"
	};
	return {
		delivered: false,
		path: "none"
	};
}
async function runSubagentAnnounceDispatch(params) {
	const phases = [];
	const appendPhase = (phase, result) => {
		phases.push({
			phase,
			delivered: result.delivered,
			path: result.path,
			error: result.error
		});
	};
	const withPhases = (result) => ({
		...result,
		phases
	});
	if (params.signal?.aborted) return withPhases({
		delivered: false,
		path: "none"
	});
	if (!params.expectsCompletionMessage) {
		const primaryQueueOutcome = await params.queue();
		const primaryQueue = mapQueueOutcomeToDeliveryResult(primaryQueueOutcome);
		appendPhase("queue-primary", primaryQueue);
		if (primaryQueue.delivered) return withPhases(primaryQueue);
		if (primaryQueueOutcome === "dropped") return withPhases(primaryQueue);
		const primaryDirect = await params.direct();
		appendPhase("direct-primary", primaryDirect);
		return withPhases(primaryDirect);
	}
	const primaryDirect = await params.direct();
	appendPhase("direct-primary", primaryDirect);
	if (primaryDirect.delivered) return withPhases(primaryDirect);
	if (params.signal?.aborted) return withPhases(primaryDirect);
	const fallbackQueue = mapQueueOutcomeToDeliveryResult(await params.queue());
	appendPhase("queue-fallback", fallbackQueue);
	if (fallbackQueue.delivered) return withPhases(fallbackQueue);
	return withPhases(primaryDirect);
}
//#endregion
//#region src/agents/subagent-announce-origin.ts
function stripThreadRouteSuffix(target) {
	return /^(.*):topic:[^:]+$/u.exec(target)?.[1] ?? target;
}
function normalizeAnnounceRouteTarget(context) {
	const rawTo = normalizeOptionalString(context?.to);
	if (!rawTo) return;
	const channel = normalizeOptionalString(context?.channel);
	let route = stripThreadRouteSuffix((channel ? resolveRouteTargetForLoadedChannel({
		channel,
		rawTarget: rawTo,
		fallbackThreadId: context?.threadId
	}) : null)?.to ?? rawTo);
	if (channel && route.toLowerCase().startsWith(`${channel}:`)) route = route.slice(channel.length + 1);
	if (route.startsWith("group:") || route.startsWith("channel:")) route = route.slice(route.indexOf(":") + 1);
	return route || void 0;
}
function shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry) {
	if (!normalizedRequester?.to || normalizedRequester.threadId != null || normalizedEntry?.threadId == null) return false;
	const requesterTarget = normalizeAnnounceRouteTarget(normalizedRequester);
	const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry);
	if (requesterTarget && entryTarget) return requesterTarget !== entryTarget;
	return false;
}
function resolveAnnounceOrigin(entry, requesterOrigin) {
	const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
	const normalizedEntry = deliveryContextFromSession(entry);
	if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) return mergeDeliveryContext({
		accountId: normalizedRequester.accountId,
		threadId: normalizedRequester.threadId
	}, normalizedEntry);
	return mergeDeliveryContext(normalizedRequester, normalizedEntry && shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry) ? (() => {
		const { threadId: _ignore, ...rest } = normalizedEntry;
		return rest;
	})() : normalizedEntry);
}
//#endregion
//#region src/agents/subagent-requester-store-key.ts
function resolveRequesterStoreKey(cfg, requesterSessionKey) {
	const raw = (requesterSessionKey ?? "").trim();
	if (!raw) return raw;
	if (raw === "global" || raw === "unknown") return raw;
	if (raw.startsWith("agent:")) return raw;
	const mainKey = normalizeMainKey(cfg?.session?.mainKey);
	if (raw === "main" || raw === mainKey) return resolveMainSessionKey(cfg);
	return `agent:${resolveAgentIdFromSessionKey(raw)}:${raw}`;
}
//#endregion
//#region src/agents/subagent-announce-delivery.ts
const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 12e4;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2147e6;
const AGENT_MEDIATED_COMPLETION_TOOLS = new Set(["music_generate", "video_generate"]);
let subagentAnnounceDeliveryDeps = {
	callGateway,
	getRuntimeConfig,
	getRequesterSessionActivity: (requesterSessionKey) => {
		const sessionId = resolveActiveEmbeddedRunSessionId(requesterSessionKey) ?? loadRequesterSessionEntry(requesterSessionKey).entry?.sessionId;
		return {
			sessionId,
			isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId))
		};
	},
	queueEmbeddedPiMessageWithOutcome
};
function resolveQueueEmbeddedPiMessageOutcome(sessionId, text, options) {
	return subagentAnnounceDeliveryDeps.queueEmbeddedPiMessageWithOutcome(sessionId, text, options);
}
function formatQueueWakeFailureError(fallback, outcome) {
	const summary = formatEmbeddedPiQueueFailureSummary(outcome);
	return summary ? `${fallback}: ${summary}` : fallback;
}
function resolveBoundConversationOrigin(params) {
	const conversation = params.bindingConversation;
	const conversationId = conversation.conversationId?.trim() ?? "";
	const parentConversationId = conversation.parentConversationId?.trim() ?? "";
	const requesterConversationId = params.requesterConversation?.conversationId?.trim() ?? "";
	const requesterTo = params.requesterOrigin?.to?.trim();
	if (conversation.channel === "matrix" && parentConversationId && requesterConversationId && parentConversationId === requesterConversationId && requesterTo) return {
		channel: conversation.channel,
		accountId: conversation.accountId,
		to: requesterTo,
		...conversationId ? { threadId: conversationId } : {}
	};
	const boundTarget = resolveConversationDeliveryTarget({
		channel: conversation.channel,
		conversationId,
		parentConversationId
	});
	const inferredThreadId = boundTarget.threadId ?? (parentConversationId && parentConversationId !== conversationId ? conversationId : void 0) ?? (params.requesterOrigin?.threadId != null && params.requesterOrigin.threadId !== "" ? stringifyRouteThreadId(params.requesterOrigin.threadId) : void 0);
	if (requesterTo && conversationId && requesterConversationId && conversationId.toLowerCase() === requesterConversationId.toLowerCase()) return {
		channel: conversation.channel,
		accountId: conversation.accountId,
		to: requesterTo,
		threadId: inferredThreadId
	};
	return {
		channel: conversation.channel,
		accountId: conversation.accountId,
		to: boundTarget.to,
		threadId: inferredThreadId
	};
}
function resolveRequesterSessionActivity(requesterSessionKey) {
	const activity = subagentAnnounceDeliveryDeps.getRequesterSessionActivity(requesterSessionKey);
	if (activity.sessionId || activity.isActive) return activity;
	const { entry } = loadRequesterSessionEntry(requesterSessionKey);
	const sessionId = entry?.sessionId;
	return {
		sessionId,
		isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId))
	};
}
function resolveDirectAnnounceTransientRetryDelaysMs() {
	return process.env.OPENCLAW_TEST_FAST === "1" ? [
		8,
		16,
		32
	] : [
		5e3,
		1e4,
		2e4
	];
}
function resolveSubagentAnnounceTimeoutMs(cfg) {
	const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
	if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
	return Math.min(Math.max(1, Math.floor(configured)), MAX_TIMER_SAFE_TIMEOUT_MS);
}
function isInternalAnnounceRequesterSession(sessionKey) {
	return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}
function summarizeDeliveryError(error) {
	if (error instanceof Error) return error.message || "error";
	if (typeof error === "string") return error;
	if (error === void 0 || error === null) return "unknown error";
	try {
		return JSON.stringify(error);
	} catch {
		return "error";
	}
}
const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS = [
	/\berrorcode=unavailable\b/i,
	/\bstatus\s*[:=]\s*"?unavailable\b/i,
	/\bUNAVAILABLE\b/,
	/no active .* listener/i,
	/gateway not connected/i,
	/gateway closed \(1006/i,
	/gateway timeout/i,
	/\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
	/\ball models failed\b/i,
	/\ball profiles unavailable\b/i,
	/\boverloaded\b/i
];
const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS = [
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
function isTransientAnnounceDeliveryError(error) {
	const message = summarizeDeliveryError(error);
	if (!message) return false;
	if (PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) return false;
	return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}
function isPermanentAnnounceDeliveryError(error) {
	const message = summarizeDeliveryError(error);
	return Boolean(message && PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message)));
}
async function waitForAnnounceRetryDelay(ms, signal) {
	if (ms <= 0) return;
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	if (signal.aborted) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function runAnnounceDeliveryWithRetry(params) {
	const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
	let retryIndex = 0;
	for (;;) {
		if (params.signal?.aborted) throw new Error("announce delivery aborted");
		try {
			return await params.run();
		} catch (err) {
			const delayMs = retryDelaysMs[retryIndex];
			if (delayMs == null || !isTransientAnnounceDeliveryError(err) || params.signal?.aborted) throw err;
			const nextAttempt = retryIndex + 2;
			const maxAttempts = retryDelaysMs.length + 1;
			defaultRuntime.log(`[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1e3)}s: ${summarizeDeliveryError(err)}`);
			retryIndex += 1;
			await waitForAnnounceRetryDelay(delayMs, params.signal);
		}
	}
}
async function resolveSubagentCompletionOrigin(params) {
	const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
	const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
	const to = requesterOrigin?.to?.trim();
	const accountId = normalizeAccountId(requesterOrigin?.accountId);
	const conversationId = (requesterOrigin?.threadId != null && requesterOrigin.threadId !== "" ? stringifyRouteThreadId(requesterOrigin.threadId) : void 0) || resolveConversationIdFromTargets({ targets: [to] }) || "";
	const requesterConversation = channel && conversationId ? {
		channel,
		accountId,
		conversationId
	} : void 0;
	const router = createBoundDeliveryRouter();
	const childRoute = router.resolveDestination({
		eventKind: "task_completion",
		targetSessionKey: params.childSessionKey,
		requester: requesterConversation,
		failClosed: true
	});
	if (childRoute.mode === "bound" && childRoute.binding) return mergeDeliveryContext(resolveBoundConversationOrigin({
		bindingConversation: childRoute.binding.conversation,
		requesterConversation,
		requesterOrigin
	}), requesterOrigin);
	const route = router.resolveDestination({
		eventKind: "task_completion",
		targetSessionKey: params.requesterSessionKey,
		requester: requesterConversation,
		failClosed: true
	});
	if (route.mode === "bound" && route.binding) return mergeDeliveryContext(resolveBoundConversationOrigin({
		bindingConversation: route.binding.conversation,
		requesterConversation,
		requesterOrigin
	}), requesterOrigin);
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("subagent_delivery_target")) return requesterOrigin;
	try {
		const hookOrigin = normalizeDeliveryContext((await hookRunner.runSubagentDeliveryTarget({
			childSessionKey: params.childSessionKey,
			requesterSessionKey: params.requesterSessionKey,
			requesterOrigin,
			childRunId: params.childRunId,
			spawnMode: params.spawnMode,
			expectsCompletionMessage: params.expectsCompletionMessage
		}, {
			runId: params.childRunId,
			childSessionKey: params.childSessionKey,
			requesterSessionKey: params.requesterSessionKey
		}))?.origin);
		if (!hookOrigin) return requesterOrigin;
		if (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel)) return requesterOrigin;
		return mergeDeliveryContext(hookOrigin, requesterOrigin);
	} catch {
		return requesterOrigin;
	}
}
async function sendAnnounce(item) {
	const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(subagentAnnounceDeliveryDeps.getRuntimeConfig());
	const requesterIsSubagent = isInternalAnnounceRequesterSession(item.sessionKey);
	const origin = item.origin;
	const threadId = origin?.threadId != null && origin.threadId !== "" ? stringifyRouteThreadId(origin.threadId) : void 0;
	const deliveryTarget = !requesterIsSubagent ? resolveExternalBestEffortDeliveryTarget({
		channel: origin?.channel,
		to: origin?.to,
		accountId: origin?.accountId,
		threadId
	}) : { deliver: false };
	const idempotencyKey = buildAnnounceIdempotencyKey(resolveQueueAnnounceId({
		announceId: item.announceId,
		sessionKey: item.sessionKey,
		enqueuedAt: item.enqueuedAt
	}));
	await subagentAnnounceDeliveryDeps.callGateway({
		method: "agent",
		params: {
			sessionKey: item.sessionKey,
			message: item.prompt,
			channel: deliveryTarget.deliver ? deliveryTarget.channel : void 0,
			accountId: deliveryTarget.deliver ? deliveryTarget.accountId : void 0,
			to: deliveryTarget.deliver ? deliveryTarget.to : void 0,
			threadId: deliveryTarget.deliver ? deliveryTarget.threadId : void 0,
			deliver: deliveryTarget.deliver,
			internalEvents: item.internalEvents,
			inputProvenance: {
				kind: "inter_session",
				sourceSessionKey: item.sourceSessionKey,
				sourceChannel: item.sourceChannel ?? "webchat",
				sourceTool: item.sourceTool ?? "subagent_announce"
			},
			continuationTrigger: item.continuationTriggerOverride,
			...item.traceparent ? { traceparent: item.traceparent } : {},
			idempotencyKey
		},
		timeoutMs: announceTimeoutMs
	});
}
function loadRequesterSessionEntry(requesterSessionKey) {
	const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
	const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
	const agentId = resolveAgentIdFromSessionKey(canonicalKey);
	return {
		cfg,
		entry: loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }))[canonicalKey],
		canonicalKey
	};
}
function loadSessionEntryByKey(sessionKey) {
	const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
	const agentId = resolveAgentIdFromSessionKey(sessionKey);
	return loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }))[sessionKey];
}
function buildAnnounceQueueKey(sessionKey, origin) {
	const accountId = normalizeAccountId(origin?.accountId);
	if (!accountId) return sessionKey;
	return `${sessionKey}:acct:${accountId}`;
}
async function maybeQueueSubagentAnnounce(params) {
	if (params.signal?.aborted) return "none";
	const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
	const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
	const { sessionId, isActive } = resolveRequesterSessionActivity(canonicalKey);
	if (!sessionId) return "none";
	const queueSettings = resolveQueueSettings({
		cfg,
		channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
		sessionEntry: entry
	});
	if (isSteeringQueueMode(queueSettings.mode)) {
		if (resolveQueueEmbeddedPiMessageOutcome(sessionId, params.steerMessage, {
			steeringMode: resolvePiSteeringModeForQueueMode(queueSettings.mode),
			...queueSettings.debounceMs !== void 0 ? { debounceMs: queueSettings.debounceMs } : {}
		}).queued) return "steered";
	}
	const shouldFollowup = queueSettings.mode === "followup" || queueSettings.mode === "collect" || queueSettings.mode === "steer-backlog" || queueSettings.mode === "interrupt";
	if (isActive && (shouldFollowup || queueSettings.mode === "steer" || queueSettings.mode === "queue")) {
		const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
		return enqueueAnnounce({
			key: buildAnnounceQueueKey(canonicalKey, origin),
			item: {
				announceId: params.announceId,
				continuationTriggerOverride: params.continuationTriggerOverride,
				prompt: params.triggerMessage,
				summaryLine: params.summaryLine,
				internalEvents: params.internalEvents,
				enqueuedAt: Date.now(),
				sessionKey: canonicalKey,
				origin,
				sourceSessionKey: params.sourceSessionKey,
				sourceChannel: params.sourceChannel,
				sourceTool: params.sourceTool,
				...params.traceparent ? { traceparent: params.traceparent } : {}
			},
			settings: queueSettings,
			send: sendAnnounce,
			shouldDefer: (item) => resolveRequesterSessionActivity(item.sessionKey).isActive
		}) ? "queued" : "dropped";
	}
	return "none";
}
function hasVisibleGatewayAgentPayload(response) {
	const result = getGatewayAgentResult(response);
	return Boolean(result && (hasVisibleAgentPayload(result) || hasMessagingToolDeliveryEvidence(result)));
}
function isGatewayAgentRunPending(response) {
	if (!response || typeof response !== "object") return false;
	const status = response.status;
	return isNonTerminalAgentRunStatus(status);
}
function requiresAgentMediatedCompletionDelivery(params) {
	return params.expectsCompletionMessage && AGENT_MEDIATED_COMPLETION_TOOLS.has(normalizeOptionalLowercaseString(params.sourceTool) ?? "");
}
function hasGatewayAgentMessagingToolDelivery(response) {
	const result = getGatewayAgentResult(response);
	return Boolean(result && hasMessagingToolDeliveryEvidence(result));
}
function getGatewayAgentCommandDeliveryFailure(response) {
	const result = getGatewayAgentResult(response);
	return result ? getAgentCommandDeliveryFailure(result) : void 0;
}
function stripNonDeliverableChannelForCompletionOrigin(context) {
	const normalized = normalizeDeliveryContext(context);
	if (!normalized?.channel) return normalized;
	const channel = normalizeMessageChannel(normalized.channel);
	if (!channel || isDeliverableMessageChannel(channel)) return normalized;
	const { channel: _channel, ...rest } = normalized;
	return normalizeDeliveryContext(rest);
}
async function sendSubagentAnnounceDirectly(params) {
	if (params.signal?.aborted) return {
		delivered: false,
		path: "none"
	};
	const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
	const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
	const canonicalRequesterSessionKey = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
	try {
		const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
		const directOrigin = normalizeDeliveryContext(params.directOrigin);
		const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
		const externalCompletionDirectOrigin = stripNonDeliverableChannelForCompletionOrigin(completionDirectOrigin);
		const completionExternalFallbackOrigin = mergeDeliveryContext(directOrigin, requesterSessionOrigin);
		const effectiveDirectOrigin = params.expectsCompletionMessage ? mergeDeliveryContext(externalCompletionDirectOrigin, completionExternalFallbackOrigin) : directOrigin;
		const sessionOnlyOrigin = effectiveDirectOrigin?.channel ? effectiveDirectOrigin : requesterSessionOrigin;
		const requesterEntry = loadRequesterSessionEntry(params.targetRequesterSessionKey).entry;
		const deliveryTarget = !params.requesterIsSubagent ? resolveExternalBestEffortDeliveryTarget({
			channel: effectiveDirectOrigin?.channel,
			to: effectiveDirectOrigin?.to,
			accountId: effectiveDirectOrigin?.accountId,
			threadId: effectiveDirectOrigin?.threadId
		}) : { deliver: false };
		const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent ? normalizeMessageChannel(sessionOnlyOrigin?.channel) : void 0;
		const sessionOnlyOriginChannel = normalizedSessionOnlyOriginChannel && isGatewayMessageChannel(normalizedSessionOnlyOriginChannel) ? normalizedSessionOnlyOriginChannel : void 0;
		const requiresMessageToolDelivery = requiresAgentMediatedCompletionDelivery({
			expectsCompletionMessage: params.expectsCompletionMessage,
			sourceTool: params.sourceTool
		}) && completionRequiresMessageToolDelivery({
			cfg,
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: params.targetRequesterSessionKey,
			requesterEntry,
			directOrigin: effectiveDirectOrigin,
			requesterSessionOrigin
		});
		const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
		const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
		const requesterQueueSettings = resolveQueueSettings({
			cfg,
			channel: requesterEntry?.channel ?? requesterEntry?.lastChannel ?? requesterEntry?.origin?.provider ?? requesterSessionOrigin?.channel ?? directOrigin?.channel,
			sessionEntry: requesterEntry
		});
		if (params.expectsCompletionMessage && requesterActivity.sessionId) {
			const wakeOutcome = resolveQueueEmbeddedPiMessageOutcome(requesterActivity.sessionId, params.triggerMessage, {
				steeringMode: "all",
				...requesterQueueSettings.debounceMs !== void 0 ? { debounceMs: requesterQueueSettings.debounceMs } : {}
			});
			if (wakeOutcome.queued) return {
				delivered: true,
				path: "steered"
			};
			if (requesterActivity.isActive) return {
				delivered: false,
				path: "direct",
				error: formatQueueWakeFailureError("active requester session could not be woken", wakeOutcome)
			};
		}
		if (params.signal?.aborted) return {
			delivered: false,
			path: "none"
		};
		let directAnnounceResponse;
		try {
			directAnnounceResponse = await runAnnounceDeliveryWithRetry({
				operation: params.expectsCompletionMessage ? "completion direct announce agent call" : "direct announce agent call",
				signal: params.signal,
				run: async () => await subagentAnnounceDeliveryDeps.callGateway({
					method: "agent",
					params: {
						sessionKey: canonicalRequesterSessionKey,
						message: params.triggerMessage,
						deliver: shouldDeliverAgentFinal,
						bestEffortDeliver: params.bestEffortDeliver,
						internalEvents: params.internalEvents,
						channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
						accountId: shouldDeliverAgentFinal ? deliveryTarget.accountId : sessionOnlyOriginChannel ? sessionOnlyOrigin?.accountId : void 0,
						to: shouldDeliverAgentFinal ? deliveryTarget.to : sessionOnlyOriginChannel ? sessionOnlyOrigin?.to : void 0,
						threadId: shouldDeliverAgentFinal ? deliveryTarget.threadId : sessionOnlyOriginChannel ? sessionOnlyOrigin?.threadId : void 0,
						inputProvenance: {
							kind: "inter_session",
							sourceSessionKey: params.sourceSessionKey,
							sourceChannel: params.sourceChannel ?? "webchat",
							sourceTool: params.sourceTool ?? "subagent_announce"
						},
						continuationTrigger: params.continuationTriggerOverride,
						...params.traceparent ? { traceparent: params.traceparent } : {},
						idempotencyKey: params.directIdempotencyKey
					},
					expectFinal: true,
					timeoutMs: announceTimeoutMs
				})
			});
		} catch (err) {
			if (isPermanentAnnounceDeliveryError(err)) throw err;
			throw err;
		}
		if (isGatewayAgentRunPending(directAnnounceResponse)) return {
			delivered: true,
			path: "direct"
		};
		if (requiresMessageToolDelivery && !hasGatewayAgentMessagingToolDelivery(directAnnounceResponse)) return {
			delivered: false,
			path: "direct",
			error: "completion agent did not deliver through the message tool"
		};
		const directDeliveryFailure = shouldDeliverAgentFinal ? getGatewayAgentCommandDeliveryFailure(directAnnounceResponse) : void 0;
		if (directDeliveryFailure) return {
			delivered: false,
			path: "direct",
			error: directDeliveryFailure
		};
		if (params.expectsCompletionMessage && shouldDeliverAgentFinal && !hasVisibleGatewayAgentPayload(directAnnounceResponse)) return {
			delivered: false,
			path: "direct",
			error: "completion agent did not produce a visible reply"
		};
		return {
			delivered: true,
			path: "direct"
		};
	} catch (err) {
		return {
			delivered: false,
			path: "direct",
			error: summarizeDeliveryError(err)
		};
	}
}
async function deliverSubagentAnnouncement(params) {
	return await runSubagentAnnounceDispatch({
		expectsCompletionMessage: params.expectsCompletionMessage,
		signal: params.signal,
		queue: async () => await maybeQueueSubagentAnnounce({
			requesterSessionKey: params.requesterSessionKey,
			announceId: params.announceId,
			triggerMessage: params.triggerMessage,
			steerMessage: params.steerMessage,
			summaryLine: params.summaryLine,
			requesterOrigin: params.requesterOrigin,
			sourceSessionKey: params.sourceSessionKey,
			sourceChannel: params.sourceChannel,
			sourceTool: params.sourceTool,
			internalEvents: params.internalEvents,
			continuationTriggerOverride: params.continuationTriggerOverride,
			...params.traceparent ? { traceparent: params.traceparent } : {},
			signal: params.signal
		}),
		direct: async () => await sendSubagentAnnounceDirectly({
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: params.targetRequesterSessionKey,
			triggerMessage: params.triggerMessage,
			internalEvents: params.internalEvents,
			directIdempotencyKey: params.directIdempotencyKey,
			completionDirectOrigin: params.completionDirectOrigin,
			directOrigin: params.directOrigin,
			requesterSessionOrigin: params.requesterSessionOrigin,
			sourceSessionKey: params.sourceSessionKey,
			sourceChannel: params.sourceChannel,
			sourceTool: params.sourceTool,
			requesterIsSubagent: params.requesterIsSubagent,
			expectsCompletionMessage: params.expectsCompletionMessage,
			continuationTriggerOverride: params.continuationTriggerOverride,
			...params.traceparent ? { traceparent: params.traceparent } : {},
			signal: params.signal,
			bestEffortDeliver: params.bestEffortDeliver
		})
	});
}
//#endregion
export { resolveSubagentAnnounceTimeoutMs as a, resolveAnnounceOrigin as c, isNonTerminalAgentRunStatus as d, hasCommittedMessagingToolDeliveryEvidence as f, hasVisibleAgentPayload as h, loadSessionEntryByKey as i, buildAnnounceIdFromChildRun as l, hasOutboundDeliveryEvidence as m, isInternalAnnounceRequesterSession as n, resolveSubagentCompletionOrigin as o, hasMessagingToolDeliveryEvidence as p, loadRequesterSessionEntry as r, runAnnounceDeliveryWithRetry as s, deliverSubagentAnnouncement as t, buildAnnounceIdempotencyKey as u };
