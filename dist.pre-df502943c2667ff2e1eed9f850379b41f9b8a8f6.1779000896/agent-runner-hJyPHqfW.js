import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, t as hasNonEmptyString } from "./string-coerce-LndEvhRk.js";
import { t as sanitizeForLog } from "./ansi-Bk0Jp_0O.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { n as isAbortError } from "./unhandled-rejections-BySXedqI.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { C as hasSessionAutoModelFallbackProvenance, i as markAutoFallbackPrimaryProbe, n as entryMatchesAutoFallbackPrimaryProbe, p as resolveAutoFallbackPrimaryProbe, r as hasConfiguredModelFallbacks, t as clearAutoFallbackPrimaryProbeSelection } from "./agent-scope-C5uhMtO-.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-CQewiu8n.js";
import { r as resolveAgentConfig } from "./agent-scope-config-BWnA6LIS.js";
import { u as measureDiagnosticsTimelineSpan } from "./plugin-metadata-snapshot-DOP9YWW2.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as freezeDiagnosticTraceContext, s as runWithDiagnosticTraceparent, t as createChildDiagnosticTraceContext } from "./diagnostic-trace-context-B7EOHOXE.js";
import { a as isDiagnosticsEnabled, i as emitTrustedDiagnosticEvent } from "./diagnostic-events-QP40Y1ku.js";
import { r as logVerbose } from "./globals-Cnlrc0S3.js";
import { t as createSubsystemLogger } from "./subsystem-CwZgZA6E.js";
import "./defaults-CWlUbhpa.js";
import { _ as resolveResponseUsageMode, g as normalizeVerboseLevel } from "./thinking-Cq1bOxic.js";
import { n as parseNonNegativeByteSize } from "./zod-schema-Ys7BBeva.js";
import { f as resolveMessageChannel, i as isMarkdownCapableMessageChannel, r as isInternalMessageChannel } from "./message-channel-B9xZ12q8.js";
import { l as resolveOpenAIRuntimeProviderForPi } from "./openai-codex-routing-M8cBnlBl.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BabvJgc_.js";
import { x as resolveMemoryFlushPlan } from "./memory-state-DzCkKlf0.js";
import { i as emitAgentEvent, l as onAgentEvent, u as registerAgentRunContext } from "./agent-events-Cnxmg94X.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, o as resolveSessionTranscriptPath } from "./paths-Bapt3qQT.js";
import { A as resolveSessionStoreEntry, t as loadSessionStore } from "./store-load-BKsOFpyS.js";
import { c as updateSessionStoreEntry, s as updateSessionStore, v as resolveGroupSessionKey } from "./store-Ba2LZdfG.js";
import { c as resolveSessionPluginTraceLines, o as resolveFreshSessionTotalTokens, s as resolveSessionPluginStatusLines } from "./types-CXS4Fv_X.js";
import "./sessions-Be8CbMNm.js";
import { o as isAudioFileName } from "./mime-DWfYSjGf.js";
import { a as resolveContextTokensForModel } from "./context-CceQRA-D.js";
import { x as resolveModelRefFromString } from "./model-selection-shared-D-NMyYXW.js";
import { t as isCliProvider } from "./model-selection-cli-DWTx1Jla.js";
import { l as resolvePersistedOverrideModelRef } from "./model-selection-Co5pqKAn.js";
import { u as resolveModelAuthMode } from "./model-auth-D77BCc_n.js";
import { f as replyRunRegistry, i as createReplyOperation, t as ReplyRunAlreadyActiveError } from "./reply-run-registry-DDPPq6Sw.js";
import { d as queueEmbeddedPiMessageWithOutcomeAsync, i as formatEmbeddedPiQueueFailureSummary } from "./runs-CuLZvr8h.js";
import { n as spawnSubagentDirect } from "./subagent-spawn-BdJw_Gl6.js";
import { a as resolveModelCostConfig, i as formatUsd, n as estimateUsageCost, r as formatTokenCount } from "./usage-format-CeWDbIl8.js";
import { i as hasNonzeroUsage, n as derivePromptTokens, o as normalizeUsage, t as deriveContextPromptTokens } from "./usage-BimSzvmv.js";
import { l as readSessionMessagesAsync } from "./session-utils.fs-CxY3GBEI.js";
import { a as resolveSessionTranscriptCandidates } from "./session-transcript-files.fs-BfF4bmPx.js";
import { i as resolveSandboxConfigForAgent } from "./config-BPiSDmWi.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-D3ljnFJW.js";
import { o as stripLegacyBracketToolCallBlocks } from "./assistant-visible-text-PVZdIXLP.js";
import { r as formatRawAssistantErrorForUi } from "./assistant-error-format-COp9PdIZ.js";
import { d as sanitizeUserFacingText, i as formatRateLimitOrOverloadedErrorCopy, t as BILLING_ERROR_USER_MESSAGE } from "./sanitize-user-facing-text-CB4MRZOj.js";
import { i as isOverloadedErrorMessage, o as isRateLimitErrorMessage, r as isBillingErrorMessage } from "./failover-matches-CLDz2hkg.js";
import { r as hasCrossSessionDelegateTargeting } from "./targeting-pure-CoyWsRK2.js";
import { a as isSilentReplyText, c as stripLeadingSilentToken, i as isSilentReplyPrefixText, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripContinuationSignal } from "./tokens-CF0uy0oR.js";
import { u as stripHeartbeatToken } from "./heartbeat-DHq9F2jJ.js";
import { r as enqueueCommitmentExtraction } from "./runtime--UkagRNk.js";
import { c as emitContinuationWorkSpan, g as startContinuationDelegateSpan, i as emitContinuationDisabledSpan, m as resolveContinuationTraceparent, n as emitContinuationDelegateFireSpan, r as emitContinuationDelegateSpan, s as emitContinuationWorkFireSpan, t as emitContinuationCompactionReleasedSpan } from "./continuation-tracer-BgjZGLwk.js";
import { s as requestHeartbeatNow } from "./heartbeat-wake-z50YY6dQ.js";
import { o as generateSecureUuid, t as generateChainId } from "./secure-random-BlwDsoUi.js";
import { a as enqueueSystemEvent } from "./system-events-B4ot3XuJ.js";
import { n as GatewayDrainingError, t as CommandLaneClearedError } from "./command-queue-B_ee8LAq.js";
import { n as resolveSendPolicy } from "./send-policy-B0mdpHpi.js";
import { d as pendingDelegateCount, i as consumePendingDelegates, l as highestDelayedContinuationReservationHop, m as takeDelayedContinuationReservation, n as cancelPendingDelegates, p as stagedPostCompactionDelegateCount, r as clearDelayedContinuationReservations, t as addDelayedContinuationReservation } from "./delegate-store-C8ETMWnz.js";
import { n as stagePostCompactionDelegate, t as consumeStagedPostCompactionDelegates } from "./continuation-delegate-store-DS3e9cJy.js";
import { r as resolveLiveContinuationRuntimeConfig } from "./config-DtUpYAh8.js";
import { t as checkContextPressure } from "./context-pressure-D_q1dlvE.js";
import { l as retainContinuationTimerRef, o as registerContinuationTimerHandle, t as clearTrackedContinuationTimers, u as unregisterContinuationTimerHandle } from "./state-BkmbTshM.js";
import { a as listLegacyRuntimeModelProviderAliases, s as resolveCliRuntimeExecutionProvider, t as areRuntimeModelRefsEquivalent } from "./model-runtime-aliases-K5vZoPt4.js";
import "./pi-embedded-helpers-CirFrq6J.js";
import { n as classifyOAuthRefreshFailure, t as buildOAuthRefreshFailureLoginCommand } from "./oauth-refresh-failure-CA3EXo1b.js";
import { _ as isTransientHttpError, d as isContextOverflowError, m as isLikelyContextOverflowError, u as isCompactionFailureError } from "./errors-DcasbQCL.js";
import { t as formatProviderModelRef } from "./model-runtime-NcpoDXWn.js";
import "./fallback-notice-state-W7V0Lsct.js";
import { i as setReplyPayloadMetadata, n as getReplyPayloadMetadata, r as markReplyPayloadForSourceSuppressionDelivery, t as copyReplyPayloadMetadata } from "./reply-payload-fd79Zpvn.js";
import { m as resolveSendableOutboundReplyParts, s as hasOutboundReplyContent } from "./reply-payload-Dxgm53dW.js";
import { s as resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget-BwM1lROq.js";
import { r as getCliSessionBinding } from "./cli-session-Bkv33gJT.js";
import { lt as isLikelyExecutionAckPrompt } from "./selection-CRTFepzu.js";
import { u as parseReplyDirectives } from "./payloads-Bbpfisa4.js";
import { r as runWithModelFallback, t as isFallbackSummaryError, u as LiveSessionModelSwitchError } from "./model-fallback-DJ4udacN.js";
import { o as estimateMessagesTokens } from "./preemptive-compaction-DO7gY7gQ.js";
import { r as resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode-C9siZZHI.js";
import { c as completeFollowupRunLifecycle, l as isFollowupRunAborted, o as scheduleFollowupDrain, r as enqueueFollowupRun, s as refreshQueuedFollowupSession } from "./queue-DgqJB5Va.js";
import { n as hasCotFramePrefix } from "./normalize-reply-sEjfZJIM.js";
import { i as isRenderablePayload, n as applyReplyThreading, t as applyReplyTagsToPayload } from "./reply-payloads-30qVRDXc.js";
import { i as resolveReplyToMode, t as createReplyToModeFilterForChannel } from "./reply-threading-CzuOtuso.js";
import { n as filterMessagingToolMediaDuplicates, r as resolveMessagingToolPayloadDedupe, t as filterMessagingToolDuplicates } from "./reply-payloads-dedupe-s4SZ21lA.js";
import { n as routeReply, t as isRoutableChannel } from "./route-reply-34U-_Jm0.js";
import "./sandbox-DCLnEJ7m.js";
import { n as readPostCompactionContext } from "./post-compaction-context-CLhbGBfL.js";
import { n as buildAgentRuntimeOutcomePlan, t as buildAgentRuntimeDeliveryPlan } from "./build-stsZyQTX.js";
import { a as resolveQueuedReplyExecutionConfig, c as resolveRunAuthProfile, i as isBunFetchSocketError, o as resolveQueuedReplyRuntimeConfig, r as formatBunFetchSocketError, s as resolveModelFallbackOptions, t as buildEmbeddedRunExecutionParams } from "./agent-runner-utils-eyhp7_6C.js";
import { t as runCliAgent } from "./cli-runner-D9e6EfWM.js";
import { n as HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, t as GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "./agent-runner-failure-copy-DQal6C4G.js";
import { n as resolveOriginMessageProvider, r as resolveOriginMessageTo, t as resolveOriginAccountId } from "./origin-routing-BnUsSZjI.js";
import { a as createBlockReplyContentKey, i as createAudioAsVoiceBuffer, o as createBlockReplyPipeline, r as resolveEffectiveBlockStreamingConfig } from "./block-streaming-7IPT8CpI.js";
import { t as createReplyMediaContext } from "./reply-media-paths.runtime-CNv3_2UU.js";
import { n as incrementCompactionCount } from "./session-updates-DdmHBcs8.js";
import { r as resolveCronStorePath, t as loadCronStore } from "./store-LfCE2GbH.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-Cfw3fXQC.js";
import { n as persistRunSessionUsage, t as incrementRunCompactionCount } from "./session-run-accounting-gprfhNMM.js";
import { t as REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "./get-reply-run-queue-B5mzm_9R.js";
import { t as sanitizePendingFinalDeliveryText } from "./pending-final-delivery-Bs-wEU_G.js";
import { i as dispatchPostCompactionDelegates, s as persistPendingPostCompactionDelegates } from "./post-compaction-delegate-dispatch-BuWtPN8P.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
//#region src/auto-reply/continuation/signal.ts
/**
* Continuation signal extraction and merging.
*
* This module owns the logic that produces a unified ContinuationSignal from
* either bracket syntax in response text or tool-call requests captured during
* the agent turn. The runner calls this after the agent response finalizes.
*
* RFC: docs/design/continue-work-signal-v2.md §2.1, §3.4
*/
const log = createSubsystemLogger("continuation/signal");
/**
* Extract a continuation signal from the agent's response payloads and/or
* tool-call request.
*
* Priority: bracket-parsed signal takes precedence (it was explicitly in the
* response text). If no bracket signal, fall back to tool-call request.
*
* The bracket signal is stripped from the payload text so the user only sees
* the conversational reply.
*
* @param payloads - The agent's response payload array (text may be mutated to strip signal)
* @param continueWorkRequest - Tool-call request captured during the turn, if any
* @param enabled - Whether continuation is enabled in config
* @param sessionKey - Session key for logging
*/
function extractContinuationSignal(params) {
	const { payloads, continueWorkRequest, enabled, sessionKey } = params;
	if (!enabled) {
		log.info(`[continuation:trace] signal-extract skipped: feature disabled session=${sessionKey ?? "none"}`);
		return {
			signal: null,
			fromBracket: false
		};
	}
	let bracketSignal = null;
	let bracketPayloadIdx = -1;
	if (payloads.length > 0) {
		for (let i = payloads.length - 1; i >= 0; i--) {
			const payload = payloads[i];
			if (!payload.text) continue;
			const result = stripContinuationSignal(payload.text);
			if (result.signal) {
				bracketSignal = result.signal;
				bracketPayloadIdx = i;
				payload.text = result.text;
				break;
			}
		}
		const presenceMap = payloads.map((p, i) => `[${i}]text=${!!p.text}`).join(" ");
		log.info(`[continuation:trace] payload-scan: count=${payloads.length} bracketIdx=${bracketPayloadIdx} ${presenceMap} session=${sessionKey ?? "none"}`);
		if (bracketSignal) log.info(`[continuation:trace] bracket-parse: kind=${bracketSignal.kind} delayMs=${bracketSignal.delayMs ?? "default"} session=${sessionKey ?? "none"}`);
	} else log.info(`[continuation:trace] bracket-parse skipped: empty payloads session=${sessionKey ?? "none"}`);
	const signal = bracketSignal ?? (continueWorkRequest ? {
		kind: "work",
		delayMs: continueWorkRequest.delaySeconds * 1e3,
		...continueWorkRequest.traceparent ? { traceparent: continueWorkRequest.traceparent } : {}
	} : null);
	const fromBracket = bracketSignal !== null;
	const origin = bracketSignal ? "bracket" : signal ? "tool-call" : "none";
	const workReason = !bracketSignal && signal?.kind === "work" ? continueWorkRequest?.reason : void 0;
	log.info(`[continuation:trace] effective-signal: origin=${origin} kind=${signal?.kind ?? "none"} session=${sessionKey ?? "none"}`);
	return {
		signal,
		workReason,
		fromBracket
	};
}
//#endregion
//#region src/auto-reply/fallback-state.ts
const FALLBACK_REASON_PART_MAX = 80;
const TRANSIENT_FALLBACK_REASONS = new Set([
	"rate_limit",
	"overloaded",
	"timeout",
	"empty_response",
	"no_error_details",
	"unclassified"
]);
const TRANSIENT_ERROR_DETAIL_HINT_RE = /\b(?:429|5\d\d|too many requests|usage limit|quota|try again in|retry[- ]after|seconds?|minutes?|hours?|temporarily unavailable|overloaded|service unavailable|throttl)\b/i;
function truncateFallbackReasonPart(value, max = FALLBACK_REASON_PART_MAX) {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
function formatFallbackAttemptErrorPreview(attempt) {
	const rawError = attempt.error?.trim();
	if (!rawError) return;
	if (!attempt.reason || !TRANSIENT_FALLBACK_REASONS.has(attempt.reason)) return;
	if (!TRANSIENT_ERROR_DETAIL_HINT_RE.test(rawError)) return;
	const formatted = formatRawAssistantErrorForUi(rawError).replace(/^⚠️\s*/, "").replace(/\s+/g, " ").trim();
	if (!formatted || /unknown error/i.test(formatted)) return;
	return formatted;
}
function formatFallbackAttemptReason(attempt) {
	const errorPreview = formatFallbackAttemptErrorPreview(attempt);
	if (errorPreview) return errorPreview;
	const reason = attempt.reason?.trim();
	if (reason) return reason.replace(/_/g, " ");
	const code = attempt.code?.trim();
	if (code) return code;
	if (typeof attempt.status === "number") return `HTTP ${attempt.status}`;
	return truncateFallbackReasonPart(attempt.error || "error");
}
function formatFallbackAttemptSummary(attempt) {
	return `${formatProviderModelRef(attempt.provider, attempt.model)} ${formatFallbackAttemptReason(attempt)}`;
}
function buildFallbackReasonSummary(attempts) {
	const firstAttempt = attempts[0];
	const firstReason = firstAttempt ? formatFallbackAttemptReason(firstAttempt) : "selected model unavailable";
	const moreAttempts = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
	return `${truncateFallbackReasonPart(firstReason)}${moreAttempts}`;
}
function buildFallbackAttemptSummaries(attempts) {
	return attempts.map((attempt) => truncateFallbackReasonPart(formatFallbackAttemptSummary(attempt)));
}
function buildFallbackNotice(params) {
	const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
	const active = formatProviderModelRef(params.activeProvider, params.activeModel);
	if (areRuntimeModelRefsEquivalent(selected, active)) return null;
	return `↪️ Model Fallback: ${active} (selected ${selected}; ${buildFallbackReasonSummary(params.attempts)})`;
}
function buildFallbackClearedNotice(params) {
	const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
	const previous = normalizeOptionalString(params.previousActiveModel);
	if (previous && previous !== selected) return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
	return `↪️ Model Fallback cleared: ${selected}`;
}
function resolveFallbackTransition(params) {
	const selectedModelRef = formatProviderModelRef(params.selectedProvider, params.selectedModel);
	const activeModelRef = formatProviderModelRef(params.activeProvider, params.activeModel);
	const previousState = {
		selectedModel: normalizeOptionalString(params.state?.fallbackNoticeSelectedModel),
		activeModel: normalizeOptionalString(params.state?.fallbackNoticeActiveModel),
		reason: normalizeOptionalString(params.state?.fallbackNoticeReason)
	};
	const fallbackActive = !areRuntimeModelRefsEquivalent(selectedModelRef, activeModelRef);
	const fallbackTransitioned = fallbackActive && (previousState.selectedModel !== selectedModelRef || previousState.activeModel !== activeModelRef);
	const previousStateWasRealFallback = Boolean(previousState.selectedModel && previousState.activeModel && !areRuntimeModelRefsEquivalent(previousState.selectedModel, previousState.activeModel));
	const fallbackCleared = !fallbackActive && previousStateWasRealFallback;
	const reasonSummary = buildFallbackReasonSummary(params.attempts);
	const attemptSummaries = buildFallbackAttemptSummaries(params.attempts);
	const nextState = fallbackActive ? {
		selectedModel: selectedModelRef,
		activeModel: activeModelRef,
		reason: reasonSummary
	} : {
		selectedModel: void 0,
		activeModel: void 0,
		reason: void 0
	};
	return {
		selectedModelRef,
		activeModelRef,
		fallbackActive,
		fallbackTransitioned,
		fallbackCleared,
		reasonSummary,
		attemptSummaries,
		previousState,
		nextState,
		stateChanged: previousState.selectedModel !== nextState.selectedModel || previousState.activeModel !== nextState.activeModel || previousState.reason !== nextState.reason
	};
}
//#endregion
//#region src/shared/silent-reply-policy.ts
const DEFAULT_SILENT_REPLY_POLICY = {
	direct: "disallow",
	group: "allow",
	internal: "allow"
};
function classifySilentReplyConversationType(params) {
	if (params.conversationType) return params.conversationType;
	const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
	if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) return "group";
	if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) return "direct";
	if (normalizeLowercaseStringOrEmpty(params.surface) === "webchat") return "direct";
	return "internal";
}
function resolveSilentReplyPolicyFromPolicies(params) {
	if (params.conversationType === "direct") return "disallow";
	return params.surfacePolicy?.[params.conversationType] ?? params.defaultPolicy?.[params.conversationType] ?? DEFAULT_SILENT_REPLY_POLICY[params.conversationType];
}
//#endregion
//#region src/config/silent-reply.ts
function resolveSilentReplyConversationContext(params) {
	const conversationType = classifySilentReplyConversationType({
		sessionKey: params.sessionKey,
		surface: params.surface,
		conversationType: params.conversationType
	});
	const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
	const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : void 0;
	return {
		conversationType,
		defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
		surfacePolicy: surface?.silentReply
	};
}
function resolveSilentReplySettings(params) {
	return { policy: resolveSilentReplyPolicyFromPolicies(resolveSilentReplyConversationContext(params)) };
}
function resolveSilentReplyPolicy(params) {
	return resolveSilentReplySettings(params).policy;
}
//#endregion
//#region src/auto-reply/reply/agent-runner-cli-dispatch.ts
function shouldBridgeCliAssistantTextToReasoning(provider) {
	return normalizeLowercaseStringOrEmpty(provider) === "claude-cli";
}
function createAssistantTextBridge(params) {
	const deliver = params.deliver;
	if (!deliver) return {
		unsubscribe: () => void 0,
		drain: async () => void 0
	};
	let lastText;
	let unsubscribed = false;
	let delivery = Promise.resolve();
	const rawUnsubscribe = onAgentEvent((evt) => {
		if (evt.runId !== params.runId || evt.stream !== "assistant") return;
		if (params.suppressed) return;
		const text = typeof evt.data.text === "string" ? evt.data.text : void 0;
		if (text === void 0 || text === lastText) return;
		lastText = text;
		delivery = delivery.then(() => deliver(text)).catch(() => void 0);
	});
	return {
		unsubscribe() {
			if (unsubscribed) return;
			unsubscribed = true;
			rawUnsubscribe();
		},
		async drain() {
			await delivery;
		}
	};
}
async function runCliAgentWithLifecycle(params) {
	const startedAt = params.startedAt ?? Date.now();
	const emitLifecycleStart = params.emitLifecycleStart ?? true;
	const emitLifecycleTerminal = params.emitLifecycleTerminal ?? true;
	params.onAgentRunStart?.();
	if (emitLifecycleStart) emitAgentEvent({
		runId: params.runId,
		stream: "lifecycle",
		data: {
			phase: "start",
			startedAt
		}
	});
	const assistantBridge = createAssistantTextBridge({
		runId: params.runId,
		suppressed: params.suppressAssistantBridge,
		deliver: params.onAssistantText
	});
	const reasoningBridge = createAssistantTextBridge({
		runId: params.runId,
		suppressed: params.suppressAssistantBridge,
		deliver: shouldBridgeCliAssistantTextToReasoning(params.provider) ? params.onReasoningText : void 0
	});
	let lifecycleTerminalEmitted = false;
	try {
		const rawResult = await runCliAgent(params.runParams);
		const result = params.transformResult?.(rawResult) ?? rawResult;
		assistantBridge.unsubscribe();
		reasoningBridge.unsubscribe();
		await assistantBridge.drain();
		await reasoningBridge.drain();
		const cliText = normalizeOptionalString(result.payloads?.[0]?.text);
		if (cliText) emitAgentEvent({
			runId: params.runId,
			stream: "assistant",
			data: { text: cliText }
		});
		if (emitLifecycleTerminal) {
			emitAgentEvent({
				runId: params.runId,
				stream: "lifecycle",
				data: {
					phase: "end",
					startedAt,
					endedAt: Date.now()
				}
			});
			lifecycleTerminalEmitted = true;
		}
		return result;
	} catch (err) {
		assistantBridge.unsubscribe();
		reasoningBridge.unsubscribe();
		await assistantBridge.drain();
		await reasoningBridge.drain();
		await params.onErrorBeforeLifecycle?.(err);
		if (emitLifecycleTerminal) {
			emitAgentEvent({
				runId: params.runId,
				stream: "lifecycle",
				data: {
					phase: "error",
					startedAt,
					endedAt: Date.now(),
					error: String(err)
				}
			});
			lifecycleTerminalEmitted = true;
		}
		throw err;
	} finally {
		assistantBridge.unsubscribe();
		reasoningBridge.unsubscribe();
		if (emitLifecycleTerminal && !lifecycleTerminalEmitted) emitAgentEvent({
			runId: params.runId,
			stream: "lifecycle",
			data: {
				phase: "error",
				startedAt,
				endedAt: Date.now(),
				error: "CLI run completed without lifecycle terminal event"
			}
		});
	}
}
//#endregion
//#region src/auto-reply/reply/reply-delivery.ts
function normalizeReplyPayloadDirectives(params) {
	const parseMode = params.parseMode ?? "always";
	const silentToken = params.silentToken ?? "NO_REPLY";
	const sourceText = params.payload.text ?? "";
	const parsed = parseMode === "always" || parseMode === "auto" && (sourceText.includes("[[") || /media:/i.test(sourceText) || params.extractMarkdownImages === true && /!\[[^\]]*]\(/.test(sourceText) || sourceText.includes(silentToken)) ? parseReplyDirectives(sourceText, {
		currentMessageId: params.currentMessageId,
		silentToken,
		extractMarkdownImages: params.extractMarkdownImages
	}) : void 0;
	let text = parsed ? parsed.text || void 0 : params.payload.text || void 0;
	if (params.trimLeadingWhitespace && text) text = text.trimStart() || void 0;
	const mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;
	const mediaUrl = params.payload.mediaUrl ?? parsed?.mediaUrl ?? mediaUrls?.[0];
	return {
		payload: copyReplyPayloadMetadata(params.payload, {
			...params.payload,
			text,
			mediaUrls,
			mediaUrl,
			replyToId: params.payload.replyToId ?? parsed?.replyToId,
			replyToTag: params.payload.replyToTag || parsed?.replyToTag,
			replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
			audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice)
		}),
		isSilent: parsed?.isSilent ?? false
	};
}
async function sendDirectBlockReply(params) {
	params.directlySentBlockKeys.add(createBlockReplyContentKey(params.trackingPayload));
	await params.onBlockReply(params.payload);
}
function createBlockReplyDeliveryHandler(params) {
	return async (payload) => {
		const { text, skip } = params.normalizeStreamingText(payload);
		if (skip && !hasOutboundReplyContent({
			...payload,
			text: void 0
		})) return;
		const implicitCurrentMessageAllowed = payload.replyToCurrent === true ? true : payload.replyToCurrent === false ? false : params.replyThreading?.implicitCurrentMessage !== "deny";
		const taggedPayload = applyReplyTagsToPayload({
			...payload,
			text,
			mediaUrl: payload.mediaUrl ?? payload.mediaUrls?.[0],
			replyToId: payload.replyToId ?? (implicitCurrentMessageAllowed ? params.currentMessageId : void 0)
		}, params.currentMessageId);
		if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) return;
		const normalized = normalizeReplyPayloadDirectives({
			payload: taggedPayload,
			currentMessageId: params.currentMessageId,
			silentToken: SILENT_REPLY_TOKEN,
			trimLeadingWhitespace: true,
			parseMode: "auto"
		});
		const mediaNormalizedPayload = params.normalizeMediaPaths ? await params.normalizeMediaPaths(normalized.payload) : normalized.payload;
		let blockPayload = copyReplyPayloadMetadata(payload, params.applyReplyToMode(mediaNormalizedPayload));
		const blockHasNonTextContent = hasOutboundReplyContent({
			...blockPayload,
			text: void 0
		});
		if (blockPayload.text && hasCotFramePrefix(blockPayload.text)) {
			if (!blockHasNonTextContent) return;
			blockPayload = {
				...blockPayload,
				text: void 0
			};
		}
		if (!blockPayload.text && !blockHasNonTextContent && !blockPayload.audioAsVoice) return;
		if (normalized.isSilent && !blockHasNonTextContent) return;
		if (blockPayload.text) params.typingSignals.signalTextDelta(blockPayload.text).catch((err) => {
			logVerbose(`block reply typing signal failed: ${String(err)}`);
		});
		if (params.blockStreamingEnabled && params.blockReplyPipeline) params.blockReplyPipeline.enqueue(blockPayload);
		else if (params.blockStreamingEnabled) await sendDirectBlockReply({
			onBlockReply: params.onBlockReply,
			directlySentBlockKeys: params.directlySentBlockKeys,
			trackingPayload: blockPayload,
			payload: blockPayload
		});
		else if (blockHasNonTextContent) await sendDirectBlockReply({
			onBlockReply: params.onBlockReply,
			directlySentBlockKeys: params.directlySentBlockKeys,
			trackingPayload: blockPayload,
			payload: blockPayload
		});
	};
}
//#endregion
//#region src/auto-reply/reply/run-provenance.ts
function resolveReplyRunFireReason(params) {
	if (params.drainsContinuationDelegateQueue === true || params.opts?.continuationTrigger === "delegate-return") return "continuation-chain";
	if (params.opts?.continuationTrigger === "work-wake" || params.opts?.isHeartbeat === true) return "timer";
	return "external-trigger";
}
//#endregion
//#region src/auto-reply/reply/agent-runner-execution.ts
async function runEmbeddedPiAgentDefault$1(...args) {
	const { runEmbeddedPiAgent } = await import("./pi-embedded.runtime.js");
	return await runEmbeddedPiAgent(...args);
}
/** Type guard for wrapped continuation run results. */
function isContinuationWrappedRunResult(result) {
	return typeof result === "object" && result !== null && "result" in result && "continueWorkRequest" in result;
}
const GPT_CHAT_BREVITY_ACK_MAX_CHARS = 420;
const GPT_CHAT_BREVITY_ACK_MAX_SENTENCES = 3;
const GPT_CHAT_BREVITY_SOFT_MAX_CHARS = 900;
const GPT_CHAT_BREVITY_SOFT_MAX_SENTENCES = 6;
const BLOCKED_LIVENESS_NOTICE_TEXT = "⚠️ Agent liveness: blocked. The run cannot make progress; try again or start a fresh conversation if this repeats.";
async function releaseQueuedCompactionCompletion(params) {
	if (!params.compactionResult.ok || !params.compactionResult.compacted) return;
	if (!params.sessionKey || !params.activeSessionStore) {
		logVerbose(`[request_compaction:post-compaction-release-skipped] session=${params.sessionKey ?? "none"} reason=session-store-unavailable`);
		return;
	}
	const sessionEntry = params.getActiveSessionEntry() ?? params.activeSessionStore[params.sessionKey];
	if (!sessionEntry) {
		logVerbose(`[request_compaction:post-compaction-release-skipped] session=${params.sessionKey} reason=session-entry-unavailable`);
		return;
	}
	const { incrementRunCompactionCount } = await import("./session-run-accounting-BefojHiz.js");
	const compactionId = await incrementRunCompactionCount({
		cfg: params.followupRun.run.config,
		sessionEntry,
		sessionStore: params.activeSessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		amount: 1,
		compactionTokensAfter: params.compactionResult.result?.tokensAfter,
		newSessionId: params.compactionResult.result?.sessionId,
		newSessionFile: params.compactionResult.result?.sessionFile
	});
	const refreshedSessionEntry = resolveSessionStoreEntry({
		store: params.activeSessionStore,
		sessionKey: params.sessionKey
	}).existing ?? sessionEntry;
	const { dispatchPostCompactionDelegates } = await import("./post-compaction-delegate-dispatch-CmqyN8m1.js");
	const dispatchResult = await dispatchPostCompactionDelegates({
		cfg: params.followupRun.run.config,
		compactionCount: compactionId,
		followupRun: params.followupRun,
		postCompactionDelegatesToPreserve: [],
		releaseTraceparent: params.traceparent,
		sessionEntry: refreshedSessionEntry,
		sessionKey: params.sessionKey,
		sessionStore: params.activeSessionStore,
		storePath: params.storePath
	});
	const { emitContinuationCompactionReleasedSpan } = await import("./continuation-tracer-Dm6Blfuc.js");
	emitContinuationCompactionReleasedSpan({
		releasedCount: dispatchResult.queuedDelegates,
		compactionId,
		traceparent: params.traceparent,
		log: (message) => logVerbose(message)
	});
}
function readApprovalScopeValue(value) {
	return value === "turn" || value === "session" ? value : void 0;
}
const FALLBACK_SELECTION_STATE_KEYS = [
	"providerOverride",
	"modelOverride",
	"modelOverrideSource",
	"modelOverrideFallbackOriginProvider",
	"modelOverrideFallbackOriginModel",
	"authProfileOverride",
	"authProfileOverrideSource",
	"authProfileOverrideCompactionCount"
];
function setFallbackSelectionStateField(entry, key, value) {
	switch (key) {
		case "providerOverride":
			if (entry.providerOverride !== value) {
				entry.providerOverride = value;
				return true;
			}
			return false;
		case "modelOverride":
			if (entry.modelOverride !== value) {
				entry.modelOverride = value;
				return true;
			}
			return false;
		case "modelOverrideSource":
			if (entry.modelOverrideSource !== value) {
				entry.modelOverrideSource = value;
				return true;
			}
			return false;
		case "modelOverrideFallbackOriginProvider":
			if (entry.modelOverrideFallbackOriginProvider !== value) {
				entry.modelOverrideFallbackOriginProvider = value;
				return true;
			}
			return false;
		case "modelOverrideFallbackOriginModel":
			if (entry.modelOverrideFallbackOriginModel !== value) {
				entry.modelOverrideFallbackOriginModel = value;
				return true;
			}
			return false;
		case "authProfileOverride":
			if (entry.authProfileOverride !== value) {
				entry.authProfileOverride = value;
				return true;
			}
			return false;
		case "authProfileOverrideSource":
			if (entry.authProfileOverrideSource !== value) {
				entry.authProfileOverrideSource = value;
				return true;
			}
			return false;
		case "authProfileOverrideCompactionCount":
			if (entry.authProfileOverrideCompactionCount !== value) {
				entry.authProfileOverrideCompactionCount = value;
				return true;
			}
			return false;
	}
	throw new Error("Unsupported fallback selection state key");
}
function snapshotFallbackSelectionState(entry) {
	return {
		providerOverride: entry.providerOverride,
		modelOverride: entry.modelOverride,
		modelOverrideSource: entry.modelOverrideSource,
		modelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider,
		modelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel,
		authProfileOverride: entry.authProfileOverride,
		authProfileOverrideSource: entry.authProfileOverrideSource,
		authProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount
	};
}
function buildFallbackSelectionState(params) {
	return {
		providerOverride: params.provider,
		modelOverride: params.model,
		modelOverrideSource: "auto",
		modelOverrideFallbackOriginProvider: params.originProvider,
		modelOverrideFallbackOriginModel: params.originModel,
		authProfileOverride: params.authProfileId,
		authProfileOverrideSource: params.authProfileId ? params.authProfileIdSource : void 0,
		authProfileOverrideCompactionCount: void 0
	};
}
function resolveFallbackSelectionOrigin(params) {
	if (params.entry.modelOverrideSource === "auto" || params.entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(params.entry)) {
		const persistedOriginProvider = normalizeOptionalString(params.entry.modelOverrideFallbackOriginProvider);
		const persistedOriginModel = normalizeOptionalString(params.entry.modelOverrideFallbackOriginModel);
		if (persistedOriginProvider && persistedOriginModel) return {
			provider: persistedOriginProvider,
			model: persistedOriginModel
		};
	}
	return {
		provider: params.run.provider,
		model: params.run.model
	};
}
function applyFallbackCandidateSelectionToEntry(params) {
	if (!params.force && params.provider === params.run.provider && params.model === params.run.model) return { updated: false };
	const scopedAuthProfile = resolveRunAuthProfile(params.run, params.provider);
	const origin = params.origin ?? resolveFallbackSelectionOrigin({
		entry: params.entry,
		run: params.run
	});
	const nextState = buildFallbackSelectionState({
		provider: params.provider,
		model: params.model,
		originProvider: origin.provider,
		originModel: origin.model,
		authProfileId: scopedAuthProfile.authProfileId,
		authProfileIdSource: scopedAuthProfile.authProfileIdSource
	});
	return {
		updated: applyFallbackSelectionState(params.entry, nextState, params.now),
		nextState
	};
}
function applyFallbackSelectionState(entry, nextState, now = Date.now()) {
	let updated = false;
	for (const key of FALLBACK_SELECTION_STATE_KEYS) {
		const nextValue = nextState[key];
		if (nextValue === void 0) {
			if (Object.hasOwn(entry, key)) {
				delete entry[key];
				updated = true;
			}
			continue;
		}
		if (entry[key] !== nextValue) updated = setFallbackSelectionStateField(entry, key, nextValue) || updated;
	}
	if (updated) entry.updatedAt = now;
	return updated;
}
function rollbackFallbackSelectionStateIfUnchanged(entry, expectedState, previousState, now = Date.now()) {
	let updated = false;
	for (const key of FALLBACK_SELECTION_STATE_KEYS) {
		if (entry[key] !== expectedState[key]) continue;
		const previousValue = previousState[key];
		if (previousValue === void 0) {
			if (Object.hasOwn(entry, key)) {
				delete entry[key];
				updated = true;
			}
			continue;
		}
		if (entry[key] !== previousValue) updated = setFallbackSelectionStateField(entry, key, previousValue) || updated;
	}
	if (updated) entry.updatedAt = now;
	return updated;
}
/**
* Build a human-friendly rate-limit message from a FallbackSummaryError.
* Includes a countdown when the soonest cooldown expiry is known.
*/
function buildRateLimitCooldownMessage(err) {
	const codexUsageLimitMessage = extractCodexUsageLimitErrorMessage(err);
	if (codexUsageLimitMessage) return codexUsageLimitMessage;
	if (!isFallbackSummaryError(err)) return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
	const expiry = err.soonestCooldownExpiry;
	const now = Date.now();
	if (typeof expiry === "number" && expiry > now) {
		const secsLeft = Math.max(1, Math.ceil((expiry - now) / 1e3));
		if (secsLeft <= 60) return `⚠️ Rate-limited — ready in ~${secsLeft}s. Please wait a moment.`;
		return `⚠️ Rate-limited — ready in ~${Math.ceil(secsLeft / 60)} min. Please try again shortly.`;
	}
	return "⚠️ All models are temporarily rate-limited. Please try again in a few minutes.";
}
function extractCodexUsageLimitErrorMessage(err) {
	if (isFallbackSummaryError(err)) {
		for (const attempt of err.attempts) {
			const message = extractCodexUsageLimitMessage(attempt.error);
			if (message) return `⚠️ ${message}`;
		}
		return;
	}
	const message = extractCodexUsageLimitMessage(formatErrorMessage(err));
	return message ? `⚠️ ${message}` : void 0;
}
function extractCodexUsageLimitMessage(text) {
	const markers = ["You've reached your Codex subscription usage limit.", "Codex usage limit reached."];
	let markerIndex;
	for (const marker of markers) {
		const index = text.indexOf(marker);
		if (index >= 0 && (markerIndex === void 0 || index < markerIndex)) markerIndex = index;
	}
	if (markerIndex === void 0) return;
	const message = sanitizeUserFacingText(text.slice(markerIndex), { errorContext: true }).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(" ").trim();
	if (!message) return;
	return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}
function isPureTransientRateLimitSummary(err) {
	return isFallbackSummaryError(err) && err.attempts.length > 0 && err.attempts.every((attempt) => {
		const reason = attempt.reason;
		return reason === "rate_limit" || reason === "overloaded";
	});
}
function isPureBillingSummary(err) {
	return isFallbackSummaryError(err) && err.attempts.length > 0 && err.attempts.every((attempt) => attempt.reason === "billing");
}
function isToolResultTurnMismatchError(message) {
	const lower = normalizeLowercaseStringOrEmpty(message);
	return lower.includes("toolresult") && lower.includes("tooluse") && lower.includes("exceeds the number") && lower.includes("previous turn");
}
function collapseRepeatedFailureDetail(message) {
	const parts = message.split(/\s+\|\s+/u).map((part) => part.trim()).filter(Boolean);
	if (parts.length >= 2 && parts.every((part) => part === parts[0])) return parts[0];
	return message.trim();
}
const SAFE_MISSING_API_KEY_PROVIDERS = new Set([
	"anthropic",
	"google",
	"openai",
	"openai-codex"
]);
const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const AGENT_FAILED_BEFORE_REPLY_TEXT = "Agent failed before reply:";
function isNonDirectConversationContext(ctx) {
	const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
	return chatType === "group" || chatType === "channel";
}
function isVerboseFailureDetailEnabled(level) {
	return level === "on" || level === "full";
}
function resolveExternalRunFailureTextForConversation(params) {
	if (!isNonDirectConversationContext(params.sessionCtx)) return params.text;
	if (!params.isGenericRunnerFailure && !params.text.includes(AGENT_FAILED_BEFORE_REPLY_TEXT)) return params.text;
	if (resolveSilentReplyPolicy({
		cfg: params.cfg,
		sessionKey: params.sessionCtx.SessionKey,
		surface: params.sessionCtx.Surface ?? params.sessionCtx.Provider,
		conversationType: "group"
	}) === "disallow") return params.text;
	return SILENT_REPLY_TOKEN;
}
const CLI_BACKEND_NO_OUTPUT_STALL_RE = /\bCLI produced no output for\s+(\d+)\s*s\s+and was terminated\b/iu;
const CLI_BACKEND_OVERALL_TIMEOUT_RE = /\bCLI exceeded timeout\s*\(\s*(\d+)\s*s\s*\)\s+and was terminated\b/iu;
const CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE = /\b([\w.-]+\/[A-Za-z][\w.-]*)\s*:\s*CLI\b/iu;
function buildCliBackendTimeoutFailureText(message) {
	const normalizedMessage = collapseRepeatedFailureDetail(message);
	const stall = normalizedMessage.match(CLI_BACKEND_NO_OUTPUT_STALL_RE);
	const overall = normalizedMessage.match(CLI_BACKEND_OVERALL_TIMEOUT_RE);
	const seconds = (stall ?? overall)?.[1];
	if (!seconds) return null;
	const routedModelRef = normalizedMessage.match(CLI_BACKEND_ROUTING_REF_BEFORE_ERROR_RE)?.[1];
	return `⚠️ CLI subprocess${routedModelRef ? ` (routing ${routedModelRef})` : ""}: timed out after ${seconds}s (${stall ? "no-output stall" : "overall CLI turn budget"}). The gateway may still be healthy. Try \`/new\`, a lighter model, or raise \`agents.defaults.timeoutSeconds\` and the watchdog \`noOutputTimeoutMs\` entries under \`cliBackends.<your-runtime>\`.`;
}
function buildMissingApiKeyFailureText(message) {
	const normalizedMessage = collapseRepeatedFailureDetail(message);
	const provider = normalizedMessage.match(/No API key found for provider "([^"]+)"/u)?.[1]?.trim().toLowerCase();
	if (!provider) return null;
	if (provider === "openai" && normalizedMessage.includes("OpenAI Codex OAuth")) return "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.5` with the Codex OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.";
	if (SAFE_MISSING_API_KEY_PROVIDERS.has(provider)) return `⚠️ Missing API key for provider "${provider}". Configure the gateway auth for that provider, then try again.`;
	return "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.";
}
function formatForwardedExternalRunFailureText(message) {
	const sanitized = sanitizeUserFacingText(message, { errorContext: true }).trim().replace(/^⚠️\s*/u, "").replace(/\s+/gu, " ");
	if (!sanitized) return GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
	const detail = sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS ? `${sanitized.slice(0, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…` : sanitized;
	return `⚠️ Agent failed before reply: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Please try again, or use /new to start a fresh session.`;
}
function buildExternalRunFailureReply(message, options) {
	const normalizedMessage = collapseRepeatedFailureDetail(message);
	const missingApiKeyFailure = buildMissingApiKeyFailureText(normalizedMessage);
	if (missingApiKeyFailure) return {
		text: missingApiKeyFailure,
		isGenericRunnerFailure: false
	};
	const oauthRefreshFailure = classifyOAuthRefreshFailure(normalizedMessage);
	if (oauthRefreshFailure) {
		const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider);
		if (oauthRefreshFailure.reason) return {
			text: `⚠️ Model login expired on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Re-auth with \`${loginCommand}\`, then try again.`,
			isGenericRunnerFailure: false
		};
		return {
			text: `⚠️ Model login failed on the gateway${oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : ""}. Please try again. If this keeps happening, re-auth with \`${loginCommand}\`.`,
			isGenericRunnerFailure: false
		};
	}
	if (options?.isHeartbeat) return {
		text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
		isGenericRunnerFailure: false
	};
	if (isToolResultTurnMismatchError(normalizedMessage)) return {
		text: "⚠️ Session history got out of sync. Please try again, or use /new to start a fresh session.",
		isGenericRunnerFailure: false
	};
	const cliBackendTimeoutFailure = buildCliBackendTimeoutFailureText(normalizedMessage);
	if (cliBackendTimeoutFailure) return {
		text: cliBackendTimeoutFailure,
		isGenericRunnerFailure: false
	};
	return {
		text: options?.includeDetails ? formatForwardedExternalRunFailureText(normalizedMessage) : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
		isGenericRunnerFailure: true
	};
}
function markAgentRunFailureReplyPayload(payload) {
	return markReplyPayloadForSourceSuppressionDelivery(payload);
}
function buildKnownAgentRunFailureReplyPayload(params) {
	const message = formatErrorMessage(params.err);
	const isFallbackSummary = isFallbackSummaryError(params.err);
	if (isFallbackSummary ? isPureBillingSummary(params.err) : isBillingErrorMessage(message)) return markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
		text: BILLING_ERROR_USER_MESSAGE,
		sessionCtx: params.sessionCtx,
		isGenericRunnerFailure: false,
		cfg: params.cfg
	}) });
	const isPureTransientSummary = isFallbackSummary ? isPureTransientRateLimitSummary(params.err) : false;
	const isRateLimit = isFallbackSummary ? isPureTransientSummary : isRateLimitErrorMessage(message);
	const rateLimitOrOverloadedCopy = !isFallbackSummary || isPureTransientSummary ? formatRateLimitOrOverloadedErrorCopy(message) : void 0;
	if (isRateLimit && !isOverloadedErrorMessage(message)) return markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
		text: buildRateLimitCooldownMessage(params.err),
		sessionCtx: params.sessionCtx,
		isGenericRunnerFailure: false,
		cfg: params.cfg
	}) });
	if (rateLimitOrOverloadedCopy) return markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
		text: rateLimitOrOverloadedCopy,
		sessionCtx: params.sessionCtx,
		isGenericRunnerFailure: false,
		cfg: params.cfg
	}) });
	const externalRunFailureReply = buildExternalRunFailureReply(message, { includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel) });
	if (externalRunFailureReply.isGenericRunnerFailure) return;
	return markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
		text: externalRunFailureReply.text,
		sessionCtx: params.sessionCtx,
		isGenericRunnerFailure: false,
		cfg: params.cfg
	}) });
}
const CONTEXT_OVERFLOW_RESET_HINT = "\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.";
function resolveAgentHeartbeatModelRaw(params) {
	const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
	const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
	return (agentId ? normalizeOptionalString(params.cfg.agents?.list?.find((entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId)?.heartbeat?.model) : void 0) ?? defaultModel;
}
function normalizeModelRefForCompare(ref) {
	if (!ref) return;
	const provider = normalizeLowercaseStringOrEmpty(ref.provider);
	const model = normalizeLowercaseStringOrEmpty(ref.model);
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function modelRefsEqual(left, right) {
	const normalizedLeft = normalizeModelRefForCompare(left);
	const normalizedRight = normalizeModelRefForCompare(right);
	if (!normalizedLeft || !normalizedRight) return false;
	return normalizedLeft.provider === normalizedRight.provider && normalizedLeft.model === normalizedRight.model;
}
function formatContextWindowLabel(tokens) {
	if (tokens >= 1e6) return `${Math.round(tokens / 1e6 * 10) / 10}M`;
	return `${Math.round(tokens / 1024)}k`;
}
function resolveContextWindowForHint(params) {
	return (typeof params.activeSessionEntry?.contextTokens === "number" && Number.isFinite(params.activeSessionEntry.contextTokens) && params.activeSessionEntry.contextTokens > 0 ? Math.floor(params.activeSessionEntry.contextTokens) : void 0) ?? resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.ref.provider,
		model: params.ref.model,
		allowAsyncLoad: false
	});
}
function resolveHeartbeatBleedHint(params) {
	const primaryProvider = normalizeOptionalString(params.primaryProvider);
	const primaryModel = normalizeOptionalString(params.primaryModel);
	if (!primaryProvider || !primaryModel) return;
	const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
	const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
	if (!runtimeProvider || !runtimeModel) return;
	const primaryRef = {
		provider: primaryProvider,
		model: primaryModel
	};
	const runtimeRef = {
		provider: runtimeProvider,
		model: runtimeModel
	};
	if (modelRefsEqual(primaryRef, runtimeRef)) return;
	const heartbeatModelRaw = resolveAgentHeartbeatModelRaw({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (!modelRefsEqual(runtimeRef, heartbeatModelRaw ? resolveModelRefFromString({
		cfg: params.cfg,
		raw: heartbeatModelRaw,
		defaultProvider: primaryProvider
	})?.ref : void 0)) return;
	const runtimeWindow = resolveContextWindowForHint({
		cfg: params.cfg,
		ref: runtimeRef,
		activeSessionEntry: params.activeSessionEntry
	});
	const primaryWindow = resolveContextTokensForModel({
		cfg: params.cfg,
		provider: primaryRef.provider,
		model: primaryRef.model,
		allowAsyncLoad: false
	});
	if (typeof runtimeWindow === "number" && typeof primaryWindow === "number" && runtimeWindow >= primaryWindow) return;
	return `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}${typeof runtimeWindow === "number" && runtimeWindow > 0 ? ` (${formatContextWindowLabel(runtimeWindow)} context)` : ""} instead of ${primaryProvider}/${primaryModel}. This matches the configured \`heartbeat.model\`, so the overflow is likely heartbeat model bleed rather than a compaction-buffer problem. Set \`heartbeat.isolatedSession: true\`, enable \`heartbeat.lightContext: true\`, or use a heartbeat model with a larger context window.`;
}
function buildContextOverflowRecoveryText(params) {
	return (params.duringCompaction ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again." : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.") + (resolveHeartbeatBleedHint({
		cfg: params.cfg,
		agentId: params.agentId,
		primaryProvider: params.primaryProvider,
		primaryModel: params.primaryModel,
		activeSessionEntry: params.activeSessionEntry
	}) ?? CONTEXT_OVERFLOW_RESET_HINT);
}
function shouldApplyOpenAIGptChatGuard(params) {
	if (params.provider !== "openai" && params.provider !== "openai-codex") return false;
	return /^gpt-5(?:[.-]|$)/i.test(params.model ?? "");
}
function countChatReplySentences(text) {
	return text.trim().split(/(?<=[.!?])\s+/u).map((part) => part.trim()).filter(Boolean).length;
}
function scoreChattyFinalReplyText(text) {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	let score = 0;
	const sentenceCount = countChatReplySentences(trimmed);
	if (trimmed.length > 900) score += 1;
	if (trimmed.length > 1500) score += 1;
	if (sentenceCount > 6) score += 1;
	if (sentenceCount > 10) score += 1;
	if (trimmed.split(/\n{2,}/u).filter(Boolean).length >= 3) score += 1;
	if (/\b(?:in summary|to summarize|here(?:'s| is) what|what changed|what I verified)\b/i.test(trimmed)) score += 1;
	return score;
}
function shortenChattyFinalReplyText(text, params) {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	let shortened = trimmed.split(/(?<=[.!?])\s+/u).map((part) => part.trim()).filter(Boolean).slice(0, params.maxSentences).join(" ");
	if (!shortened) shortened = trimmed.slice(0, params.maxChars).trimEnd();
	if (shortened.length > params.maxChars) shortened = shortened.slice(0, params.maxChars).trimEnd();
	if (shortened.length >= trimmed.length) return trimmed;
	return shortened.replace(/[.,;:!?-]*$/u, "").trimEnd() + "...";
}
function applyOpenAIGptChatReplyGuard(params) {
	if (params.isHeartbeat || !shouldApplyOpenAIGptChatGuard({
		provider: params.provider,
		model: params.model
	}) || !params.payloads?.length) return;
	const trimmedCommand = params.commandBody.trim();
	const isAckTurn = isLikelyExecutionAckPrompt(trimmedCommand);
	const allowSoftCap = !isAckTurn && trimmedCommand.length > 0 && trimmedCommand.length <= 120 && !/\b(?:detail|detailed|depth|deep dive|explain|compare|walk me through|why|how)\b/i.test(trimmedCommand);
	for (const payload of params.payloads) {
		const text = normalizeOptionalString(payload.text);
		if (!text || payload.isError || payload.isReasoning || payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0 || payload.interactive || text.includes("```")) continue;
		if (isAckTurn) {
			payload.text = shortenChattyFinalReplyText(text, {
				maxChars: GPT_CHAT_BREVITY_ACK_MAX_CHARS,
				maxSentences: GPT_CHAT_BREVITY_ACK_MAX_SENTENCES
			});
			continue;
		}
		if (allowSoftCap && scoreChattyFinalReplyText(text) >= 4) payload.text = shortenChattyFinalReplyText(text, {
			maxChars: GPT_CHAT_BREVITY_SOFT_MAX_CHARS,
			maxSentences: GPT_CHAT_BREVITY_SOFT_MAX_SENTENCES
		});
	}
}
function buildRestartLifecycleReplyText() {
	return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}
function resolveRestartLifecycleError(err) {
	const pending = [err];
	const seen = /* @__PURE__ */ new Set();
	let pendingIndex = 0;
	while (pendingIndex < pending.length) {
		const candidate = pending[pendingIndex++];
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (candidate instanceof GatewayDrainingError || candidate instanceof CommandLaneClearedError) return candidate;
		if (isFallbackSummaryError(candidate)) for (const attempt of candidate.attempts) pending.push(attempt.error);
		if (candidate instanceof Error && "cause" in candidate) pending.push(candidate.cause);
	}
}
function isReplyOperationUserAbort(replyOperation) {
	return replyOperation?.result?.kind === "aborted" && replyOperation.result.code === "aborted_by_user";
}
function isReplyOperationRestartAbort(replyOperation) {
	return replyOperation?.result?.kind === "aborted" && replyOperation.result.code === "aborted_for_restart";
}
function createEmbeddedLifecycleTerminalBackstop(params) {
	let terminalEmitted = false;
	let startedAt;
	const note = (evt) => {
		if (evt.stream !== "lifecycle") return;
		const phase = readStringValue(evt.data.phase);
		if (phase === "start" && typeof evt.data.startedAt === "number") startedAt = evt.data.startedAt;
		if (phase === "end" || phase === "error") terminalEmitted = true;
	};
	const emit = (phase, resultOrError) => {
		if (terminalEmitted) return;
		terminalEmitted = true;
		const data = {
			phase,
			endedAt: Date.now(),
			...startedAt !== void 0 ? { startedAt } : {}
		};
		if (phase === "error") data.error = formatErrorMessage(resultOrError);
		else {
			const meta = resultOrError && typeof resultOrError === "object" && "meta" in resultOrError ? resultOrError.meta : void 0;
			if (meta?.aborted === true) data.aborted = true;
			const stopReason = readStringValue(meta?.stopReason);
			if (stopReason) data.stopReason = stopReason;
			const livenessState = readStringValue(meta?.livenessState);
			if (livenessState) data.livenessState = livenessState;
			if (meta?.replayInvalid === true) data.replayInvalid = true;
		}
		emitAgentEvent({
			runId: params.runId,
			...params.sessionKey ? { sessionKey: params.sessionKey } : {},
			stream: "lifecycle",
			data
		});
	};
	return {
		emit,
		note
	};
}
function emitModelFallbackStepLifecycle(params) {
	emitAgentEvent({
		runId: params.runId,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		stream: "lifecycle",
		data: {
			phase: "fallback_step",
			...params.step
		}
	});
}
function resolveSessionRuntimeOverrideForProvider(params) {
	const provider = normalizeLowercaseStringOrEmpty(params.provider);
	const runtime = normalizeLowercaseStringOrEmpty(params.entry?.agentRuntimeOverride);
	if (!runtime || runtime === "auto" || runtime === "default") return;
	if (runtime === "pi") return "pi";
	if (provider === "openai" && runtime === "codex") return "codex";
	return listLegacyRuntimeModelProviderAliases().find((alias) => normalizeLowercaseStringOrEmpty(alias.provider) === provider && normalizeLowercaseStringOrEmpty(alias.runtime) === runtime)?.runtime;
}
function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params) {
	const probe = params.run.autoFallbackPrimaryProbe;
	if (!probe || !params.sessionKey) return params.run;
	if (!params.entry) return params.run;
	const resolveEntrySelectionRun = () => {
		const entryRef = resolvePersistedOverrideModelRef({
			defaultProvider: params.run.provider,
			overrideProvider: params.entry?.providerOverride,
			overrideModel: params.entry?.modelOverride
		});
		const hasEntryModelOverride = Boolean(entryRef);
		const authProfileId = normalizeOptionalString(params.entry?.authProfileOverride);
		const fallbackRun = {
			...params.run,
			provider: entryRef?.provider ?? params.run.provider,
			model: entryRef?.model ?? params.run.model,
			autoFallbackPrimaryProbe: void 0
		};
		if (hasEntryModelOverride) {
			fallbackRun.hasSessionModelOverride = true;
			fallbackRun.hasAutoFallbackProvenance = hasSessionAutoModelFallbackProvenance(params.entry) || void 0;
		} else {
			delete fallbackRun.hasSessionModelOverride;
			delete fallbackRun.hasAutoFallbackProvenance;
		}
		if (hasEntryModelOverride && params.entry?.modelOverrideSource) fallbackRun.modelOverrideSource = params.entry.modelOverrideSource;
		else delete fallbackRun.modelOverrideSource;
		if (hasEntryModelOverride && authProfileId) {
			fallbackRun.authProfileId = authProfileId;
			if (params.entry?.authProfileOverrideSource) fallbackRun.authProfileIdSource = params.entry.authProfileOverrideSource;
			else delete fallbackRun.authProfileIdSource;
		} else if (hasEntryModelOverride) {
			delete fallbackRun.authProfileId;
			delete fallbackRun.authProfileIdSource;
		}
		return fallbackRun;
	};
	const refreshedProbe = resolveAutoFallbackPrimaryProbe({
		entry: params.entry,
		sessionKey: params.sessionKey,
		primaryProvider: probe.provider,
		primaryModel: probe.model
	});
	if (!refreshedProbe) return resolveEntrySelectionRun();
	return {
		...params.run,
		provider: refreshedProbe.provider,
		model: refreshedProbe.model,
		autoFallbackPrimaryProbe: refreshedProbe
	};
}
async function runAgentTurnWithFallback(params) {
	const TRANSIENT_HTTP_RETRY_DELAY_MS = 2500;
	let didLogHeartbeatStrip = false;
	let autoCompactionCount = 0;
	const directlySentBlockKeys = /* @__PURE__ */ new Set();
	let runnableRun = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
		run: params.followupRun.run,
		entry: params.activeSessionStore?.[params.sessionKey ?? ""] ?? params.getActiveSessionEntry(),
		sessionKey: params.sessionKey
	});
	if (runnableRun !== params.followupRun.run) params.followupRun.run = runnableRun;
	const runtimeConfig = resolveQueuedReplyRuntimeConfig(runnableRun.config);
	let effectiveRun = runtimeConfig === runnableRun.config ? runnableRun : {
		...runnableRun,
		config: runtimeConfig
	};
	const resolveRunForFallbackCandidate = (provider, model) => {
		const probe = effectiveRun.autoFallbackPrimaryProbe;
		const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
		if (probe && provider === probe.fallbackProvider && !isPrimaryProbeCandidate && probe.fallbackAuthProfileId) {
			const candidateRun = {
				...effectiveRun,
				provider,
				model,
				authProfileId: probe.fallbackAuthProfileId
			};
			if (probe.fallbackAuthProfileIdSource) candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
			else delete candidateRun.authProfileIdSource;
			return candidateRun;
		}
		return effectiveRun;
	};
	const applyLiveModelSwitchToRun = (run, err) => {
		run.provider = err.provider;
		run.model = err.model;
		run.authProfileId = err.authProfileId;
		run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : void 0;
		run.autoFallbackPrimaryProbe = void 0;
	};
	const runId = params.opts?.runId ?? crypto.randomUUID();
	const replyMediaContext = params.replyMediaContext ?? createReplyMediaContext({
		cfg: runtimeConfig,
		sessionKey: params.sessionKey,
		workspaceDir: params.followupRun.run.workspaceDir,
		messageProvider: params.followupRun.run.messageProvider,
		accountId: params.followupRun.originatingAccountId ?? params.followupRun.run.agentAccountId,
		groupId: params.followupRun.run.groupId,
		groupChannel: params.followupRun.run.groupChannel,
		groupSpace: params.followupRun.run.groupSpace,
		requesterSenderId: params.followupRun.run.senderId,
		requesterSenderName: params.followupRun.run.senderName,
		requesterSenderUsername: params.followupRun.run.senderUsername,
		requesterSenderE164: params.followupRun.run.senderE164
	});
	let didNotifyAgentRunStart = false;
	const notifyAgentRunStart = () => {
		if (didNotifyAgentRunStart) return;
		didNotifyAgentRunStart = true;
		params.opts?.onAgentRunStart?.(runId);
	};
	const currentMessageId = params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
	const shouldNotifyUserAboutCompaction = runtimeConfig?.agents?.defaults?.compaction?.notifyUser === true;
	let didSurfaceBlockedLivenessState = false;
	const surfaceBlockedLivenessState = async () => {
		if (didSurfaceBlockedLivenessState || !params.opts?.onBlockReply) return;
		const noticePayload = params.applyReplyToMode({
			text: BLOCKED_LIVENESS_NOTICE_TEXT,
			replyToId: currentMessageId,
			replyToCurrent: true,
			isError: true
		});
		try {
			await params.opts.onBlockReply(noticePayload);
			didSurfaceBlockedLivenessState = true;
		} catch (err) {
			logVerbose(`blocked liveness notice delivery failed (non-fatal): ${String(err)}`);
		}
	};
	const sendCompactionNotice = async (phase) => {
		if (!params.opts?.onBlockReply) return;
		const text = phase === "start" ? "🧹 Compacting context..." : phase === "end" ? "🧹 Compaction complete" : "🧹 Compaction incomplete";
		const noticePayload = params.applyReplyToMode({
			text,
			replyToId: currentMessageId,
			replyToCurrent: true,
			isCompactionNotice: true
		});
		try {
			await params.opts.onBlockReply(noticePayload);
		} catch (err) {
			logVerbose(`compaction ${phase} notice delivery failed (non-fatal): ${String(err)}`);
		}
	};
	const readCompactionHookMessages = (value) => {
		if (!Array.isArray(value)) return [];
		return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	};
	const sendCompactionHookMessages = async (messages) => {
		if (!params.opts?.onBlockReply || messages.length === 0) return;
		const noticePayload = params.applyReplyToMode({
			text: messages.join("\n\n"),
			replyToId: currentMessageId,
			replyToCurrent: true,
			isCompactionNotice: true
		});
		try {
			await params.opts.onBlockReply(noticePayload);
		} catch (err) {
			logVerbose(`compaction hook notice delivery failed (non-fatal): ${String(err)}`);
		}
	};
	const shouldSurfaceToControlUi = isInternalMessageChannel(params.followupRun.run.messageProvider ?? params.sessionCtx.Surface ?? params.sessionCtx.Provider);
	if (params.sessionKey) registerAgentRunContext(runId, {
		sessionKey: params.sessionKey,
		verboseLevel: params.resolvedVerboseLevel,
		isHeartbeat: params.isHeartbeat,
		isControlUiVisible: shouldSurfaceToControlUi
	});
	let runResult;
	let fallbackProvider = params.followupRun.run.provider;
	let fallbackModel = params.followupRun.run.model;
	let fallbackAttempts = [];
	let continueWorkRequest;
	let compactionTraceparent;
	let didResetAfterCompactionFailure = false;
	let didRetryTransientHttpError = false;
	let liveModelSwitchRetries = 0;
	let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(params.getActiveSessionEntry()?.systemPromptReport);
	let pendingFallbackCandidateRollback;
	const clearPendingFallbackRollback = (rollback) => {
		if (!rollback || pendingFallbackCandidateRollback?.rollback === rollback) pendingFallbackCandidateRollback = void 0;
	};
	const rollbackClassifiedFallbackCandidateSelection = async (provider, model) => {
		const pending = pendingFallbackCandidateRollback;
		if (!pending || pending.provider !== provider || pending.model !== model) return;
		pendingFallbackCandidateRollback = void 0;
		try {
			await pending.rollback();
		} catch (rollbackError) {
			logVerbose(`failed to roll back classified fallback candidate selection (non-fatal): ${String(rollbackError)}`);
		}
	};
	const persistFallbackCandidateSelection = async (provider, model, candidateRun) => {
		if (effectiveRun.hasOneTurnModelOverride === true) return;
		if (!params.sessionKey || !params.activeSessionStore || provider === effectiveRun.provider && model === effectiveRun.model) return;
		const activeSessionEntry = params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
		if (!activeSessionEntry) return;
		if (activeSessionEntry.modelOverrideSource === "user" || activeSessionEntry.modelOverrideSource === void 0 && Boolean(normalizeOptionalString(activeSessionEntry.modelOverride)) && !hasSessionAutoModelFallbackProvenance(activeSessionEntry)) return;
		const previousState = snapshotFallbackSelectionState(activeSessionEntry);
		const applied = applyFallbackCandidateSelectionToEntry({
			entry: activeSessionEntry,
			run: candidateRun !== effectiveRun && effectiveRun.autoFallbackPrimaryProbe ? {
				...candidateRun,
				provider: candidateRun.provider,
				model: effectiveRun.model
			} : candidateRun,
			provider,
			model,
			force: candidateRun !== effectiveRun && Boolean(effectiveRun.autoFallbackPrimaryProbe),
			...effectiveRun.autoFallbackPrimaryProbe ? { origin: {
				provider: effectiveRun.autoFallbackPrimaryProbe.provider,
				model: effectiveRun.autoFallbackPrimaryProbe.model
			} } : {}
		});
		const nextState = applied.nextState;
		if (!applied.updated || !nextState) return;
		params.activeSessionStore[params.sessionKey] = activeSessionEntry;
		try {
			if (params.storePath) await updateSessionStore(params.storePath, (store) => {
				const persistedEntry = store[params.sessionKey];
				if (!persistedEntry) return;
				applyFallbackSelectionState(persistedEntry, nextState);
				store[params.sessionKey] = persistedEntry;
			});
		} catch (error) {
			rollbackFallbackSelectionStateIfUnchanged(activeSessionEntry, nextState, previousState);
			params.activeSessionStore[params.sessionKey] = activeSessionEntry;
			throw error;
		}
		return async () => {
			if (rollbackFallbackSelectionStateIfUnchanged(activeSessionEntry, nextState, previousState)) params.activeSessionStore[params.sessionKey] = activeSessionEntry;
			if (!params.storePath) return;
			await updateSessionStore(params.storePath, (store) => {
				const persistedEntry = store[params.sessionKey];
				if (!persistedEntry) return;
				if (rollbackFallbackSelectionStateIfUnchanged(persistedEntry, nextState, previousState)) store[params.sessionKey] = persistedEntry;
			});
		};
	};
	const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear) => {
		const probe = effectiveRun.autoFallbackPrimaryProbe;
		if (!probe) return;
		if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) return;
		if (!params.sessionKey || !params.activeSessionStore) return;
		const activeSessionEntry = params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
		if (!activeSessionEntry) return;
		if (!entryMatchesAutoFallbackPrimaryProbe(activeSessionEntry, probe)) return;
		clearAutoFallbackPrimaryProbeSelection(activeSessionEntry);
		params.activeSessionStore[params.sessionKey] = activeSessionEntry;
		if (!params.storePath) return;
		await updateSessionStore(params.storePath, (store) => {
			const persistedEntry = store[params.sessionKey];
			if (!persistedEntry) return;
			if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) return;
			clearAutoFallbackPrimaryProbeSelection(persistedEntry);
			store[params.sessionKey] = persistedEntry;
		});
	};
	while (true) try {
		const normalizeStreamingText = (payload) => {
			let text = payload.text;
			const reply = resolveSendableOutboundReplyParts(payload);
			if (params.followupRun.run.silentExpected) return { skip: true };
			if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
				const stripped = stripHeartbeatToken(text, { mode: "message" });
				if (stripped.didStrip && !didLogHeartbeatStrip) {
					didLogHeartbeatStrip = true;
					logVerbose("Stripped stray HEARTBEAT_OK token from reply");
				}
				if (stripped.shouldSkip && !reply.hasMedia) return { skip: true };
				text = stripped.text;
			}
			if (isSilentReplyText(text, "NO_REPLY")) return { skip: true };
			if (isSilentReplyPrefixText(text, "NO_REPLY") || isSilentReplyPrefixText(text, "HEARTBEAT_OK")) return { skip: true };
			if (text && startsWithSilentToken(text, "NO_REPLY")) text = stripLeadingSilentToken(text, SILENT_REPLY_TOKEN);
			if (text && params.followupRun.run.config?.agents?.defaults?.continuation?.enabled === true) {
				const cont = stripContinuationSignal(text);
				if (cont.signal) text = cont.text;
			}
			if (!text) {
				if (reply.hasMedia) return {
					text: void 0,
					skip: false
				};
				return { skip: true };
			}
			const sanitized = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
			if (!sanitized.trim()) return { skip: true };
			return {
				text: sanitized,
				skip: false
			};
		};
		const handlePartialForTyping = async (payload) => {
			if (isSilentReplyPrefixText(payload.text, "NO_REPLY")) return;
			const { text, skip } = normalizeStreamingText(payload);
			if (skip || !text) return;
			await params.typingSignals.signalTextDelta(text);
			return text;
		};
		const blockReplyPipeline = params.blockReplyPipeline;
		const blockReplyHandler = params.opts?.onBlockReply ? createBlockReplyDeliveryHandler({
			onBlockReply: params.opts.onBlockReply,
			currentMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
			replyThreading: params.replyThreading,
			normalizeStreamingText,
			applyReplyToMode: params.applyReplyToMode,
			normalizeMediaPaths: replyMediaContext.normalizePayload,
			typingSignals: params.typingSignals,
			blockStreamingEnabled: params.blockStreamingEnabled,
			blockReplyPipeline,
			directlySentBlockKeys
		}) : void 0;
		const onToolResult = params.opts?.onToolResult;
		const outcomePlan = buildAgentRuntimeOutcomePlan();
		const runLane = "main";
		const fallbackResult = await runWithModelFallback({
			...resolveModelFallbackOptions(effectiveRun, runtimeConfig),
			runId,
			sessionId: params.followupRun.run.sessionId,
			lane: runLane,
			onFallbackStep: (step) => {
				emitModelFallbackStepLifecycle({
					runId,
					sessionKey: params.sessionKey,
					step
				});
			},
			classifyResult: async ({ result, provider, model }) => {
				const effectiveResult = isContinuationWrappedRunResult(result) ? result.result : result;
				const classification = outcomePlan.classifyRunResult({
					result: effectiveResult,
					provider,
					model,
					hasDirectlySentBlockReply: directlySentBlockKeys.size > 0,
					hasBlockReplyPipelineOutput: Boolean(blockReplyPipeline?.hasBuffered() || blockReplyPipeline?.didStream())
				});
				if (classification) await rollbackClassifiedFallbackCandidateSelection(provider, model);
				return classification;
			},
			run: async (provider, model, runOptions) => {
				const candidateRun = resolveRunForFallbackCandidate(provider, model);
				const activeProbe = effectiveRun.autoFallbackPrimaryProbe;
				if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) markAutoFallbackPrimaryProbe({
					probe: activeProbe,
					sessionKey: params.sessionKey
				});
				params.opts?.onModelSelected?.({
					provider,
					model,
					thinkLevel: params.followupRun.run.thinkLevel
				});
				let rollbackFallbackCandidateSelection;
				try {
					rollbackFallbackCandidateSelection = await persistFallbackCandidateSelection(provider, model, candidateRun);
					if (rollbackFallbackCandidateSelection) pendingFallbackCandidateRollback = {
						provider,
						model,
						rollback: rollbackFallbackCandidateSelection
					};
				} catch (error) {
					logVerbose(`failed to persist fallback candidate selection (non-fatal): ${String(error)}`);
				}
				const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
					provider,
					entry: params.getActiveSessionEntry()
				});
				const cliExecutionProvider = sessionRuntimeOverride === "pi" ? provider : (sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig) ? sessionRuntimeOverride : void 0) ?? resolveCliRuntimeExecutionProvider({
					provider,
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					modelId: model
				}) ?? provider;
				if (isCliProvider(cliExecutionProvider, runtimeConfig)) {
					const isRoomEventCliRun = params.followupRun.currentInboundEventKind === "room_event";
					const cliSessionBinding = isRoomEventCliRun ? void 0 : getCliSessionBinding(params.getActiveSessionEntry(), cliExecutionProvider);
					const authProfile = resolveRunAuthProfile(candidateRun, cliExecutionProvider, { config: runtimeConfig });
					const hookMessageProvider = resolveOriginMessageProvider({
						originatingChannel: params.followupRun.originatingChannel,
						provider: params.sessionCtx.Provider
					});
					const result = await runCliAgentWithLifecycle({
						runId,
						provider: cliExecutionProvider,
						onAgentRunStart: notifyAgentRunStart,
						suppressAssistantBridge: params.followupRun.run.silentExpected,
						onAssistantText: async (text) => {
							const textForTyping = await handlePartialForTyping({ text });
							if (textForTyping === void 0 || !params.opts?.onPartialReply) return;
							await params.opts.onPartialReply({ text: textForTyping });
						},
						onReasoningText: async (text) => {
							await params.opts?.onReasoningStream?.({ text });
						},
						onErrorBeforeLifecycle: async () => {
							if (!rollbackFallbackCandidateSelection) return;
							try {
								await rollbackFallbackCandidateSelection();
								clearPendingFallbackRollback(rollbackFallbackCandidateSelection);
							} catch (rollbackError) {
								logVerbose(`failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`);
							}
						},
						runParams: {
							sessionId: params.followupRun.run.sessionId,
							sessionKey: params.sessionKey,
							agentId: params.followupRun.run.agentId,
							trigger: params.isHeartbeat ? "heartbeat" : "user",
							sessionFile: params.followupRun.run.sessionFile,
							workspaceDir: params.followupRun.run.workspaceDir,
							config: runtimeConfig,
							prompt: params.commandBody,
							transcriptPrompt: params.transcriptCommandBody,
							currentInboundEventKind: params.followupRun.currentInboundEventKind,
							currentInboundContext: params.followupRun.currentInboundContext,
							inputProvenance: params.followupRun.run.inputProvenance,
							provider: cliExecutionProvider,
							model,
							thinkLevel: params.followupRun.run.thinkLevel,
							timeoutMs: params.followupRun.run.timeoutMs,
							runId,
							lane: runLane,
							extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
							sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
							silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
							extraSystemPromptStatic: params.followupRun.run.extraSystemPromptStatic,
							ownerNumbers: params.followupRun.run.ownerNumbers,
							cliSessionId: cliSessionBinding?.sessionId,
							cliSessionBinding,
							authProfileId: authProfile.authProfileId,
							bootstrapPromptWarningSignaturesSeen,
							bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
							images: params.opts?.images,
							imageOrder: params.opts?.imageOrder,
							skillsSnapshot: params.followupRun.run.skillsSnapshot,
							messageChannel: params.followupRun.originatingChannel ?? void 0,
							messageProvider: hookMessageProvider,
							agentAccountId: params.followupRun.run.agentAccountId,
							senderIsOwner: params.followupRun.run.senderIsOwner,
							disableTools: params.opts?.disableTools,
							abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
							replyOperation: params.replyOperation
						},
						transformResult: (rawResult) => isRoomEventCliRun && rawResult.meta.agentMeta ? (() => {
							const { cliSessionBinding: _cliSessionBinding, ...agentMeta } = rawResult.meta.agentMeta;
							return {
								...rawResult,
								meta: {
									...rawResult.meta,
									agentMeta: {
										...agentMeta,
										sessionId: ""
									}
								}
							};
						})() : rawResult
					});
					bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
					return result;
				}
				const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
					run: candidateRun,
					sessionCtx: params.sessionCtx,
					hasRepliedRef: params.opts?.hasRepliedRef,
					provider,
					runId,
					allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
					model
				});
				const agentHarnessPolicy = sessionRuntimeOverride ? {
					runtime: sessionRuntimeOverride,
					runtimeSource: "model"
				} : resolveAgentHarnessPolicy({
					provider,
					modelId: model,
					config: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey
				});
				const embeddedRunProvider = resolveOpenAIRuntimeProviderForPi({
					provider,
					harnessRuntime: agentHarnessPolicy.runtime,
					authProfileProvider: runBaseParams.authProfileId?.split(":", 1)[0],
					authProfileId: runBaseParams.authProfileId,
					config: runtimeConfig,
					workspaceDir: params.followupRun.run.workspaceDir
				});
				const embeddedRunHarnessOverride = sessionRuntimeOverride ?? (agentHarnessPolicy.runtime === "pi" && embeddedRunProvider !== provider ? "pi" : void 0);
				return (async () => {
					let attemptCompactionCount = 0;
					let attemptCompactionTraceparent;
					const lifecycleBackstop = createEmbeddedLifecycleTerminalBackstop({
						runId,
						sessionKey: params.sessionKey
					});
					let attemptContinueWorkRequest;
					try {
						const result = await runEmbeddedPiAgentDefault$1({
							...embeddedContext,
							allowGatewaySubagentBinding: true,
							trigger: params.isHeartbeat ? "heartbeat" : "user",
							fireReason: resolveReplyRunFireReason({
								opts: params.opts,
								drainsContinuationDelegateQueue: effectiveRun.drainsContinuationDelegateQueue === true
							}),
							parentRunId: params.opts?.parentRunId,
							groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
							groupChannel: normalizeOptionalString(params.sessionCtx.GroupChannel) ?? normalizeOptionalString(params.sessionCtx.GroupSubject),
							groupSpace: normalizeOptionalString(params.sessionCtx.GroupSpace),
							...senderContext,
							...runBaseParams,
							provider: embeddedRunProvider,
							agentHarnessId: embeddedRunHarnessOverride,
							agentHarnessRuntimeOverride: embeddedRunHarnessOverride,
							sandboxSessionKey: params.runtimePolicySessionKey,
							prompt: params.commandBody,
							transcriptPrompt: params.transcriptCommandBody,
							currentInboundEventKind: params.followupRun.currentInboundEventKind,
							currentInboundContext: params.followupRun.currentInboundContext,
							extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
							sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode,
							forceMessageTool: params.followupRun.run.sourceReplyDeliveryMode === "message_tool_only",
							silentReplyPromptMode: params.followupRun.run.silentReplyPromptMode,
							suppressNextUserMessagePersistence: params.followupRun.run.suppressNextUserMessagePersistence,
							suppressTranscriptOnlyAssistantPersistence: params.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
							drainsContinuationDelegateQueue: params.followupRun.run.drainsContinuationDelegateQueue,
							continueWorkOpts: params.followupRun.run.config?.agents?.defaults?.continuation?.enabled === true ? { requestContinuation: (request) => {
								attemptContinueWorkRequest = request;
							} } : void 0,
							toolResultFormat: (() => {
								const channel = resolveMessageChannel(params.sessionCtx.Surface, params.sessionCtx.Provider);
								if (!channel) return "markdown";
								return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
							})(),
							toolProgressDetail: params.toolProgressDetail,
							suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
							disableTools: params.opts?.disableTools,
							enableHeartbeatTool: params.opts?.enableHeartbeatTool,
							forceHeartbeatTool: params.opts?.forceHeartbeatTool,
							bootstrapContextMode: params.opts?.bootstrapContextMode,
							bootstrapContextRunKind: params.opts?.isHeartbeat ? "heartbeat" : "default",
							images: params.opts?.images,
							imageOrder: params.opts?.imageOrder,
							abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
							replyOperation: params.replyOperation,
							requestCompactionOpts: runtimeConfig?.agents?.defaults?.continuation?.enabled === true ? {
								sessionId: params.followupRun.run.sessionId,
								getContextUsage: () => {
									const entry = params.getActiveSessionEntry();
									const totalTokens = entry?.totalTokens ?? 0;
									const contextWindow = entry?.contextTokens ?? 2e5;
									return contextWindow > 0 ? totalTokens / contextWindow : 0;
								},
								triggerCompaction: async (request) => {
									attemptCompactionTraceparent = request.traceparent;
									try {
										const { compactEmbeddedPiSession } = await import("./compact.queued-DUHZjYWw.js");
										const compactionAuthProfileId = provider === params.followupRun.run.provider ? params.followupRun.run.authProfileId : void 0;
										const result = await compactEmbeddedPiSession({
											sessionId: params.followupRun.run.sessionId ?? "",
											runId: request.runId ?? runId,
											sessionKey: params.sessionKey,
											sessionFile: params.followupRun.run.sessionFile ?? "",
											workspaceDir: params.followupRun.run.workspaceDir ?? process.cwd(),
											messageProvider: params.followupRun.run.messageProvider,
											provider,
											model,
											authProfileId: compactionAuthProfileId,
											trigger: request.trigger,
											diagId: request.diagId,
											traceparent: request.traceparent
										});
										if (result.ok && result.compacted) await releaseQueuedCompactionCompletion({
											activeSessionStore: params.activeSessionStore,
											compactionResult: result,
											followupRun: params.followupRun,
											getActiveSessionEntry: params.getActiveSessionEntry,
											sessionKey: params.sessionKey,
											storePath: params.storePath,
											traceparent: request.traceparent
										});
										return {
											ok: result.ok,
											compacted: result.compacted,
											reason: result.reason
										};
									} catch (err) {
										return {
											ok: false,
											compacted: false,
											reason: err instanceof Error ? err.message : String(err)
										};
									}
								}
							} : void 0,
							blockReplyBreak: params.resolvedBlockStreamingBreak,
							blockReplyChunking: params.blockReplyChunking,
							onPartialReply: async (payload) => {
								const textForTyping = await handlePartialForTyping(payload);
								if (!params.opts?.onPartialReply || textForTyping === void 0) return;
								await params.opts.onPartialReply({
									text: textForTyping,
									mediaUrls: payload.mediaUrls
								});
							},
							onAssistantMessageStart: async () => {
								await params.typingSignals.signalMessageStart();
								await params.opts?.onAssistantMessageStart?.();
							},
							onReasoningStream: params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream ? async (payload) => {
								if (params.followupRun.run.silentExpected) return;
								await params.typingSignals.signalReasoningDelta();
								await params.opts?.onReasoningStream?.({
									text: payload.text,
									mediaUrls: payload.mediaUrls
								});
							} : void 0,
							onReasoningEnd: params.opts?.onReasoningEnd,
							onAgentEvent: async (evt) => {
								lifecycleBackstop.note(evt);
								const hasLifecyclePhase = evt.stream === "lifecycle" && typeof evt.data.phase === "string";
								if (evt.stream !== "lifecycle" || hasLifecyclePhase) notifyAgentRunStart();
								if (evt.stream === "lifecycle" && readStringValue(evt.data.livenessState) === "blocked") await surfaceBlockedLivenessState();
								if (evt.stream === "tool") {
									const phase = readStringValue(evt.data.phase) ?? "";
									const name = readStringValue(evt.data.name);
									if (phase === "start" || phase === "update") {
										const toolStartProgressPromise = params.opts?.onToolStart?.({
											name,
											phase,
											args: evt.data.args && typeof evt.data.args === "object" ? evt.data.args : void 0,
											detailMode: params.toolProgressDetail
										});
										await Promise.all([params.typingSignals.signalToolStart(), toolStartProgressPromise]);
									}
								}
								const suppressItemChannelProgress = evt.stream === "item" && evt.data.suppressChannelProgress === true && Boolean(params.opts?.onToolStart);
								if (evt.stream === "item" && !suppressItemChannelProgress) await params.opts?.onItemEvent?.({
									itemId: readStringValue(evt.data.itemId),
									kind: readStringValue(evt.data.kind),
									title: readStringValue(evt.data.title),
									name: readStringValue(evt.data.name),
									phase: readStringValue(evt.data.phase),
									status: readStringValue(evt.data.status),
									summary: readStringValue(evt.data.summary),
									progressText: readStringValue(evt.data.progressText),
									meta: readStringValue(evt.data.meta),
									approvalId: readStringValue(evt.data.approvalId),
									approvalSlug: readStringValue(evt.data.approvalSlug)
								});
								if (evt.stream === "plan") await params.opts?.onPlanUpdate?.({
									phase: readStringValue(evt.data.phase),
									title: readStringValue(evt.data.title),
									explanation: readStringValue(evt.data.explanation),
									steps: Array.isArray(evt.data.steps) ? evt.data.steps.filter((step) => typeof step === "string") : void 0,
									source: readStringValue(evt.data.source)
								});
								if (evt.stream === "approval") await params.opts?.onApprovalEvent?.({
									phase: readStringValue(evt.data.phase),
									kind: readStringValue(evt.data.kind),
									status: readStringValue(evt.data.status),
									title: readStringValue(evt.data.title),
									itemId: readStringValue(evt.data.itemId),
									toolCallId: readStringValue(evt.data.toolCallId),
									approvalId: readStringValue(evt.data.approvalId),
									approvalSlug: readStringValue(evt.data.approvalSlug),
									command: readStringValue(evt.data.command),
									host: readStringValue(evt.data.host),
									reason: readStringValue(evt.data.reason),
									scope: readApprovalScopeValue(evt.data.scope),
									message: readStringValue(evt.data.message)
								});
								if (evt.stream === "command_output") await params.opts?.onCommandOutput?.({
									itemId: readStringValue(evt.data.itemId),
									phase: readStringValue(evt.data.phase),
									title: readStringValue(evt.data.title),
									toolCallId: readStringValue(evt.data.toolCallId),
									name: readStringValue(evt.data.name),
									output: readStringValue(evt.data.output),
									status: readStringValue(evt.data.status),
									exitCode: typeof evt.data.exitCode === "number" || evt.data.exitCode === null ? evt.data.exitCode : void 0,
									durationMs: typeof evt.data.durationMs === "number" ? evt.data.durationMs : void 0,
									cwd: readStringValue(evt.data.cwd)
								});
								if (evt.stream === "patch") await params.opts?.onPatchSummary?.({
									itemId: readStringValue(evt.data.itemId),
									phase: readStringValue(evt.data.phase),
									title: readStringValue(evt.data.title),
									toolCallId: readStringValue(evt.data.toolCallId),
									name: readStringValue(evt.data.name),
									added: Array.isArray(evt.data.added) ? evt.data.added.filter((entry) => typeof entry === "string") : void 0,
									modified: Array.isArray(evt.data.modified) ? evt.data.modified.filter((entry) => typeof entry === "string") : void 0,
									deleted: Array.isArray(evt.data.deleted) ? evt.data.deleted.filter((entry) => typeof entry === "string") : void 0,
									summary: readStringValue(evt.data.summary)
								});
								if (evt.stream === "compaction") {
									const phase = readStringValue(evt.data.phase) ?? "";
									const hookMessages = readCompactionHookMessages(evt.data.messages);
									if (phase === "start") {
										if (params.opts?.onCompactionStart) await params.opts.onCompactionStart();
										if (hookMessages.length > 0) await sendCompactionHookMessages(hookMessages);
										else if (!params.opts?.onCompactionStart && shouldNotifyUserAboutCompaction) await sendCompactionNotice("start");
									}
									if (phase === "end") {
										if (evt.data?.completed === true) {
											attemptCompactionCount += 1;
											if (params.opts?.onCompactionEnd) await params.opts.onCompactionEnd();
											if (hookMessages.length > 0) await sendCompactionHookMessages(hookMessages);
											else if (!params.opts?.onCompactionEnd && shouldNotifyUserAboutCompaction) await sendCompactionNotice("end");
										} else if (hookMessages.length > 0) await sendCompactionHookMessages(hookMessages);
										else if (shouldNotifyUserAboutCompaction) await sendCompactionNotice("incomplete");
									}
								}
							},
							onBlockReply: blockReplyHandler,
							onBlockReplyFlush: params.blockStreamingEnabled && blockReplyPipeline ? async () => {
								await blockReplyPipeline.flush({ force: true });
							} : void 0,
							shouldEmitToolResult: params.shouldEmitToolResult,
							shouldEmitToolOutput: params.shouldEmitToolOutput,
							bootstrapPromptWarningSignaturesSeen,
							bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
							onToolResult: onToolResult ? (() => {
								let toolResultChain = Promise.resolve();
								return (payload) => {
									toolResultChain = toolResultChain.then(async () => {
										const { text, skip } = normalizeStreamingText(payload);
										if (skip) return;
										if (text !== void 0) await params.typingSignals.signalTextDelta(text);
										await onToolResult({
											...payload,
											text
										});
									}).catch((err) => {
										logVerbose(`tool result delivery failed: ${String(err)}`);
									});
									const task = toolResultChain.finally(() => {
										params.pendingToolTasks.delete(task);
									});
									params.pendingToolTasks.add(task);
								};
							})() : void 0
						});
						bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
						lifecycleBackstop.emit("end", result);
						const resultCompactionCount = Math.max(0, result.meta?.agentMeta?.compactionCount ?? 0);
						attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
						return {
							result,
							continueWorkRequest: attemptContinueWorkRequest,
							compactionTraceparent: attemptCompactionTraceparent
						};
					} catch (err) {
						if (rollbackFallbackCandidateSelection) try {
							await rollbackFallbackCandidateSelection();
							clearPendingFallbackRollback(rollbackFallbackCandidateSelection);
						} catch (rollbackError) {
							logVerbose(`failed to roll back fallback candidate selection (non-fatal): ${String(rollbackError)}`);
						}
						lifecycleBackstop.emit("error", err);
						throw err;
					} finally {
						autoCompactionCount += attemptCompactionCount;
					}
				})();
			}
		});
		const fallbackRunResult = fallbackResult.result;
		if (isContinuationWrappedRunResult(fallbackRunResult)) {
			runResult = fallbackRunResult.result;
			continueWorkRequest = fallbackRunResult.continueWorkRequest;
			compactionTraceparent = fallbackRunResult.compactionTraceparent;
		} else {
			runResult = fallbackRunResult;
			continueWorkRequest = void 0;
			compactionTraceparent = void 0;
		}
		fallbackProvider = fallbackResult.provider;
		fallbackModel = fallbackResult.model;
		fallbackAttempts = Array.isArray(fallbackResult.attempts) ? fallbackResult.attempts.map((attempt) => ({
			provider: attempt.provider,
			model: attempt.model,
			error: attempt.error,
			reason: attempt.reason || void 0,
			status: typeof attempt.status === "number" ? attempt.status : void 0,
			code: attempt.code || void 0
		})) : [];
		await clearRecoveredAutoFallbackPrimaryProbe({
			provider: fallbackProvider,
			model: fallbackModel
		});
		const embeddedError = runResult.meta?.error;
		if (embeddedError && isContextOverflowError(embeddedError.message) && !didResetAfterCompactionFailure && await params.resetSessionAfterCompactionFailure(embeddedError.message)) {
			didResetAfterCompactionFailure = true;
			params.replyOperation?.fail("run_failed", embeddedError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildContextOverflowRecoveryText({
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					primaryProvider: params.followupRun.run.provider,
					primaryModel: params.followupRun.run.model,
					activeSessionEntry: params.getActiveSessionEntry()
				}) })
			};
		}
		if (embeddedError?.kind === "role_ordering") {
			if (await params.resetSessionAfterRoleOrderingConflict(embeddedError.message)) {
				params.replyOperation?.fail("run_failed", embeddedError);
				return {
					kind: "final",
					payload: markAgentRunFailureReplyPayload({ text: "⚠️ Message ordering conflict. I've reset the conversation - please try again." })
				};
			}
		}
		break;
	} catch (err) {
		if (err instanceof LiveSessionModelSwitchError) {
			liveModelSwitchRetries += 1;
			if (liveModelSwitchRetries > 2) {
				defaultRuntime.error(`Live model switch failed after 2 retries (${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}). The requested model may be unavailable.`);
				const switchErrorText = shouldSurfaceToControlUi ? "⚠️ Agent failed before reply: model switch could not be completed. The requested model may be temporarily unavailable.\nLogs: openclaw logs --follow" : isVerboseFailureDetailEnabled(params.resolvedVerboseLevel) ? "⚠️ Agent failed before reply: model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly." : "⚠️ Model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly.";
				params.replyOperation?.fail("run_failed", err);
				return {
					kind: "final",
					payload: markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
						text: switchErrorText,
						sessionCtx: params.sessionCtx,
						isGenericRunnerFailure: !shouldSurfaceToControlUi,
						cfg: params.followupRun.run.config
					}) })
				};
			}
			applyLiveModelSwitchToRun(params.followupRun.run, err);
			if (runnableRun !== params.followupRun.run) applyLiveModelSwitchToRun(runnableRun, err);
			if (effectiveRun !== runnableRun && effectiveRun !== params.followupRun.run) applyLiveModelSwitchToRun(effectiveRun, err);
			fallbackProvider = err.provider;
			fallbackModel = err.model;
			continue;
		}
		const message = formatErrorMessage(err);
		const isBilling = isFallbackSummaryError(err) ? isPureBillingSummary(err) : isBillingErrorMessage(message);
		const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
		const isCompactionFailure = !isBilling && isCompactionFailureError(message);
		const isSessionCorruption = /function call turn comes immediately after/i.test(message);
		const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);
		const isTransientHttp = isTransientHttpError(message);
		if (isReplyOperationRestartAbort(params.replyOperation)) return {
			kind: "final",
			payload: markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() })
		};
		if (isReplyOperationUserAbort(params.replyOperation)) return {
			kind: "final",
			payload: { text: SILENT_REPLY_TOKEN }
		};
		const restartLifecycleError = resolveRestartLifecycleError(err);
		if (restartLifecycleError instanceof GatewayDrainingError) {
			params.replyOperation?.fail("gateway_draining", restartLifecycleError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() })
			};
		}
		if (restartLifecycleError instanceof CommandLaneClearedError) {
			params.replyOperation?.fail("command_lane_cleared", restartLifecycleError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() })
			};
		}
		if (isCompactionFailure && !didResetAfterCompactionFailure && await params.resetSessionAfterCompactionFailure(message)) {
			didResetAfterCompactionFailure = true;
			params.replyOperation?.fail("run_failed", err);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildContextOverflowRecoveryText({
					duringCompaction: true,
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					primaryProvider: params.followupRun.run.provider,
					primaryModel: params.followupRun.run.model,
					activeSessionEntry: params.getActiveSessionEntry()
				}) })
			};
		}
		if (isRoleOrderingError) {
			if (await params.resetSessionAfterRoleOrderingConflict(message)) {
				params.replyOperation?.fail("run_failed", err);
				return {
					kind: "final",
					payload: markAgentRunFailureReplyPayload({ text: "⚠️ Message ordering conflict. I've reset the conversation - please try again." })
				};
			}
		}
		if (isSessionCorruption && params.sessionKey && params.activeSessionStore && params.storePath) {
			const sessionKey = params.sessionKey;
			const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
			defaultRuntime.error(`Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`);
			try {
				if (corruptedSessionId) {
					const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
					try {
						fs.unlinkSync(transcriptPath);
					} catch {}
				}
				{
					const memResolved = resolveSessionStoreEntry({
						store: params.activeSessionStore,
						sessionKey
					});
					delete params.activeSessionStore[memResolved.normalizedKey];
					for (const legacyKey of memResolved.legacyKeys) delete params.activeSessionStore[legacyKey];
				}
				await updateSessionStore(params.storePath, (store) => {
					const resolved = resolveSessionStoreEntry({
						store,
						sessionKey
					});
					delete store[resolved.normalizedKey];
					for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
				});
			} catch (cleanupErr) {
				defaultRuntime.error(`Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`);
			}
			params.replyOperation?.fail("session_corruption_reset", err);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!" })
			};
		}
		if (isTransientHttp && !didRetryTransientHttpError) {
			didRetryTransientHttpError = true;
			defaultRuntime.error(`Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`);
			await new Promise((resolve) => {
				setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
			});
			continue;
		}
		defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
		const isFallbackSummary = isFallbackSummaryError(err);
		const isPureTransientSummary = isFallbackSummary ? isPureTransientRateLimitSummary(err) : false;
		const isRateLimit = isFallbackSummary ? isPureTransientSummary : isRateLimitErrorMessage(message);
		const rateLimitOrOverloadedCopy = !isFallbackSummary || isPureTransientSummary ? formatRateLimitOrOverloadedErrorCopy(message) : void 0;
		const trimmedMessage = (isTransientHttp ? sanitizeUserFacingText(message, { errorContext: true }) : message).replace(/\.\s*$/, "");
		const externalRunFailureReply = !isBilling && !(isRateLimit && !isOverloadedErrorMessage(message)) && !rateLimitOrOverloadedCopy && !isContextOverflow && !isRoleOrderingError && !shouldSurfaceToControlUi ? buildExternalRunFailureReply(message, {
			includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
			isHeartbeat: params.isHeartbeat
		}) : void 0;
		const genericFallbackText = params.isHeartbeat ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
		const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
			text: isBilling ? BILLING_ERROR_USER_MESSAGE : isRateLimit && !isOverloadedErrorMessage(message) ? buildRateLimitCooldownMessage(err) : rateLimitOrOverloadedCopy ? rateLimitOrOverloadedCopy : isContextOverflow ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model." : isRoleOrderingError ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session." : shouldSurfaceToControlUi ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow` : externalRunFailureReply?.text ?? genericFallbackText,
			sessionCtx: params.sessionCtx,
			isGenericRunnerFailure: externalRunFailureReply?.isGenericRunnerFailure ?? false,
			cfg: params.followupRun.run.config
		});
		params.replyOperation?.fail("run_failed", err);
		return {
			kind: "final",
			payload: markAgentRunFailureReplyPayload({ text: userVisibleFallbackText })
		};
	}
	const finalEmbeddedError = runResult?.meta?.error;
	const hasPayloadText = runResult?.payloads?.some((p) => normalizeOptionalString(p.text));
	const hasErrorPayload = runResult?.payloads?.some((p) => p.isError) ?? false;
	if (runResult?.meta?.livenessState === "blocked" && !didSurfaceBlockedLivenessState && !hasErrorPayload) {
		runResult.payloads = [{
			text: BLOCKED_LIVENESS_NOTICE_TEXT,
			isError: true
		}, ...runResult.payloads ?? []];
		didSurfaceBlockedLivenessState = true;
	}
	if (finalEmbeddedError && !hasPayloadText) {
		if (isContextOverflowError(finalEmbeddedError.message ?? "")) {
			params.replyOperation?.fail("run_failed", finalEmbeddedError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session." })
			};
		}
	}
	const finalLivenessState = runResult?.meta?.livenessState;
	if (runResult && finalLivenessState === "blocked" && Array.isArray(runResult.payloads) && runResult.payloads.length > 0) {
		const blockedMarker = "⛔ Session blocked: ";
		runResult.payloads = runResult.payloads.map((payload) => {
			if (!payload.isError) return payload;
			const text = normalizeOptionalString(payload.text);
			if (!text) return payload;
			if (text.startsWith(blockedMarker)) return payload;
			if (text.startsWith(BLOCKED_LIVENESS_NOTICE_TEXT)) return payload;
			return {
				...payload,
				text: `${blockedMarker}${text}`
			};
		});
	}
	if (runResult) {
		if (!runResult.payloads?.some((p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }))) {
			const metaErrorMsg = finalEmbeddedError?.message ?? "";
			const rawErrorPayloadText = runResult.payloads?.find((p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"))?.text ?? "";
			const errorCandidate = metaErrorMsg || rawErrorPayloadText;
			const formattedErrorCandidate = errorCandidate ? formatRateLimitOrOverloadedErrorCopy(errorCandidate) : void 0;
			if (formattedErrorCandidate) runResult.payloads = [markAgentRunFailureReplyPayload({
				text: formattedErrorCandidate,
				isError: true
			})];
		}
		applyOpenAIGptChatReplyGuard({
			provider: fallbackProvider,
			model: fallbackModel,
			commandBody: params.commandBody,
			isHeartbeat: params.isHeartbeat,
			payloads: runResult.payloads
		});
	}
	return {
		kind: "success",
		runId,
		runResult,
		fallbackProvider,
		fallbackModel,
		fallbackAttempts,
		didLogHeartbeatStrip,
		autoCompactionCount,
		compactionTraceparent,
		directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : void 0,
		continueWorkRequest
	};
}
//#endregion
//#region src/auto-reply/reply/agent-runner-helpers.ts
const hasAudioMedia = (urls) => Boolean(urls?.some((url) => isAudioFileName(url)));
const isAudioPayload = (payload) => hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);
const VERBOSE_GATE_SESSION_REFRESH_MS = 250;
function readCurrentVerboseLevel(params) {
	if (!params.sessionKey || !params.storePath) return;
	try {
		const entry = loadSessionStore(params.storePath)[params.sessionKey];
		return typeof entry?.verboseLevel === "string" ? normalizeVerboseLevel(entry.verboseLevel) : void 0;
	} catch {
		return;
	}
}
function createCurrentVerboseLevelResolver(params) {
	let cachedLevel;
	let cachedAtMs = Number.NEGATIVE_INFINITY;
	return () => {
		if (!params.sessionKey || !params.storePath) return;
		const now = Date.now();
		if (now - cachedAtMs < VERBOSE_GATE_SESSION_REFRESH_MS) return cachedLevel;
		cachedLevel = readCurrentVerboseLevel(params);
		cachedAtMs = now;
		return cachedLevel;
	};
}
function createVerboseGate(params, shouldEmit) {
	const fallbackVerbose = params.resolvedVerboseLevel;
	const resolveCurrentVerboseLevel = createCurrentVerboseLevelResolver(params);
	return () => {
		return shouldEmit(resolveCurrentVerboseLevel() ?? fallbackVerbose);
	};
}
const createShouldEmitToolResult = (params) => {
	return createVerboseGate(params, (level) => level !== "off");
};
const createShouldEmitToolOutput = (params) => {
	return createVerboseGate(params, (level) => level === "full");
};
const signalTypingIfNeeded = async (payloads, typingSignals) => {
	if (payloads.some((payload) => hasOutboundReplyContent(payload, { trimText: true }))) await typingSignals.signalRunStart();
};
//#endregion
//#region src/auto-reply/reply/memory-flush.ts
function resolveMemoryFlushContextWindowTokens(params) {
	return resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.provider,
		model: params.modelId,
		contextTokensOverride: params.agentCfgContextTokens,
		allowAsyncLoad: false
	}) ?? 2e5;
}
function resolveMaxActiveTranscriptBytes(cfg) {
	const compaction = cfg?.agents?.defaults?.compaction;
	if (compaction?.truncateAfterCompaction !== true) return;
	const parsed = parseNonNegativeByteSize(compaction.maxActiveTranscriptBytes);
	return typeof parsed === "number" && parsed > 0 ? parsed : void 0;
}
function resolvePositiveTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function resolveMemoryFlushGateState(params) {
	if (!params.entry) return null;
	const totalTokens = resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
	if (!totalTokens || totalTokens <= 0) return null;
	const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
	const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
	const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
	const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);
	if (threshold <= 0) return null;
	return {
		entry: params.entry,
		totalTokens,
		threshold
	};
}
function shouldRunMemoryFlush(params) {
	const state = resolveMemoryFlushGateState(params);
	if (!state || state.totalTokens < state.threshold) return false;
	if (hasAlreadyFlushedForCurrentCompaction(state.entry)) return false;
	return true;
}
function shouldRunPreflightCompaction(params) {
	const state = resolveMemoryFlushGateState(params);
	return Boolean(state && state.totalTokens >= state.threshold);
}
/**
* Returns true when a memory flush has already been performed for the current
* compaction cycle. This prevents repeated flush runs within the same cycle —
* important for both the token-based and transcript-size–based trigger paths.
*/
function hasAlreadyFlushedForCurrentCompaction(entry) {
	const compactionCount = entry.compactionCount ?? 0;
	const lastFlushAt = entry.memoryFlushCompactionCount;
	return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
//#endregion
//#region src/auto-reply/reply/agent-runner-memory.ts
const MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS = 600;
const piEmbeddedRuntimeLoader = createLazyImportLoader(() => import("./pi-embedded-BeZh9z3_.js"));
function loadPiEmbeddedRuntime() {
	return piEmbeddedRuntimeLoader.load();
}
async function compactEmbeddedPiSessionDefault(...args) {
	const { compactEmbeddedPiSession } = await loadPiEmbeddedRuntime();
	return await compactEmbeddedPiSession(...args);
}
async function runEmbeddedPiAgentDefault(...args) {
	const { runEmbeddedPiAgent } = await loadPiEmbeddedRuntime();
	return await runEmbeddedPiAgent(...args);
}
const memoryDeps = {
	compactEmbeddedPiSession: compactEmbeddedPiSessionDefault,
	runWithModelFallback,
	runEmbeddedPiAgent: runEmbeddedPiAgentDefault,
	registerAgentRunContext,
	refreshQueuedFollowupSession,
	incrementCompactionCount,
	updateSessionStoreEntry,
	randomUUID: () => crypto.randomUUID(),
	now: () => Date.now()
};
function estimatePromptTokensForMemoryFlush(prompt) {
	const trimmed = normalizeOptionalString(prompt);
	if (!trimmed) return;
	const tokens = estimateMessagesTokens([{
		role: "user",
		content: trimmed,
		timestamp: Date.now()
	}]);
	if (!Number.isFinite(tokens) || tokens <= 0) return;
	return Math.ceil(tokens);
}
function resolveEffectivePromptTokens(basePromptTokens, lastOutputTokens, promptTokenEstimate) {
	const base = Math.max(0, basePromptTokens ?? 0);
	const output = Math.max(0, lastOutputTokens ?? 0);
	const estimate = Math.max(0, promptTokenEstimate ?? 0);
	return base + output + estimate;
}
function resolveMemoryFlushModelFallbackOptions(run, model, configOverride = run.config) {
	const options = resolveModelFallbackOptions(run, configOverride);
	const override = normalizeOptionalString(model);
	if (!override) return options;
	const slashIdx = override.indexOf("/");
	if (slashIdx > 0) {
		const overrideProvider = override.slice(0, slashIdx).trim();
		const overrideModel = override.slice(slashIdx + 1).trim();
		if (overrideProvider && overrideModel) return {
			...options,
			provider: overrideProvider,
			model: overrideModel,
			fallbacksOverride: []
		};
	}
	return {
		...options,
		model: override,
		fallbacksOverride: []
	};
}
function resolveVisibleMemoryFlushErrorPayloads(payloads) {
	return (payloads ?? []).filter((payload) => payload.isError === true && isRenderablePayload(payload));
}
function buildMemoryFlushErrorPayload(err) {
	if (isAbortError(err)) return;
	const message = normalizeOptionalString(formatErrorMessage(err));
	if (!message) return;
	const visibleText = message.startsWith("⚠️") ? message : `⚠️ ${message}`;
	return {
		text: visibleText.length > MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS ? `${visibleText.slice(0, MAX_VISIBLE_MEMORY_FLUSH_ERROR_CHARS - 1)}…` : visibleText,
		isError: true
	};
}
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;
function parseUsageFromTranscriptLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const parsed = JSON.parse(trimmed);
		const usage = normalizeUsage(parsed.message?.usage ?? parsed.usage);
		if (usage && hasNonzeroUsage(usage)) return usage;
	} catch {}
}
function resolveSessionLogPath(sessionId, sessionEntry, sessionKey, opts) {
	if (!sessionId) return;
	try {
		const transcriptPath = normalizeOptionalString(sessionEntry?.transcriptPath);
		const sessionFile = normalizeOptionalString(sessionEntry?.sessionFile) || transcriptPath;
		const pathOpts = resolveSessionFilePathOptions({
			agentId: resolveAgentIdFromSessionKey(sessionKey),
			storePath: opts?.storePath
		});
		return resolveSessionFilePath(sessionId, sessionFile ? { sessionFile } : sessionEntry, pathOpts);
	} catch {
		return;
	}
}
function deriveTranscriptUsageSnapshot(snapshot) {
	const usage = snapshot?.usage;
	if (!usage) return;
	const promptTokens = derivePromptTokens(usage);
	const outputRaw = usage.output;
	const outputTokens = typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0 ? outputRaw : void 0;
	if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) return;
	return {
		promptTokens,
		outputTokens,
		trailingBytesTokens: typeof snapshot.trailingBytes === "number" && Number.isFinite(snapshot.trailingBytes) && snapshot.trailingBytes > 0 ? Math.ceil(snapshot.trailingBytes / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN) : void 0
	};
}
async function appendPostCompactionRefreshPrompt(params) {
	const refreshPrompt = await readPostCompactionContext(params.followupRun.run.workspaceDir, {
		cfg: params.cfg,
		agentId: params.followupRun.run.agentId
	});
	if (!refreshPrompt) return;
	const existingPrompt = normalizeOptionalString(params.followupRun.run.extraSystemPrompt);
	if (existingPrompt?.includes(refreshPrompt)) return;
	params.followupRun.run.extraSystemPrompt = [existingPrompt, refreshPrompt].filter(Boolean).join("\n\n");
}
async function readSessionLogSnapshot(params) {
	const logPath = resolveSessionLogPath(params.sessionId, params.sessionEntry, params.sessionKey, params.opts);
	if (!logPath) return {};
	const snapshot = {};
	if (params.includeByteSize) try {
		const stat = await fs.promises.stat(logPath);
		const size = Math.floor(stat.size);
		snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : void 0;
	} catch {
		snapshot.byteSize = void 0;
	}
	if (params.includeUsage) try {
		snapshot.usage = deriveTranscriptUsageSnapshot(await readLastNonzeroUsageFromSessionLog(logPath));
	} catch {
		snapshot.usage = void 0;
	}
	return snapshot;
}
async function readLastNonzeroUsageFromSessionLog(logPath) {
	const handle = await fs.promises.open(logPath, "r");
	try {
		const stat = await handle.stat();
		let position = stat.size;
		let leadingPartial = "";
		while (position > 0) {
			const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
			const start = position - chunkSize;
			const buffer = Buffer.allocUnsafe(chunkSize);
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
			if (bytesRead <= 0) break;
			const chunk = buffer.toString("utf-8", 0, bytesRead);
			const appendedPartialBytes = Buffer.byteLength(leadingPartial, "utf8");
			const lines = `${chunk}${leadingPartial}`.split(/\n+/);
			leadingPartial = lines.shift() ?? "";
			const suffixBytesBeforeChunk = stat.size - position;
			const suffixBytesOutsideCombined = Math.max(0, suffixBytesBeforeChunk - appendedPartialBytes);
			for (let i = lines.length - 1; i >= 0; i -= 1) {
				const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
				if (usage) {
					const trailingLines = lines.slice(i + 1);
					return {
						usage,
						trailingBytes: suffixBytesOutsideCombined + (Buffer.byteLength(trailingLines.join("\n"), "utf8") + trailingLines.length)
					};
				}
			}
			position = start;
		}
		const usage = parseUsageFromTranscriptLine(leadingPartial);
		return usage ? {
			usage,
			trailingBytes: Math.max(0, stat.size - Buffer.byteLength(leadingPartial, "utf8"))
		} : void 0;
	} finally {
		await handle.close();
	}
}
async function estimatePromptTokensFromSessionTranscript(params) {
	const sessionId = normalizeOptionalString(params.sessionId);
	if (!sessionId) return;
	const fallbackSessionFile = normalizeOptionalString(params.sessionFile);
	const sessionEntryForTranscript = params.sessionEntry?.sessionFile || !fallbackSessionFile ? params.sessionEntry : {
		...params.sessionEntry,
		sessionFile: fallbackSessionFile
	};
	try {
		const snapshot = await readSessionLogSnapshot({
			sessionId,
			sessionEntry: sessionEntryForTranscript,
			sessionKey: params.sessionKey,
			opts: { storePath: params.storePath },
			includeByteSize: true,
			includeUsage: true
		});
		const transcriptBytesTokens = typeof snapshot.byteSize === "number" && Number.isFinite(snapshot.byteSize) && snapshot.byteSize > 0 ? Math.ceil(snapshot.byteSize / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN) : void 0;
		const promptTokens = snapshot.usage?.promptTokens;
		const trailingBytesTokens = snapshot.usage?.trailingBytesTokens;
		const messages = await readSessionMessagesAsync(sessionId, params.storePath, sessionEntryForTranscript?.sessionFile, {
			mode: "recent",
			maxMessages: 200,
			maxBytes: 1024 * 1024
		});
		const estimatedMessageTokens = (() => {
			if (messages.length === 0) return;
			const tokens = estimateMessagesTokens(messages);
			return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : void 0;
		})();
		if (typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens > 0) {
			const outputTokens = snapshot.usage?.outputTokens;
			const usagePromptTokens = Math.ceil(promptTokens) + (trailingBytesTokens ?? 0);
			return {
				promptTokens: Math.max(usagePromptTokens, estimatedMessageTokens ?? 0),
				outputTokens: typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0 ? Math.ceil(outputTokens) : void 0,
				transcriptBytesTokens
			};
		}
		const estimatedTokens = estimatedMessageTokens ?? transcriptBytesTokens;
		if (estimatedTokens === void 0) return;
		return {
			promptTokens: Math.ceil(estimatedTokens),
			transcriptBytesTokens
		};
	} catch {
		return;
	}
}
async function runPreflightCompactionIfNeeded(params) {
	if (!params.sessionKey) return params.sessionEntry;
	let entry = params.sessionEntry ?? (params.sessionKey ? params.sessionStore?.[params.sessionKey] : void 0);
	if (!entry?.sessionId) return entry ?? params.sessionEntry;
	const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
	if (params.isHeartbeat || isCli) return entry ?? params.sessionEntry;
	const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
		cfg: params.cfg,
		provider: params.followupRun.run.provider,
		modelId: params.followupRun.run.model ?? params.defaultModel,
		agentCfgContextTokens: params.agentCfgContextTokens
	});
	const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
	const reserveTokensFloor = memoryFlushPlan?.reserveTokensFloor ?? params.cfg.agents?.defaults?.compaction?.reserveTokensFloor ?? 2e4;
	const softThresholdTokens = memoryFlushPlan?.softThresholdTokens ?? 4e3;
	const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
	const persistedTotalTokens = entry.totalTokens;
	const hasPersistedTotalTokens = typeof persistedTotalTokens === "number" && Number.isFinite(persistedTotalTokens) && persistedTotalTokens > 0;
	const maxActiveTranscriptBytes = resolveMaxActiveTranscriptBytes(params.cfg);
	const activeTranscriptBytes = (typeof maxActiveTranscriptBytes === "number" ? await readSessionLogSnapshot({
		sessionId: entry.sessionId,
		sessionEntry: entry.sessionFile || !params.followupRun.run.sessionFile ? entry : {
			...entry,
			sessionFile: params.followupRun.run.sessionFile
		},
		sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
		opts: { storePath: params.storePath },
		includeByteSize: true,
		includeUsage: false
	}) : void 0)?.byteSize;
	const shouldCompactByTranscriptBytes = typeof activeTranscriptBytes === "number" && typeof maxActiveTranscriptBytes === "number" && activeTranscriptBytes >= maxActiveTranscriptBytes;
	if (!(entry.totalTokensFresh === false || !hasPersistedTotalTokens) && !shouldCompactByTranscriptBytes) return entry ?? params.sessionEntry;
	const promptTokenEstimate = estimatePromptTokensForMemoryFlush(params.promptForEstimate ?? params.followupRun.prompt);
	const transcriptUsageTokens = typeof freshPersistedTokens === "number" ? void 0 : await estimatePromptTokensFromSessionTranscript({
		sessionId: entry.sessionId,
		sessionEntry: entry,
		sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
		sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
		storePath: params.storePath
	});
	const stalePersistedPromptTokens = hasPersistedTotalTokens ? Math.floor(persistedTotalTokens) : void 0;
	const transcriptPromptTokens = transcriptUsageTokens?.promptTokens;
	const transcriptOutputTokens = transcriptUsageTokens?.outputTokens;
	const usageProjectedTokenCount = typeof transcriptPromptTokens === "number" ? resolveEffectivePromptTokens(transcriptPromptTokens, transcriptOutputTokens, promptTokenEstimate) : void 0;
	const projectedTokenCount = Math.max(usageProjectedTokenCount ?? 0, stalePersistedPromptTokens ?? 0);
	const tokenCountForCompaction = Number.isFinite(projectedTokenCount) && projectedTokenCount > 0 ? projectedTokenCount : void 0;
	const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;
	logVerbose(`preflightCompaction check: sessionKey=${params.sessionKey} tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} contextWindow=${contextWindowTokens} threshold=${threshold} isHeartbeat=${params.isHeartbeat} isCli=${isCli} persistedFresh=${entry?.totalTokensFresh === true} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} promptTokensEst=${promptTokenEstimate ?? "undefined"} activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"} sizeTrigger=${shouldCompactByTranscriptBytes}`);
	if (!(shouldRunPreflightCompaction({
		entry,
		tokenCount: tokenCountForCompaction,
		contextWindowTokens,
		reserveTokensFloor,
		softThresholdTokens
	}) || shouldCompactByTranscriptBytes)) return entry ?? params.sessionEntry;
	const compactionTrigger = shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";
	logVerbose(`preflightCompaction triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} threshold=${threshold} trigger=${compactionTrigger} activeTranscriptBytes=${activeTranscriptBytes ?? "undefined"} maxActiveTranscriptBytes=${maxActiveTranscriptBytes ?? "undefined"}`);
	params.replyOperation.setPhase("preflight_compacting");
	const sessionFile = resolveSessionLogPath(entry.sessionId, entry.sessionFile ? entry : {
		...entry,
		sessionFile: params.followupRun.run.sessionFile
	}, params.sessionKey ?? params.followupRun.run.sessionKey, { storePath: params.storePath });
	const result = await memoryDeps.compactEmbeddedPiSession({
		sessionId: entry.sessionId,
		sessionKey: params.sessionKey,
		sandboxSessionKey: params.runtimePolicySessionKey,
		allowGatewaySubagentBinding: true,
		messageChannel: params.followupRun.run.messageProvider,
		groupId: entry.groupId ?? params.followupRun.run.groupId,
		groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
		groupSpace: entry.space ?? params.followupRun.run.groupSpace,
		senderId: params.followupRun.run.senderId,
		senderName: params.followupRun.run.senderName,
		senderUsername: params.followupRun.run.senderUsername,
		senderE164: params.followupRun.run.senderE164,
		sessionFile: sessionFile ?? params.followupRun.run.sessionFile,
		workspaceDir: params.followupRun.run.workspaceDir,
		agentDir: params.followupRun.run.agentDir,
		config: params.cfg,
		skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
		provider: params.followupRun.run.provider,
		model: params.followupRun.run.model,
		agentHarnessId: entry.sessionId === params.followupRun.run.sessionId ? entry.agentHarnessId : void 0,
		thinkLevel: params.followupRun.run.thinkLevel,
		bashElevated: params.followupRun.run.bashElevated,
		trigger: "budget",
		currentTokenCount: tokenCountForCompaction ?? freshPersistedTokens,
		senderIsOwner: params.followupRun.run.senderIsOwner,
		ownerNumbers: params.followupRun.run.ownerNumbers,
		abortSignal: params.replyOperation.abortSignal
	});
	if (!result?.ok || !result.compacted) {
		logVerbose(`preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${result?.reason ?? "not_compacted"}`);
		return entry ?? params.sessionEntry;
	}
	await incrementCompactionCount({
		cfg: params.cfg,
		sessionEntry: entry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		tokensAfter: result.result?.tokensAfter,
		newSessionId: result.result?.sessionId,
		newSessionFile: result.result?.sessionFile
	});
	await appendPostCompactionRefreshPrompt({
		cfg: params.cfg,
		followupRun: params.followupRun
	});
	entry = params.sessionStore?.[params.sessionKey] ?? entry;
	if (entry) {
		const previousSessionId = params.followupRun.run.sessionId;
		params.followupRun.run.sessionId = entry.sessionId;
		params.replyOperation.updateSessionId(entry.sessionId);
		if (entry.sessionFile) params.followupRun.run.sessionFile = entry.sessionFile;
		const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
		if (queueKey) memoryDeps.refreshQueuedFollowupSession({
			key: queueKey,
			previousSessionId,
			nextSessionId: entry.sessionId,
			nextSessionFile: entry.sessionFile
		});
	}
	return entry ?? params.sessionEntry;
}
async function runMemoryFlushIfNeeded(params) {
	const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
	if (!memoryFlushPlan) return params.sessionEntry;
	const memoryFlushWritable = (() => {
		if (!params.sessionKey) return true;
		const runtime = resolveSandboxRuntimeStatus({
			cfg: params.cfg,
			sessionKey: params.runtimePolicySessionKey ?? params.sessionKey
		});
		if (!runtime.sandboxed) return true;
		return resolveSandboxConfigForAgent(params.cfg, runtime.agentId).workspaceAccess === "rw";
	})();
	const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
	const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat && !isCli;
	let entry = params.sessionEntry ?? (params.sessionKey ? params.sessionStore?.[params.sessionKey] : void 0);
	const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
		cfg: params.cfg,
		provider: params.followupRun.run.provider,
		modelId: params.followupRun.run.model ?? params.defaultModel,
		agentCfgContextTokens: params.agentCfgContextTokens
	});
	const promptTokenEstimate = estimatePromptTokensForMemoryFlush(params.promptForEstimate ?? params.followupRun.prompt);
	const persistedPromptTokensRaw = entry?.totalTokens;
	const persistedPromptTokens = typeof persistedPromptTokensRaw === "number" && Number.isFinite(persistedPromptTokensRaw) && persistedPromptTokensRaw > 0 ? persistedPromptTokensRaw : void 0;
	const hasFreshPersistedPromptTokens = typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true;
	const flushThreshold = contextWindowTokens - memoryFlushPlan.reserveTokensFloor - memoryFlushPlan.softThresholdTokens;
	const shouldReadTranscriptForOutput = canAttemptFlush && entry && hasFreshPersistedPromptTokens && typeof promptTokenEstimate === "number" && Number.isFinite(promptTokenEstimate) && flushThreshold > 0 && (persistedPromptTokens ?? 0) + promptTokenEstimate >= flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;
	const shouldReadTranscript = Boolean(canAttemptFlush && entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput));
	const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
	const shouldCheckTranscriptSizeForForcedFlush = Boolean(canAttemptFlush && entry && Number.isFinite(forceFlushTranscriptBytes) && forceFlushTranscriptBytes > 0);
	const sessionLogSnapshot = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush ? await readSessionLogSnapshot({
		sessionId: params.followupRun.run.sessionId,
		sessionEntry: entry,
		sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
		opts: { storePath: params.storePath },
		includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
		includeUsage: shouldReadTranscript
	}) : void 0;
	const transcriptByteSize = sessionLogSnapshot?.byteSize;
	const shouldForceFlushByTranscriptSize = typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;
	const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
	const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
	const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
	const hasReliableTranscriptPromptTokens = typeof transcriptPromptTokens === "number" && Number.isFinite(transcriptPromptTokens) && transcriptPromptTokens > 0;
	if (entry && hasReliableTranscriptPromptTokens && (!hasFreshPersistedPromptTokens || (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0))) {
		const nextEntry = {
			...entry,
			totalTokens: transcriptPromptTokens,
			totalTokensFresh: true
		};
		entry = nextEntry;
		if (params.sessionKey && params.sessionStore) params.sessionStore[params.sessionKey] = nextEntry;
		if (params.storePath && params.sessionKey) try {
			const updatedEntry = await updateSessionStoreEntry({
				storePath: params.storePath,
				sessionKey: params.sessionKey,
				update: async () => ({
					totalTokens: transcriptPromptTokens,
					totalTokensFresh: true
				})
			});
			if (updatedEntry) {
				entry = updatedEntry;
				if (params.sessionStore) params.sessionStore[params.sessionKey] = updatedEntry;
			}
		} catch (err) {
			logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
		}
	}
	const promptTokensSnapshot = Math.max(hasFreshPersistedPromptTokens ? persistedPromptTokens ?? 0 : 0, hasReliableTranscriptPromptTokens ? transcriptPromptTokens ?? 0 : 0);
	const projectedTokenCount = promptTokensSnapshot > 0 && (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens) ? resolveEffectivePromptTokens(promptTokensSnapshot, transcriptOutputTokens, promptTokenEstimate) : void 0;
	const tokenCountForFlush = typeof projectedTokenCount === "number" && Number.isFinite(projectedTokenCount) && projectedTokenCount > 0 ? projectedTokenCount : void 0;
	logVerbose(`memoryFlush check: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} contextWindow=${contextWindowTokens} threshold=${flushThreshold} isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`);
	if (!(memoryFlushWritable && !params.isHeartbeat && !isCli && shouldRunMemoryFlush({
		entry,
		tokenCount: tokenCountForFlush,
		contextWindowTokens,
		reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
		softThresholdTokens: memoryFlushPlan.softThresholdTokens
	}) || shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry))) return entry ?? params.sessionEntry;
	logVerbose(`memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`);
	params.replyOperation.setPhase("memory_flushing");
	let activeSessionEntry = entry ?? params.sessionEntry;
	const activeSessionStore = params.sessionStore;
	let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(activeSessionEntry?.systemPromptReport ?? (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : void 0));
	const flushRunId = memoryDeps.randomUUID();
	if (params.sessionKey) memoryDeps.registerAgentRunContext(flushRunId, {
		sessionKey: params.sessionKey,
		verboseLevel: params.resolvedVerboseLevel
	});
	let memoryCompactionCompleted = false;
	const memoryFlushNowMs = memoryDeps.now();
	const activeMemoryFlushPlan = resolveMemoryFlushPlan({
		cfg: params.cfg,
		nowMs: memoryFlushNowMs
	}) ?? memoryFlushPlan;
	const memoryFlushWritePath = activeMemoryFlushPlan.relativePath;
	const flushSystemPrompt = [params.followupRun.run.extraSystemPrompt, activeMemoryFlushPlan.systemPrompt].filter(Boolean).join("\n\n");
	let postCompactionSessionId;
	let postCompactionSessionFile;
	try {
		await memoryDeps.runWithModelFallback({
			...resolveMemoryFlushModelFallbackOptions(params.followupRun.run, activeMemoryFlushPlan.model, params.cfg),
			runId: flushRunId,
			sessionId: activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId,
			lane: "main",
			run: async (provider, model, runOptions) => {
				const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
					run: params.followupRun.run,
					sessionCtx: params.sessionCtx,
					hasRepliedRef: params.opts?.hasRepliedRef,
					provider,
					model,
					runId: flushRunId,
					allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe
				});
				const result = await memoryDeps.runEmbeddedPiAgent({
					...embeddedContext,
					...senderContext,
					...runBaseParams,
					sandboxSessionKey: params.runtimePolicySessionKey,
					allowGatewaySubagentBinding: true,
					silentExpected: true,
					trigger: "memory",
					memoryFlushWritePath,
					prompt: activeMemoryFlushPlan.prompt,
					transcriptPrompt: "",
					extraSystemPrompt: flushSystemPrompt,
					bootstrapPromptWarningSignaturesSeen,
					bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
					abortSignal: params.replyOperation.abortSignal,
					replyOperation: params.replyOperation,
					onAgentEvent: (evt) => {
						if (evt.stream === "compaction") {
							if ((typeof evt.data.phase === "string" ? evt.data.phase : "") === "end") memoryCompactionCompleted = true;
						}
					}
				});
				const visibleErrorPayloads = resolveVisibleMemoryFlushErrorPayloads(result.payloads);
				if (visibleErrorPayloads.length > 0) params.onVisibleErrorPayloads?.(visibleErrorPayloads);
				if (result.meta?.agentMeta?.sessionId) postCompactionSessionId = result.meta.agentMeta.sessionId;
				if (result.meta?.agentMeta?.sessionFile) postCompactionSessionFile = result.meta.agentMeta.sessionFile;
				bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
				return result;
			}
		});
		const flushedCompactionCount = activeSessionEntry?.compactionCount ?? (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ?? 0;
		if (memoryCompactionCompleted) {
			const previousSessionId = activeSessionEntry?.sessionId ?? params.followupRun.run.sessionId;
			await memoryDeps.incrementCompactionCount({
				cfg: params.cfg,
				sessionEntry: activeSessionEntry,
				sessionStore: activeSessionStore,
				sessionKey: params.sessionKey,
				storePath: params.storePath,
				newSessionId: postCompactionSessionId,
				newSessionFile: postCompactionSessionFile
			});
			const updatedEntry = params.sessionKey ? activeSessionStore?.[params.sessionKey] : void 0;
			if (updatedEntry) {
				activeSessionEntry = updatedEntry;
				params.followupRun.run.sessionId = updatedEntry.sessionId;
				params.replyOperation.updateSessionId(updatedEntry.sessionId);
				if (updatedEntry.sessionFile) params.followupRun.run.sessionFile = updatedEntry.sessionFile;
				const queueKey = params.followupRun.run.sessionKey ?? params.sessionKey;
				if (queueKey) memoryDeps.refreshQueuedFollowupSession({
					key: queueKey,
					previousSessionId,
					nextSessionId: updatedEntry.sessionId,
					nextSessionFile: updatedEntry.sessionFile
				});
			}
		}
		if (params.storePath && params.sessionKey) try {
			const updatedEntry = await memoryDeps.updateSessionStoreEntry({
				storePath: params.storePath,
				sessionKey: params.sessionKey,
				update: async () => ({
					memoryFlushAt: memoryDeps.now(),
					memoryFlushCompactionCount: flushedCompactionCount
				})
			});
			if (updatedEntry) {
				activeSessionEntry = updatedEntry;
				params.followupRun.run.sessionId = updatedEntry.sessionId;
				params.replyOperation.updateSessionId(updatedEntry.sessionId);
				if (updatedEntry.sessionFile) params.followupRun.run.sessionFile = updatedEntry.sessionFile;
			}
		} catch (err) {
			logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
		}
	} catch (err) {
		logVerbose(`memory flush run failed: ${String(err)}`);
		const visibleErrorPayload = buildMemoryFlushErrorPayload(err);
		if (visibleErrorPayload) params.onVisibleErrorPayloads?.([visibleErrorPayload]);
	}
	return activeSessionEntry;
}
//#endregion
//#region src/auto-reply/reply/agent-runner-payloads.ts
const replyPayloadsDedupeRuntimeLoader = createLazyImportLoader(() => import("./reply-payloads-dedupe.runtime.js"));
function loadReplyPayloadsDedupeRuntime() {
	return replyPayloadsDedupeRuntimeLoader.load();
}
async function normalizeReplyPayloadMedia(params) {
	if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) return params.payload;
	try {
		const normalized = await params.normalizeMediaPaths(params.payload);
		return copyReplyPayloadMetadata(params.payload, normalized);
	} catch (err) {
		logVerbose(`reply payload media normalization failed: ${String(err)}`);
		return copyReplyPayloadMetadata(params.payload, {
			...params.payload,
			mediaUrl: void 0,
			mediaUrls: void 0,
			audioAsVoice: false
		});
	}
}
async function normalizeSentMediaUrlsForDedupe(params) {
	if (params.sentMediaUrls.length === 0 || !params.normalizeMediaPaths) return [...params.sentMediaUrls];
	const normalizedUrls = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of params.sentMediaUrls) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			normalizedUrls.push(trimmed);
		}
		try {
			const normalizedMediaUrls = resolveSendableOutboundReplyParts(await params.normalizeMediaPaths({
				mediaUrl: trimmed,
				mediaUrls: [trimmed]
			})).mediaUrls;
			for (const mediaUrl of normalizedMediaUrls) {
				const candidate = mediaUrl.trim();
				if (!candidate || seen.has(candidate)) continue;
				seen.add(candidate);
				normalizedUrls.push(candidate);
			}
		} catch (err) {
			logVerbose(`messaging tool sent-media normalization failed: ${String(err)}`);
		}
	}
	return normalizedUrls;
}
function shouldKeepPayloadDuringSilentTurn(payload) {
	if (payload.isError) return true;
	return payload.audioAsVoice === true && resolveSendableOutboundReplyParts(payload).hasMedia;
}
function sanitizeFinalReplyText(payload, text) {
	if (!text) return text;
	return sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
}
function sanitizeHeartbeatPayload(payload) {
	const text = payload.text;
	if (!text) return payload;
	const withoutLegacyBlocks = stripLegacyBracketToolCallBlocks(text);
	const cleaned = sanitizeFinalReplyText(payload, withoutLegacyBlocks);
	if (cleaned === text) return payload;
	if (withoutLegacyBlocks !== text) logVerbose("Stripped legacy tool-call block from heartbeat reply");
	return copyPayloadWithSanitizedText(payload, cleaned);
}
function copyPayloadWithSanitizedText(payload, text) {
	const sanitizedText = sanitizeFinalReplyText(payload, text);
	const next = copyReplyPayloadMetadata(payload, {
		...payload,
		text: sanitizedText
	});
	const mirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
	if (!mirror?.text) return next;
	setReplyPayloadMetadata(next, { sourceReplyTranscriptMirror: {
		...mirror,
		text: sanitizeFinalReplyText(payload, mirror.text) || void 0
	} });
	return next;
}
async function buildReplyPayloads(params) {
	let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
	const sanitizedPayloads = [];
	if (params.isHeartbeat) for (const payload of params.payloads) sanitizedPayloads.push(sanitizeHeartbeatPayload(payload));
	else for (const payload of params.payloads) {
		let text = payload.text;
		if (payload.isError && text && isBunFetchSocketError(text)) text = formatBunFetchSocketError(text);
		if (!text || !text.includes("HEARTBEAT_OK")) {
			sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, text));
			continue;
		}
		const stripped = stripHeartbeatToken(text, { mode: "message" });
		if (stripped.didStrip && !didLogHeartbeatStrip) {
			didLogHeartbeatStrip = true;
			logVerbose("Stripped stray HEARTBEAT_OK token from reply");
		}
		const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
		if (stripped.shouldSkip && !hasMedia) continue;
		sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, stripped.text));
	}
	const replyTaggedPayloadCandidates = await Promise.all(applyReplyThreading({
		payloads: sanitizedPayloads,
		replyToMode: params.replyToMode,
		replyToChannel: params.replyToChannel,
		currentMessageId: params.currentMessageId,
		replyThreading: params.replyThreading
	}).map(async (payload) => {
		const parsed = normalizeReplyPayloadDirectives({
			payload,
			currentMessageId: params.currentMessageId,
			silentToken: SILENT_REPLY_TOKEN,
			parseMode: "always",
			extractMarkdownImages: params.extractMarkdownImages
		});
		const mediaNormalizedPayload = await normalizeReplyPayloadMedia({
			payload: parsed.payload,
			normalizeMediaPaths: params.normalizeMediaPaths
		});
		if (parsed.isSilent && !resolveSendableOutboundReplyParts(mediaNormalizedPayload).hasMedia) mediaNormalizedPayload.text = void 0;
		return mediaNormalizedPayload;
	}));
	const replyTaggedPayloads = [];
	for (const payload of replyTaggedPayloadCandidates) if (isRenderablePayload(payload)) replyTaggedPayloads.push(payload);
	const silentFilteredPayloads = [];
	if (params.silentExpected) {
		for (const payload of replyTaggedPayloads) if (shouldKeepPayloadDuringSilentTurn(payload)) silentFilteredPayloads.push(payload);
	} else silentFilteredPayloads.push(...replyTaggedPayloads);
	const shouldDropFinalPayloads = params.blockStreamingEnabled && Boolean(params.blockReplyPipeline?.didStream()) && !params.blockReplyPipeline?.isAborted();
	const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
	const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
	const shouldCheckMessagingToolDedupe = messagingToolSentTexts.length > 0 || (params.messagingToolSentMediaUrls?.length ?? 0) > 0 || messagingToolSentTargets.length > 0;
	const dedupeRuntime = shouldCheckMessagingToolDedupe ? await loadReplyPayloadsDedupeRuntime() : null;
	const messagingToolPayloadDedupe = dedupeRuntime?.resolveMessagingToolPayloadDedupe({
		messageProvider: resolveOriginMessageProvider({
			originatingChannel: params.originatingChannel,
			provider: params.messageProvider
		}),
		messagingToolSentTargets,
		originatingTo: resolveOriginMessageTo({ originatingTo: params.originatingTo }),
		accountId: resolveOriginAccountId({ originatingAccountId: params.accountId })
	}) ?? {
		shouldDedupePayloads: shouldCheckMessagingToolDedupe && messagingToolSentTargets.length === 0,
		matchingRoute: false,
		routeSentTexts: [],
		routeSentMediaUrls: [],
		useGlobalSentTextEvidenceFallback: false,
		useGlobalSentMediaUrlEvidenceFallback: false
	};
	const dedupeMessagingToolPayloads = messagingToolPayloadDedupe.shouldDedupePayloads;
	const sentMediaUrlFallback = params.messagingToolSentMediaUrls ?? [];
	const shouldUseGlobalSentMediaUrlEvidence = messagingToolPayloadDedupe.matchingRoute && messagingToolPayloadDedupe.routeSentMediaUrls.length === 0 && messagingToolPayloadDedupe.useGlobalSentMediaUrlEvidenceFallback;
	const shouldUseGlobalSentTextEvidence = messagingToolPayloadDedupe.matchingRoute && messagingToolPayloadDedupe.routeSentTexts.length === 0 && messagingToolPayloadDedupe.useGlobalSentTextEvidenceFallback;
	const sentMediaUrlsForDedupe = messagingToolPayloadDedupe.matchingRoute ? shouldUseGlobalSentMediaUrlEvidence ? sentMediaUrlFallback : messagingToolPayloadDedupe.routeSentMediaUrls : sentMediaUrlFallback;
	const sentTextsForDedupe = messagingToolPayloadDedupe.matchingRoute ? shouldUseGlobalSentTextEvidence ? messagingToolSentTexts : messagingToolPayloadDedupe.routeSentTexts : messagingToolSentTexts;
	const messagingToolSentMediaUrls = dedupeMessagingToolPayloads ? await normalizeSentMediaUrlsForDedupe({
		sentMediaUrls: sentMediaUrlsForDedupe,
		normalizeMediaPaths: params.normalizeMediaPaths
	}) : sentMediaUrlsForDedupe;
	const mediaFilteredPayloads = dedupeMessagingToolPayloads ? (dedupeRuntime ?? await loadReplyPayloadsDedupeRuntime()).filterMessagingToolMediaDuplicates({
		payloads: silentFilteredPayloads,
		sentMediaUrls: messagingToolSentMediaUrls
	}) : silentFilteredPayloads;
	const dedupedPayloads = dedupeMessagingToolPayloads ? (dedupeRuntime ?? await loadReplyPayloadsDedupeRuntime()).filterMessagingToolDuplicates({
		payloads: mediaFilteredPayloads,
		sentTexts: sentTextsForDedupe
	}) : mediaFilteredPayloads;
	const isDirectlySentBlockPayload = (payload) => Boolean(params.directlySentBlockKeys?.has(createBlockReplyContentKey(payload)));
	const normalizePreviewDedupeText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
	const buildPreviewDedupeTextSet = (value) => {
		const dedupeText = /* @__PURE__ */ new Set();
		const normalizedWhole = normalizePreviewDedupeText(value);
		if (normalizedWhole) dedupeText.add(normalizedWhole);
		for (const block of (value ?? "").split(/\n{2,}/u)) {
			const normalizedBlock = normalizePreviewDedupeText(block);
			if (normalizedBlock) dedupeText.add(normalizedBlock);
		}
		return dedupeText;
	};
	const previewStreamedText = buildPreviewDedupeTextSet(params.previewStreamedText);
	const isPreviewStreamedTextPayload = (payload) => {
		if (previewStreamedText.size === 0 || payload.isError) return false;
		const text = normalizePreviewDedupeText(payload.text);
		return Boolean(text && previewStreamedText.has(text));
	};
	const preserveUnsentMediaAfterPreviewStream = (payload) => {
		if (!isPreviewStreamedTextPayload(payload)) return payload;
		if (!resolveSendableOutboundReplyParts(payload).hasMedia) return null;
		return copyReplyPayloadMetadata(payload, {
			...payload,
			text: void 0,
			audioAsVoice: payload.audioAsVoice || void 0
		});
	};
	const suppressPreviewStreamedPayloads = (payloads) => {
		const unsent = [];
		for (const payload of payloads) {
			const next = preserveUnsentMediaAfterPreviewStream(payload);
			if (next) unsent.push(next);
		}
		return unsent;
	};
	const preserveUnsentMediaAfterBlockStream = (payload) => {
		if (payload.isError || payload.isFallbackNotice) return payload;
		const reply = resolveSendableOutboundReplyParts(payload);
		if (!reply.hasMedia) return null;
		if (!reply.trimmedText) return payload;
		const textOnlyPayload = copyReplyPayloadMetadata(payload, {
			...payload,
			mediaUrl: void 0,
			mediaUrls: void 0,
			audioAsVoice: void 0
		});
		if (!params.blockReplyPipeline?.hasSentPayload(textOnlyPayload)) return payload;
		return copyReplyPayloadMetadata(payload, {
			...payload,
			text: void 0,
			audioAsVoice: payload.audioAsVoice || void 0
		});
	};
	const contentSuppressedPayloads = shouldDropFinalPayloads ? (() => {
		const preserved = [];
		for (const payload of dedupedPayloads) {
			const next = preserveUnsentMediaAfterBlockStream(payload);
			if (next) preserved.push(next);
		}
		return preserved;
	})() : params.blockStreamingEnabled ? (() => {
		const unsent = [];
		for (const payload of dedupedPayloads) if (!params.blockReplyPipeline?.hasSentPayload(payload) && !isDirectlySentBlockPayload(payload)) unsent.push(payload);
		return unsent;
	})() : params.directlySentBlockKeys?.size ? (() => {
		const unsent = [];
		for (const payload of dedupedPayloads) if (!params.directlySentBlockKeys.has(createBlockReplyContentKey(payload))) unsent.push(payload);
		return unsent;
	})() : previewStreamedText.size > 0 ? suppressPreviewStreamedPayloads(dedupedPayloads) : dedupedPayloads;
	const blockSentMediaUrls = params.blockStreamingEnabled ? await normalizeSentMediaUrlsForDedupe({
		sentMediaUrls: params.blockReplyPipeline?.getSentMediaUrls() ?? [],
		normalizeMediaPaths: params.normalizeMediaPaths
	}) : [];
	const filteredPayloads = blockSentMediaUrls.length > 0 ? (dedupeRuntime ?? await loadReplyPayloadsDedupeRuntime()).filterMessagingToolMediaDuplicates({
		payloads: contentSuppressedPayloads,
		sentMediaUrls: blockSentMediaUrls
	}) : contentSuppressedPayloads;
	const replyPayloads = [];
	for (const payload of filteredPayloads) if (isRenderablePayload(payload)) replyPayloads.push(payload);
	return {
		replyPayloads,
		didLogHeartbeatStrip
	};
}
//#endregion
//#region src/auto-reply/reply/agent-runner-reminder-guard.ts
const UNSCHEDULED_REMINDER_NOTE = "Note: I did not schedule a reminder in this turn, so this will not trigger automatically.";
const REMINDER_COMMITMENT_PATTERNS = [/\b(?:i\s*['’]?ll|i will)\s+(?:make sure to\s+)?(?:remember|remind|ping|follow up|follow-up|check back|circle back)\b/i, /\b(?:i\s*['’]?ll|i will)\s+(?:set|create|schedule)\s+(?:a\s+)?reminder\b/i];
function hasUnbackedReminderCommitment(text) {
	const normalized = normalizeLowercaseStringOrEmpty(text);
	if (!normalized.trim()) return false;
	if (normalized.includes(normalizeLowercaseStringOrEmpty(UNSCHEDULED_REMINDER_NOTE))) return false;
	return REMINDER_COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}
