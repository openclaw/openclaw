import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, t as hasNonEmptyString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { C as hasSessionAutoModelFallbackProvenance, i as markAutoFallbackPrimaryProbe, n as entryMatchesAutoFallbackPrimaryProbe, p as resolveAutoFallbackPrimaryProbe, t as clearAutoFallbackPrimaryProbeSelection } from "./agent-scope-CtLXGcWm.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { o as isDiagnosticsEnabled } from "./diagnostic-events-BLgzARSp.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { f as resolveMessageChannel, i as isMarkdownCapableMessageChannel, r as isInternalMessageChannel } from "./message-channel-CYCKkVrh.js";
import { l as resolveOpenAIRuntimeProviderForPi } from "./openai-codex-routing-DwRY-_VI.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { i as emitAgentEvent, l as onAgentEvent, u as registerAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { b as resolveGroupSessionKey, u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import { l as resolvePersistedOverrideModelRef } from "./model-selection-P-81eBKx.js";
import { d as sanitizeUserFacingText, i as formatRateLimitOrOverloadedErrorCopy, t as BILLING_ERROR_USER_MESSAGE } from "./sanitize-user-facing-text-Df1D-hzs.js";
import { i as isOverloadedErrorMessage, o as isRateLimitErrorMessage, r as isBillingErrorMessage } from "./failover-matches-C-tab7FS.js";
import { d as logSessionTurnCreated } from "./diagnostic-DEgTYLXt.js";
import { a as isSilentReplyText, i as isSilentReplyPrefixText, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripLeadingSilentToken } from "./tokens-CFv3Qu_v.js";
import { o as resolveContextTokensForModel } from "./context-L0xQd5wI.js";
import { n as GatewayDrainingError, t as CommandLaneClearedError } from "./command-queue-Da2Lh3Ua.js";
import { l as markReplyPayloadForSourceSuppressionDelivery, r as copyReplyPayloadMetadata } from "./reply-payload-CiT5mlcY.js";
import { m as resolveSendableOutboundReplyParts, s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
import "./selection-hR-AeOeU.js";
import { d as stripHeartbeatToken } from "./heartbeat-6oYmHVVQ.js";
import { l as resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget-WP_UMPQC.js";
import "./pi-embedded-helpers-bmljPI1n.js";
import { n as classifyOAuthRefreshFailure, t as buildOAuthRefreshFailureLoginCommand } from "./oauth-refresh-failure-szcD_aib.js";
import { d as isContextOverflowError, g as isLikelyContextOverflowError, u as isCompactionFailureError, y as isTransientHttpError } from "./errors-DYND-qcd.js";
import { G as isMessagingToolSendAction } from "./attempt.tool-run-context-QAUT7ucg.js";
import { d as parseReplyDirectives } from "./payloads-BOM5t2O4.js";
import { o as LiveSessionModelSwitchError, r as runWithModelFallback, t as isFallbackSummaryError } from "./model-fallback-BCpDvqqS.js";
import { i as isRenderablePayload, t as applyReplyTagsToPayload } from "./reply-payloads-MDazU9oj.js";
import { c as resolveCliRuntimeExecutionProvider, o as listLegacyRuntimeModelProviderAliases } from "./model-runtime-aliases-D35Lx2no.js";
import { r as getCliSessionBinding } from "./cli-session-FftCLDUT.js";
import { t as ensureSelectedAgentHarnessPlugin } from "./runtime-plugin-VHkAKsBb.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CsSFzly6.js";
import { n as buildAgentRuntimeOutcomePlan } from "./build-CsBPGY-v.js";
import { n as resolveSilentReplyPolicy, t as resolveCurrentTurnImages } from "./current-turn-images-Ce6AQNAO.js";
import { c as resolveRunAuthProfile, o as resolveQueuedReplyRuntimeConfig, s as resolveModelFallbackOptions, t as buildEmbeddedRunExecutionParams } from "./agent-runner-utils-Ues7rde4.js";
import { t as runCliAgent } from "./cli-runner-BZsJFWmR.js";
import { n as HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, t as GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "./agent-runner-failure-copy-CU6Vmacs.js";
import { n as resolveOriginMessageProvider } from "./origin-routing-BrwjqMJ_.js";
import { n as createBlockReplyContentKey } from "./block-reply-pipeline-rWq9jszq.js";
import { t as createReplyMediaContext } from "./reply-media-paths.runtime-DYciI0K5.js";
import crypto from "node:crypto";
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
//#region src/auto-reply/reply/provider-request-error-classifier.ts
const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE = "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";
function classifyProviderRequestError(err) {
	const technicalMessage = formatErrorMessage(err);
	if (isProviderConversationStateErrorMessage(technicalMessage)) return {
		code: "provider_conversation_state_error",
		userMessage: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
		technicalMessage
	};
}
function isProviderConversationStateErrorMessage(message) {
	const lower = normalizeLowercaseStringOrEmpty(message);
	return lower.includes("custom tool call output is missing") && lower.includes("call id") || lower.includes("toolresult") && lower.includes("tooluse") && lower.includes("exceeds the number") && lower.includes("previous turn") || lower.includes("function call turn comes immediately after") || lower.includes("incorrect role information") || lower.includes("roles must alternate");
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
		if (normalized.isSilent) mediaNormalizedPayload.text = void 0;
		const blockPayload = copyReplyPayloadMetadata(payload, params.applyReplyToMode(mediaNormalizedPayload));
		const blockHasNonTextContent = hasOutboundReplyContent({
			...blockPayload,
			text: void 0
		});
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
	if (isFallbackSummaryError(err) && hasBillingAttemptSummary(err)) return BILLING_ERROR_USER_MESSAGE;
	if (isBillingErrorMessage(formatErrorMessage(err))) return BILLING_ERROR_USER_MESSAGE;
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
function hasBillingAttemptSummary(err) {
	return isFallbackSummaryError(err) && err.attempts.length > 0 && err.attempts.some((attempt) => attempt.reason === "billing");
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
const CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE = /\bcodex app-server client closed before turn completed\b/iu;
const CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE = /\bcodex app-server turn idle timed out waiting for turn\/completed\b/iu;
function buildCodexAppServerFailureText(message) {
	const normalizedMessage = collapseRepeatedFailureDetail(message);
	if (CODEX_APP_SERVER_CLIENT_CLOSED_BEFORE_REPLY_RE.test(normalizedMessage)) return "⚠️ Codex app-server connection closed before this turn finished. OpenClaw retried once when the stdio turn was still replay-safe; please try again if this keeps happening.";
	if (CODEX_APP_SERVER_TURN_COMPLETION_IDLE_TIMEOUT_RE.test(normalizedMessage)) return "⚠️ Codex app-server stopped before confirming turn completion. OpenClaw did not replay the turn automatically because it may still be active; try again, or use /new if the session stays stuck.";
	return null;
}
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
	const providerRequestError = classifyProviderRequestError(normalizedMessage);
	if (providerRequestError) return {
		text: providerRequestError.userMessage,
		isGenericRunnerFailure: false
	};
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
	const cliBackendTimeoutFailure = buildCliBackendTimeoutFailureText(normalizedMessage);
	if (cliBackendTimeoutFailure) return {
		text: cliBackendTimeoutFailure,
		isGenericRunnerFailure: false
	};
	const codexAppServerFailure = buildCodexAppServerFailureText(normalizedMessage);
	if (codexAppServerFailure) return {
		text: codexAppServerFailure,
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
	if (isFallbackSummary ? hasBillingAttemptSummary(params.err) : isBillingErrorMessage(message)) return markAgentRunFailureReplyPayload({ text: resolveExternalRunFailureTextForConversation({
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
function normalizePositiveContextTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function resolveAgentContextTokensForHint(params) {
	const defaultContextTokens = normalizePositiveContextTokens(params.cfg.agents?.defaults?.contextTokens);
	const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
	return (agentId ? normalizePositiveContextTokens(params.cfg.agents?.list?.find((entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId)?.contextTokens) : void 0) ?? defaultContextTokens;
}
function resolveContextWindowForHint(params) {
	const sessionContextTokens = normalizePositiveContextTokens(params.activeSessionEntry?.contextTokens);
	const contextTokens = resolveContextTokensForModel({
		cfg: params.cfg,
		provider: params.ref.provider,
		model: params.ref.model,
		allowAsyncLoad: false
	}) ?? sessionContextTokens;
	if (contextTokens === void 0) return;
	const agentContextTokens = resolveAgentContextTokensForHint({
		cfg: params.cfg,
		agentId: params.agentId
	});
	return agentContextTokens !== void 0 ? Math.min(agentContextTokens, contextTokens) : contextTokens;
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
		agentId: params.agentId,
		ref: runtimeRef,
		activeSessionEntry: params.activeSessionEntry
	});
	const primaryWindow = resolveContextWindowForHint({
		cfg: params.cfg,
		agentId: params.agentId,
		ref: primaryRef
	});
	if (typeof runtimeWindow === "number" && typeof primaryWindow === "number" && runtimeWindow >= primaryWindow) return;
	return `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}${typeof runtimeWindow === "number" && runtimeWindow > 0 ? ` (${formatContextWindowLabel(runtimeWindow)} context)` : ""} instead of ${primaryProvider}/${primaryModel}. This matches the configured \`heartbeat.model\`, so the overflow is likely heartbeat model bleed rather than a compaction-buffer problem. Set \`heartbeat.isolatedSession: true\`, enable \`heartbeat.lightContext: true\`, or use a heartbeat model with a larger context window.`;
}
function buildContextOverflowRecoveryText(params) {
	return (params.preserveSessionMapping ? "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session." : params.duringCompaction ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again." : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.") + (resolveHeartbeatBleedHint({
		cfg: params.cfg,
		agentId: params.agentId,
		primaryProvider: params.primaryProvider,
		primaryModel: params.primaryModel,
		activeSessionEntry: params.activeSessionEntry
	}) ?? CONTEXT_OVERFLOW_RESET_HINT);
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
	if (isDiagnosticsEnabled(runtimeConfig)) logSessionTurnCreated({
		runId,
		sessionKey: params.sessionKey,
		sessionId: params.followupRun.run.sessionId,
		agentId: params.followupRun.run.agentId,
		channel: params.followupRun.run.messageProvider ?? params.sessionCtx.Surface ?? params.sessionCtx.Provider,
		trigger: params.isHeartbeat ? "heartbeat" : "user"
	});
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
	const currentTurnImages = await resolveCurrentTurnImages({
		ctx: params.sessionCtx,
		cfg: runtimeConfig,
		images: params.followupRun.images ?? params.opts?.images,
		imageOrder: params.followupRun.imageOrder ?? params.opts?.imageOrder
	});
	let didNotifyAgentRunStart = false;
	const notifyAgentRunStart = () => {
		if (didNotifyAgentRunStart) return;
		didNotifyAgentRunStart = true;
		params.opts?.onAgentRunStart?.(runId);
	};
	const currentMessageId = params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
	const shouldNotifyUserAboutCompaction = runtimeConfig?.agents?.defaults?.compaction?.notifyUser === true;
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
		let messageToolOnlyDeliveryCompleted = false;
		const messageToolOnlyDeliveryToolCallIds = /* @__PURE__ */ new Set();
		const sourceRepliesAreToolOnly = params.followupRun.run.sourceReplyDeliveryMode === "message_tool_only";
		const shouldSuppressProgressAfterMessageToolDelivery = () => sourceRepliesAreToolOnly && messageToolOnlyDeliveryCompleted;
		const onToolResult = params.opts?.onToolResult;
		const outcomePlan = buildAgentRuntimeOutcomePlan();
		const runLane = "main";
		let queuedUserMessagePersistedAcrossFallback = false;
		let assistantErrorPersistedAcrossFallback = false;
		const fallbackResult = await runWithModelFallback({
			...resolveModelFallbackOptions(effectiveRun, runtimeConfig),
			runId,
			sessionId: params.followupRun.run.sessionId,
			lane: runLane,
			resolveAgentHarnessRuntimeOverride: (provider) => resolveSessionRuntimeOverrideForProvider({
				provider,
				entry: params.getActiveSessionEntry()
			}),
			prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
				await ensureSelectedAgentHarnessPlugin({
					config: runtimeConfig,
					provider,
					modelId: model,
					agentId: params.followupRun.run.agentId,
					sessionKey: params.followupRun.run.runtimePolicySessionKey ?? params.sessionKey,
					agentHarnessRuntimeOverride,
					workspaceDir: params.followupRun.run.workspaceDir
				});
			},
			onFallbackStep: (step) => {
				emitModelFallbackStepLifecycle({
					runId,
					sessionKey: params.sessionKey,
					step
				});
			},
			classifyResult: async ({ result, provider, model }) => {
				const classification = outcomePlan.classifyRunResult({
					result,
					provider,
					model,
					hasDirectlySentBlockReply: directlySentBlockKeys.size > 0,
					hasBlockReplyPipelineOutput: Boolean(blockReplyPipeline?.hasBuffered() || blockReplyPipeline?.didStream())
				});
				if (classification) await rollbackClassifiedFallbackCandidateSelection(provider, model);
				return classification;
			},
			run: async (provider, model, runOptions) => {
				const suppressQueuedUserPersistenceForCandidate = (params.followupRun.run.suppressNextUserMessagePersistence ?? false) || queuedUserMessagePersistedAcrossFallback;
				const suppressAssistantErrorPersistenceForCandidate = assistantErrorPersistedAcrossFallback;
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
				const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, { config: runtimeConfig });
				const cliExecutionProvider = sessionRuntimeOverride === "pi" ? provider : (sessionRuntimeOverride && isCliProvider(sessionRuntimeOverride, runtimeConfig) ? sessionRuntimeOverride : void 0) ?? resolveCliRuntimeExecutionProvider({
					provider,
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					modelId: model,
					authProfileId: selectedAuthProfile.authProfileId
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
							images: currentTurnImages.images,
							imageOrder: currentTurnImages.imageOrder,
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
					const lifecycleBackstop = createEmbeddedLifecycleTerminalBackstop({
						runId,
						sessionKey: params.sessionKey
					});
					try {
						const result = await runEmbeddedPiAgent({
							...embeddedContext,
							allowGatewaySubagentBinding: true,
							trigger: params.isHeartbeat ? "heartbeat" : "user",
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
							suppressNextUserMessagePersistence: suppressQueuedUserPersistenceForCandidate,
							onUserMessagePersisted: () => {
								queuedUserMessagePersistedAcrossFallback = true;
							},
							suppressTranscriptOnlyAssistantPersistence: params.followupRun.run.suppressTranscriptOnlyAssistantPersistence,
							suppressAssistantErrorPersistence: suppressAssistantErrorPersistenceForCandidate,
							onAssistantErrorMessagePersisted: () => {
								assistantErrorPersistedAcrossFallback = true;
							},
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
							images: currentTurnImages.images,
							imageOrder: currentTurnImages.imageOrder,
							abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
							replyOperation: params.replyOperation,
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
								if (evt.stream === "tool") {
									const phase = readStringValue(evt.data.phase) ?? "";
									const name = readStringValue(evt.data.name);
									const toolCallId = readStringValue(evt.data.toolCallId) ?? "";
									const args = evt.data.args && typeof evt.data.args === "object" ? evt.data.args : void 0;
									if (sourceRepliesAreToolOnly && toolCallId && name && (phase === "start" || phase === "update") && args && isMessagingToolSendAction(name, args)) messageToolOnlyDeliveryToolCallIds.add(toolCallId);
									if (shouldSuppressProgressAfterMessageToolDelivery()) return;
									if (phase === "start" || phase === "update") {
										const toolStartProgressPromise = params.opts?.onToolStart?.({
											name,
											phase,
											args,
											detailMode: params.toolProgressDetail
										});
										await Promise.all([params.typingSignals.signalToolStart(), toolStartProgressPromise]);
									}
								}
								const suppressItemChannelProgress = evt.stream === "item" && evt.data.suppressChannelProgress === true && Boolean(params.opts?.onToolStart);
								const itemPhase = evt.stream === "item" ? readStringValue(evt.data.phase) : "";
								const itemName = evt.stream === "item" ? readStringValue(evt.data.name) : "";
								const itemStatus = evt.stream === "item" ? readStringValue(evt.data.status) : "";
								const itemToolCallId = evt.stream === "item" ? readStringValue(evt.data.toolCallId) ?? "" : "";
								const completedMessageToolDelivery = sourceRepliesAreToolOnly && itemPhase === "end" && itemStatus === "completed" && itemToolCallId.length > 0 && messageToolOnlyDeliveryToolCallIds.has(itemToolCallId);
								const suppressProgressAfterMessageToolDelivery = shouldSuppressProgressAfterMessageToolDelivery();
								if (completedMessageToolDelivery) {
									messageToolOnlyDeliveryToolCallIds.delete(itemToolCallId);
									messageToolOnlyDeliveryCompleted = true;
								}
								if (evt.stream === "item" && !suppressItemChannelProgress && (!suppressProgressAfterMessageToolDelivery || completedMessageToolDelivery)) await params.opts?.onItemEvent?.({
									itemId: readStringValue(evt.data.itemId),
									kind: readStringValue(evt.data.kind),
									title: readStringValue(evt.data.title),
									name: itemName,
									phase: itemPhase,
									status: itemStatus,
									summary: readStringValue(evt.data.summary),
									progressText: readStringValue(evt.data.progressText),
									meta: readStringValue(evt.data.meta),
									approvalId: readStringValue(evt.data.approvalId),
									approvalSlug: readStringValue(evt.data.approvalSlug)
								});
								if (evt.stream === "plan" && !shouldSuppressProgressAfterMessageToolDelivery()) await params.opts?.onPlanUpdate?.({
									phase: readStringValue(evt.data.phase),
									title: readStringValue(evt.data.title),
									explanation: readStringValue(evt.data.explanation),
									steps: Array.isArray(evt.data.steps) ? evt.data.steps.filter((step) => typeof step === "string") : void 0,
									source: readStringValue(evt.data.source)
								});
								if (evt.stream === "approval" && !shouldSuppressProgressAfterMessageToolDelivery()) await params.opts?.onApprovalEvent?.({
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
								if (evt.stream === "command_output" && !shouldSuppressProgressAfterMessageToolDelivery()) await params.opts?.onCommandOutput?.({
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
								if (evt.stream === "patch" && !shouldSuppressProgressAfterMessageToolDelivery()) await params.opts?.onPatchSummary?.({
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
						return result;
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
		runResult = fallbackResult.result;
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
		if (embeddedError && isContextOverflowError(embeddedError.message)) {
			defaultRuntime.error(`Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${params.sessionKey ?? params.followupRun.run.sessionId}.`);
			params.replyOperation?.fail("run_failed", embeddedError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildContextOverflowRecoveryText({
					preserveSessionMapping: true,
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					primaryProvider: params.followupRun.run.provider,
					primaryModel: params.followupRun.run.model,
					activeSessionEntry: params.getActiveSessionEntry()
				}) })
			};
		}
		if (embeddedError?.kind === "role_ordering") {
			const providerRequestError = classifyProviderRequestError(embeddedError);
			params.replyOperation?.fail("run_failed", embeddedError);
			const embeddedErrorText = formatErrorMessage(embeddedError).replace(/\.\s*$/, "");
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: shouldSurfaceToControlUi ? `⚠️ Agent failed before reply: ${embeddedErrorText}.\nLogs: openclaw logs --follow` : providerRequestError?.userMessage ?? "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session." })
			};
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
		const isBilling = isFallbackSummaryError(err) ? hasBillingAttemptSummary(err) : isBillingErrorMessage(message);
		const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
		const isCompactionFailure = !isBilling && isCompactionFailureError(message);
		const providerRequestError = !isBilling && !shouldSurfaceToControlUi ? classifyProviderRequestError(err) : void 0;
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
		if (isCompactionFailure) {
			defaultRuntime.error(`Auto-compaction failed (${message}). Preserving existing session mapping for ${params.sessionKey ?? params.followupRun.run.sessionId}.`);
			params.replyOperation?.fail("run_failed", err);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: buildContextOverflowRecoveryText({
					duringCompaction: true,
					preserveSessionMapping: true,
					cfg: runtimeConfig,
					agentId: params.followupRun.run.agentId,
					primaryProvider: params.followupRun.run.provider,
					primaryModel: params.followupRun.run.model,
					activeSessionEntry: params.getActiveSessionEntry()
				}) })
			};
		}
		if (providerRequestError) {
			params.replyOperation?.fail("run_failed", err);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: providerRequestError.userMessage })
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
		const externalRunFailureReply = !isBilling && !(isRateLimit && !isOverloadedErrorMessage(message)) && !rateLimitOrOverloadedCopy && !isContextOverflow && !shouldSurfaceToControlUi ? buildExternalRunFailureReply(message, {
			includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
			isHeartbeat: params.isHeartbeat
		}) : void 0;
		const genericFallbackText = params.isHeartbeat ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
		const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
			text: isBilling ? BILLING_ERROR_USER_MESSAGE : isRateLimit && !isOverloadedErrorMessage(message) ? buildRateLimitCooldownMessage(err) : rateLimitOrOverloadedCopy ? rateLimitOrOverloadedCopy : isContextOverflow ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model." : shouldSurfaceToControlUi ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow` : externalRunFailureReply?.text ?? genericFallbackText,
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
	if (finalEmbeddedError && !hasPayloadText) {
		if (isContextOverflowError(finalEmbeddedError.message ?? "")) {
			params.replyOperation?.fail("run_failed", finalEmbeddedError);
			return {
				kind: "final",
				payload: markAgentRunFailureReplyPayload({ text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session." })
			};
		}
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
		directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : void 0
	};
}
//#endregion
export { normalizeReplyPayloadDirectives as a, runAgentTurnWithFallback as i, resolveRunAfterAutoFallbackPrimaryProbeRecheck as n, runCliAgentWithLifecycle as o, resolveSessionRuntimeOverrideForProvider as r, buildKnownAgentRunFailureReplyPayload as t };
