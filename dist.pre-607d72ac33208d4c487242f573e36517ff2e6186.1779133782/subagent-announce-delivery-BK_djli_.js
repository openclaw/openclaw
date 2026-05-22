import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { i as isCronSessionKey } from "./session-key-utils-CJRKuBJA.js";
import { n as normalizeAccountId } from "./account-id-9_btbLFO.js";
import { l as normalizeMainKey, u as resolveAgentIdFromSessionKey } from "./session-key-CQewiu8n.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as getRuntimeConfig } from "./io-DxVmbF3R.js";
import "./config-CBeYX-pH.js";
import "./message-channel-core-CNnWDHPu.js";
import { c as isGatewayMessageChannel, r as isInternalMessageChannel, s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-DJtqYoTD.js";
import "./call-CiOX_d7c.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-Cd2Qar9Y.js";
import { i as resolveMainSessionKey } from "./main-session-X0KvSFJP.js";
import { h as stringifyRouteThreadId } from "./channel-route-DBqK_NgW.js";
import { i as normalizeDeliveryContext, r as mergeDeliveryContext } from "./delivery-context.shared-CPgWum5w.js";
import { u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { t as loadSessionStore } from "./store-load-NR217KeP.js";
import "./sessions-Buwioyq3.js";
import { d as queueEmbeddedPiMessageWithOutcomeAsync, i as formatEmbeddedPiQueueFailureSummary, o as isEmbeddedPiRunActive, p as resolveActiveEmbeddedRunSessionId } from "./runs-ClbTjXdu.js";
import { s as getSubagentDepthFromSessionStore } from "./subagent-capabilities-p9yM-kRv.js";
import { n as resolveCompletionChatType, t as completionRequiresMessageToolDelivery } from "./completion-delivery-policy-LuXj91YD.js";
import { t as basenameFromAnyPath } from "./file-name-CBPDmQDu.js";
import { n as resolveConversationDeliveryTarget } from "./delivery-context-BAih5QFq.js";
import { r as dispatchGatewayMethodInProcess } from "./server-plugins-DWjJh2Hp.js";
import { t as resolveQueueSettings } from "./queue-CN4uiGb2.js";
import { t as resolveExternalBestEffortDeliveryTarget } from "./best-effort-delivery-ClHEcFvQ.js";
import "./message-BAU0w3da.js";
import { r as normalizeConversationRef } from "./conversation-id-DkkH8hhw.js";
import { n as getSessionBindingService } from "./session-binding-service-Bizp3BT1.js";
import { t as resolveConversationIdFromTargets } from "./conversation-id-BRTuTs9K.js";
//#region src/agents/generated-attachments.ts
function generatedAttachmentReference(attachment) {
	return normalizeOptionalString(attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath);
}
function mediaUrlsFromGeneratedAttachments(attachments) {
	if (!attachments?.length) return [];
	const urls = [];
	const seen = /* @__PURE__ */ new Set();
	for (const attachment of attachments) {
		const url = generatedAttachmentReference(attachment);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}
function nameFromGeneratedAttachment(attachment) {
	return normalizeOptionalString(attachment.name) ?? basenameFromAnyPath(generatedAttachmentReference(attachment) ?? "");
}
function formatGeneratedAttachmentLines(attachments) {
	if (!attachments?.length) return [];
	const lines = ["Attachments:"];
	for (const [index, attachment] of attachments.entries()) {
		const parts = [`${index + 1}.`];
		const type = normalizeOptionalString(attachment.type);
		const name = nameFromGeneratedAttachment(attachment);
		const mimeType = normalizeOptionalString(attachment.mimeType);
		const path = normalizeOptionalString(attachment.path ?? attachment.filePath);
		const url = normalizeOptionalString(attachment.url ?? attachment.mediaUrl);
		if (type) parts.push(`type=${type}`);
		if (name) parts.push(`name=${JSON.stringify(name)}`);
		if (mimeType) parts.push(`mimeType=${mimeType}`);
		if (path) parts.push(`path=${JSON.stringify(path)}`);
		else if (url) parts.push(`mediaUrl=${JSON.stringify(url)}`);
		lines.push(parts.join(" "));
	}
	return lines;
}
//#endregion
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
function collectStringValues(value, output) {
	if (typeof value === "string" && value.trim()) {
		output.add(value.trim());
		return;
	}
	if (!Array.isArray(value)) return;
	for (const entry of value) if (typeof entry === "string" && entry.trim()) output.add(entry.trim());
}
function collectMediaUrlsFromRecord(record, output) {
	collectStringValues(record.mediaUrl, output);
	collectStringValues(record.mediaUrls, output);
	collectStringValues(record.path, output);
	collectStringValues(record.url, output);
	collectStringValues(record.filePath, output);
	const attachments = record.attachments;
	if (Array.isArray(attachments)) {
		for (const attachment of attachments) if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) collectMediaUrlsFromRecord(attachment, output);
	}
}
function collectDeliveredMediaUrls(result) {
	const urls = /* @__PURE__ */ new Set();
	if (Array.isArray(result.payloads)) {
		for (const payload of result.payloads) if (payload && typeof payload === "object" && !Array.isArray(payload)) collectMediaUrlsFromRecord(payload, urls);
	}
	collectStringValues(result.messagingToolSentMediaUrls, urls);
	if (Array.isArray(result.messagingToolSentTargets)) {
		for (const target of result.messagingToolSentTargets) if (target && typeof target === "object" && !Array.isArray(target)) collectMediaUrlsFromRecord(target, urls);
	}
	return Array.from(urls);
}
function hasDeliveredExpectedMedia(result, expectedMediaUrls) {
	const expected = Array.from(new Set(expectedMediaUrls.map((url) => url.trim()).filter((url) => url.length > 0)));
	if (expected.length === 0) return true;
	const delivered = new Set(collectDeliveredMediaUrls(result));
	return expected.every((url) => delivered.has(url));
}
function hasPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function getGatewayAgentResult(response) {
	if (!response || typeof response !== "object") return null;
	const candidate = hasAgentDeliveryEvidenceShape(response) ? response : response.result;
	if (!candidate || typeof candidate !== "object" || !hasAgentDeliveryEvidenceShape(candidate)) return null;
	return candidate;
}
function hasAgentDeliveryEvidenceShape(value) {
	return "payloads" in value || "deliveryStatus" in value || "didSendViaMessagingTool" in value || "messagingToolSentTexts" in value || "messagingToolSentMediaUrls" in value || "messagingToolSentTargets" in value || "successfulCronAdds" in value || "meta" in value;
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
function mapSteerOutcomeToDeliveryResult(outcome) {
	if (outcome.status === "steered") return {
		delivered: true,
		path: "steered",
		deliveredAt: outcome.deliveredAt,
		enqueuedAt: outcome.enqueuedAt
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
			deliveredAt: result.deliveredAt,
			enqueuedAt: result.enqueuedAt,
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
		const primarySteerOutcome = await params.steer();
		const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
		appendPhase("steer-primary", primarySteer);
		if (primarySteer.delivered) return withPhases(primarySteer);
		if (primarySteerOutcome.status === "dropped") return withPhases(primarySteer);
		const primaryDirect = await params.direct();
		appendPhase("direct-primary", primaryDirect);
		return withPhases(primaryDirect);
	}
	const primaryDirect = await params.direct();
	appendPhase("direct-primary", primaryDirect);
	if (primaryDirect.delivered) return withPhases(primaryDirect);
	if (params.signal?.aborted) return withPhases(primaryDirect);
	const fallbackSteer = mapSteerOutcomeToDeliveryResult(await params.steer());
	appendPhase("steer-fallback", fallbackSteer);
	if (fallbackSteer.delivered) return withPhases(fallbackSteer);
	return withPhases(primaryDirect);
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
const AGENT_MEDIATED_COMPLETION_TOOLS = new Set([
	"image_generate",
	"music_generate",
	"subagent_announce",
	"video_generate"
]);
let subagentAnnounceDeliveryDeps = {
	dispatchGatewayMethodInProcess,
	getRuntimeConfig,
	getRequesterSessionActivity: (requesterSessionKey) => {
		const sessionId = resolveActiveEmbeddedRunSessionId(requesterSessionKey) ?? loadRequesterSessionEntry(requesterSessionKey).entry?.sessionId;
		return {
			sessionId,
			isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId))
		};
	},
	queueEmbeddedPiMessageWithOutcome: queueEmbeddedPiMessageWithOutcomeAsync
};
async function resolveQueueEmbeddedPiMessageOutcome(sessionId, text, options) {
	return await subagentAnnounceDeliveryDeps.queueEmbeddedPiMessageWithOutcome(sessionId, text, options);
}
async function runAnnounceAgentCall(params) {
	return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess("agent", params.agentParams, {
		expectFinal: params.expectFinal,
		timeoutMs: params.timeoutMs
	});
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
	/\ball models failed\b/i,
	/\ball profiles unavailable\b/i,
	/\boverloaded\b/i,
	/\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i
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
	const conversationId = stringifyRouteThreadId(requesterOrigin?.threadId != null && requesterOrigin.threadId !== "" ? requesterOrigin.threadId : void 0) || resolveConversationIdFromTargets({ targets: [to] }) || "";
	const requesterConversation = channel && conversationId ? {
		channel,
		accountId,
		conversationId
	} : void 0;
	const router = createBoundDeliveryRouter();
	const requesterRoute = router.resolveDestination({
		eventKind: "task_completion",
		targetSessionKey: params.requesterSessionKey,
		requester: requesterConversation,
		failClosed: true
	});
	if (requesterRoute.mode === "bound" && requesterRoute.binding) return mergeDeliveryContext(resolveBoundConversationOrigin({
		bindingConversation: requesterRoute.binding.conversation,
		requesterConversation,
		requesterOrigin
	}), requesterOrigin);
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
async function maybeSteerSubagentAnnounce(params) {
	if (params.signal?.aborted) return { status: "none" };
	const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
	const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
	const { sessionId } = resolveRequesterSessionActivity(canonicalKey);
	if (!sessionId) return { status: "none" };
	const queueSettings = resolveQueueSettings({
		cfg,
		channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
		sessionEntry: entry
	});
	const queueOptions = {
		deliveryTimeoutMs: params.deliveryTimeoutMs,
		steeringMode: "all",
		...queueSettings.debounceMs !== void 0 ? { debounceMs: queueSettings.debounceMs } : {},
		waitForTranscriptCommit: true
	};
	let queueOutcome = await resolveQueueEmbeddedPiMessageOutcome(sessionId, params.steerMessage, queueOptions);
	if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
		const bestEffortQueueOptions = { ...queueOptions };
		delete bestEffortQueueOptions.waitForTranscriptCommit;
		queueOutcome = await resolveQueueEmbeddedPiMessageOutcome(sessionId, params.steerMessage, bestEffortQueueOptions);
	}
	if (queueOutcome.queued) return {
		status: "steered",
		deliveredAt: queueOutcome.deliveredAtMs,
		enqueuedAt: queueOutcome.enqueuedAtMs
	};
	return { status: resolveRequesterSessionActivity(canonicalKey).isActive ? "dropped" : "none" };
}
function hasVisibleGatewayAgentPayload(response) {
	const result = getGatewayAgentResult(response);
	return Boolean(result && (hasVisibleAgentPayload(result) || hasMessagingToolDeliveryEvidence(result)));
}
function requiresAgentMediatedCompletionDelivery(params) {
	return params.expectsCompletionMessage && AGENT_MEDIATED_COMPLETION_TOOLS.has(normalizeOptionalLowercaseString(params.sourceTool) ?? "");
}
function hasGatewayAgentMessagingToolDelivery(response) {
	const result = getGatewayAgentResult(response);
	return Boolean(result && hasMessagingToolDeliveryEvidence(result));
}
function collectExpectedMediaFromInternalEvents(events) {
	if (!events?.length) return [];
	const mediaUrls = [];
	const seen = /* @__PURE__ */ new Set();
	for (const event of events) {
		const values = [...Array.isArray(event.mediaUrls) ? event.mediaUrls : [], ...mediaUrlsFromGeneratedAttachments(event.attachments)];
		for (const value of values) {
			const normalized = typeof value === "string" ? value.trim() : "";
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			mediaUrls.push(normalized);
		}
	}
	return mediaUrls;
}
function hasGatewayAgentDeliveredExpectedMedia(response, expectedMediaUrls) {
	const result = getGatewayAgentResult(response);
	return Boolean(result && hasDeliveredExpectedMedia(result, expectedMediaUrls));
}
function getGatewayAgentCommandDeliveryFailure(response) {
	const result = getGatewayAgentResult(response);
	return result ? getAgentCommandDeliveryFailure(result) : void 0;
}
function isGatewayAgentRunPending(response) {
	if (!response || typeof response !== "object") return false;
	const status = response.status;
	return isNonTerminalAgentRunStatus(status);
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
		const agentMediatedCompletion = requiresAgentMediatedCompletionDelivery({
			expectsCompletionMessage: params.expectsCompletionMessage,
			sourceTool: params.sourceTool
		});
		const expectedMediaUrls = collectExpectedMediaFromInternalEvents(params.internalEvents);
		const completionChatType = resolveCompletionChatType({
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: canonicalRequesterSessionKey,
			requesterEntry,
			directOrigin: effectiveDirectOrigin,
			requesterSessionOrigin
		});
		const requiresMessageToolDelivery = agentMediatedCompletion && (completionChatType === "channel" || completionChatType === "group" || expectedMediaUrls.length > 0 || completionRequiresMessageToolDelivery({
			cfg,
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: canonicalRequesterSessionKey,
			requesterEntry,
			directOrigin: effectiveDirectOrigin,
			requesterSessionOrigin
		}));
		const completionSourceReplyDeliveryMode = requiresMessageToolDelivery ? "message_tool_only" : void 0;
		const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
		const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
		const requesterQueueSettings = resolveQueueSettings({
			cfg,
			channel: requesterEntry?.channel ?? requesterEntry?.lastChannel ?? requesterEntry?.origin?.provider ?? requesterSessionOrigin?.channel ?? directOrigin?.channel,
			sessionEntry: requesterEntry
		});
		if (params.expectsCompletionMessage && requesterActivity.sessionId) {
			const wakeOutcome = await resolveQueueEmbeddedPiMessageOutcome(requesterActivity.sessionId, params.triggerMessage, {
				deliveryTimeoutMs: announceTimeoutMs,
				steeringMode: "all",
				...completionSourceReplyDeliveryMode ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode } : {},
				...requesterQueueSettings.debounceMs !== void 0 ? { debounceMs: requesterQueueSettings.debounceMs } : {},
				waitForTranscriptCommit: true
			});
			if (wakeOutcome.queued) return {
				delivered: true,
				deliveredAt: wakeOutcome.deliveredAtMs,
				enqueuedAt: wakeOutcome.enqueuedAtMs,
				path: "steered"
			};
			if (requesterActivity.isActive) defaultRuntime.log(`[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: ${formatQueueWakeFailureError("active requester session could not be woken", wakeOutcome)}`);
		}
		if (params.signal?.aborted) return {
			delivered: false,
			path: "none"
		};
		const directAgentThreadId = shouldDeliverAgentFinal ? stringifyRouteThreadId(deliveryTarget.threadId) : sessionOnlyOriginChannel ? stringifyRouteThreadId(sessionOnlyOrigin?.threadId) : void 0;
		const directAgentParams = {
			sessionKey: canonicalRequesterSessionKey,
			message: params.triggerMessage,
			deliver: shouldDeliverAgentFinal,
			bestEffortDeliver: params.bestEffortDeliver,
			internalEvents: params.internalEvents,
			channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
			accountId: shouldDeliverAgentFinal ? deliveryTarget.accountId : sessionOnlyOriginChannel ? sessionOnlyOrigin?.accountId : void 0,
			to: shouldDeliverAgentFinal ? deliveryTarget.to : sessionOnlyOriginChannel ? sessionOnlyOrigin?.to : void 0,
			threadId: directAgentThreadId,
			inputProvenance: {
				kind: "inter_session",
				sourceSessionKey: params.sourceSessionKey,
				sourceChannel: params.sourceChannel ?? "webchat",
				sourceTool: params.sourceTool ?? "subagent_announce"
			},
			...completionSourceReplyDeliveryMode ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode } : {},
			continuationTrigger: params.continuationTriggerOverride,
			...params.traceparent ? { traceparent: params.traceparent } : {},
			idempotencyKey: params.directIdempotencyKey
		};
		let directAnnounceResponse;
		try {
			directAnnounceResponse = await runAnnounceDeliveryWithRetry({
				operation: params.expectsCompletionMessage ? "completion direct announce agent call" : "direct announce agent call",
				signal: params.signal,
				run: async () => await runAnnounceAgentCall({
					agentParams: directAgentParams,
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
		if (agentMediatedCompletion && expectedMediaUrls.length > 0 && !hasGatewayAgentDeliveredExpectedMedia(directAnnounceResponse, expectedMediaUrls)) return {
			delivered: false,
			path: "direct",
			error: "completion agent did not deliver generated media"
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
		steer: async () => await maybeSteerSubagentAnnounce({
			deliveryTimeoutMs: resolveSubagentAnnounceTimeoutMs(subagentAnnounceDeliveryDeps.getRuntimeConfig()),
			requesterSessionKey: params.requesterSessionKey,
			steerMessage: params.steerMessage,
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
export { resolveSubagentAnnounceTimeoutMs as a, isNonTerminalAgentRunStatus as c, hasOutboundDeliveryEvidence as d, hasVisibleAgentPayload as f, loadSessionEntryByKey as i, hasCommittedMessagingToolDeliveryEvidence as l, mediaUrlsFromGeneratedAttachments as m, isInternalAnnounceRequesterSession as n, resolveSubagentCompletionOrigin as o, formatGeneratedAttachmentLines as p, loadRequesterSessionEntry as r, runAnnounceDeliveryWithRetry as s, deliverSubagentAnnouncement as t, hasMessagingToolDeliveryEvidence as u };