/**
* Returns true when the cron store has at least one enabled job that shares the
* current session key. Used to suppress the "no reminder scheduled" guard note
* when an existing cron (created in a prior turn) already covers the commitment.
*/
async function hasSessionRelatedCronJobs(params) {
	try {
		const store = await loadCronStore(resolveCronStorePath(params.cronStorePath));
		if (store.jobs.length === 0) return false;
		if (params.sessionKey) return store.jobs.some((job) => job.enabled && job.sessionKey === params.sessionKey);
		return false;
	} catch {
		return false;
	}
}
function appendUnscheduledReminderNote(payloads) {
	let appended = false;
	return payloads.map((payload) => {
		if (appended || payload.isError || typeof payload.text !== "string") return payload;
		if (!hasUnbackedReminderCommitment(payload.text)) return payload;
		appended = true;
		const trimmed = payload.text.trimEnd();
		return {
			...payload,
			text: `${trimmed}\n\n${UNSCHEDULED_REMINDER_NOTE}`
		};
	});
}
function isValidReplayTimestamp(value) {
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && value.trim().length > 0;
}
function replayableRole(record) {
	if (!record || record.type !== "message" || typeof record.id !== "string" || record.id.trim().length === 0 || !isValidReplayTimestamp(record.timestamp) || !(record.parentId === null || record.parentId === void 0 || typeof record.parentId === "string")) return;
	const role = record.message?.role;
	return role === "user" || role === "assistant" ? role : void 0;
}
/**
* Copy the tail of user/assistant JSONL records from a prior transcript into a
* freshly-rotated one. Tool, system, and compaction records are skipped so
* replay cannot reshape tool/role ordering, and the tail is aligned and
* coalesced into alternating user/assistant turns so role-ordering resets
* cannot immediately recur. Uses async I/O so long transcripts do not block
* the event loop. Returns 0 on any error.
*/
async function replayRecentUserAssistantMessages(params) {
	const max = Math.max(0, params.maxMessages ?? 6);
	const src = params.sourceTranscript;
	if (max === 0 || !src || !fs.existsSync(src)) return 0;
	try {
		const kept = [];
		for (const line of (await fs$1.readFile(src, "utf-8")).split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const role = replayableRole(JSON.parse(line));
				if (role) kept.push({
					role,
					line
				});
			} catch {}
		}
		if (kept.length === 0) return 0;
		let startIdx = Math.max(0, kept.length - max);
		while (startIdx < kept.length && kept[startIdx].role === "assistant") startIdx += 1;
		if (startIdx === kept.length) return 0;
		const tail = coalesceAlternatingReplayTail(kept.slice(startIdx)).map((entry) => entry.line);
		if (!fs.existsSync(params.targetTranscript)) {
			await fs$1.mkdir(path.dirname(params.targetTranscript), { recursive: true });
			const header = JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: params.newSessionId,
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				cwd: process.cwd()
			});
			await fs$1.writeFile(params.targetTranscript, `${header}\n`, {
				encoding: "utf-8",
				mode: 384
			});
		}
		await fs$1.appendFile(params.targetTranscript, `${tail.join("\n")}\n`, "utf-8");
		return tail.length;
	} catch {
		return 0;
	}
}
function coalesceAlternatingReplayTail(entries) {
	const tail = [];
	for (const entry of entries) {
		const lastIdx = tail.length - 1;
		if (lastIdx >= 0 && tail[lastIdx]?.role === entry.role) {
			tail[lastIdx] = entry;
			continue;
		}
		tail.push(entry);
	}
	return tail;
}
//#endregion
//#region src/auto-reply/reply/agent-runner-session-reset.ts
const deps = {
	generateSecureUuid,
	updateSessionStore,
	refreshQueuedFollowupSession,
	error: (message) => defaultRuntime.error(message)
};
async function resetReplyRunSession(params) {
	if (!params.sessionKey || !params.activeSessionStore || !params.storePath) return false;
	const prevEntry = params.activeSessionStore[params.sessionKey] ?? params.activeSessionEntry;
	if (!prevEntry) return false;
	const prevSessionId = params.options.cleanupTranscripts ? prevEntry.sessionId : void 0;
	const nextSessionId = deps.generateSecureUuid();
	const now = Date.now();
	const nextEntry = {
		...prevEntry,
		sessionId: nextSessionId,
		updatedAt: now,
		sessionStartedAt: now,
		usageFamilyKey: prevEntry.usageFamilyKey ?? params.sessionKey,
		usageFamilySessionIds: Array.from(new Set([
			...prevEntry.usageFamilySessionIds ?? [],
			prevEntry.sessionId,
			nextSessionId
		])),
		lastInteractionAt: now,
		systemSent: false,
		abortedLastRun: false,
		modelProvider: void 0,
		model: void 0,
		inputTokens: void 0,
		outputTokens: void 0,
		totalTokens: void 0,
		totalTokensFresh: false,
		estimatedCostUsd: void 0,
		cacheRead: void 0,
		cacheWrite: void 0,
		contextTokens: void 0,
		systemPromptReport: void 0,
		fallbackNoticeSelectedModel: void 0,
		fallbackNoticeActiveModel: void 0,
		fallbackNoticeReason: void 0,
		continuationChainCount: void 0,
		continuationChainStartedAt: void 0,
		continuationChainTokens: void 0,
		continuationChainId: void 0
	};
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const nextSessionFile = resolveSessionTranscriptPath(nextSessionId, agentId, params.messageThreadId);
	nextEntry.sessionFile = nextSessionFile;
	params.activeSessionStore[params.sessionKey] = nextEntry;
	try {
		await deps.updateSessionStore(params.storePath, (store) => {
			store[params.sessionKey] = nextEntry;
		});
	} catch (err) {
		deps.error(`Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`);
	}
	await replayRecentUserAssistantMessages({
		sourceTranscript: prevEntry.sessionFile,
		targetTranscript: nextSessionFile,
		newSessionId: nextSessionId
	});
	params.followupRun.run.sessionId = nextSessionId;
	params.followupRun.run.sessionFile = nextSessionFile;
	deps.refreshQueuedFollowupSession({
		key: params.queueKey,
		previousSessionId: prevEntry.sessionId,
		nextSessionId,
		nextSessionFile
	});
	params.onActiveSessionEntry(nextEntry);
	params.onNewSession(nextSessionId, nextSessionFile);
	deps.error(params.options.buildLogMessage(nextSessionId));
	if (params.options.cleanupTranscripts && prevSessionId) {
		const transcriptCandidates = /* @__PURE__ */ new Set();
		const resolved = resolveSessionFilePath(prevSessionId, prevEntry, resolveSessionFilePathOptions({
			agentId,
			storePath: params.storePath
		}));
		if (resolved) transcriptCandidates.add(resolved);
		transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
		for (const candidate of transcriptCandidates) try {
			fs.unlinkSync(candidate);
		} catch {}
	}
	return true;
}
//#endregion
//#region src/auto-reply/reply/agent-runner-usage-line.ts
const formatResponseUsageLine = (params) => {
	const usage = params.usage;
	if (!usage) return null;
	const input = usage.input;
	const output = usage.output;
	if (typeof input !== "number" && typeof output !== "number") return null;
	const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
	const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
	const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : void 0;
	const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : void 0;
	const cost = params.showCost && typeof input === "number" && typeof output === "number" ? estimateUsageCost({
		usage: {
			input,
			output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite
		},
		cost: params.costConfig
	}) : void 0;
	const costLabel = params.showCost ? formatUsd(cost) : void 0;
	return `Usage: ${inputLabel} in / ${outputLabel} out${typeof cacheRead === "number" && cacheRead > 0 || typeof cacheWrite === "number" && cacheWrite > 0 ? ` · cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new` : ""}${costLabel ? ` · est ${costLabel}` : ""}`;
};
const appendUsageLine = (payloads, line) => {
	let index = -1;
	for (let i = payloads.length - 1; i >= 0; i -= 1) if (payloads[i]?.text) {
		index = i;
		break;
	}
	if (index === -1) return [...payloads, { text: line }];
	const existing = payloads[index];
	const existingText = existing.text ?? "";
	const separator = existingText.endsWith("\n") ? "" : "\n";
	const next = {
		...existing,
		text: `${existingText}${separator}${line}`
	};
	const updated = payloads.slice();
	updated[index] = next;
	return updated;
};
//#endregion
//#region src/auto-reply/reply/followup-delivery.ts
function hasReplyPayloadMedia(payload) {
	if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) return true;
	return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => url.trim().length > 0);
}
function resolveFollowupDeliveryPayloads(params) {
	const replyMessageProvider = resolveOriginMessageProvider({
		originatingChannel: params.originatingChannel,
		provider: params.messageProvider
	});
	const replyToChannel = replyMessageProvider;
	const replyToMode = resolveReplyToMode(params.cfg, replyToChannel, params.originatingAccountId, params.originatingChatType);
	const sanitizedPayloads = [];
	for (const payload of params.payloads) {
		const text = payload.text;
		if (!text || !text.includes("HEARTBEAT_OK")) {
			sanitizedPayloads.push(payload);
			continue;
		}
		const stripped = stripHeartbeatToken(text, { mode: "message" });
		const hasMedia = hasReplyPayloadMedia(payload);
		if (stripped.shouldSkip && !hasMedia) continue;
		sanitizedPayloads.push({
			...payload,
			text: stripped.text
		});
	}
	const replyTaggedPayloads = applyReplyThreading({
		payloads: sanitizedPayloads,
		replyToMode,
		replyToChannel
	});
	const messagingToolPayloadDedupe = resolveMessagingToolPayloadDedupe({
		messageProvider: replyMessageProvider,
		messagingToolSentTargets: params.sentTargets,
		originatingTo: resolveOriginMessageTo({ originatingTo: params.originatingTo }),
		accountId: resolveOriginAccountId({ originatingAccountId: params.originatingAccountId })
	});
	const sentMediaUrlFallback = params.sentMediaUrls ?? [];
	const sentTextFallback = params.sentTexts ?? [];
	const shouldUseGlobalSentMediaUrlEvidence = messagingToolPayloadDedupe.matchingRoute && messagingToolPayloadDedupe.routeSentMediaUrls.length === 0 && messagingToolPayloadDedupe.useGlobalSentMediaUrlEvidenceFallback;
	const shouldUseGlobalSentTextEvidence = messagingToolPayloadDedupe.matchingRoute && messagingToolPayloadDedupe.routeSentTexts.length === 0 && messagingToolPayloadDedupe.useGlobalSentTextEvidenceFallback;
	const sentMediaUrlsForDedupe = messagingToolPayloadDedupe.matchingRoute ? shouldUseGlobalSentMediaUrlEvidence ? sentMediaUrlFallback : messagingToolPayloadDedupe.routeSentMediaUrls : sentMediaUrlFallback;
	const sentTextsForDedupe = messagingToolPayloadDedupe.matchingRoute ? shouldUseGlobalSentTextEvidence ? sentTextFallback : messagingToolPayloadDedupe.routeSentTexts : sentTextFallback;
	const mediaFilteredPayloads = messagingToolPayloadDedupe.shouldDedupePayloads ? filterMessagingToolMediaDuplicates({
		payloads: replyTaggedPayloads,
		sentMediaUrls: sentMediaUrlsForDedupe
	}) : replyTaggedPayloads;
	return messagingToolPayloadDedupe.shouldDedupePayloads ? filterMessagingToolDuplicates({
		payloads: mediaFilteredPayloads,
		sentTexts: sentTextsForDedupe
	}) : mediaFilteredPayloads;
}
//#endregion
//#region src/auto-reply/reply/typing-mode.ts
const DEFAULT_GROUP_TYPING_MODE = "message";
function resolveTypingMode({ configured, isGroupChat, wasMentioned, isHeartbeat, typingPolicy, suppressTyping, sourceReplyDeliveryMode }) {
	if (isHeartbeat || typingPolicy === "heartbeat" || typingPolicy === "system_event" || typingPolicy === "internal_webchat" || suppressTyping) return "never";
	if (configured) return configured;
	if (sourceReplyDeliveryMode === "message_tool_only") return "instant";
	if (!isGroupChat || wasMentioned) return "instant";
	return DEFAULT_GROUP_TYPING_MODE;
}
function createTypingSignaler(params) {
	const { typing, mode, isHeartbeat } = params;
	const shouldStartImmediately = mode === "instant";
	const shouldStartOnMessageStart = mode === "message";
	const shouldStartOnText = mode === "message" || mode === "instant";
	const shouldStartOnReasoning = mode === "thinking";
	const disabled = isHeartbeat || mode === "never";
	let hasRenderableText = false;
	const isRenderableText = (text) => {
		const trimmed = normalizeOptionalString(text);
		if (!trimmed) return false;
		return !isSilentReplyText(trimmed, SILENT_REPLY_TOKEN);
	};
	const signalRunStart = async () => {
		if (disabled || !shouldStartImmediately) return;
		await typing.startTypingLoop();
	};
	const signalMessageStart = async () => {
		if (disabled || !shouldStartOnMessageStart) return;
		if (!hasRenderableText) return;
		await typing.startTypingLoop();
	};
	const signalTextDelta = async (text) => {
		if (disabled) return;
		if (isRenderableText(text)) hasRenderableText = true;
		else if (normalizeOptionalString(text)) return;
		else return;
		if (shouldStartOnText) {
			await typing.startTypingOnText(text);
			return;
		}
		if (shouldStartOnReasoning) {
			if (!typing.isActive()) await typing.startTypingLoop();
			typing.refreshTypingTtl();
		}
	};
	const signalReasoningDelta = async () => {
		if (disabled || !shouldStartOnReasoning) return;
		if (!hasRenderableText) return;
		await typing.startTypingLoop();
		typing.refreshTypingTtl();
	};
	const signalToolStart = async () => {
		if (disabled) return;
		if (!typing.isActive()) {
			await typing.startTypingLoop();
			typing.refreshTypingTtl();
			return;
		}
		typing.refreshTypingTtl();
	};
	return {
		mode,
		shouldStartImmediately,
		shouldStartOnMessageStart,
		shouldStartOnText,
		shouldStartOnReasoning,
		signalRunStart,
		signalMessageStart,
		signalTextDelta,
		signalReasoningDelta,
		signalToolStart
	};
}
//#endregion
//#region src/auto-reply/reply/followup-runner.ts
function createFollowupRunner(params) {
	const { opts, typing, typingMode, sessionEntry, sessionStore, sessionKey, storePath, defaultModel, agentCfgContextTokens } = params;
	const typingSignals = createTypingSignaler({
		typing,
		mode: typingMode,
		isHeartbeat: opts?.isHeartbeat === true
	});
	/**
	* Sends followup payloads, routing to the originating channel if set.
	*
	* When originatingChannel/originatingTo are set on the queued run,
	* replies are routed directly to that provider instead of using the
	* session's current dispatcher. This ensures replies go back to
	* where the message originated.
	*/
	const sendFollowupPayloads = async (payloads, queued, resolvedRun) => {
		const { originatingChannel, originatingTo } = queued;
		const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
		const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
		const deliveryPlan = buildAgentRuntimeDeliveryPlan({
			provider: resolvedRun.provider,
			modelId: resolvedRun.modelId,
			config: runtimeConfig,
			workspaceDir: queued.run.workspaceDir,
			agentDir: queued.run.agentDir
		});
		const sendablePayloads = payloads.filter((payload) => hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload));
		if (sendablePayloads.length === 0) return;
		if (!shouldRouteToOriginating && !opts?.onBlockReply) {
			defaultRuntime.error?.("followup queue: completed with payloads but no origin route or visible dispatcher is available");
			return;
		}
		let crossChannelRouteFailureNeedsNotice = false;
		let routedAnyCrossChannelPayloadToOrigin = false;
		for (const payload of sendablePayloads) {
			const providerRoute = deliveryPlan.resolveFollowupRoute({
				payload,
				originatingChannel,
				originatingTo,
				originRoutable: Boolean(shouldRouteToOriginating),
				dispatcherAvailable: Boolean(opts?.onBlockReply)
			});
			if (providerRoute?.route === "drop") {
				logVerbose(`followup queue: provider hook dropped payload route reason=${providerRoute.reason ?? "unspecified"}`);
				continue;
			}
			const deliveryRoute = providerRoute?.route === "origin" && shouldRouteToOriginating ? "origin" : providerRoute?.route === "dispatcher" && opts?.onBlockReply ? "dispatcher" : shouldRouteToOriginating ? "origin" : opts?.onBlockReply ? "dispatcher" : void 0;
			await typingSignals.signalTextDelta(payload.text);
			if (deliveryRoute === "origin" && isRoutableChannel(originatingChannel) && originatingTo) {
				const result = await routeReply({
					payload,
					channel: originatingChannel,
					to: originatingTo,
					sessionKey: queued.run.sessionKey,
					accountId: queued.originatingAccountId,
					requesterSenderId: queued.run.senderId,
					requesterSenderName: queued.run.senderName,
					requesterSenderUsername: queued.run.senderUsername,
					requesterSenderE164: queued.run.senderE164,
					threadId: queued.originatingThreadId,
					cfg: runtimeConfig
				});
				if (!result.ok) {
					const errorMsg = result.error ?? "unknown error";
					logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
					const provider = resolveOriginMessageProvider({ provider: queued.run.messageProvider });
					const origin = resolveOriginMessageProvider({ originatingChannel });
					if (opts?.onBlockReply) if (origin && origin === provider) await opts.onBlockReply(payload);
					else crossChannelRouteFailureNeedsNotice = true;
					else defaultRuntime.error?.(`followup queue: route-reply failed: ${errorMsg}`);
				} else {
					const provider = resolveOriginMessageProvider({ provider: queued.run.messageProvider });
					const origin = resolveOriginMessageProvider({ originatingChannel });
					if (origin && provider && origin !== provider) routedAnyCrossChannelPayloadToOrigin = true;
				}
			} else if (deliveryRoute === "dispatcher" && opts?.onBlockReply) await opts.onBlockReply(payload);
		}
		if (crossChannelRouteFailureNeedsNotice && !routedAnyCrossChannelPayloadToOrigin && opts?.onBlockReply) await opts.onBlockReply({
			text: "Follow-up completed, but OpenClaw could not deliver it to the originating channel. The reply content was not forwarded to this channel to avoid cross-channel misdelivery.",
			isError: true
		});
	};
	return async (queued) => {
		if (isFollowupRunAborted(queued)) {
			completeFollowupRunLifecycle(queued);
			typing.markRunComplete();
			typing.markDispatchIdle();
			return;
		}
		const endDeliveryCorrelations = (queued.deliveryCorrelations ?? []).map((correlation) => correlation.begin()).filter((end) => typeof end === "function");
		const queuedImages = queued.images ?? opts?.images;
		const queuedImageOrder = queued.imageOrder ?? opts?.imageOrder;
		let replyOperation;
		try {
			queued.run.config = await resolveQueuedReplyExecutionConfig(queued.run.config, {
				originatingChannel: queued.originatingChannel,
				messageProvider: queued.run.messageProvider,
				originatingAccountId: queued.originatingAccountId,
				agentAccountId: queued.run.agentAccountId
			});
			const replySessionKey = queued.run.sessionKey ?? sessionKey;
			const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
			let effectiveQueued = runtimeConfig === queued.run.config ? queued : {
				...queued,
				run: {
					...queued.run,
					config: runtimeConfig
				}
			};
			let run = effectiveQueued.run;
			let activeSessionEntry = (replySessionKey ? sessionStore?.[replySessionKey] : void 0) ?? (replySessionKey === sessionKey ? sessionEntry : void 0);
			run = resolveRunAfterAutoFallbackPrimaryProbeRecheck({
				run,
				entry: activeSessionEntry,
				sessionKey: replySessionKey
			});
			if (run !== effectiveQueued.run) effectiveQueued = {
				...effectiveQueued,
				run
			};
			replyOperation = createReplyOperation({
				sessionId: run.sessionId,
				sessionKey: replySessionKey ?? "",
				resetTriggered: false,
				upstreamAbortSignal: queued.abortSignal ?? opts?.abortSignal
			});
			const runId = crypto.randomUUID();
			const shouldSurfaceToControlUi = isInternalMessageChannel(resolveOriginMessageProvider({
				originatingChannel: queued.originatingChannel,
				provider: run.messageProvider
			}));
			if (run.sessionKey) registerAgentRunContext(runId, {
				sessionKey: run.sessionKey,
				verboseLevel: run.verboseLevel,
				isControlUiVisible: shouldSurfaceToControlUi
			});
			let autoCompactionCount = 0;
			let runResult;
			let fallbackProvider = run.provider;
			let fallbackModel = run.model;
			activeSessionEntry = await runPreflightCompactionIfNeeded({
				cfg: runtimeConfig,
				followupRun: effectiveQueued,
				promptForEstimate: queued.prompt,
				defaultModel,
				agentCfgContextTokens,
				sessionEntry: activeSessionEntry,
				sessionStore,
				sessionKey: replySessionKey,
				storePath,
				isHeartbeat: opts?.isHeartbeat === true,
				replyOperation
			});
			let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(activeSessionEntry?.systemPromptReport);
			const resolveRunForFallbackCandidate = (provider, model) => {
				const probe = run.autoFallbackPrimaryProbe;
				const isPrimaryProbeCandidate = probe && provider === probe.provider && model === probe.model;
				if (probe && provider === probe.fallbackProvider && !isPrimaryProbeCandidate && probe.fallbackAuthProfileId) {
					const candidateRun = {
						...run,
						provider,
						model,
						authProfileId: probe.fallbackAuthProfileId
					};
					if (probe.fallbackAuthProfileIdSource) candidateRun.authProfileIdSource = probe.fallbackAuthProfileIdSource;
					else delete candidateRun.authProfileIdSource;
					return candidateRun;
				}
				return run;
			};
			const clearRecoveredAutoFallbackPrimaryProbe = async (paramsForClear) => {
				const probe = run.autoFallbackPrimaryProbe;
				if (!probe) return;
				if (paramsForClear.provider !== probe.provider || paramsForClear.model !== probe.model) return;
				if (!replySessionKey || !sessionStore) return;
				const entry = sessionStore[replySessionKey] ?? activeSessionEntry;
				if (!entry || !entryMatchesAutoFallbackPrimaryProbe(entry, probe)) return;
				clearAutoFallbackPrimaryProbeSelection(entry);
				sessionStore[replySessionKey] = entry;
				activeSessionEntry = entry;
				if (!storePath) return;
				await updateSessionStore(storePath, (store) => {
					const persistedEntry = store[replySessionKey];
					if (!persistedEntry) return;
					if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) return;
					clearAutoFallbackPrimaryProbeSelection(persistedEntry);
					store[replySessionKey] = persistedEntry;
				});
			};
			fallbackProvider = run.provider;
			fallbackModel = run.model;
			replyOperation.setPhase("running");
			let pendingDeferredCliTerminal;
			try {
				const outcomePlan = buildAgentRuntimeOutcomePlan();
				const fallbackResult = await runWithModelFallback({
					...resolveModelFallbackOptions(run, runtimeConfig),
					cfg: runtimeConfig,
					runId,
					classifyResult: ({ result, provider, model }) => outcomePlan.classifyRunResult({
						result,
						provider,
						model
					}),
					run: async (provider, model, runOptions) => {
						const candidateRun = resolveRunForFallbackCandidate(provider, model);
						const activeProbe = run.autoFallbackPrimaryProbe;
						if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) markAutoFallbackPrimaryProbe({
							probe: activeProbe,
							sessionKey: replySessionKey
						});
						const authProfile = resolveRunAuthProfile(candidateRun, provider, { config: runtimeConfig });
						const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
							provider,
							entry: activeSessionEntry
						});
						const cliExecutionProvider = sessionRuntimeOverride === "pi" ? provider : (sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig) ? sessionRuntimeOverride : void 0) ?? resolveCliRuntimeExecutionProvider({
							provider,
							cfg: runtimeConfig,
							agentId: run.agentId,
							modelId: model
						}) ?? provider;
						let attemptCompactionCount = 0;
						try {
							if (isCliProvider(cliExecutionProvider, runtimeConfig)) {
								const isRoomEventCliRun = queued.currentInboundEventKind === "room_event";
								const cliSessionBinding = isRoomEventCliRun ? void 0 : getCliSessionBinding(activeSessionEntry, cliExecutionProvider);
								const cliLifecycleStartedAt = Date.now();
								pendingDeferredCliTerminal = {
									provider,
									model,
									startedAt: cliLifecycleStartedAt
								};
								const result = await runCliAgentWithLifecycle({
									runId,
									provider: cliExecutionProvider,
									startedAt: cliLifecycleStartedAt,
									emitLifecycleTerminal: false,
									onAgentRunStart: () => opts?.onAgentRunStart?.(runId),
									suppressAssistantBridge: run.silentExpected,
									runParams: {
										replyOperation,
										sessionId: run.sessionId,
										sessionKey: replySessionKey,
										agentId: run.agentId,
										trigger: opts?.isHeartbeat === true ? "heartbeat" : "user",
										sessionFile: run.sessionFile,
										workspaceDir: run.workspaceDir,
										config: runtimeConfig,
										prompt: queued.prompt,
										transcriptPrompt: queued.transcriptPrompt,
										currentInboundEventKind: queued.currentInboundEventKind,
										currentInboundContext: queued.currentInboundContext,
										inputProvenance: run.inputProvenance,
										provider: cliExecutionProvider,
										model,
										...resolveRunAuthProfile(candidateRun, cliExecutionProvider, { config: runtimeConfig }),
										thinkLevel: run.thinkLevel,
										timeoutMs: run.timeoutMs,
										runId,
										extraSystemPrompt: run.extraSystemPrompt,
										sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
										silentReplyPromptMode: run.silentReplyPromptMode,
										extraSystemPromptStatic: run.extraSystemPromptStatic,
										ownerNumbers: run.ownerNumbers,
										cliSessionId: cliSessionBinding?.sessionId,
										cliSessionBinding,
										bootstrapPromptWarningSignaturesSeen,
										bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
										images: queuedImages,
										imageOrder: queuedImageOrder,
										skillsSnapshot: run.skillsSnapshot,
										messageChannel: queued.originatingChannel ?? void 0,
										messageProvider: resolveOriginMessageProvider({
											originatingChannel: queued.originatingChannel,
											provider: run.messageProvider
										}),
										agentAccountId: run.agentAccountId,
										senderIsOwner: run.senderIsOwner,
										disableTools: opts?.disableTools,
										abortSignal: queued.abortSignal ?? opts?.abortSignal
									},
									transformResult: (rawResult) => isRoomEventCliRun && rawResult.meta.agentMeta ? (() => {
										const { cliSessionBinding: _cliSessionBinding, ...agentMeta } = rawResult.meta.agentMeta;
										return {
											...rawResult,
											meta: {
												...rawResult.meta,
												agentMeta: {
													...agentMeta,
													sessionId: ""
												}
											}
										};
									})() : rawResult
								});
								bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
								return result;
							}
							pendingDeferredCliTerminal = void 0;
							const result = await runEmbeddedPiAgent({
								allowGatewaySubagentBinding: true,
								replyOperation,
								sessionId: run.sessionId,
								sessionKey: run.sessionKey,
								agentId: run.agentId,
								trigger: "user",
								fireReason: resolveReplyRunFireReason({
									opts,
									drainsContinuationDelegateQueue: run.drainsContinuationDelegateQueue === true
								}),
								parentRunId: opts?.parentRunId,
								messageChannel: queued.originatingChannel ?? void 0,
								messageProvider: run.messageProvider,
								agentAccountId: run.agentAccountId,
								messageTo: queued.originatingTo,
								messageThreadId: queued.originatingThreadId,
								currentChannelId: queued.originatingTo,
								currentThreadTs: queued.originatingThreadId != null ? String(queued.originatingThreadId) : void 0,
								groupId: run.groupId,
								groupChannel: run.groupChannel,
								groupSpace: run.groupSpace,
								senderId: run.senderId,
								senderName: run.senderName,
								senderUsername: run.senderUsername,
								senderE164: run.senderE164,
								senderIsOwner: run.senderIsOwner,
								sessionFile: run.sessionFile,
								agentDir: run.agentDir,
								workspaceDir: run.workspaceDir,
								config: runtimeConfig,
								skillsSnapshot: run.skillsSnapshot,
								prompt: queued.prompt,
								transcriptPrompt: queued.transcriptPrompt,
								currentInboundEventKind: queued.currentInboundEventKind,
								currentInboundContext: queued.currentInboundContext,
								extraSystemPrompt: run.extraSystemPrompt,
								silentReplyPromptMode: run.silentReplyPromptMode,
								sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
								forceMessageTool: run.sourceReplyDeliveryMode === "message_tool_only",
								suppressNextUserMessagePersistence: run.suppressNextUserMessagePersistence,
								suppressTranscriptOnlyAssistantPersistence: run.suppressTranscriptOnlyAssistantPersistence,
								ownerNumbers: run.ownerNumbers,
								enforceFinalTag: run.enforceFinalTag,
								allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
								provider,
								model,
								...authProfile,
								thinkLevel: run.thinkLevel,
								verboseLevel: run.verboseLevel,
								reasoningLevel: run.reasoningLevel,
								suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
								execOverrides: run.execOverrides,
								bashElevated: run.bashElevated,
								timeoutMs: run.timeoutMs,
								runId,
								abortSignal: queued.abortSignal ?? opts?.abortSignal,
								images: queuedImages,
								imageOrder: queuedImageOrder,
								allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
								blockReplyBreak: run.blockReplyBreak,
								bootstrapPromptWarningSignaturesSeen,
								bootstrapPromptWarningSignature: bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
								requestCompactionOpts: runtimeConfig?.agents?.defaults?.continuation?.enabled === true ? {
									sessionId: run.sessionId,
									getContextUsage: () => {
										return null;
									},
									triggerCompaction: async (request) => {
										try {
											const { compactEmbeddedPiSession } = await import("./compact.queued-DUHZjYWw.js");
											const compactionAuthProfileId = provider === run.provider ? run.authProfileId : void 0;
											const result = await compactEmbeddedPiSession({
												sessionId: run.sessionId ?? "",
												runId: request.runId ?? runId,
												sessionKey: run.sessionKey,
												sessionFile: run.sessionFile ?? "",
												workspaceDir: run.workspaceDir ?? process.cwd(),
												messageProvider: run.messageProvider,
												provider,
												model,
												authProfileId: compactionAuthProfileId,
												trigger: request.trigger,
												diagId: request.diagId,
												traceparent: request.traceparent
											});
											return {
												ok: result.ok,
												compacted: result.compacted,
												reason: result.reason
											};
										} catch (err) {
											return {
												ok: false,
												compacted: false,
												reason: err instanceof Error ? err.message : String(err)
											};
										}
									}
								} : void 0,
								onAgentEvent: (evt) => {
									if (evt.stream !== "compaction") return;
									const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
									const completed = evt.data?.completed === true;
									if (phase === "end" && completed) attemptCompactionCount += 1;
								}
							});
							bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(result.meta?.systemPromptReport);
							const resultCompactionCount = Math.max(0, result.meta?.agentMeta?.compactionCount ?? 0);
							attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
							return result;
						} finally {
							autoCompactionCount += attemptCompactionCount;
						}
					}
				});
				runResult = fallbackResult.result;
				fallbackProvider = fallbackResult.provider;
				fallbackModel = fallbackResult.model;
				if (pendingDeferredCliTerminal && pendingDeferredCliTerminal.provider === fallbackProvider && pendingDeferredCliTerminal.model === fallbackModel) emitAgentEvent({
					runId,
					stream: "lifecycle",
					data: {
						phase: "end",
						startedAt: pendingDeferredCliTerminal.startedAt,
						endedAt: Date.now()
					}
				});
				pendingDeferredCliTerminal = void 0;
				await clearRecoveredAutoFallbackPrimaryProbe({
					provider: fallbackProvider,
					model: fallbackModel
				});
			} catch (err) {
				const message = formatErrorMessage(err);
				replyOperation.fail("run_failed", err);
				if (pendingDeferredCliTerminal) {
					emitAgentEvent({
						runId,
						stream: "lifecycle",
						data: {
							phase: "error",
							startedAt: pendingDeferredCliTerminal.startedAt,
							endedAt: Date.now(),
							error: message
						}
					});
					pendingDeferredCliTerminal = void 0;
				}
				defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
				return;
			}
			if (runtimeConfig?.agents?.defaults?.continuation?.enabled === true && sessionKey) {
				const [{ dispatchToolDelegates }, { resolveLiveContinuationRuntimeConfig }, { loadContinuationChainState, persistContinuationChainState }, { updateSessionStore, resolveSessionStoreEntry }] = await Promise.all([
					import("./delegate-dispatch-B2yXO7fH.js"),
					import("./config-BVO-Yxff.js"),
					import("./state-432R9vCc.js"),
					import("./store-fxUW98QN.js")
				]);
				const tailUsage = runResult.meta?.agentMeta?.usage;
				const turnTokens = (tailUsage?.input ?? 0) + (tailUsage?.output ?? 0);
				const tailEntry = (sessionKey ? sessionStore?.[sessionKey] : void 0) ?? sessionEntry;
				const dispatchResult = await dispatchToolDelegates({
					sessionKey,
					chainState: loadContinuationChainState(tailEntry, turnTokens),
					ctx: {
						sessionKey,
						agentChannel: queued.originatingChannel ?? void 0,
						agentAccountId: queued.originatingAccountId ?? void 0,
						agentTo: queued.originatingTo ?? void 0,
						agentThreadId: queued.originatingThreadId ?? void 0
					},
					maxChainLength: resolveLiveContinuationRuntimeConfig(runtimeConfig).maxChainLength,
					loadFreshChainState: () => loadContinuationChainState(tailEntry, 0)
				});
				if (dispatchResult && tailEntry) {
					persistContinuationChainState({
						sessionEntry: tailEntry,
						count: dispatchResult.chainState.currentChainCount,
						startedAt: dispatchResult.chainState.chainStartedAt,
						tokens: dispatchResult.chainState.accumulatedChainTokens
					});
					if (storePath && sessionKey) try {
						await updateSessionStore(storePath, (store) => {
							const resolved = resolveSessionStoreEntry({
								store,
								sessionKey
							});
							if (resolved.existing) {
								store[resolved.normalizedKey] = {
									...resolved.existing,
									continuationChainCount: dispatchResult.chainState.currentChainCount,
									continuationChainStartedAt: dispatchResult.chainState.chainStartedAt,
									continuationChainTokens: dispatchResult.chainState.accumulatedChainTokens
								};
								for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
							}
						});
					} catch (err) {
						defaultRuntime.error?.(`[followup-runner] failed to persist continuation chain state for ${sessionKey}: ${String(err)}`);
					}
				}
			}
			const usage = runResult.meta?.agentMeta?.usage;
			const promptTokens = runResult.meta?.agentMeta?.promptTokens;
			const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
			const providerUsed = runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? queued.run.provider;
			const contextTokensUsed = resolveContextTokensForModel({
				cfg: queued.run.config,
				provider: providerUsed,
				model: modelUsed,
				contextTokensOverride: agentCfgContextTokens,
				fallbackContextTokens: activeSessionEntry?.contextTokens ?? 2e5,
				allowAsyncLoad: false
			}) ?? 2e5;
			if (storePath && replySessionKey) await persistRunSessionUsage({
				storePath,
				sessionKey: replySessionKey,
				cfg: runtimeConfig,
				usage,
				lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
				promptTokens,
				isHeartbeat: opts?.isHeartbeat === true,
				modelUsed,
				providerUsed,
				contextTokensUsed,
				systemPromptReport: runResult.meta?.systemPromptReport,
				cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
				logLabel: "followup"
			});
			const payloadArray = runResult.payloads ?? [];
			if (payloadArray.length === 0) return;
			const finalPayloads = resolveFollowupDeliveryPayloads({
				cfg: runtimeConfig,
				payloads: payloadArray,
				messageProvider: run.messageProvider,
				originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
				originatingChannel: queued.originatingChannel,
				originatingChatType: queued.originatingChatType,
				originatingTo: queued.originatingTo,
				sentMediaUrls: runResult.messagingToolSentMediaUrls,
				sentTargets: runResult.messagingToolSentTargets,
				sentTexts: runResult.messagingToolSentTexts
			});
			if (finalPayloads.length === 0) return;
			let deliveryPayloads = finalPayloads;
			if (autoCompactionCount > 0) {
				const previousSessionId = run.sessionId;
				const count = await incrementRunCompactionCount({
					cfg: runtimeConfig,
					sessionEntry: activeSessionEntry,
					sessionStore,
					sessionKey: replySessionKey,
					storePath,
					amount: autoCompactionCount,
					compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
					lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
					contextTokensUsed,
					newSessionId: runResult.meta?.agentMeta?.sessionId,
					newSessionFile: runResult.meta?.agentMeta?.sessionFile
				});
				const refreshedSessionEntry = replySessionKey && sessionStore ? sessionStore[replySessionKey] : void 0;
				if (refreshedSessionEntry) {
					const queueKey = run.sessionKey ?? sessionKey;
					if (queueKey) refreshQueuedFollowupSession({
						key: queueKey,
						previousSessionId,
						nextSessionId: refreshedSessionEntry.sessionId,
						nextSessionFile: refreshedSessionEntry.sessionFile
					});
				}
				if (run.verboseLevel && run.verboseLevel !== "off") deliveryPayloads = [{ text: `🧹 Auto-compaction complete${typeof count === "number" ? ` (count ${count})` : ""}.` }, ...finalPayloads];
			}
			if (run.sourceReplyDeliveryMode === "message_tool_only") {
				logVerbose("followup queue: automatic source delivery suppressed by sourceReplyDeliveryMode: message_tool_only");
				return;
			}
			await sendFollowupPayloads(deliveryPayloads, effectiveQueued, {
				provider: providerUsed,
				modelId: modelUsed
			});
		} finally {
			for (const end of endDeliveryCorrelations.toReversed()) try {
				end();
			} catch (err) {
				defaultRuntime.error?.(`followup queue: delivery correlation cleanup failed: ${formatErrorMessage(err)}`);
			}
			completeFollowupRunLifecycle(queued);
			replyOperation?.complete();
			typing.markRunComplete();
			typing.markDispatchIdle();
		}
	};
}
//#endregion
//#region src/auto-reply/reply/pending-tool-task-drain.ts
const DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS = 3e4;
function createIdleTimeoutPromise(timeoutMs) {
	let timeoutId;
	return {
		promise: new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
			timeoutId.unref?.();
		}),
		clear: () => {
			if (timeoutId) clearTimeout(timeoutId);
		}
	};
}
async function drainPendingToolTasks({ tasks, idleTimeoutMs = DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS, onTimeout }) {
	if (tasks.size === 0) return { kind: "settled" };
	if (idleTimeoutMs <= 0) return {
		kind: "timeout",
		remaining: tasks.size
	};
	while (tasks.size > 0) {
		const snapshot = [...tasks];
		const timeout = createIdleTimeoutPromise(idleTimeoutMs);
		const outcome = await Promise.race([timeout.promise, ...snapshot.map((task) => task.then(() => ({
			kind: "settled",
			task
		}), () => ({
			kind: "settled",
			task
		})))]);
		timeout.clear();
		if (outcome === "timeout") {
			const remaining = tasks.size;
			onTimeout?.(`pending tool tasks made no progress within ${idleTimeoutMs}ms; proceeding with ${remaining} task(s) still pending to avoid session deadlock`);
			return {
				kind: "timeout",
				remaining
			};
		}
		tasks.delete(outcome.task);
	}
	return { kind: "settled" };
}
//#endregion
//#region src/auto-reply/reply/queue-policy.ts
function resolveActiveRunQueueAction(params) {
	if (!params.isActive) return "run-now";
	if (params.isHeartbeat) return "drop";
	if (params.resetTriggered) return "run-now";
	if (params.shouldFollowup) return "enqueue-followup";
	return "run-now";
}
//#endregion
//#region src/auto-reply/reply/agent-runner.ts
const BLOCK_REPLY_SEND_TIMEOUT_MS = 15e3;
function markBeforeAgentRunBlockedPayloads(payloads) {
	return payloads.map((payload) => setReplyPayloadMetadata(payload, { beforeAgentRunBlocked: true }));
}
function buildSilentFallbackFailurePayload(params) {
	if (params.isHeartbeat || params.allowEmptyAssistantReplyAsSilent === true || params.silentExpected === true || params.hasSuccessfulSideEffectDelivery || !params.fallbackTransition.fallbackActive || !params.fallbackFailureKnown) return;
	return markReplyPayloadForSourceSuppressionDelivery({
		text: `⚠️ I couldn't reach the configured model backend ${params.fallbackTransition.selectedModelRef}. Fallback used ${params.fallbackTransition.activeModelRef}, but it produced no visible reply.`,
		isError: true
	});
}
function hasNonEmptyStringArray(value) {
	return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
}
function hasCommittedMessagingTargetDeliveryEvidence(value) {
	if (!Array.isArray(value)) return false;
	return value.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const record = entry;
		if ("text" in record || "mediaUrls" in record) return typeof record.text === "string" && record.text.trim().length > 0 || hasNonEmptyStringArray(record.mediaUrls);
		return true;
	});
}
function hasSuccessfulSideEffectDelivery(params) {
	return params.blockReplyPipeline?.didStream() && !params.blockReplyPipeline.isAborted() || (params.directlySentBlockKeys?.size ?? 0) > 0 || hasNonEmptyStringArray(params.messagingToolSentTexts) || hasNonEmptyStringArray(params.messagingToolSentMediaUrls) || hasCommittedMessagingTargetDeliveryEvidence(params.messagingToolSentTargets) || (params.successfulCronAdds ?? 0) > 0 || params.didSendDeterministicApprovalPrompt === true;
}
function resolveConfiguredFallbackModel(params) {
	const entry = params.fallbackStateEntry;
	if ((entry?.modelOverrideSource === "auto" || entry !== void 0 && entry.modelOverrideSource === void 0 && hasSessionAutoModelFallbackProvenance(entry)) && entry !== void 0) {
		const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
		const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
		if (originProvider && originModel) return {
			provider: originProvider,
			model: originModel,
			persistedAutoFallback: true
		};
	}
	return {
		provider: params.run.provider,
		model: params.run.model,
		persistedAutoFallback: false
	};
}
function buildInlinePluginStatusPayload(params) {
	const statusLines = params.entry?.verboseLevel && params.entry.verboseLevel !== "off" ? resolveSessionPluginStatusLines(params.entry) : [];
	const traceLines = params.includeTraceLines && (params.entry?.traceLevel === "on" || params.entry?.traceLevel === "raw") ? resolveSessionPluginTraceLines(params.entry) : [];
	const lines = [...statusLines, ...traceLines];
	if (lines.length === 0) return;
	return { text: lines.join("\n") };
}
function formatRawTraceBlock(title, value) {
	return `🔎 ${title}:\n~~~text\n${value?.trim() ? escapeTraceFence(value) : "<empty>"}\n~~~`;
}
function escapeTraceFence(value) {
	return value.replace(/^~~~/gm, "\\~~~");
}
function hasTraceUsageFields(usage) {
	if (!usage) return false;
	return [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"total"
	].some((key) => {
		const value = usage[key];
		return typeof value === "number" && Number.isFinite(value);
	});
}
function formatTraceUsageLine(label, value) {
	return `${label}=${typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()} tok (${formatTokenCount(value)})` : "n/a"}`;
}
function formatUsageTraceBlock(title, usage) {
	if (!hasTraceUsageFields(usage)) return;
	return `🔎 ${title}:\n~~~text\n${[
		formatTraceUsageLine("input", usage?.input),
		formatTraceUsageLine("output", usage?.output),
		formatTraceUsageLine("cacheRead", usage?.cacheRead),
		formatTraceUsageLine("cacheWrite", usage?.cacheWrite),
		formatTraceUsageLine("total", usage?.total)
	].join("\n")}\n~~~`;
}
function formatTraceScalar(value) {
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : void 0;
	return normalizeOptionalString(value) ?? void 0;
}
function formatKeyValueTraceBlock(title, fields) {
	const lines = fields.flatMap(([key, rawValue]) => {
		const value = formatTraceScalar(rawValue);
		return value ? [`${key}=${value}`] : [];
	});
	if (lines.length === 0) return;
	return `🔎 ${title}:\n~~~text\n${lines.join("\n")}\n~~~`;
}
function inferFallbackAttemptResult(attempt) {
	if (attempt.reason === "timeout") return "timeout";
	return "candidate_failed";
}
function mergeExecutionTrace(params) {
	const attempts = [...(params.fallbackAttempts ?? []).map((attempt) => Object.assign({
		provider: attempt.provider,
		model: attempt.model,
		result: inferFallbackAttemptResult(attempt)
	}, attempt.reason ? { reason: attempt.reason } : {}, typeof attempt.status === `number` ? { status: attempt.status } : {})), ...params.executionTrace?.attempts ?? []];
	const winnerProvider = params.executionTrace?.winnerProvider ?? normalizeOptionalString(params.provider);
	const winnerModel = params.executionTrace?.winnerModel ?? normalizeOptionalString(params.model);
	if (winnerProvider && winnerModel && !attempts.some((attempt) => attempt.provider === winnerProvider && attempt.model === winnerModel && attempt.result === "success")) attempts.push({
		provider: winnerProvider,
		model: winnerModel,
		result: "success"
	});
	if (!winnerProvider && !winnerModel && attempts.length === 0) return;
	const fallbackAttemptCount = params.fallbackAttempts?.length ?? 0;
	const traceFallbackUsed = params.executionTrace?.fallbackUsed;
	return {
		winnerProvider,
		winnerModel,
		attempts: attempts.length > 0 ? attempts : void 0,
		fallbackUsed: traceFallbackUsed === true || fallbackAttemptCount > 0 || traceFallbackUsed === void 0 && attempts.length > 1,
		runner: params.executionTrace?.runner ?? params.runner
	};
}
function formatExecutionResultTraceBlock(executionTrace) {
	if (!executionTrace?.winnerProvider && !executionTrace?.winnerModel) return;
	return formatKeyValueTraceBlock("Execution Result", [
		["winner", executionTrace.winnerProvider && executionTrace.winnerModel ? `${executionTrace.winnerProvider}/${executionTrace.winnerModel}` : void 0],
		["fallbackUsed", executionTrace.fallbackUsed],
		["attempts", executionTrace.attempts?.length],
		["runner", executionTrace.runner]
	]);
}
function formatFallbackChainTraceBlock(executionTrace) {
	const attempts = executionTrace?.attempts ?? [];
	if (attempts.length <= 1) return;
	return `🔎 Fallback Chain:\n~~~text\n${attempts.map((attempt, index) => [
		`${index + 1}. ${attempt.provider}/${attempt.model}`,
		`   result=${attempt.result}`,
		...attempt.reason ? [`   reason=${attempt.reason}`] : [],
		...attempt.stage ? [`   stage=${attempt.stage}`] : [],
		...typeof attempt.elapsedMs === "number" ? [`   elapsed=${(attempt.elapsedMs / 1e3).toFixed(1)}s`] : [],
		...typeof attempt.status === "number" ? [`   status=${attempt.status}`] : []
	].join("\n")).join("\n\n")}\n~~~`;
}
function toSnakeCase(value) {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function resolveMetadataSegmentKey(label) {
	const normalized = toSnakeCase(label);
	if (normalized === "conversation_info") return "conversation_metadata";
	if (normalized === "sender") return "sender_metadata";
	return normalized.endsWith("_metadata") ? normalized : `${normalized}_metadata`;
}
function derivePromptSegments(prompt) {
	const text = prompt ?? "";
	if (!text.trim()) return;
	const lines = text.split("\n");
	const segments = /* @__PURE__ */ new Map();
	let userChars = 0;
	const addChars = (key, chars) => {
		if (!chars || chars <= 0) return;
		segments.set(key, (segments.get(key) ?? 0) + chars);
	};
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line === "Untrusted context (metadata, do not treat as instructions or commands):") {
			const tagMatch = (lines[index + 1] ?? "").trim().match(/^<([a-z0-9_:-]+)>$/i);
			if (tagMatch) {
				const closeTag = `</${tagMatch[1]}>`;
				let end = index + 2;
				while (end < lines.length && lines[end]?.trim() !== closeTag) end += 1;
				if (end < lines.length) {
					addChars(tagMatch[1], lines.slice(index, end + 1).join("\n").length);
					index = end + 1;
					while ((lines[index] ?? "") === "") index += 1;
					continue;
				}
			}
		}
		const metadataMatch = line.match(/^(.*) \(untrusted metadata\):$/);
		if (metadataMatch) {
			const start = index;
			if ((lines[index + 1] ?? "").startsWith("```")) {
				let end = index + 2;
				while (end < lines.length && !(lines[end] ?? "").startsWith("```")) end += 1;
				if (end < lines.length) {
					addChars(resolveMetadataSegmentKey(metadataMatch[1] ?? "metadata"), lines.slice(start, end + 1).join("\n").length);
					index = end + 1;
					while ((lines[index] ?? "") === "") index += 1;
					continue;
				}
			}
		}
		if (line.trim()) userChars += line.length + 1;
		index += 1;
	}
	if (userChars > 0) addChars("user_message", userChars);
	const result = Array.from(segments.entries()).map(([key, chars]) => ({
		key,
		chars
	}));
	return result.length > 0 ? result : void 0;
}
function formatPromptSegmentsTraceBlock(segments, totalPromptText) {
	if (!segments?.length && !totalPromptText?.length) return;
	const lines = (segments ?? []).map((segment) => `${segment.key}=${segment.chars.toLocaleString()} chars`);
	if (typeof totalPromptText === "string" && totalPromptText.length > 0) lines.push(`totalPromptText=${totalPromptText.length.toLocaleString()} chars`);
	return lines.length > 0 ? `🔎 Prompt Segments:\n~~~text\n${lines.join("\n")}\n~~~` : void 0;
}
function formatToolSummaryTraceBlock(toolSummary) {
	if (!toolSummary || toolSummary.calls <= 0) return;
	return formatKeyValueTraceBlock("Tool Summary", [
		["calls", toolSummary.calls],
		["tools", toolSummary.tools.length > 0 ? toolSummary.tools.join(", ") : void 0],
		["failures", toolSummary.failures],
		["totalToolTimeMs", toolSummary.totalToolTimeMs]
	]);
}
function formatCompletionTraceBlock(completion) {
	if (!completion) return;
	return formatKeyValueTraceBlock("Completion", [
		["finishReason", completion.finishReason],
		["stopReason", completion.stopReason],
		["refusal", completion.refusal]
	]);
}
function formatContextManagementTraceBlock(contextManagement) {
	if (!contextManagement) return;
	return formatKeyValueTraceBlock("Context Management", [
		["sessionCompactions", contextManagement.sessionCompactions],
		["lastTurnCompactions", contextManagement.lastTurnCompactions],
		["preflightCompactionApplied", contextManagement.preflightCompactionApplied],
		["postCompactionContextInjected", contextManagement.postCompactionContextInjected]
	]);
}
async function accumulateSessionUsageFromTranscript(params) {
	const sessionId = normalizeOptionalString(params.sessionId);
	if (!sessionId) return;
	try {
		const candidates = resolveSessionTranscriptCandidates(sessionId, params.storePath, params.sessionFile);
		let transcriptText;
		for (const candidate of candidates) try {
			transcriptText = await fs$1.readFile(candidate, "utf-8");
			break;
		} catch {
			continue;
		}
		if (!transcriptText) return;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let sawUsage = false;
		for (const line of transcriptText.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const message = parsed?.message;
			if (!message) continue;
			const usage = normalizeUsage(message?.usage);
			if (!hasNonzeroUsage(usage)) continue;
			sawUsage = true;
			input += usage.input ?? 0;
			output += usage.output ?? 0;
			cacheRead += usage.cacheRead ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
		}
		if (!sawUsage) return;
		const total = input + output + cacheRead + cacheWrite;
		return {
			input: input || void 0,
			output: output || void 0,
			cacheRead: cacheRead || void 0,
			cacheWrite: cacheWrite || void 0,
			total: total || void 0
		};
	} catch {
		return;
	}
}
function formatRequestContextTraceBlock(params) {
	const limit = params.contextLimit;
	const used = params.promptTokens;
	if ((typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) && (typeof used !== "number" || !Number.isFinite(used) || used <= 0) && !params.provider && !params.model) return;
	const headroom = typeof limit === "number" && Number.isFinite(limit) && typeof used === "number" && Number.isFinite(used) ? Math.max(0, limit - used) : void 0;
	const percent = typeof limit === "number" && Number.isFinite(limit) && limit > 0 && typeof used === "number" && Number.isFinite(used) ? Math.round(used / limit * 100) : void 0;
	return `🔎 Context Window (Last Model Request):\n~~~text\n${[
		`provider=${params.provider ?? "n/a"}`,
		`model=${params.model ?? "n/a"}`,
		`used=${typeof used === "number" && Number.isFinite(used) ? `${used.toLocaleString()} tok (${formatTokenCount(used)})` : "n/a"}`,
		`limit=${typeof limit === "number" && Number.isFinite(limit) ? `${limit.toLocaleString()} tok (${formatTokenCount(limit)})` : "n/a"}`,
		`headroom=${typeof headroom === "number" ? `${headroom.toLocaleString()} tok (${formatTokenCount(headroom)})` : "n/a"}`,
		`usage=${typeof percent === "number" ? `${percent}%` : "n/a"}`
	].join("\n")}\n~~~`;
}
function formatSummaryPromptValue(params) {
	const used = params.promptTokens;
	const limit = params.contextLimit;
	if (typeof used !== "number" || !Number.isFinite(used) || used <= 0 || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return;
	return `${formatTokenCount(used)}/${formatTokenCount(limit)}`;
}
function formatRawTraceSummaryLine(params) {
	const thinking = normalizeOptionalString(params.requestShaping?.thinking);
	const fields = [
		params.executionTrace?.winnerModel ? `winner=${params.executionTrace.winnerModel}${thinking ? ` 🧠 ${thinking}` : ""}` : void 0,
		typeof params.executionTrace?.fallbackUsed === "boolean" ? `fallback=${params.executionTrace.fallbackUsed ? "yes" : "no"}` : void 0,
		typeof params.executionTrace?.attempts?.length === "number" ? `attempts=${params.executionTrace.attempts.length.toLocaleString()}` : void 0,
		params.completion?.stopReason ? `stop=${params.completion.stopReason}` : void 0,
		(() => {
			const prompt = formatSummaryPromptValue({
				contextLimit: params.contextLimit,
				promptTokens: params.promptTokens
			});
			return prompt ? `prompt=${prompt}` : void 0;
		})(),
		typeof params.usage?.input === "number" && params.usage.input > 0 ? `⬇️ ${formatTokenCount(params.usage.input)}` : void 0,
		typeof params.usage?.output === "number" && params.usage.output > 0 ? `⬆️ ${formatTokenCount(params.usage.output)}` : void 0,
		typeof params.usage?.cacheRead === "number" && params.usage.cacheRead > 0 ? `♻️ ${formatTokenCount(params.usage.cacheRead)}` : void 0,
		typeof params.usage?.cacheWrite === "number" && params.usage.cacheWrite > 0 ? `🆕 ${formatTokenCount(params.usage.cacheWrite)}` : void 0,
		typeof params.usage?.total === "number" && params.usage.total > 0 ? `🔢 ${formatTokenCount(params.usage.total)}` : void 0,
		typeof params.toolSummary?.calls === "number" && params.toolSummary.calls > 0 ? `tools=${params.toolSummary.calls.toLocaleString()}` : void 0,
		typeof params.contextManagement?.lastTurnCompactions === "number" && params.contextManagement.lastTurnCompactions > 0 ? `compactions=${params.contextManagement.lastTurnCompactions.toLocaleString()}` : void 0
	].filter((value) => Boolean(value));
	return fields.length > 0 ? `Summary: ${fields.join(" ")}` : void 0;
}
function buildInlineRawTracePayload(params) {
	if (params.entry?.traceLevel !== "raw") return;
	const resolvedPromptTokens = deriveContextPromptTokens({
		lastCallUsage: params.lastCallUsage,
		promptTokens: params.promptTokens,
		usage: params.usage
	});
	const requestContextBlock = formatRequestContextTraceBlock({
		provider: params.provider,
		model: params.model,
		contextLimit: params.contextLimit,
		promptTokens: resolvedPromptTokens
	});
	return { text: [
		...[
			formatUsageTraceBlock("Usage (Session Total)", params.sessionUsage),
			formatUsageTraceBlock("Usage (Last Turn Total)", params.usage),
			requestContextBlock,
			formatExecutionResultTraceBlock(params.executionTrace),
			formatFallbackChainTraceBlock(params.executionTrace),
			formatKeyValueTraceBlock("Request Shaping", [
				["provider", params.provider],
				["model", params.model],
				["auth", params.requestShaping?.authMode],
				["thinking", params.requestShaping?.thinking],
				["reasoning", params.requestShaping?.reasoning],
				["verbose", params.requestShaping?.verbose],
				["trace", params.requestShaping?.trace],
				["fallbackEligible", params.requestShaping?.fallbackEligible],
				["blockStreaming", params.requestShaping?.blockStreaming]
			]),
			formatPromptSegmentsTraceBlock(params.promptSegments, params.rawUserText),
			formatToolSummaryTraceBlock(params.toolSummary),
			formatCompletionTraceBlock(params.completion),
			formatContextManagementTraceBlock(params.contextManagement)
		].filter((value) => Boolean(value)),
		formatRawTraceBlock("Model Input (User Role)", params.rawUserText),
		formatRawTraceBlock("Model Output (Assistant Role)", params.rawAssistantText),
		formatRawTraceSummaryLine({
			executionTrace: params.executionTrace,
			completion: params.completion,
			contextLimit: params.contextLimit,
			promptTokens: resolvedPromptTokens,
			usage: params.usage,
			toolSummary: params.toolSummary,
			contextManagement: params.contextManagement,
			requestShaping: params.requestShaping
		})
	].join("\n\n\n") };
}
function joinCommitmentAssistantText(payloads) {
	return payloads.filter((payload) => !payload.isError && !payload.isReasoning && !payload.isCompactionNotice).map((payload) => payload.text?.trim()).filter((text) => Boolean(text)).join("\n").trim();
}
function buildPendingFinalDeliveryText(payloads) {
	return sanitizePendingFinalDeliveryText(payloads.filter((payload) => payload.isReasoning !== true).map((payload) => payload.text).filter((text) => Boolean(text)).join("\n\n"));
}
function enqueueCommitmentExtractionForTurn(params) {
	if (params.isHeartbeat) return;
	const userText = params.commandBody.trim() || params.sessionCtx.BodyStripped?.trim() || params.sessionCtx.BodyForCommands?.trim() || params.sessionCtx.CommandBody?.trim() || params.sessionCtx.RawBody?.trim() || params.sessionCtx.Body?.trim() || "";
	const assistantText = joinCommitmentAssistantText(params.payloads);
	const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
	const channel = params.replyToChannel ?? params.followupRun.run.messageProvider ?? params.sessionCtx.Surface ?? params.sessionCtx.Provider;
	if (!userText || !assistantText || !sessionKey || !channel) return;
	const to = resolveOriginMessageTo({
		originatingTo: params.sessionCtx.OriginatingTo,
		to: params.sessionCtx.To
	});
	enqueueCommitmentExtraction({
		cfg: params.cfg,
		agentId: params.followupRun.run.agentId,
		sessionKey,
		channel,
		...params.sessionCtx.AccountId ? { accountId: params.sessionCtx.AccountId } : {},
		...to ? { to } : {},
		...params.sessionCtx.MessageThreadId !== void 0 ? { threadId: String(params.sessionCtx.MessageThreadId) } : {},
		...params.followupRun.run.senderId ? { senderId: params.followupRun.run.senderId } : {},
		userText,
		assistantText,
		...params.sessionCtx.MessageSidFull || params.sessionCtx.MessageSid ? { sourceMessageId: params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid } : {},
		sourceRunId: params.runId
	});
}
function refreshSessionEntryFromStore(params) {
	const { storePath, sessionKey, fallbackEntry, activeSessionStore } = params;
	if (!storePath || !sessionKey) return fallbackEntry;
	try {
		const latestEntry = loadSessionStore(storePath, { skipCache: true })?.[sessionKey];
		if (!latestEntry) return fallbackEntry;
		if (activeSessionStore) activeSessionStore[sessionKey] = latestEntry;
		return latestEntry;
	} catch {
		return fallbackEntry;
	}
}
/**
* Cancel any pending continuation timer for the given session AND reset
* chain metadata. Call this from early-return paths (inline actions, slash
* commands, directive replies) that bypass runReplyAgent but still represent
* real user input that should preempt a running continuation chain.
*/
function cancelContinuationTimer(sessionKey, sessionCtx) {
	clearTrackedContinuationTimers(sessionKey);
	clearDelayedContinuationReservations(sessionKey);
	const hasChainState = (sessionCtx?.sessionEntry?.continuationChainCount ?? 0) > 0 || (sessionCtx?.sessionEntry?.continuationChainTokens ?? 0) > 0;
	if (sessionCtx?.sessionEntry && hasChainState) {
		sessionCtx.sessionEntry.continuationChainCount = 0;
		sessionCtx.sessionEntry.continuationChainStartedAt = void 0;
		sessionCtx.sessionEntry.continuationChainTokens = void 0;
		sessionCtx.sessionEntry.continuationChainId = void 0;
	}
	if (sessionCtx?.sessionStore) {
		const storeResolved = resolveSessionStoreEntry({
			store: sessionCtx.sessionStore,
			sessionKey
		});
		const storeEntry = storeResolved.existing;
		const storeHasChainState = (storeEntry?.continuationChainCount ?? 0) > 0 || (storeEntry?.continuationChainTokens ?? 0) > 0;
		if (storeEntry && storeHasChainState) {
			sessionCtx.sessionStore[storeResolved.normalizedKey] = {
				...storeEntry,
				continuationChainCount: 0,
				continuationChainStartedAt: void 0,
				continuationChainTokens: void 0,
				continuationChainId: void 0
			};
			for (const legacyKey of storeResolved.legacyKeys) delete sessionCtx.sessionStore[legacyKey];
		}
	}
	if (sessionCtx?.storePath) updateSessionStore(sessionCtx.storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const entryHasChainState = (resolved.existing?.continuationChainCount ?? 0) > 0 || (resolved.existing?.continuationChainTokens ?? 0) > 0;
		if (resolved.existing && entryHasChainState) {
			store[resolved.normalizedKey] = {
				...resolved.existing,
				continuationChainCount: 0,
				continuationChainStartedAt: void 0,
				continuationChainTokens: void 0,
				continuationChainId: void 0
			};
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}
	}).catch(() => {});
	cancelPendingDelegates(sessionKey);
}
async function runReplyAgent(params) {
	const { commandBody, transcriptCommandBody, followupRun, queueKey, resolvedQueue, shouldSteer, shouldFollowup, isActive, isRunActive, isStreaming, opts, typing, sessionEntry, sessionStore, sessionKey, runtimePolicySessionKey, storePath, defaultModel, agentCfgContextTokens, resolvedVerboseLevel, toolProgressDetail, isNewSession, blockStreamingEnabled, blockReplyChunking, resolvedBlockStreamingBreak, sessionCtx, shouldInjectGroupIntro, typingMode, resetTriggered, replyThreadingOverride, replyOperation: providedReplyOperation } = params;
	let activeSessionEntry = sessionEntry;
	const activeSessionStore = sessionStore;
	let activeIsNewSession = isNewSession;
	const effectiveResetTriggered = resetTriggered === true;
	const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;
	const isHeartbeat = opts?.isHeartbeat === true;
	const cfg = followupRun.run.config;
	const continuationFeatureEnabled = cfg?.agents?.defaults?.continuation?.enabled === true;
	const traceAttributes = {
		provider: followupRun.run.provider,
		hasSessionKey: Boolean(sessionKey ?? followupRun.run.sessionKey),
		isHeartbeat,
		queueMode: resolvedQueue.mode,
		isActive,
		blockStreamingEnabled
	};
	const traceAgentPhase = (name, run) => measureDiagnosticsTimelineSpan(name, run, {
		phase: "agent-turn",
		config: followupRun.run.config,
		attributes: traceAttributes
	});
	const effectiveShouldSteer = !isHeartbeat && !effectiveResetTriggered && shouldSteer;
	const effectiveShouldFollowup = !effectiveResetTriggered && shouldFollowup;
	const typingSignals = createTypingSignaler({
		typing,
		mode: typingMode,
		isHeartbeat
	});
	const shouldEmitToolResult = createShouldEmitToolResult({
		sessionKey,
		storePath,
		resolvedVerboseLevel
	});
	const shouldEmitToolOutput = createShouldEmitToolOutput({
		sessionKey,
		storePath,
		resolvedVerboseLevel
	});
	const pendingToolTasks = /* @__PURE__ */ new Set();
	const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
	const touchActiveSessionEntry = async () => {
		if (!activeSessionEntry || !activeSessionStore || !sessionKey) return;
		const updatedAt = Date.now();
		activeSessionEntry.updatedAt = updatedAt;
		activeSessionStore[sessionKey] = activeSessionEntry;
		if (storePath) try {
			await updateSessionStoreEntry({
				storePath,
				sessionKey,
				update: async () => ({ updatedAt })
			});
		} catch (err) {
			defaultRuntime.log(`Failed to persist session touch for ${sessionKey}: ${String(err)}`);
		}
	};
	if (effectiveShouldSteer && isStreaming) {
		const steerSessionId = (sessionKey ? replyRunRegistry.resolveSessionId(sessionKey) : void 0) ?? followupRun.run.sessionId;
		const steerOutcome = await queueEmbeddedPiMessageWithOutcomeAsync(steerSessionId, followupRun.prompt, {
			steeringMode: "all",
			...resolvedQueue.debounceMs !== void 0 ? { debounceMs: resolvedQueue.debounceMs } : {}
		});
		if (steerOutcome.queued) {
			await touchActiveSessionEntry();
			typing.cleanup();
			return;
		}
		logVerbose(`queue: active session ${steerSessionId} rejected steering injection: ${formatEmbeddedPiQueueFailureSummary(steerOutcome)}`);
	}
	const activeRunQueueAction = resolveActiveRunQueueAction({
		isActive,
		isHeartbeat,
		shouldFollowup: effectiveShouldFollowup,
		queueMode: activeRunQueueMode,
		resetTriggered: effectiveResetTriggered
	});
	const queuedRunFollowupTurn = createFollowupRunner({
		opts,
		typing,
		typingMode,
		sessionEntry: activeSessionEntry,
		sessionStore: activeSessionStore,
		sessionKey,
		storePath,
		defaultModel,
		agentCfgContextTokens
	});
	if (activeRunQueueAction === "drop") {
		typing.cleanup();
		return;
	}
	if (activeRunQueueAction === "enqueue-followup") {
		enqueueFollowupRun(queueKey, followupRun, resolvedQueue, "message-id", queuedRunFollowupTurn, false);
		const queuedBehindActiveRun = isRunActive?.() === true;
		if (!queuedBehindActiveRun) scheduleFollowupDrain(queueKey, queuedRunFollowupTurn);
		await touchActiveSessionEntry();
		if (queuedBehindActiveRun) await typingSignals.signalToolStart();
		else typing.cleanup();
		return;
	}
	followupRun.run.config = await resolveQueuedReplyExecutionConfig(followupRun.run.config, {
		originatingChannel: sessionCtx.OriginatingChannel,
		messageProvider: followupRun.run.messageProvider,
		originatingAccountId: followupRun.originatingAccountId,
		agentAccountId: followupRun.run.agentAccountId
	});
	const resolvedRunCfg = followupRun.run.config;
	const replyToChannel = resolveOriginMessageProvider({
		originatingChannel: sessionCtx.OriginatingChannel,
		provider: sessionCtx.Surface ?? sessionCtx.Provider
	});
	const replyToMode = resolveReplyToMode(resolvedRunCfg, replyToChannel, sessionCtx.AccountId, sessionCtx.ChatType);
	const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
	const replyMediaContext = createReplyMediaContext({
		cfg: resolvedRunCfg,
		sessionKey,
		workspaceDir: followupRun.run.workspaceDir,
		messageProvider: followupRun.run.messageProvider,
		accountId: followupRun.originatingAccountId ?? followupRun.run.agentAccountId,
		groupId: followupRun.run.groupId,
		groupChannel: followupRun.run.groupChannel,
		groupSpace: followupRun.run.groupSpace,
		requesterSenderId: followupRun.run.senderId,
		requesterSenderName: followupRun.run.senderName,
		requesterSenderUsername: followupRun.run.senderUsername,
		requesterSenderE164: followupRun.run.senderE164
	});
	const blockReplyCoalescing = blockStreamingEnabled && opts?.onBlockReply ? resolveEffectiveBlockStreamingConfig({
		cfg: resolvedRunCfg,
		provider: sessionCtx.Provider,
		accountId: sessionCtx.AccountId,
		chunking: blockReplyChunking
	}).coalescing : void 0;
	const blockReplyPipeline = blockStreamingEnabled && opts?.onBlockReply ? createBlockReplyPipeline({
		onBlockReply: opts.onBlockReply,
		timeoutMs: blockReplyTimeoutMs,
		coalescing: blockReplyCoalescing,
		buffer: createAudioAsVoiceBuffer({ isAudioPayload })
	}) : null;
	const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
	let latestPreviewStreamedText;
	const effectiveOpts = opts?.onPartialReply ? {
		...opts,
		onPartialReply: async (payload) => {
			if (typeof payload.text === "string" && payload.text.trim()) latestPreviewStreamedText = payload.text;
			await opts.onPartialReply?.(payload);
		}
	} : opts;
	let replyOperation;
	try {
		replyOperation = providedReplyOperation ?? createReplyOperation({
			sessionId: followupRun.run.sessionId,
			sessionKey: replySessionKey ?? "",
			resetTriggered: effectiveResetTriggered,
			upstreamAbortSignal: opts?.abortSignal
		});
	} catch (error) {
		if (error instanceof ReplyRunAlreadyActiveError) {
			typing.cleanup();
			return markReplyPayloadForSourceSuppressionDelivery({ text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT });
		}
		throw error;
	}
	let runFollowupTurn = queuedRunFollowupTurn;
	let shouldDrainQueuedFollowupsAfterClear = false;
	const returnWithQueuedFollowupDrain = (value) => {
		shouldDrainQueuedFollowupsAfterClear = true;
		return value;
	};
	const drainQueuedFollowupsAfterClear = () => {
		scheduleFollowupDrain(queueKey, runFollowupTurn);
	};
	const prePreflightCompactionCount = activeSessionEntry?.compactionCount ?? 0;
	let preflightCompactionApplied = false;
	const postCompactionDelegatesToPreserve = [];
	const persistContinuationChainState = async (params) => {
		if (!sessionKey) return { chainId: void 0 };
		const previousCount = activeSessionEntry?.continuationChainCount ?? 0;
		const previousChainId = activeSessionEntry?.continuationChainId;
		const chainId = previousCount > 0 && previousChainId !== void 0 ? previousChainId : generateChainId();
		if (activeSessionEntry) {
			activeSessionEntry.continuationChainCount = params.count;
			activeSessionEntry.continuationChainStartedAt = params.startedAt;
			activeSessionEntry.continuationChainTokens = params.tokens;
			activeSessionEntry.continuationChainId = chainId;
		}
		if (activeSessionStore) {
			const resolved = resolveSessionStoreEntry({
				store: activeSessionStore,
				sessionKey
			});
			const existingEntry = resolved.existing ?? activeSessionEntry;
			if (existingEntry) {
				activeSessionStore[resolved.normalizedKey] = {
					...existingEntry,
					continuationChainCount: params.count,
					continuationChainStartedAt: params.startedAt,
					continuationChainTokens: params.tokens,
					continuationChainId: chainId
				};
				for (const legacyKey of resolved.legacyKeys) delete activeSessionStore[legacyKey];
			}
		}
		if (storePath) try {
			await updateSessionStore(storePath, (store) => {
				const resolved = resolveSessionStoreEntry({
					store,
					sessionKey
				});
				if (resolved.existing) {
					store[resolved.normalizedKey] = {
						...resolved.existing,
						continuationChainCount: params.count,
						continuationChainStartedAt: params.startedAt,
						continuationChainTokens: params.tokens,
						continuationChainId: chainId
					};
					for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
				}
			});
		} catch (err) {
			defaultRuntime.log(`Failed to persist continuation chain state for ${sessionKey}: ${String(err)}`);
		}
		return { chainId };
	};
	try {
		await typingSignals.signalRunStart();
		activeSessionEntry = await traceAgentPhase("reply.preflight_compaction", () => runPreflightCompactionIfNeeded({
			cfg: resolvedRunCfg,
			followupRun,
			promptForEstimate: followupRun.prompt,
			defaultModel,
			agentCfgContextTokens,
			sessionEntry: activeSessionEntry,
			sessionStore: activeSessionStore,
			sessionKey,
			runtimePolicySessionKey,
			storePath,
			isHeartbeat,
			replyOperation
		}));
		preflightCompactionApplied = (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;
		const visibleMemoryFlushErrorPayloads = [];
		activeSessionEntry = await traceAgentPhase("reply.memory_flush", () => runMemoryFlushIfNeeded({
			cfg: resolvedRunCfg,
			followupRun,
			promptForEstimate: followupRun.prompt,
			sessionCtx,
			opts,
			defaultModel,
			agentCfgContextTokens,
			resolvedVerboseLevel,
			sessionEntry: activeSessionEntry,
			sessionStore: activeSessionStore,
			sessionKey,
			runtimePolicySessionKey,
			storePath,
			isHeartbeat,
			replyOperation,
			onVisibleErrorPayloads: (payloads) => {
				visibleMemoryFlushErrorPayloads.push(...payloads);
			}
		}));
		if (visibleMemoryFlushErrorPayloads.length > 0) {
			const replyPayloads = (await buildReplyPayloads({
				payloads: visibleMemoryFlushErrorPayloads,
				isHeartbeat,
				didLogHeartbeatStrip: false,
				silentExpected: true,
				blockStreamingEnabled,
				blockReplyPipeline,
				replyToMode,
				replyToChannel,
				currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
				replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
				messageProvider: followupRun.run.messageProvider,
				originatingChannel: sessionCtx.OriginatingChannel,
				originatingTo: resolveOriginMessageTo({
					originatingTo: sessionCtx.OriginatingTo,
					to: sessionCtx.To
				}),
				accountId: sessionCtx.AccountId,
				normalizeMediaPaths: replyMediaContext.normalizePayload
			})).replyPayloads.map((payload) => markReplyPayloadForSourceSuppressionDelivery(payload));
			if (replyPayloads.length > 0) {
				replyOperation.fail("run_failed", /* @__PURE__ */ new Error("memory flush produced visible error payloads"));
				await signalTypingIfNeeded(replyPayloads, typingSignals);
				return returnWithQueuedFollowupDrain(replyPayloads.length === 1 ? replyPayloads[0] : replyPayloads);
			}
		}
		runFollowupTurn = createFollowupRunner({
			opts,
			typing,
			typingMode,
			sessionEntry: activeSessionEntry,
			sessionStore: activeSessionStore,
			sessionKey,
			storePath,
			defaultModel,
			agentCfgContextTokens
		});
		let responseUsageLine;
		const resetSession = async ({ failureLabel, buildLogMessage, cleanupTranscripts }) => await resetReplyRunSession({
			options: {
				failureLabel,
				buildLogMessage,
				cleanupTranscripts
			},
			sessionKey,
			queueKey,
			activeSessionEntry,
			activeSessionStore,
			storePath,
			messageThreadId: typeof sessionCtx.MessageThreadId === "string" ? sessionCtx.MessageThreadId : void 0,
			followupRun,
			onActiveSessionEntry: (nextEntry) => {
				activeSessionEntry = nextEntry;
			},
			onNewSession: () => {
				activeIsNewSession = true;
			}
		});
		const resetSessionAfterCompactionFailure = async (reason) => resetSession({
			failureLabel: "compaction failure",
			buildLogMessage: (nextSessionId) => `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`
		});
		const resetSessionAfterRoleOrderingConflict = async (reason) => resetSession({
			failureLabel: "role ordering conflict",
			buildLogMessage: (nextSessionId) => `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
			cleanupTranscripts: true
		});
		replyOperation.setPhase("running");
		if (activeSessionEntry && sessionKey) {
			const { contextPressureThreshold, earlyWarningBand } = resolveLiveContinuationRuntimeConfig(cfg);
			const contextWindowTokens = resolveContextTokensForModel({
				cfg,
				provider: followupRun.run.provider,
				model: defaultModel,
				contextTokensOverride: agentCfgContextTokens,
				fallbackContextTokens: activeSessionEntry.contextTokens ?? 2e5,
				allowAsyncLoad: false
			}) ?? 2e5;
			const pressureResult = checkContextPressure({
				sessionEntry: activeSessionEntry,
				sessionKey,
				contextPressureThreshold,
				contextWindowTokens,
				earlyWarningBand,
				postCompaction: preflightCompactionApplied
			});
			if (pressureResult.fired && storePath) try {
				await updateSessionStore(storePath, (store) => {
					const resolved = resolveSessionStoreEntry({
						store,
						sessionKey
					});
					if (resolved.existing) {
						store[resolved.normalizedKey] = {
							...resolved.existing,
							lastContextPressureBand: pressureResult.band
						};
						for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
					}
				});
			} catch (err) {
				defaultRuntime.log(`context-pressure band persistence failed (non-fatal): ${String(err)}`);
			}
		}
		const runStartedAt = Date.now();
		const runOutcome = await runWithDiagnosticTraceparent(followupRun.run.traceparent, () => traceAgentPhase("reply.run_agent_turn", () => runAgentTurnWithFallback({
			commandBody,
			transcriptCommandBody,
			followupRun,
			sessionCtx,
			replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
			replyOperation,
			opts: effectiveOpts,
			typingSignals,
			blockReplyPipeline,
			blockStreamingEnabled,
			blockReplyChunking,
			resolvedBlockStreamingBreak,
			applyReplyToMode,
			shouldEmitToolResult,
			shouldEmitToolOutput,
			pendingToolTasks,
			resetSessionAfterCompactionFailure,
			resetSessionAfterRoleOrderingConflict,
			isHeartbeat,
			sessionKey,
			runtimePolicySessionKey,
			getActiveSessionEntry: () => activeSessionEntry,
			activeSessionStore,
			storePath,
			resolvedVerboseLevel,
			toolProgressDetail,
			replyMediaContext
		})));
		if (runOutcome.kind === "final") {
			if (!replyOperation.result) replyOperation.fail("run_failed", /* @__PURE__ */ new Error("reply operation exited with final payload"));
			return returnWithQueuedFollowupDrain(runOutcome.payload);
		}
		const { runId, runResult, fallbackProvider, fallbackModel, fallbackAttempts, directlySentBlockKeys } = runOutcome;
		let { didLogHeartbeatStrip, autoCompactionCount } = runOutcome;
		if (shouldInjectGroupIntro && activeSessionEntry && activeSessionStore && sessionKey && activeSessionEntry.groupActivationNeedsSystemIntro) {
			const updatedAt = Date.now();
			activeSessionEntry.groupActivationNeedsSystemIntro = false;
			activeSessionEntry.updatedAt = updatedAt;
			activeSessionStore[sessionKey] = activeSessionEntry;
			if (storePath) try {
				await updateSessionStoreEntry({
					storePath,
					sessionKey,
					update: async () => ({
						groupActivationNeedsSystemIntro: false,
						updatedAt
					})
				});
			} catch (err) {
				defaultRuntime.log(`Failed to persist group activation intro state for ${sessionKey}: ${String(err)}`);
			}
		}
		const payloadArray = runResult.payloads ?? [];
		if (blockReplyPipeline) {
			await blockReplyPipeline.flush({ force: true });
			blockReplyPipeline.stop();
		}
		if (pendingToolTasks.size > 0) await drainPendingToolTasks({
			tasks: pendingToolTasks,
			onTimeout: logVerbose
		});
		const continueWorkRequest = runOutcome.continueWorkRequest;
		const continuationExtraction = extractContinuationSignal({
			payloads: payloadArray,
			continueWorkRequest: continueWorkRequest ? {
				reason: continueWorkRequest.reason,
				delaySeconds: continueWorkRequest.delaySeconds,
				...continueWorkRequest.traceparent ? { traceparent: continueWorkRequest.traceparent } : {}
			} : void 0,
			enabled: continuationFeatureEnabled,
			sessionKey
		});
		const effectiveContinuationSignal = continuationExtraction.signal;
		const continuationWorkReason = continuationExtraction.workReason;
		const usage = runResult.meta?.agentMeta?.usage;
		const promptTokens = runResult.meta?.agentMeta?.promptTokens;
		const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
		const providerUsed = runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
		const verboseEnabled = resolvedVerboseLevel !== "off";
		const fallbackStateEntry = activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : void 0);
		const configuredFallbackModel = resolveConfiguredFallbackModel({
			run: followupRun.run,
			fallbackStateEntry
		});
		const selectedProvider = configuredFallbackModel.provider;
		const selectedModel = configuredFallbackModel.model;
		const fallbackTransition = resolveFallbackTransition({
			selectedProvider,
			selectedModel,
			activeProvider: providerUsed,
			activeModel: modelUsed,
			attempts: fallbackAttempts,
			state: fallbackStateEntry
		});
		if (fallbackTransition.stateChanged) {
			if (fallbackStateEntry) {
				fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
				fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
				fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
				fallbackStateEntry.updatedAt = Date.now();
				activeSessionEntry = fallbackStateEntry;
			}
			if (sessionKey && fallbackStateEntry && activeSessionStore) activeSessionStore[sessionKey] = fallbackStateEntry;
			if (sessionKey && storePath) try {
				await updateSessionStoreEntry({
					storePath,
					sessionKey,
					update: async () => ({
						fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
						fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
						fallbackNoticeReason: fallbackTransition.nextState.reason
					})
				});
			} catch (err) {
				defaultRuntime.log(`Failed to persist fallback notice state for ${sessionKey}: ${String(err)}`);
			}
		}
		const usedCliProvider = isCliProvider(providerUsed, cfg);
		const cliSessionId = usedCliProvider ? normalizeOptionalString(runResult.meta?.agentMeta?.sessionId) : void 0;
		const cliSessionBinding = usedCliProvider ? runResult.meta?.agentMeta?.cliSessionBinding : void 0;
		const contextTokensUsed = (typeof runResult.meta?.agentMeta?.contextTokens === "number" && Number.isFinite(runResult.meta.agentMeta.contextTokens) && runResult.meta.agentMeta.contextTokens > 0 ? Math.floor(runResult.meta.agentMeta.contextTokens) : void 0) ?? resolveContextTokensForModel({
			cfg,
			provider: providerUsed,
			model: modelUsed,
			contextTokensOverride: agentCfgContextTokens,
			fallbackContextTokens: activeSessionEntry?.contextTokens ?? 2e5,
			allowAsyncLoad: false
		}) ?? 2e5;
		await persistRunSessionUsage({
			storePath,
			sessionKey,
			cfg,
			usage,
			lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
			promptTokens,
			usageIsContextSnapshot: usedCliProvider ? true : void 0,
			isHeartbeat,
			modelUsed,
			providerUsed,
			contextTokensUsed,
			systemPromptReport: runResult.meta?.systemPromptReport,
			cliSessionId,
			cliSessionBinding,
			preserveFreshTotalTokensOnStaleUsage: preflightCompactionApplied
		});
		const returnSilentFallbackFailureIfNeeded = async () => {
			const silentFallbackFailurePayload = buildSilentFallbackFailurePayload({
				fallbackTransition,
				fallbackFailureKnown: fallbackAttempts.length > 0 || configuredFallbackModel.persistedAutoFallback,
				isHeartbeat,
				hasSuccessfulSideEffectDelivery: hasSuccessfulSideEffectDelivery({
					blockReplyPipeline,
					directlySentBlockKeys,
					messagingToolSentTexts: runResult.messagingToolSentTexts,
					messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
					messagingToolSentTargets: runResult.messagingToolSentTargets,
					successfulCronAdds: runResult.successfulCronAdds,
					didSendDeterministicApprovalPrompt: runResult.didSendDeterministicApprovalPrompt
				}),
				allowEmptyAssistantReplyAsSilent: followupRun.run.allowEmptyAssistantReplyAsSilent,
				silentExpected: followupRun.run.silentExpected
			});
			if (!silentFallbackFailurePayload) return;
			replyOperation.fail("run_failed", /* @__PURE__ */ new Error(`configured model backend ${fallbackTransition.selectedModelRef} failed and fallback ${fallbackTransition.activeModelRef} produced no visible reply`));
			await signalTypingIfNeeded([silentFallbackFailurePayload], typingSignals);
			return returnWithQueuedFollowupDrain(silentFallbackFailurePayload);
		};
		const hasQueuedDelegateWork = continuationFeatureEnabled && !!sessionKey && (pendingDelegateCount(sessionKey) > 0 || stagedPostCompactionDelegateCount(sessionKey) > 0);
		if (payloadArray.length === 0 && !hasQueuedDelegateWork && !effectiveContinuationSignal) {
			const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
			if (silentFallbackFailurePayload) return silentFallbackFailurePayload;
			return returnWithQueuedFollowupDrain(void 0);
		}
		const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
		const payloadResult = await buildReplyPayloads({
			payloads: payloadArray,
			isHeartbeat,
			didLogHeartbeatStrip,
			silentExpected: followupRun.run.silentExpected,
			blockStreamingEnabled,
			blockReplyPipeline,
			previewStreamedText: latestPreviewStreamedText,
			directlySentBlockKeys,
			replyToMode,
			replyToChannel,
			currentMessageId,
			replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
			messageProvider: followupRun.run.messageProvider,
			messagingToolSentTexts: runResult.messagingToolSentTexts,
			messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
			messagingToolSentTargets: runResult.messagingToolSentTargets,
			originatingChannel: sessionCtx.OriginatingChannel,
			originatingTo: resolveOriginMessageTo({
				originatingTo: sessionCtx.OriginatingTo,
				to: sessionCtx.To
			}),
			accountId: sessionCtx.AccountId,
			normalizeMediaPaths: replyMediaContext.normalizePayload
		});
		const { replyPayloads } = payloadResult;
		didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;
		const wasSilentContinuation = replyPayloads.length === 0 && !!effectiveContinuationSignal;
		if (replyPayloads.length === 0) {
			const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
			if (silentFallbackFailurePayload) return silentFallbackFailurePayload;
			if (!effectiveContinuationSignal && !hasQueuedDelegateWork) return returnWithQueuedFollowupDrain(void 0);
		}
		const successfulCronAdds = runResult.successfulCronAdds ?? 0;
		const hasReminderCommitment = replyPayloads.some((payload) => !payload.isError && typeof payload.text === "string" && hasUnbackedReminderCommitment(payload.text));
		const coveredByExistingCron = hasReminderCommitment && successfulCronAdds === 0 ? await hasSessionRelatedCronJobs({
			cronStorePath: cfg.cron?.store,
			sessionKey
		}) : false;
		const guardedReplyPayloads = hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron ? appendUnscheduledReminderNote(replyPayloads) : replyPayloads;
		enqueueCommitmentExtractionForTurn({
			cfg,
			commandBody,
			isHeartbeat,
			followupRun,
			sessionCtx,
			sessionKey,
			replyToChannel,
			payloads: replyPayloads,
			runId
		});
		await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);
		if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const usagePromptTokens = input + cacheRead + cacheWrite;
			const totalTokens = usage.total ?? usagePromptTokens + output;
			const contextUsedTokens = deriveContextPromptTokens({
				lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
				promptTokens,
				usage
			});
			const costUsd = estimateUsageCost({
				usage,
				cost: resolveModelCostConfig({
					provider: providerUsed,
					model: modelUsed,
					config: cfg
				})
			});
			emitTrustedDiagnosticEvent({
				type: "model.usage",
				...runResult.diagnosticTrace ? { trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runResult.diagnosticTrace)) } : {},
				sessionKey,
				sessionId: followupRun.run.sessionId,
				channel: replyToChannel,
				agentId: followupRun.run.agentId,
				provider: providerUsed,
				model: modelUsed,
				usage: {
					input,
					output,
					cacheRead,
					cacheWrite,
					promptTokens: usagePromptTokens,
					total: totalTokens
				},
				lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
				context: {
					limit: contextTokensUsed,
					...contextUsedTokens !== void 0 ? { used: contextUsedTokens } : {}
				},
				costUsd,
				durationMs: Date.now() - runStartedAt
			});
		}
		const responseUsageMode = resolveResponseUsageMode(activeSessionEntry?.responseUsage ?? (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : void 0));
		if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
			const showCost = resolveModelAuthMode(providerUsed, cfg, void 0, { workspaceDir: followupRun.run.workspaceDir }) === "api-key";
			let formatted = formatResponseUsageLine({
				usage,
				showCost,
				costConfig: showCost ? resolveModelCostConfig({
					provider: providerUsed,
					model: modelUsed,
					config: cfg
				}) : void 0
			});
			if (formatted && responseUsageMode === "full" && sessionKey) formatted = `${formatted} · session \`${sessionKey}\``;
			if (formatted) responseUsageLine = formatted;
		}
		if (verboseEnabled) activeSessionEntry = refreshSessionEntryFromStore({
			storePath,
			sessionKey,
			fallbackEntry: activeSessionEntry,
			activeSessionStore
		});
		let finalPayloads = guardedReplyPayloads;
		const verboseNotices = [];
		if (verboseEnabled && activeIsNewSession) verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
		if (fallbackTransition.fallbackTransitioned) {
			emitAgentEvent({
				runId,
				sessionKey,
				stream: "lifecycle",
				data: {
					phase: "fallback",
					selectedProvider,
					selectedModel,
					activeProvider: providerUsed,
					activeModel: modelUsed,
					reasonSummary: fallbackTransition.reasonSummary,
					attemptSummaries: fallbackTransition.attemptSummaries,
					attempts: fallbackAttempts
				}
			});
			if (verboseEnabled) {
				const fallbackNotice = buildFallbackNotice({
					selectedProvider,
					selectedModel,
					activeProvider: providerUsed,
					activeModel: modelUsed,
					attempts: fallbackAttempts
				});
				if (fallbackNotice) verboseNotices.push({ text: fallbackNotice });
			}
		}
		if (fallbackTransition.fallbackCleared) {
			emitAgentEvent({
				runId,
				sessionKey,
				stream: "lifecycle",
				data: {
					phase: "fallback_cleared",
					selectedProvider,
					selectedModel,
					activeProvider: providerUsed,
					activeModel: modelUsed,
					previousActiveModel: fallbackTransition.previousState.activeModel
				}
			});
			if (verboseEnabled) verboseNotices.push({ text: buildFallbackClearedNotice({
				selectedProvider,
				selectedModel,
				previousActiveModel: fallbackTransition.previousState.activeModel
			}) });
		}
		if (autoCompactionCount > 0) {
			const previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
			const count = await incrementRunCompactionCount({
				cfg,
				sessionEntry: activeSessionEntry,
				sessionStore: activeSessionStore,
				sessionKey,
				storePath,
				amount: autoCompactionCount,
				compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
				lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
				contextTokensUsed,
				newSessionId: runResult.meta?.agentMeta?.sessionId,
				newSessionFile: runResult.meta?.agentMeta?.sessionFile
			});
			const refreshedSessionEntry = sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : void 0;
			if (refreshedSessionEntry) {
				activeSessionEntry = refreshedSessionEntry;
				refreshQueuedFollowupSession({
					key: queueKey,
					previousSessionId,
					nextSessionId: refreshedSessionEntry.sessionId,
					nextSessionFile: refreshedSessionEntry.sessionFile
				});
			}
			if (sessionKey) {
				const releasedCount = activeSessionEntry?.pendingPostCompactionDelegates?.length ?? 0;
				await dispatchPostCompactionDelegates({
					cfg,
					compactionCount: count,
					continuationSignalKind: effectiveContinuationSignal?.kind,
					followupRun,
					postCompactionDelegatesToPreserve,
					sessionEntry: activeSessionEntry,
					sessionKey,
					sessionStore: activeSessionStore,
					storePath
				});
				emitContinuationCompactionReleasedSpan({
					releasedCount,
					compactionId: count,
					traceparent: runOutcome.compactionTraceparent,
					log: (message) => defaultRuntime.log(message)
				});
			}
			if (verboseEnabled) {
				const suffix = typeof count === "number" ? ` (count ${count})` : "";
				verboseNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
			}
		}
		if (!wasSilentContinuation) {
			const prefixPayloads = [...verboseNotices];
			const isHookBlockedRun = runResult.meta?.error?.kind === "hook_block";
			const rawUserText = isHookBlockedRun ? runResult.meta?.finalPromptText : runResult.meta?.finalPromptText ?? sessionCtx.CommandBody ?? sessionCtx.RawBody ?? sessionCtx.BodyForAgent ?? sessionCtx.Body;
			const rawAssistantText = isHookBlockedRun ? void 0 : runResult.meta?.finalAssistantRawText ?? runResult.meta?.finalAssistantVisibleText;
			const traceAuthorized = followupRun.run.traceAuthorized === true;
			const executionTrace = mergeExecutionTrace({
				fallbackAttempts,
				executionTrace: runResult.meta?.executionTrace,
				provider: providerUsed,
				model: modelUsed,
				runner: isCliProvider(providerUsed, cfg) ? "cli" : "embedded"
			});
			const requestShaping = {
				authMode: runResult.meta?.requestShaping?.authMode ?? (cfg?.models?.providers && providerUsed in cfg.models.providers ? resolveModelAuthMode(providerUsed, cfg, void 0, { workspaceDir: followupRun.run.workspaceDir }) ?? void 0 : void 0),
				thinking: runResult.meta?.requestShaping?.thinking ?? normalizeOptionalString(followupRun.run.thinkLevel),
				reasoning: runResult.meta?.requestShaping?.reasoning ?? normalizeOptionalString(followupRun.run.reasoningLevel),
				verbose: runResult.meta?.requestShaping?.verbose ?? normalizeOptionalString(resolvedVerboseLevel),
				trace: runResult.meta?.requestShaping?.trace ?? normalizeOptionalString(activeSessionEntry?.traceLevel),
				fallbackEligible: runResult.meta?.requestShaping?.fallbackEligible ?? hasConfiguredModelFallbacks({
					cfg,
					agentId: followupRun.run.agentId,
					sessionKey: followupRun.run.sessionKey
				}),
				blockStreaming: runResult.meta?.requestShaping?.blockStreaming ?? normalizeOptionalString(resolvedBlockStreamingBreak)
			};
			const promptSegments = runResult.meta?.promptSegments ?? derivePromptSegments(rawUserText);
			const toolSummary = runResult.meta?.toolSummary;
			const completion = runResult.meta?.completion ?? (runResult.meta?.stopReason ? {
				stopReason: runResult.meta.stopReason,
				finishReason: runResult.meta.stopReason,
				...runResult.meta.stopReason.toLowerCase().includes("refusal") ? { refusal: true } : {}
			} : void 0);
			const contextManagement = {
				...typeof activeSessionEntry?.compactionCount === "number" ? { sessionCompactions: activeSessionEntry.compactionCount } : {},
				...typeof runResult.meta?.contextManagement?.lastTurnCompactions === "number" ? { lastTurnCompactions: runResult.meta.contextManagement.lastTurnCompactions } : typeof runResult.meta?.agentMeta?.compactionCount === "number" ? { lastTurnCompactions: runResult.meta.agentMeta.compactionCount } : {},
				...runResult.meta?.contextManagement && typeof runResult.meta.contextManagement.preflightCompactionApplied === "boolean" ? { preflightCompactionApplied: runResult.meta.contextManagement.preflightCompactionApplied } : preflightCompactionApplied ? { preflightCompactionApplied } : {},
				...runResult.meta?.contextManagement && typeof runResult.meta.contextManagement.postCompactionContextInjected === "boolean" ? { postCompactionContextInjected: runResult.meta.contextManagement.postCompactionContextInjected } : {}
			};
			const sessionUsage = traceAuthorized && activeSessionEntry?.traceLevel === "raw" ? await accumulateSessionUsageFromTranscript({
				sessionId: runResult.meta?.agentMeta?.sessionId ?? followupRun.run.sessionId,
				storePath,
				sessionFile: followupRun.run.sessionFile
			}) : void 0;
			const traceEnabledForSender = traceAuthorized && (activeSessionEntry?.traceLevel === "on" || activeSessionEntry?.traceLevel === "raw");
			const shouldAppendTracePayload = verboseEnabled || traceEnabledForSender;
			let trailingPluginStatusPayload;
			if (shouldAppendTracePayload) {
				const pluginStatusPayload = buildInlinePluginStatusPayload({
					entry: activeSessionEntry,
					includeTraceLines: traceEnabledForSender
				});
				const rawTracePayload = traceAuthorized && activeSessionEntry?.traceLevel === "raw" ? buildInlineRawTracePayload({
					entry: activeSessionEntry,
					rawUserText,
					rawAssistantText,
					sessionUsage,
					usage: runResult.meta?.agentMeta?.usage,
					lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
					provider: providerUsed,
					model: modelUsed,
					contextLimit: contextTokensUsed,
					promptTokens,
					executionTrace,
					requestShaping,
					promptSegments,
					toolSummary,
					completion,
					contextManagement
				}) : void 0;
				trailingPluginStatusPayload = pluginStatusPayload && rawTracePayload ? { text: `${pluginStatusPayload.text}\n\n${rawTracePayload.text}` } : pluginStatusPayload ?? rawTracePayload;
			}
			if (prefixPayloads.length > 0) finalPayloads = [...prefixPayloads, ...finalPayloads];
			if (trailingPluginStatusPayload) finalPayloads = [...finalPayloads, trailingPluginStatusPayload];
			if (responseUsageLine) finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
			if (isHookBlockedRun) finalPayloads = markBeforeAgentRunBlockedPayloads(finalPayloads);
		}
		let bracketTokensAccumulated = false;
		if (effectiveContinuationSignal && sessionKey) {
			const { maxChainLength, defaultDelayMs, minDelayMs, maxDelayMs, costCapTokens, crossSessionTargeting } = resolveLiveContinuationRuntimeConfig(cfg);
			{
				const currentChainCount = activeSessionEntry?.continuationChainCount ?? 0;
				const allocatedChainHop = Math.max(currentChainCount, highestDelayedContinuationReservationHop(sessionKey));
				if (allocatedChainHop >= maxChainLength) {
					defaultRuntime.log(`Continuation chain capped at ${maxChainLength} for session ${sessionKey}`);
					enqueueSystemEvent(`[continuation] Bracket continuation rejected: chain length ${maxChainLength} reached.`, {
						sessionKey,
						trusted: true
					});
					{
						const isDelegate = effectiveContinuationSignal.kind === "delegate";
						const delegateMode = isDelegate ? effectiveContinuationSignal.silentWake ? "silent-wake" : effectiveContinuationSignal.silent ? "silent" : "normal" : void 0;
						const delegateDelivery = isDelegate ? (effectiveContinuationSignal.delayMs ?? defaultDelayMs) > 0 ? "timer" : "immediate" : void 0;
						emitContinuationDisabledSpan({
							chainId: activeSessionEntry?.continuationChainId,
							chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
							disabledReason: "cap.chain",
							signalKind: isDelegate ? "bracket-delegate" : "bracket-work",
							delegateDelivery,
							delegateMode,
							log: defaultRuntime.log
						});
					}
				} else {
					const usage = runResult.meta?.agentMeta?.usage;
					const turnTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
					const accumulatedChainTokens = (activeSessionEntry?.continuationChainTokens ?? 0) + turnTokens;
					if (costCapTokens > 0 && accumulatedChainTokens > costCapTokens) {
						defaultRuntime.log(`Continuation cost cap exceeded (${accumulatedChainTokens} > ${costCapTokens}) for session ${sessionKey}`);
						enqueueSystemEvent(`[continuation] Bracket continuation rejected: cost cap exceeded (${accumulatedChainTokens} > ${costCapTokens}).`, {
							sessionKey,
							trusted: true
						});
						{
							const isDelegate = effectiveContinuationSignal.kind === "delegate";
							const delegateMode = isDelegate ? effectiveContinuationSignal.silentWake ? "silent-wake" : effectiveContinuationSignal.silent ? "silent" : "normal" : void 0;
							const delegateDelivery = isDelegate ? (effectiveContinuationSignal.delayMs ?? defaultDelayMs) > 0 ? "timer" : "immediate" : void 0;
							emitContinuationDisabledSpan({
								chainId: activeSessionEntry?.continuationChainId,
								chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
								disabledReason: "cap.cost",
								signalKind: isDelegate ? "bracket-delegate" : "bracket-work",
								delegateDelivery,
								delegateMode,
								log: defaultRuntime.log
							});
						}
					} else {
						bracketTokensAccumulated = true;
						const nextChainCount = allocatedChainHop + 1;
						const chainStartedAt = activeSessionEntry?.continuationChainStartedAt ?? Date.now();
						if (effectiveContinuationSignal.kind === "delegate") {
							const delegateTask = effectiveContinuationSignal.task;
							const delegateDelayMs = effectiveContinuationSignal.delayMs;
							const rejectCrossSessionTargeting = (targeting, details) => {
								if (crossSessionTargeting === "enabled" || !hasCrossSessionDelegateTargeting(targeting, sessionKey)) return false;
								defaultRuntime.log(`[continuation] Cross-session targeting rejected by policy for session ${sessionKey}`);
								enqueueSystemEvent("[continuation] Delegate rejected: cross-session targeting is disabled by policy. Use the default return target, targetSessionKey set to this session, or fanoutMode=\"tree\".", {
									sessionKey,
									trusted: true
								});
								emitContinuationDisabledSpan({
									chainId: activeSessionEntry?.continuationChainId,
									chainStepRemaining: Math.max(0, maxChainLength - details.plannedHop),
									disabledReason: "policy.cross_session_targeting",
									signalKind: "bracket-delegate",
									delegateDelivery: details.delegateDelivery,
									delegateMode: details.silentWake ? "silent-wake" : details.silent ? "silent" : "normal",
									reason: details.task,
									log: (message) => defaultRuntime.log(message)
								});
								bracketTokensAccumulated = false;
								return true;
							};
							const doSpawn = async (plannedHop, task, options) => {
								let dispatchSpan;
								try {
									if (rejectCrossSessionTargeting({
										...options?.targetSessionKey ? { targetSessionKey: options.targetSessionKey } : {},
										...options?.targetSessionKeys && options.targetSessionKeys.length > 0 ? { targetSessionKeys: options.targetSessionKeys } : {},
										...options?.fanoutMode ? { fanoutMode: options.fanoutMode } : {}
									}, {
										plannedHop,
										task,
										delegateDelivery: options?.timerTriggered ? "timer" : "immediate",
										...options?.silent ? { silent: options.silent } : {},
										...options?.silentWake ? { silentWake: options.silentWake } : {}
									})) return false;
									const outboundTraceparent = resolveContinuationTraceparent(options?.traceparent);
									const delegateMode = options?.silentWake ? "silent-wake" : options?.silent ? "silent" : "normal";
									if (!options?.timerTriggered) dispatchSpan = startContinuationDelegateSpan({
										chainId: void 0,
										chainStepRemaining: maxChainLength - plannedHop,
										delayMs: 0,
										delivery: "immediate",
										delegateMode,
										traceparent: outboundTraceparent,
										log: (message) => defaultRuntime.log(message)
									});
									const spawnTraceparent = dispatchSpan?.traceparent?.() ?? outboundTraceparent;
									const spawnResult = await spawnSubagentDirect({
										task: `[continuation:chain-hop:${plannedHop}] Delegated task (turn ${plannedHop}/${maxChainLength}): ${task}`,
										...options?.silent ? { silentAnnounce: true } : {},
										...options?.silentWake ? {
											silentAnnounce: true,
											wakeOnReturn: true
										} : {},
										drainsContinuationDelegateQueue: true,
										...options?.targetSessionKey ? { continuationTargetSessionKey: options.targetSessionKey } : {},
										...options?.targetSessionKeys && options.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: options.targetSessionKeys } : {},
										...options?.fanoutMode ? { continuationFanoutMode: options.fanoutMode } : {},
										...spawnTraceparent ? { traceparent: spawnTraceparent } : {}
									}, {
										agentSessionKey: sessionKey,
										agentChannel: followupRun.originatingChannel ?? void 0,
										agentAccountId: followupRun.originatingAccountId ?? void 0,
										agentTo: followupRun.originatingTo ?? void 0,
										agentThreadId: followupRun.originatingThreadId ?? void 0
									});
									if (spawnResult.status === "accepted") {
										if (options?.timerTriggered) defaultRuntime.log(`DELEGATE timer fired and spawned turn ${plannedHop}/${maxChainLength} for session ${sessionKey}: ${task}`);
										const { chainId: persistedChainId } = await persistContinuationChainState({
											count: Math.max(activeSessionEntry?.continuationChainCount ?? 0, plannedHop),
											startedAt: options?.startedAt ?? chainStartedAt,
											tokens: Math.max(accumulatedChainTokens, activeSessionEntry?.continuationChainTokens ?? 0)
										});
										if (dispatchSpan) {
											if (persistedChainId !== void 0) dispatchSpan.setAttributes({ "chain.id": persistedChainId });
											dispatchSpan.setStatus("OK");
										}
										enqueueSystemEvent(`[continuation:delegate-spawned] Spawned turn ${plannedHop}/${maxChainLength}: ${task}`, {
											sessionKey,
											trusted: true
										});
										return true;
									}
									defaultRuntime.log(`DELEGATE spawn rejected (${spawnResult.status}) for session ${sessionKey}`);
									dispatchSpan?.setStatus("ERROR", spawnResult.status);
									enqueueSystemEvent(`[continuation] DELEGATE spawn ${spawnResult.status}: delegation was not accepted. Use sessions_spawn manually. Original task: ${task}`, {
										sessionKey,
										trusted: true
									});
									return false;
								} catch (err) {
									dispatchSpan?.recordException(err);
									dispatchSpan?.setStatus("ERROR", String(err));
									defaultRuntime.log(`DELEGATE spawn failed for session ${sessionKey}: ${String(err)}`);
									enqueueSystemEvent(`[continuation] DELEGATE spawn failed: ${String(err)}. Original task: ${task}`, {
										sessionKey,
										trusted: true
									});
									return false;
								} finally {
									dispatchSpan?.end();
								}
							};
							if (delegateDelayMs && delegateDelayMs > 0) {
								if (!rejectCrossSessionTargeting({
									...effectiveContinuationSignal.targetSessionKey ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey } : {},
									...effectiveContinuationSignal.targetSessionKeys && effectiveContinuationSignal.targetSessionKeys.length > 0 ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys } : {},
									...effectiveContinuationSignal.fanoutMode ? { fanoutMode: effectiveContinuationSignal.fanoutMode } : {}
								}, {
									plannedHop: nextChainCount,
									task: delegateTask,
									delegateDelivery: "timer",
									...effectiveContinuationSignal.silent ? { silent: effectiveContinuationSignal.silent } : {},
									...effectiveContinuationSignal.silentWake ? { silentWake: effectiveContinuationSignal.silentWake } : {}
								})) {
									const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, delegateDelayMs));
									const outboundTraceparent = resolveContinuationTraceparent(effectiveContinuationSignal.traceparent);
									const reservationId = generateSecureUuid();
									addDelayedContinuationReservation(sessionKey, {
										id: reservationId,
										source: "bracket",
										task: delegateTask,
										createdAt: chainStartedAt,
										fireAt: Date.now() + clampedDelay,
										plannedHop: nextChainCount,
										silent: effectiveContinuationSignal.silent,
										silentWake: effectiveContinuationSignal.silentWake,
										...effectiveContinuationSignal.targetSessionKey ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey } : {},
										...effectiveContinuationSignal.targetSessionKeys && effectiveContinuationSignal.targetSessionKeys.length > 0 ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys } : {},
										...effectiveContinuationSignal.fanoutMode ? { fanoutMode: effectiveContinuationSignal.fanoutMode } : {},
										...outboundTraceparent ? { traceparent: outboundTraceparent } : {}
									});
									const { chainId: persistedChainIdForTimer } = await persistContinuationChainState({
										count: currentChainCount,
										startedAt: chainStartedAt,
										tokens: accumulatedChainTokens
									});
									{
										const delegateMode = effectiveContinuationSignal.silentWake ? "silent-wake" : effectiveContinuationSignal.silent ? "silent" : "normal";
										emitContinuationDelegateSpan({
											chainId: persistedChainIdForTimer,
											chainStepRemaining: maxChainLength - nextChainCount,
											delayMs: clampedDelay,
											delivery: "timer",
											delegateMode,
											traceparent: outboundTraceparent,
											log: (message) => defaultRuntime.log(message)
										});
									}
									const fireDelegateMode = effectiveContinuationSignal.silentWake ? "silent-wake" : effectiveContinuationSignal.silent ? "silent" : "normal";
									const chainStepRemainingAtDispatch = maxChainLength - nextChainCount;
									retainContinuationTimerRef(sessionKey);
									const armedAt = Date.now();
									const timerHandle = setTimeout(() => {
										emitContinuationDelegateFireSpan({
											chainId: persistedChainIdForTimer,
											chainStepRemainingAtDispatch,
											delegateMode: fireDelegateMode,
											delayMs: clampedDelay,
											fireDeferredMs: Date.now() - armedAt,
											log: (message) => defaultRuntime.log(message)
										});
										try {
											const reservation = takeDelayedContinuationReservation(sessionKey, reservationId);
											if (!reservation) {
												defaultRuntime.log(`DELEGATE timer fired but reservation already cleared for session ${sessionKey}`);
												emitContinuationDisabledSpan({
													chainId: persistedChainIdForTimer,
													chainStepRemaining: chainStepRemainingAtDispatch,
													disabledReason: "reservation.missing",
													signalKind: "bracket-delegate",
													delegateDelivery: "timer",
													delegateMode: fireDelegateMode,
													log: (message) => defaultRuntime.log(message)
												});
												return;
											}
											doSpawn(reservation.plannedHop, reservation.task, {
												timerTriggered: true,
												silent: reservation.silent,
												silentWake: reservation.silentWake,
												startedAt: reservation.createdAt,
												...reservation.targetSessionKey ? { targetSessionKey: reservation.targetSessionKey } : {},
												...reservation.targetSessionKeys && reservation.targetSessionKeys.length > 0 ? { targetSessionKeys: reservation.targetSessionKeys } : {},
												...reservation.fanoutMode ? { fanoutMode: reservation.fanoutMode } : {},
												...reservation.traceparent ? { traceparent: reservation.traceparent } : {}
											});
										} finally {
											unregisterContinuationTimerHandle(sessionKey, timerHandle);
										}
									}, clampedDelay);
									registerContinuationTimerHandle(sessionKey, timerHandle);
									timerHandle.unref();
								}
							} else await doSpawn(nextChainCount, delegateTask, {
								silent: effectiveContinuationSignal.silent,
								silentWake: effectiveContinuationSignal.silentWake,
								startedAt: chainStartedAt,
								...effectiveContinuationSignal.targetSessionKey ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey } : {},
								...effectiveContinuationSignal.targetSessionKeys && effectiveContinuationSignal.targetSessionKeys.length > 0 ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys } : {},
								...effectiveContinuationSignal.fanoutMode ? { fanoutMode: effectiveContinuationSignal.fanoutMode } : {},
								...effectiveContinuationSignal.traceparent ? { traceparent: effectiveContinuationSignal.traceparent } : {}
							});
						} else {
							const { chainId: persistedChainId } = await persistContinuationChainState({
								count: nextChainCount,
								startedAt: chainStartedAt,
								tokens: accumulatedChainTokens
							});
							const requestedDelay = effectiveContinuationSignal.delayMs ?? defaultDelayMs;
							const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, requestedDelay));
							emitContinuationWorkSpan({
								chainId: persistedChainId,
								chainStepRemaining: maxChainLength - nextChainCount,
								delayMs: clampedDelay,
								reason: continuationWorkReason,
								traceparent: effectiveContinuationSignal.traceparent,
								log: (message) => defaultRuntime.log(message)
							});
							retainContinuationTimerRef(sessionKey);
							const persistedChainIdForWorkTimer = persistedChainId;
							const workChainStepRemainingAtDispatch = maxChainLength - nextChainCount;
							const workArmedAt = Date.now();
							const timerHandle = setTimeout(() => {
								try {
									emitContinuationWorkFireSpan({
										chainId: persistedChainIdForWorkTimer,
										chainStepRemainingAtDispatch: workChainStepRemainingAtDispatch,
										delayMs: clampedDelay,
										fireDeferredMs: Date.now() - workArmedAt,
										reason: continuationWorkReason,
										log: (message) => defaultRuntime.log(message)
									});
									defaultRuntime.log(`WORK timer fired for session ${sessionKey}`);
									enqueueSystemEvent(`[continuation:wake] Turn ${nextChainCount}/${maxChainLength}. Chain started at ${new Date(chainStartedAt).toISOString()}. Accumulated tokens: ${accumulatedChainTokens}. The agent elected to continue working.` + (continuationWorkReason ? ` Reason: ${continuationWorkReason}` : ""), {
										sessionKey,
										trusted: true
									});
									requestHeartbeatNow({
										sessionKey,
										reason: "continuation",
										parentRunId: runId
									});
								} finally {
									unregisterContinuationTimerHandle(sessionKey, timerHandle);
								}
							}, clampedDelay);
							registerContinuationTimerHandle(sessionKey, timerHandle);
							timerHandle.unref();
						}
					}
				}
			}
		}
		if (continuationFeatureEnabled && sessionKey) {
			const toolDelegates = consumePendingDelegates(sessionKey);
			if (toolDelegates.length > 0) defaultRuntime.log(`[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}`);
			if (toolDelegates.length > 0) {
				const { maxChainLength, costCapTokens, maxDelegatesPerTurn, crossSessionTargeting } = resolveLiveContinuationRuntimeConfig(cfg);
				const bracketDelegateCount = effectiveContinuationSignal?.kind === "delegate" ? 1 : 0;
				const remainingBudget = Math.max(0, maxDelegatesPerTurn - bracketDelegateCount);
				const delegatesWithinLimit = toolDelegates.slice(0, remainingBudget);
				const delegatesOverLimit = toolDelegates.slice(remainingBudget);
				for (const droppedDelegate of delegatesOverLimit) {
					enqueueSystemEvent(`[continuation] Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}). Task: ${droppedDelegate.task}`, {
						sessionKey,
						trusted: true
					});
					{
						const delegateMode = droppedDelegate.mode ?? "normal";
						const delegateDelivery = droppedDelegate.delayMs && droppedDelegate.delayMs > 0 ? "timer" : "immediate";
						emitContinuationDisabledSpan({
							chainId: activeSessionEntry?.continuationChainId,
							chainStepRemaining: Math.max(0, maxChainLength - (activeSessionEntry?.continuationChainCount ?? 0)),
							disabledReason: "cap.delegates_per_turn",
							signalKind: "tool-delegate",
							delegateDelivery,
							delegateMode,
							reason: droppedDelegate.task,
							log: defaultRuntime.log
						});
					}
				}
				let currentChainCount = activeSessionEntry?.continuationChainCount ?? 0;
				const bracketAlreadyAccumulated = bracketTokensAccumulated;
				const toolDelegateUsage = runResult.meta?.agentMeta?.usage;
				const toolDelegateTurnTokens = bracketAlreadyAccumulated ? 0 : (toolDelegateUsage?.input ?? 0) + (toolDelegateUsage?.output ?? 0);
				let accumulatedChainTokens = (activeSessionEntry?.continuationChainTokens ?? 0) + toolDelegateTurnTokens;
				const chainStartedAt = activeSessionEntry?.continuationChainStartedAt ?? Date.now();
				for (const delegate of delegatesWithinLimit) {
					const allocatedChainHop = Math.max(currentChainCount, highestDelayedContinuationReservationHop(sessionKey));
					if (crossSessionTargeting === "disabled" && hasCrossSessionDelegateTargeting(delegate, sessionKey)) {
						const delegateMode = delegate.mode ?? "normal";
						const delegateDelivery = delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
						defaultRuntime.log(`[continuation] Cross-session targeting rejected by policy for tool delegate in session ${sessionKey}`);
						enqueueSystemEvent(`[continuation] Tool delegate rejected: cross-session targeting is disabled by policy. Use the default return target, targetSessionKey set to this session, or fanoutMode="tree". Task: ${delegate.task}`, {
							sessionKey,
							trusted: true
						});
						emitContinuationDisabledSpan({
							chainId: activeSessionEntry?.continuationChainId,
							chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
							disabledReason: "policy.cross_session_targeting",
							signalKind: "tool-delegate",
							delegateDelivery,
							delegateMode,
							reason: delegate.task,
							log: defaultRuntime.log
						});
						continue;
					}
					if (allocatedChainHop >= maxChainLength) {
						defaultRuntime.log(`Continuation chain capped at ${maxChainLength} for tool delegate in session ${sessionKey}`);
						enqueueSystemEvent(`[continuation] Tool delegate rejected: chain length ${maxChainLength} reached. Task: ${delegate.task}`, {
							sessionKey,
							trusted: true
						});
						{
							const delegateMode = delegate.mode ?? "normal";
							const delegateDelivery = delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
							emitContinuationDisabledSpan({
								chainId: activeSessionEntry?.continuationChainId,
								chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
								disabledReason: "cap.chain",
								signalKind: "tool-delegate",
								delegateDelivery,
								delegateMode,
								reason: delegate.task,
								log: defaultRuntime.log
							});
						}
						break;
					}
					if (costCapTokens > 0 && accumulatedChainTokens > costCapTokens) {
						defaultRuntime.log(`Continuation cost cap exceeded for tool delegate in session ${sessionKey}`);
						enqueueSystemEvent(`[continuation] Tool delegate rejected: cost cap exceeded (${accumulatedChainTokens} > ${costCapTokens}). Task: ${delegate.task}`, {
							sessionKey,
							trusted: true
						});
						{
							const delegateMode = delegate.mode ?? "normal";
							const delegateDelivery = delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
							emitContinuationDisabledSpan({
								chainId: activeSessionEntry?.continuationChainId,
								chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
								disabledReason: "cap.cost",
								signalKind: "tool-delegate",
								delegateDelivery,
								delegateMode,
								reason: delegate.task,
								log: defaultRuntime.log
							});
						}
						break;
					}
					const nextChainCount = allocatedChainHop + 1;
					const doToolSpawn = async (plannedHop, task, options) => {
						let dispatchSpan;
						try {
							const outboundTraceparent = resolveContinuationTraceparent(options?.traceparent);
							const delegateMode = options?.silentWake ? "silent-wake" : options?.silent ? "silent" : "normal";
							if (!options?.timerTriggered) dispatchSpan = startContinuationDelegateSpan({
								chainId: void 0,
								chainStepRemaining: maxChainLength - plannedHop,
								delayMs: 0,
								delivery: "immediate",
								delegateMode,
								traceparent: outboundTraceparent,
								log: (message) => defaultRuntime.log(message)
							});
							const spawnTraceparent = dispatchSpan?.traceparent?.() ?? outboundTraceparent;
							const spawnResult = await spawnSubagentDirect({
								task: `[continuation:chain-hop:${plannedHop}] Delegated task (turn ${plannedHop}/${maxChainLength}): ${task}`,
								...options?.silent ? { silentAnnounce: true } : {},
								...options?.silentWake ? {
									silentAnnounce: true,
									wakeOnReturn: true
								} : {},
								drainsContinuationDelegateQueue: true,
								...options?.targetSessionKey ? { continuationTargetSessionKey: options.targetSessionKey } : {},
								...options?.targetSessionKeys && options.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: options.targetSessionKeys } : {},
								...options?.fanoutMode ? { continuationFanoutMode: options.fanoutMode } : {},
								...spawnTraceparent ? { traceparent: spawnTraceparent } : {}
							}, {
								agentSessionKey: sessionKey,
								agentChannel: followupRun.originatingChannel ?? void 0,
								agentAccountId: followupRun.originatingAccountId ?? void 0,
								agentTo: followupRun.originatingTo ?? void 0,
								agentThreadId: followupRun.originatingThreadId ?? void 0
							});
							if (spawnResult.status === "accepted") {
								if (options?.timerTriggered) defaultRuntime.log(`Tool DELEGATE timer fired and spawned turn ${plannedHop}/${maxChainLength} for session ${sessionKey}: ${task}`);
								currentChainCount = Math.max(currentChainCount, plannedHop);
								const { chainId: persistedChainId } = await persistContinuationChainState({
									count: currentChainCount,
									startedAt: options?.startedAt ?? chainStartedAt,
									tokens: Math.max(accumulatedChainTokens, activeSessionEntry?.continuationChainTokens ?? 0)
								});
								if (dispatchSpan) {
									if (persistedChainId !== void 0) dispatchSpan.setAttributes({ "chain.id": persistedChainId });
									dispatchSpan.setStatus("OK");
								}
								enqueueSystemEvent(`[continuation:delegate-spawned] Tool delegate turn ${plannedHop}/${maxChainLength}: ${task}`, {
									sessionKey,
									trusted: true
								});
								return true;
							}
							defaultRuntime.log(`Tool DELEGATE spawn rejected (${spawnResult.status}) for session ${sessionKey}`);
							dispatchSpan?.setStatus("ERROR", spawnResult.status);
							enqueueSystemEvent(`[continuation] Tool DELEGATE spawn ${spawnResult.status}: ${task}`, {
								sessionKey,
								trusted: true
							});
							return false;
						} catch (err) {
							dispatchSpan?.recordException(err);
							dispatchSpan?.setStatus("ERROR", String(err));
							defaultRuntime.log(`Tool DELEGATE spawn failed for session ${sessionKey}: ${String(err)}`);
							enqueueSystemEvent(`[continuation] Tool DELEGATE spawn failed: ${String(err)}. Task: ${task}`, {
								sessionKey,
								trusted: true
							});
							return false;
						} finally {
							dispatchSpan?.end();
						}
					};
					await doToolSpawn(nextChainCount, delegate.task, {
						silent: delegate.mode === "silent" || delegate.mode === "silent-wake",
						silentWake: delegate.mode === "silent-wake",
						startedAt: chainStartedAt,
						...delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {},
						...delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0 ? { targetSessionKeys: delegate.targetSessionKeys } : {},
						...delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {},
						...delegate.traceparent ? { traceparent: delegate.traceparent } : {}
					});
				}
			}
		}
		if (!autoCompactionCount && continuationFeatureEnabled && sessionKey) {
			const stagedCompactionDelegates = consumeStagedPostCompactionDelegates(sessionKey);
			if (stagedCompactionDelegates.length > 0) try {
				await persistPendingPostCompactionDelegates({
					sessionEntry: activeSessionEntry,
					sessionStore: activeSessionStore,
					sessionKey,
					storePath,
					delegates: stagedCompactionDelegates
				});
			} catch (err) {
				postCompactionDelegatesToPreserve.push(...stagedCompactionDelegates);
				defaultRuntime.log(`Failed to persist post-compaction delegates for ${sessionKey} (re-staged ${stagedCompactionDelegates.length}): ${String(err)}`);
			}
		}
		if (wasSilentContinuation) return returnWithQueuedFollowupDrain(void 0);
		let toolDelegateDispatchResult;
		if (continuationFeatureEnabled && sessionKey) {
			const turnTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
			const { dispatchToolDelegates, loadContinuationChainState } = await import("./auto-reply/continuation/lazy.runtime.js");
			toolDelegateDispatchResult = await dispatchToolDelegates({
				sessionKey,
				chainState: loadContinuationChainState(activeSessionEntry, turnTokens),
				ctx: {
					sessionKey,
					agentChannel: followupRun.originatingChannel ?? void 0,
					agentAccountId: followupRun.originatingAccountId ?? void 0,
					agentTo: followupRun.originatingTo ?? void 0,
					agentThreadId: followupRun.originatingThreadId ?? void 0
				},
				maxChainLength: resolveLiveContinuationRuntimeConfig(cfg).maxChainLength,
				loadFreshChainState: () => loadContinuationChainState(activeSessionEntry, 0)
			});
		}
		if ((effectiveContinuationSignal || hasQueuedDelegateWork) && sessionKey && activeSessionEntry) {
			const { loadContinuationChainState } = await import("./auto-reply/continuation/lazy.runtime.js");
			const turnTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
			const nextState = toolDelegateDispatchResult?.chainState ?? loadContinuationChainState(activeSessionEntry, turnTokens);
			await persistContinuationChainState({
				count: nextState.currentChainCount,
				startedAt: nextState.chainStartedAt,
				tokens: nextState.accumulatedChainTokens
			});
		}
		if (finalPayloads.length === 0 && effectiveContinuationSignal) return returnWithQueuedFollowupDrain(void 0);
		if (sessionKey && storePath && finalPayloads.length > 0) {
			const sendPolicy = resolveSendPolicy({
				cfg,
				entry: activeSessionEntry,
				sessionKey: params.runtimePolicySessionKey ?? sessionKey,
				channel: sessionCtx.OriginatingChannel ?? sessionCtx.Surface ?? sessionCtx.Provider ?? activeSessionEntry?.channel,
				chatType: activeSessionEntry?.chatType
			});
			const pendingText = resolveSourceReplyVisibilityPolicy({
				cfg,
				ctx: sessionCtx,
				requested: opts?.sourceReplyDeliveryMode,
				sendPolicy
			}).suppressDelivery ? "" : buildPendingFinalDeliveryText(finalPayloads);
			const agentId = followupRun.run.agentId;
			const heartbeatAgentCfg = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : void 0;
			const heartbeatAckMaxChars = Math.max(0, heartbeatAgentCfg?.ackMaxChars ?? cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? 300);
			const resolvedPendingText = isHeartbeat ? (() => {
				const stripped = stripHeartbeatToken(pendingText, {
					mode: "heartbeat",
					maxAckChars: heartbeatAckMaxChars
				});
				return stripped.shouldSkip ? "" : stripped.text || pendingText;
			})() : pendingText;
			if (resolvedPendingText) await updateSessionStoreEntry({
				storePath,
				sessionKey,
				update: async () => ({
					pendingFinalDelivery: true,
					pendingFinalDeliveryText: resolvedPendingText,
					pendingFinalDeliveryCreatedAt: Date.now(),
					updatedAt: Date.now()
				})
			});
		}
		return returnWithQueuedFollowupDrain(finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads);
	} catch (error) {
		if (replyOperation.result?.kind === "aborted" && replyOperation.result.code === "aborted_for_restart") return returnWithQueuedFollowupDrain(markReplyPayloadForSourceSuppressionDelivery({ text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." }));
		if (replyOperation.result?.kind === "aborted") return returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
		if (error instanceof GatewayDrainingError) {
			replyOperation.fail("gateway_draining", error);
			return returnWithQueuedFollowupDrain(markReplyPayloadForSourceSuppressionDelivery({ text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." }));
		}
		if (error instanceof CommandLaneClearedError) {
			replyOperation.fail("command_lane_cleared", error);
			return returnWithQueuedFollowupDrain(markReplyPayloadForSourceSuppressionDelivery({ text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." }));
		}
		const knownFailurePayload = buildKnownAgentRunFailureReplyPayload({
			err: error,
			sessionCtx,
			resolvedVerboseLevel,
			cfg
		});
		if (knownFailurePayload) {
			replyOperation.fail("run_failed", error);
			return returnWithQueuedFollowupDrain(knownFailurePayload);
		}
		replyOperation.fail("run_failed", error);
		returnWithQueuedFollowupDrain(void 0);
		throw error;
	} finally {
		if (shouldDrainQueuedFollowupsAfterClear) replyOperation.completeThen(drainQueuedFollowupsAfterClear);
		else replyOperation.complete();
		blockReplyPipeline?.stop();
		typing.markRunComplete();
		if (sessionKey) {
			consumePendingDelegates(sessionKey);
			consumeStagedPostCompactionDelegates(sessionKey);
			for (const delegate of postCompactionDelegatesToPreserve) stagePostCompactionDelegate(sessionKey, delegate);
		}
		typing.markDispatchIdle();
	}
}
//#endregion
export { resolveSilentReplySettings as a, resolveTypingMode as i, runReplyAgent as n, resolveActiveRunQueueAction as r, cancelContinuationTimer as t };
