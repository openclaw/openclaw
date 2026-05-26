import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as isAbortError } from "./unhandled-rejections-Km9wbHjh.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { o as resolveAgentWorkspaceDir, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { c as measureDiagnosticsTimelineSpanSync, s as measureDiagnosticsTimelineSpan } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { o as isDiagnosticsEnabled } from "./diagnostic-events-BLgzARSp.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as applyMergePatch } from "./merge-patch-BAO515t_.js";
import { g as normalizeVerboseLevel } from "./thinking-DNSlsULp.js";
import "./message-channel-core-BoUoCGOD.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { n as getGlobalPluginRegistry, t as getGlobalHookRunner, u as fireAndForgetHook } from "./hook-runner-global-BkXXy1ub.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { F as resolveSessionStoreEntry, i as readSessionEntry, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { b as resolveGroupSessionKey, d as updateSessionStoreEntry } from "./store-BmtchQvp.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { t as appendAssistantMessageToSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { a as isNativeCommandTurn, c as resolveCommandTurnTargetSessionKey, s as resolveCommandTurnContext } from "./command-turn-context-BiMylvBj.js";
import { r as resolveSourceReplyVisibilityPolicy, t as isExplicitSourceReplyCommand } from "./source-reply-delivery-mode-Dng9YkQe.js";
import { f as replyRunRegistry, i as createReplyOperation, t as ReplyRunAlreadyActiveError } from "./reply-run-registry-CwZ9EftF.js";
import { a as logMessageProcessed, g as markDiagnosticSessionProgress, i as logMessageDispatchStarted, o as logMessageQueued, r as logMessageDispatchCompleted, s as logMessageReceived, u as logSessionStateChange } from "./diagnostic-DEgTYLXt.js";
import { c as markReplyPayloadAsTtsSupplement, i as getReplyPayloadMetadata, o as isReplyPayloadStatusNotice } from "./reply-payload-CiT5mlcY.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { c as toPluginInboundClaimEvent, i as toInternalMessageReceivedContext, l as toPluginMessageContext, n as deriveInboundMessageHookContext, s as toPluginInboundClaimContext, u as toPluginMessageReceivedEvent } from "./message-hook-mappers-CNfn6PTM.js";
import { m as resolveSendableOutboundReplyParts, s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
import { A as isParentOwnedBackgroundAcpSession } from "./openclaw-tools-QeySpphx.js";
import { h as resolveToolProfilePolicy, l as mergeAlsoAllowPolicy } from "./tool-policy-COX5DaEj.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-C9WqMgmG.js";
import { o as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-mB73wM9t.js";
import { i as resolveInheritedToolPolicyForSession, n as resolveEffectiveToolPolicy, o as resolveSubagentToolPolicyForSession, r as resolveGroupToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { i as selectAgentHarness } from "./selection-hR-AeOeU.js";
import { n as normalizeTtsAutoMode } from "./tts-auto-mode-CHJnGxS9.js";
import { i as shouldCleanTtsDirectiveText, r as shouldAttemptTtsPayload, t as resolveConfiguredTtsMode } from "./tts-config-WOpwhkHq.js";
import { a as buildPluginBindingUnavailableText, b as touchConversationBindingRecord, c as hasShownPluginBindingFallbackNotice, d as markPluginBindingFallbackNoticeShown, h as toPluginConversationBinding, n as buildPluginBindingDeclinedText, r as buildPluginBindingErrorText, u as isPluginOwnedSessionBindingRecord, y as resolveConversationBindingRecord } from "./conversation-binding-CMioKWCr.js";
import { t as resolveChannelModelOverride } from "./model-overrides-CFY_AkZm.js";
import { n as hasActiveApprovalNativeRouteRuntime } from "./approval-native-route-coordinator-7EKM2kRd.js";
import { r as matchPluginCommand } from "./commands-knen7QS8.js";
import { n as resolveSendPolicy } from "./send-policy-Dh6BW0dE.js";
import { t as createTtsDirectiveTextStreamCleaner } from "./directives-DiYOXJC0.js";
import { i as resolveTextCommand, r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
import { r as findCommandByNativeName } from "./commands-registry-Bthd8JBl.js";
import { r as resolveSessionRuntimeOverrideForProvider } from "./agent-runner-execution-BvaszXAD.js";
import { n as resolveOriginMessageProvider } from "./origin-routing-BrwjqMJ_.js";
import { i as resolveConversationBindingContextFromMessage } from "./conversation-binding-input-CG40gdHa.js";
import { d as resolveEffectiveReplyRoute, l as withFullRuntimeReplyConfig, t as resolveRunTypingPolicy } from "./typing-policy-chb9znfJ.js";
import { n as commitInboundDedupe, r as releaseInboundDedupe, t as claimInboundDedupe } from "./inbound-dedupe-CV1givUI.js";
import { n as createReplyDispatcherWithTyping, r as waitForReplyDispatcherIdle, t as createReplyDispatcher } from "./reply-dispatcher-DPt1UxjJ.js";
import { t as resolveRoutedDeliveryThreadId } from "./routed-delivery-thread-BH8x0lSi.js";
import { n as resolveStoredModelOverride } from "./stored-model-override-DwKmC9nn.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import crypto from "node:crypto";
//#region src/auto-reply/dispatch-dispatcher.ts
async function settleReplyDispatcher(params) {
	params.dispatcher.markComplete();
	try {
		await params.dispatcher.waitForIdle();
	} finally {
		await params.onSettled?.();
	}
}
async function withReplyDispatcher(params) {
	try {
		return await params.run();
	} finally {
		await settleReplyDispatcher(params);
	}
}
//#endregion
//#region src/channels/plugins/exec-approval-local.ts
function shouldSuppressLocalExecApprovalPrompt(params) {
	const channel = params.channel ? normalizeChannelId(params.channel) : null;
	if (!channel) return false;
	return getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.({
		cfg: params.cfg,
		accountId: params.accountId,
		payload: params.payload,
		hint: {
			kind: "approval-pending",
			approvalKind: "exec",
			nativeRouteActive: hasActiveApprovalNativeRouteRuntime({
				channel,
				accountId: params.accountId,
				approvalKind: "exec"
			})
		}
	}) ?? false;
}
//#endregion
//#region src/auto-reply/reply/routing-policy.ts
function resolveReplyRoutingDecision(params) {
	const originatingChannel = normalizeMessageChannel(params.originatingChannel);
	const providerChannel = normalizeMessageChannel(params.provider);
	const surfaceChannel = normalizeMessageChannel(params.surface);
	const currentSurface = providerChannel ?? surfaceChannel;
	const isInternalWebchatTurn = currentSurface === "webchat" && (surfaceChannel === "webchat" || !surfaceChannel) && params.explicitDeliverRoute !== true;
	const shouldRouteToOriginating = Boolean(!params.suppressDirectUserDelivery && !isInternalWebchatTurn && params.isRoutableChannel(originatingChannel) && params.originatingTo && originatingChannel !== currentSurface);
	return {
		originatingChannel,
		currentSurface,
		isInternalWebchatTurn,
		shouldRouteToOriginating,
		shouldSuppressTyping: params.suppressDirectUserDelivery === true || shouldRouteToOriginating || originatingChannel === "webchat"
	};
}
//#endregion
//#region src/auto-reply/reply/dispatch-from-config.ts
var DispatchReplyOperationAbortedError = class extends Error {
	constructor() {
		super("Dispatch reply operation aborted");
		this.name = "AbortError";
	}
};
function isDispatchReplyOperationAbortedError(error) {
	return error instanceof DispatchReplyOperationAbortedError;
}
const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const getReplyFromConfigRuntimeLoader = createLazyImportLoader(() => import("./get-reply-from-config.runtime.js"));
const abortRuntimeLoader = createLazyImportLoader(() => import("./abort.runtime.js"));
const ttsRuntimeLoader = createLazyImportLoader(() => import("./tts.runtime-hD3depa3.js"));
const runtimePluginsLoader = createLazyImportLoader(() => import("./runtime-plugins.runtime.js"));
const replyMediaPathsRuntimeLoader = createLazyImportLoader(() => import("./reply-media-paths.runtime-HYS4pdT7.js"));
function loadRouteReplyRuntime() {
	return routeReplyRuntimeLoader.load();
}
function loadGetReplyFromConfigRuntime() {
	return getReplyFromConfigRuntimeLoader.load();
}
function loadAbortRuntime() {
	return abortRuntimeLoader.load();
}
function loadTtsRuntime() {
	return ttsRuntimeLoader.load();
}
function loadRuntimePlugins() {
	return runtimePluginsLoader.load();
}
function loadReplyMediaPathsRuntime() {
	return replyMediaPathsRuntimeLoader.load();
}
function formatSuppressedReplyPayloadForLog(reply) {
	const metadata = getReplyPayloadMetadata(reply);
	const text = normalizeOptionalString(reply.text);
	const textPreview = text ? text.replace(/\s+/g, " ").slice(0, 160) : void 0;
	const sendableParts = resolveSendableOutboundReplyParts(reply);
	const richParts = [
		reply.presentation ? "presentation" : void 0,
		reply.interactive ? "interactive" : void 0,
		reply.channelData ? "channelData" : void 0
	].filter(Boolean);
	return [
		`textChars=${text?.length ?? 0}`,
		`media=${sendableParts.mediaCount}`,
		`rich=${richParts.length ? richParts.join("|") : "none"}`,
		`error=${reply.isError === true}`,
		`beforeAgentRunBlocked=${metadata?.beforeAgentRunBlocked === true}`,
		`deliverDespiteSuppression=${metadata?.deliverDespiteSourceReplySuppression === true}`,
		textPreview ? `textPreview=${JSON.stringify(textPreview)}` : void 0
	].filter(Boolean).join(" ");
}
async function maybeApplyTtsToReplyPayload(params) {
	if (isReplyPayloadStatusNotice(params.payload)) return params.payload;
	if (!shouldAttemptTtsPayload({
		cfg: params.cfg,
		ttsAuto: params.ttsAuto,
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	})) return params.payload;
	const { maybeApplyTtsToPayload } = await loadTtsRuntime();
	return maybeApplyTtsToPayload(params);
}
const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value) => normalizeOptionalLowercaseString(value.split(";")[0]) ?? "";
const isInboundAudioContext = (ctx) => {
	if ([typeof ctx.MediaType === "string" ? ctx.MediaType : void 0, ...Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []].filter(Boolean).map((type) => normalizeMediaType(type)).some((type) => type === "audio" || type.startsWith("audio/"))) return true;
	const trimmed = (typeof ctx.BodyForCommands === "string" ? ctx.BodyForCommands : typeof ctx.CommandBody === "string" ? ctx.CommandBody : typeof ctx.RawBody === "string" ? ctx.RawBody : typeof ctx.Body === "string" ? ctx.Body : "").trim();
	if (!trimmed) return false;
	if (AUDIO_PLACEHOLDER_RE.test(trimmed)) return true;
	return AUDIO_HEADER_RE.test(trimmed);
};
const resolveRoutedPolicyConversationType = (ctx) => {
	const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
	if (commandTargetSessionKey && commandTargetSessionKey !== ctx.SessionKey) return;
	const chatType = normalizeChatType(ctx.ChatType);
	if (chatType === "direct") return "direct";
	if (chatType === "group" || chatType === "channel") return "group";
};
const resolveSessionStoreLookup = (ctx, cfg) => {
	const sessionKey = normalizeOptionalString(resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey);
	if (!sessionKey) return {};
	const agentId = resolveSessionAgentId({
		sessionKey,
		config: cfg
	});
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	try {
		const store = loadSessionStore(storePath);
		return {
			sessionKey,
			storePath,
			store,
			entry: resolveSessionStoreEntry({
				store,
				sessionKey
			}).existing
		};
	} catch {
		return {
			sessionKey,
			storePath
		};
	}
};
const resolveBoundAcpDispatchSessionKey = (params) => {
	const bindingContext = resolveConversationBindingContextFromMessage({
		cfg: params.cfg,
		ctx: params.ctx
	});
	if (!bindingContext) return;
	const binding = getSessionBindingService().resolveByConversation({
		channel: bindingContext.channel,
		accountId: bindingContext.accountId,
		conversationId: bindingContext.conversationId,
		...bindingContext.parentConversationId ? { parentConversationId: bindingContext.parentConversationId } : {}
	});
	const targetSessionKey = normalizeOptionalString(binding?.targetSessionKey);
	if (!binding || !targetSessionKey || !isAcpSessionKey(targetSessionKey)) return;
	if (isPluginOwnedSessionBindingRecord(binding)) return;
	getSessionBindingService().touch(binding.bindingId);
	return targetSessionKey;
};
const createShouldEmitVerboseProgress = (params) => {
	const resolveLevel = () => {
		if (params.sessionKey && params.storePath) try {
			const currentLevel = normalizeVerboseLevel(readSessionEntry(params.storePath, params.sessionKey)?.verboseLevel ?? "");
			if (currentLevel) return currentLevel;
		} catch {}
		return normalizeVerboseLevel(params.fallbackLevel) ?? "off";
	};
	return {
		shouldEmit: () => resolveLevel() !== "off",
		shouldEmitFull: () => resolveLevel() === "full"
	};
};
function resolveHarnessDefaultChannel(params) {
	const originatingChannel = typeof params.ctx.OriginatingChannel === "string" ? params.ctx.OriginatingChannel : void 0;
	return params.entry?.channel ?? params.entry?.origin?.provider ?? originatingChannel ?? params.ctx.Provider ?? params.ctx.Surface;
}
function resolveHarnessDefaultParentSessionKey(params) {
	return params.entry?.parentSessionKey ?? params.ctx.ModelParentSessionKey ?? params.ctx.ParentSessionKey;
}
function resolveTurnModelOverride(replyOptions) {
	const modelOverride = normalizeOptionalString(replyOptions?.modelOverride);
	if (modelOverride) return modelOverride;
	if (replyOptions?.isHeartbeat !== true) return;
	return normalizeOptionalString(replyOptions.heartbeatModelOverride);
}
function resolveChannelModelCandidate(params) {
	if (!params.cfg.channels?.modelByChannel) return;
	const channel = resolveHarnessDefaultChannel({
		ctx: params.ctx,
		entry: params.entry
	});
	const channelModelOverride = resolveChannelModelOverride({
		cfg: params.cfg,
		channel,
		groupId: params.entry?.groupId,
		groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
		groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
		groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
		parentSessionKey: params.parentSessionKey
	});
	if (!channelModelOverride) return;
	return resolveModelRefFromString({
		raw: channelModelOverride.model,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	})?.ref;
}
function resolveStoredModelCandidate(params) {
	const storedModelRef = resolveStoredModelOverride({
		sessionEntry: params.entry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		parentSessionKey: params.parentSessionKey,
		defaultProvider: params.defaultProvider
	});
	if (!storedModelRef) return;
	return {
		provider: storedModelRef.provider ?? params.defaultProvider,
		model: storedModelRef.model
	};
}
function resolveModelOverrideCandidate(params) {
	if (!params.modelOverride) return;
	return resolveModelRefFromString({
		raw: params.modelOverride,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex
	})?.ref;
}
const resolveHarnessSourceVisibleRepliesDefault = (params) => {
	if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) return;
	try {
		const defaultModelRef = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId: params.sessionAgentId
		});
		const aliasIndex = buildModelAliasIndex({
			cfg: params.cfg,
			defaultProvider: defaultModelRef.provider
		});
		const parentSessionKey = resolveHarnessDefaultParentSessionKey(params);
		const channelModelCandidate = resolveChannelModelCandidate({
			aliasIndex,
			cfg: params.cfg,
			ctx: params.ctx,
			defaultProvider: defaultModelRef.provider,
			entry: params.entry,
			parentSessionKey
		});
		const storedModelCandidate = resolveStoredModelCandidate({
			defaultProvider: defaultModelRef.provider,
			entry: params.entry,
			parentSessionKey,
			sessionKey: params.sessionKey,
			sessionStore: params.sessionStore
		});
		const turnModelCandidate = resolveModelOverrideCandidate({
			aliasIndex,
			defaultProvider: defaultModelRef.provider,
			modelOverride: params.turnModelOverride
		});
		const resolveCandidateDefault = (candidate) => {
			const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
				provider: candidate.provider,
				entry: params.entry
			});
			return selectAgentHarness({
				provider: candidate.provider,
				modelId: candidate.model,
				config: params.cfg,
				agentId: params.sessionAgentId,
				sessionKey: params.sessionKey,
				agentHarnessRuntimeOverride
			}).deliveryDefaults?.sourceVisibleReplies;
		};
		const selectedModelCandidate = turnModelCandidate ?? storedModelCandidate ?? channelModelCandidate;
		if (selectedModelCandidate) return resolveCandidateDefault(selectedModelCandidate);
		const sourceProvider = normalizeOptionalString(params.entry?.origin?.provider ?? params.ctx.Provider ?? params.ctx.Surface);
		if (sourceProvider) {
			const sourceDefault = resolveCandidateDefault({ provider: sourceProvider });
			if (sourceDefault) return sourceDefault;
		}
		return resolveCandidateDefault(defaultModelRef);
	} catch (error) {
		logVerbose(`dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`);
		return;
	}
};
function shouldBypassPluginOwnedBindingForCommand(ctx) {
	const commandTurn = resolveCommandTurnContext(ctx);
	if (!commandTurn.authorized) return false;
	if (isNativeCommandTurn(commandTurn)) return true;
	if (commandTurn.kind !== "text-slash") return false;
	const commandBody = normalizeCommandBody(commandTurn.body ?? "", { botUsername: ctx.BotUsername });
	if (!commandBody.startsWith("/")) return false;
	if (resolveTextCommand(commandBody)) return true;
	const provider = normalizeOptionalString(ctx.Provider ?? ctx.Surface);
	if (commandTurn.commandName && findCommandByNativeName(commandTurn.commandName, provider, { includeBundledChannelFallback: true })) return true;
	return Boolean(matchPluginCommand(commandBody, { channel: normalizeOptionalString(ctx.Surface ?? ctx.Provider) }));
}
async function clearPendingFinalDeliveryAfterSuccess(params) {
	if (!params.storePath || !params.sessionKey) return;
	await updateSessionStoreEntry({
		storePath: params.storePath,
		sessionKey: params.sessionKey,
		update: async (entry) => {
			if (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText) return null;
			return {
				pendingFinalDelivery: void 0,
				pendingFinalDeliveryText: void 0,
				pendingFinalDeliveryCreatedAt: void 0,
				pendingFinalDeliveryLastAttemptAt: void 0,
				pendingFinalDeliveryAttemptCount: void 0,
				pendingFinalDeliveryLastError: void 0,
				pendingFinalDeliveryContext: void 0,
				updatedAt: Date.now()
			};
		}
	});
}
async function mirrorInternalSourceReplyToTranscript(params) {
	const mirror = params.metadata;
	if (!mirror) return;
	const result = await appendAssistantMessageToSessionTranscript({
		sessionKey: mirror.sessionKey,
		agentId: mirror.agentId,
		text: mirror.text,
		mediaUrls: mirror.mediaUrls,
		idempotencyKey: mirror.idempotencyKey,
		updateMode: "inline",
		config: params.cfg
	});
	if (!result.ok) logVerbose(`dispatch-from-config: internal source reply mirror skipped: ${result.reason}`);
}
function runWithReplyOperationAbort(operation, run) {
	if (!operation) return Promise.resolve().then(run);
	const signal = operation.abortSignal;
	const shouldStopForOperationAbort = () => signal.aborted;
	if (signal.aborted && shouldStopForOperationAbort()) return Promise.reject(new DispatchReplyOperationAbortedError());
	let settled = false;
	let abortHandler;
	const aborted = new Promise((_, reject) => {
		abortHandler = () => {
			if (!settled && shouldStopForOperationAbort()) reject(new DispatchReplyOperationAbortedError());
		};
		signal.addEventListener("abort", abortHandler, { once: true });
	});
	const work = Promise.resolve().then(run).then((value) => {
		settled = true;
		return value;
	}, (error) => {
		settled = true;
		if (shouldStopForOperationAbort() && isAbortError(error)) throw new DispatchReplyOperationAbortedError();
		throw error;
	});
	return Promise.race([work, aborted]).finally(() => {
		settled = true;
		if (abortHandler) signal.removeEventListener("abort", abortHandler);
	});
}
function createAbortAwareDispatcher(params) {
	const sendIfActive = (send) => (payload) => params.isAborted() ? false : send(payload);
	const dispatcher = {
		sendToolResult: sendIfActive(params.dispatcher.sendToolResult),
		sendBlockReply: sendIfActive(params.dispatcher.sendBlockReply),
		sendFinalReply: sendIfActive(params.dispatcher.sendFinalReply),
		waitForIdle: () => params.dispatcher.waitForIdle(),
		getQueuedCounts: () => params.dispatcher.getQueuedCounts(),
		getFailedCounts: () => params.dispatcher.getFailedCounts(),
		markComplete: () => {
			if (!params.isAborted()) params.dispatcher.markComplete();
		}
	};
	if (params.dispatcher.getCancelledCounts) dispatcher.getCancelledCounts = () => params.dispatcher.getCancelledCounts();
	return dispatcher;
}
async function dispatchReplyFromConfig(params) {
	const { ctx, cfg, dispatcher } = params;
	const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
	const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
	const chatId = ctx.To ?? ctx.From;
	const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
	const sessionKey = normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
	const startTime = diagnosticsEnabled ? Date.now() : 0;
	const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);
	const traceAttributes = {
		surface: channel,
		hasSessionKey: Boolean(sessionKey),
		hasRunId: typeof params.replyOptions?.runId === "string"
	};
	const traceReplyPhase = (name, run) => measureDiagnosticsTimelineSpan(name, run, {
		phase: "agent-turn",
		config: cfg,
		attributes: traceAttributes
	});
	let agentDispatchStartedAt = 0;
	const recordProcessed = (outcome, opts) => {
		if (!diagnosticsEnabled) return;
		logMessageProcessed({
			channel,
			chatId,
			messageId,
			sessionKey,
			durationMs: Date.now() - startTime,
			outcome,
			reason: opts?.reason,
			error: opts?.error
		});
	};
	const recordAgentDispatchStarted = () => {
		if (!diagnosticsEnabled || agentDispatchStartedAt > 0) return;
		agentDispatchStartedAt = Date.now();
		logMessageDispatchStarted({
			channel,
			sessionKey: acpDispatchSessionKey,
			source: "replyResolver"
		});
	};
	const recordAgentDispatchCompleted = (outcome, opts) => {
		if (!diagnosticsEnabled || agentDispatchStartedAt <= 0) return;
		logMessageDispatchCompleted({
			channel,
			sessionKey: acpDispatchSessionKey,
			source: "replyResolver",
			durationMs: Date.now() - agentDispatchStartedAt,
			outcome,
			reason: opts?.reason,
			error: opts?.error
		});
	};
	const markProcessing = () => {
		if (!canTrackSession || !sessionKey) return;
		logMessageQueued({
			sessionKey,
			channel,
			source: "dispatch"
		});
		logSessionStateChange({
			sessionKey,
			state: "processing",
			reason: "message_start"
		});
	};
	const markIdle = (reason) => {
		if (!canTrackSession || !sessionKey) return;
		logSessionStateChange({
			sessionKey,
			state: "idle",
			reason
		});
	};
	let inboundDedupeReplayUnsafe = false;
	const markInboundDedupeReplayUnsafe = () => {
		inboundDedupeReplayUnsafe = true;
	};
	const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
	const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({
		ctx,
		cfg
	});
	const acpDispatchSessionKey = boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
	const dispatchOperationSessionKey = initialSessionStoreEntry.sessionKey ?? sessionKey ?? acpDispatchSessionKey;
	const markProgress = () => {
		if (!canTrackSession || !sessionKey) return;
		markDiagnosticSessionProgress({ sessionKey });
		if (acpDispatchSessionKey && acpDispatchSessionKey !== sessionKey) markDiagnosticSessionProgress({ sessionKey: acpDispatchSessionKey });
	};
	const sessionStoreEntry = boundAcpDispatchSessionKey ? resolveSessionStoreLookup({
		...ctx,
		SessionKey: boundAcpDispatchSessionKey
	}, cfg) : initialSessionStoreEntry;
	const sessionAgentId = resolveSessionAgentId({
		sessionKey: acpDispatchSessionKey,
		config: cfg
	});
	const sessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);
	const verboseProgress = createShouldEmitVerboseProgress({
		sessionKey: acpDispatchSessionKey,
		storePath: sessionStoreEntry.storePath,
		fallbackLevel: normalizeVerboseLevel(sessionStoreEntry.entry?.verboseLevel ?? sessionAgentCfg?.verboseDefault ?? cfg.agents?.defaults?.verboseDefault ?? "") ?? "off"
	});
	const shouldEmitVerboseProgress = verboseProgress.shouldEmit;
	const shouldEmitFullVerboseProgress = verboseProgress.shouldEmitFull;
	const replyRoute = resolveEffectiveReplyRoute({
		ctx,
		entry: sessionStoreEntry.entry
	});
	const routeThreadId = resolveRoutedDeliveryThreadId({
		ctx,
		sessionKey: acpDispatchSessionKey
	});
	const inboundAudio = isInboundAudioContext(ctx);
	const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
	let dispatchReplyOperation;
	let dispatchAbortOperation;
	const ensureDispatchReplyOperation = () => {
		if (dispatchReplyOperation && !dispatchReplyOperation.result) return dispatchReplyOperation;
		if (dispatchAbortOperation && !dispatchAbortOperation.result) return dispatchReplyOperation;
		if (!dispatchOperationSessionKey) return;
		const operationSessionId = dispatchAbortOperation?.sessionId ?? initialSessionStoreEntry.entry?.sessionId ?? sessionStoreEntry.entry?.sessionId ?? crypto.randomUUID();
		try {
			dispatchReplyOperation = createReplyOperation({
				sessionKey: dispatchOperationSessionKey,
				sessionId: operationSessionId,
				resetTriggered: false,
				upstreamAbortSignal: params.replyOptions?.abortSignal
			});
			dispatchAbortOperation = dispatchReplyOperation;
		} catch (error) {
			if (error instanceof ReplyRunAlreadyActiveError) {
				dispatchAbortOperation = replyRunRegistry.get(dispatchOperationSessionKey);
				logVerbose(`dispatch-from-config: reply operation already active for ${dispatchOperationSessionKey}; using active operation abort signal without ownership`);
				return;
			}
			throw error;
		}
		return dispatchReplyOperation;
	};
	const getReplyOptions = () => dispatchReplyOperation ? {
		...params.replyOptions,
		abortSignal: dispatchReplyOperation.abortSignal,
		replyOperation: dispatchReplyOperation
	} : params.replyOptions;
	const completeDispatchReplyOperation = () => {
		if (dispatchReplyOperation) dispatchReplyOperation.complete();
	};
	const failDispatchReplyOperation = (error) => {
		if (dispatchReplyOperation && !dispatchReplyOperation.result) dispatchReplyOperation.fail("run_failed", error);
	};
	const isDispatchOperationAborted = () => dispatchAbortOperation?.abortSignal.aborted === true;
	const throwIfDispatchOperationAborted = () => {
		if (isDispatchOperationAborted()) throw new DispatchReplyOperationAbortedError();
	};
	const dispatchHookDispatcher = createAbortAwareDispatcher({
		dispatcher,
		isAborted: isDispatchOperationAborted
	});
	const { ensureRuntimePluginsLoaded } = await traceReplyPhase("reply.load_runtime_plugins", () => loadRuntimePlugins());
	await traceReplyPhase("reply.ensure_runtime_plugins", () => {
		ensureRuntimePluginsLoaded({
			config: cfg,
			workspaceDir
		});
	});
	const hookRunner = getGlobalHookRunner();
	const timestamp = typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : void 0;
	const hookContext = deriveInboundMessageHookContext(ctx, { messageId: ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast });
	const { isGroup, groupId } = hookContext;
	const inboundClaimContext = toPluginInboundClaimContext(hookContext);
	const inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
		commandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : void 0,
		wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : void 0
	});
	const suppressAcpChildUserDelivery = isParentOwnedBackgroundAcpSession(sessionStoreEntry.entry);
	const normalizedRouteReplyChannel = normalizeMessageChannel(replyRoute.channel);
	const normalizedProviderChannel = normalizeMessageChannel(ctx.Provider);
	const normalizedSurfaceChannel = normalizeMessageChannel(ctx.Surface);
	const normalizedCurrentSurface = normalizedProviderChannel ?? normalizedSurfaceChannel;
	const isInternalWebchatTurn = normalizedCurrentSurface === "webchat" && (normalizedSurfaceChannel === "webchat" || !normalizedSurfaceChannel) && ctx.ExplicitDeliverRoute !== true;
	const routeReplyRuntime = Boolean(!suppressAcpChildUserDelivery && !isInternalWebchatTurn && normalizedRouteReplyChannel && replyRoute.to && normalizedRouteReplyChannel !== normalizedCurrentSurface) ? await loadRouteReplyRuntime() : void 0;
	const { originatingChannel: routeReplyChannel, currentSurface, shouldRouteToOriginating, shouldSuppressTyping } = resolveReplyRoutingDecision({
		provider: ctx.Provider,
		surface: ctx.Surface,
		explicitDeliverRoute: ctx.ExplicitDeliverRoute,
		originatingChannel: replyRoute.channel,
		originatingTo: replyRoute.to,
		suppressDirectUserDelivery: suppressAcpChildUserDelivery,
		isRoutableChannel: routeReplyRuntime?.isRoutableChannel ?? (() => false)
	});
	const routeReplyTo = replyRoute.to;
	const deliveryChannel = shouldRouteToOriginating ? routeReplyChannel : currentSurface;
	let normalizeReplyMediaPaths;
	const getNormalizeReplyMediaPaths = async () => {
		if (normalizeReplyMediaPaths) return normalizeReplyMediaPaths;
		const { createReplyMediaPathNormalizer } = await loadReplyMediaPathsRuntime();
		normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
			cfg,
			sessionKey: acpDispatchSessionKey,
			workspaceDir,
			messageProvider: deliveryChannel,
			accountId: replyRoute.accountId,
			groupId,
			groupChannel: ctx.GroupChannel,
			groupSpace: ctx.GroupSpace,
			requesterSenderId: ctx.SenderId,
			requesterSenderName: ctx.SenderName,
			requesterSenderUsername: ctx.SenderUsername,
			requesterSenderE164: ctx.SenderE164
		});
		return normalizeReplyMediaPaths;
	};
	const normalizeReplyMediaPayload = async (payload) => {
		if (!resolveSendableOutboundReplyParts(payload).hasMedia) return payload;
		return await (await getNormalizeReplyMediaPaths())(payload);
	};
	const routeReplyToOriginating = async (payload, options) => {
		if (!shouldRouteToOriginating || !routeReplyChannel || !routeReplyTo || !routeReplyRuntime) return null;
		markInboundDedupeReplayUnsafe();
		return await routeReplyRuntime.routeReply({
			payload,
			channel: routeReplyChannel,
			to: routeReplyTo,
			sessionKey: ctx.SessionKey,
			policySessionKey: resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey,
			policyConversationType: resolveRoutedPolicyConversationType(ctx),
			accountId: replyRoute.accountId,
			requesterSenderId: ctx.SenderId,
			requesterSenderName: ctx.SenderName,
			requesterSenderUsername: ctx.SenderUsername,
			requesterSenderE164: ctx.SenderE164,
			threadId: routeThreadId,
			cfg,
			abortSignal: options?.abortSignal,
			mirror: options?.mirror,
			isGroup,
			groupId
		});
	};
	/**
	* Helper to send a payload via route-reply (async).
	* Only used when actually routing to a different provider.
	* Note: Only called when shouldRouteToOriginating is true, so
	* routeReplyChannel and routeReplyTo are guaranteed to be defined.
	*/
	const sendPayloadAsync = async (payload, abortSignal, mirror) => {
		if (!routeReplyRuntime || !routeReplyChannel || !routeReplyTo) return;
		const effectiveAbortSignal = abortSignal ?? dispatchAbortOperation?.abortSignal;
		if (effectiveAbortSignal?.aborted) return;
		const result = await routeReplyToOriginating(payload, {
			abortSignal: effectiveAbortSignal,
			mirror
		});
		if (result && !result.ok) logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
	};
	const sendBindingNotice = async (payload, mode) => {
		const result = await routeReplyToOriginating(payload);
		if (result) {
			if (!result.ok) logVerbose(`dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`);
			return result.ok;
		}
		markInboundDedupeReplayUnsafe();
		return mode === "additive" ? dispatcher.sendToolResult(payload) : dispatcher.sendFinalReply(payload);
	};
	const pluginOwnedBindingRecord = inboundClaimContext.conversationId && inboundClaimContext.channelId ? resolveConversationBindingRecord({
		channel: inboundClaimContext.channelId,
		accountId: inboundClaimContext.accountId ?? cfg.channels?.[inboundClaimContext.channelId]?.defaultAccount ?? "default",
		conversationId: inboundClaimContext.conversationId,
		parentConversationId: inboundClaimContext.parentConversationId
	}) : null;
	const pluginOwnedBinding = isPluginOwnedSessionBindingRecord(pluginOwnedBindingRecord) ? toPluginConversationBinding(pluginOwnedBindingRecord) : null;
	const sendPolicy = resolveSendPolicy({
		cfg,
		entry: sessionStoreEntry.entry,
		sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
		channel: (shouldRouteToOriginating ? routeReplyChannel : void 0) ?? sessionStoreEntry.entry?.channel ?? replyRoute.channel ?? ctx.Surface ?? ctx.Provider ?? void 0,
		chatType: sessionStoreEntry.entry?.chatType
	});
	const { globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: cfg,
		sessionKey: acpDispatchSessionKey,
		agentId: sessionAgentId
	});
	const chatType = normalizeChatType(ctx.ChatType);
	const configuredVisibleReplies = chatType === "group" || chatType === "channel" ? cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies : cfg.messages?.visibleReplies;
	const harnessDefaultVisibleReplies = configuredVisibleReplies === void 0 && chatType !== "group" && chatType !== "channel" ? resolveHarnessSourceVisibleRepliesDefault({
		cfg,
		ctx,
		entry: sessionStoreEntry.entry,
		sessionAgentId,
		sessionKey: acpDispatchSessionKey,
		sessionStore: sessionStoreEntry.store,
		turnModelOverride: resolveTurnModelOverride(params.replyOptions)
	}) : void 0;
	const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
	const runtimeProfileAlsoAllow = params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" || ctx.InboundEventKind === "room_event" || params.replyOptions?.sourceReplyDeliveryMode === void 0 && !isExplicitSourceReplyCommand(ctx) && effectiveVisibleReplies === "message_tool" ? ["message"] : [];
	const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [...profileAlsoAllow ?? [], ...runtimeProfileAlsoAllow]);
	const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [...providerProfileAlsoAllow ?? [], ...runtimeProfileAlsoAllow]);
	const groupResolution = resolveGroupSessionKey(ctx);
	const groupPolicy = resolveGroupToolPolicy({
		config: cfg,
		sessionKey: acpDispatchSessionKey,
		messageProvider: resolveOriginMessageProvider({
			originatingChannel: ctx.OriginatingChannel,
			provider: ctx.Provider ?? ctx.Surface
		}),
		groupId: groupResolution?.id,
		groupChannel: normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
		groupSpace: normalizeOptionalString(ctx.GroupSpace),
		accountId: ctx.AccountId,
		senderId: normalizeOptionalString(ctx.SenderId),
		senderName: normalizeOptionalString(ctx.SenderName),
		senderUsername: normalizeOptionalString(ctx.SenderUsername),
		senderE164: normalizeOptionalString(ctx.SenderE164)
	});
	const subagentStore = resolveSubagentCapabilityStore(acpDispatchSessionKey, { cfg });
	const messageToolAvailable = isToolAllowedByPolicies("message", [
		profilePolicy,
		providerProfilePolicy,
		globalProviderPolicy,
		agentProviderPolicy,
		globalPolicy,
		agentPolicy,
		groupPolicy,
		acpDispatchSessionKey && isSubagentEnvelopeSession(acpDispatchSessionKey, {
			cfg,
			store: subagentStore
		}) ? resolveSubagentToolPolicyForSession(cfg, acpDispatchSessionKey, { store: subagentStore }) : void 0,
		resolveInheritedToolPolicyForSession(cfg, acpDispatchSessionKey, { store: subagentStore })
	]);
	const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
		cfg,
		ctx,
		requested: params.replyOptions?.sourceReplyDeliveryMode,
		strictMessageToolOnly: ctx.InboundEventKind === "room_event",
		sendPolicy,
		suppressAcpChildUserDelivery,
		explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
		shouldSuppressTyping,
		messageToolAvailable,
		defaultVisibleReplies: harnessDefaultVisibleReplies
	});
	const { sourceReplyDeliveryMode, suppressAutomaticSourceDelivery, suppressDelivery, sendPolicyDenied, deliverySuppressionReason, suppressHookUserDelivery, suppressHookReplyLifecycle } = sourceReplyPolicy;
	const attachSourceReplyDeliveryMode = (result) => sourceReplyDeliveryMode === "message_tool_only" ? {
		...result,
		sourceReplyDeliveryMode
	} : result;
	const inboundDedupeClaim = claimInboundDedupe(ctx);
	if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
		recordProcessed("skipped", { reason: "duplicate" });
		return attachSourceReplyDeliveryMode({
			queuedFinal: false,
			counts: dispatcher.getQueuedCounts()
		});
	}
	const commitInboundDedupeIfClaimed = () => {
		if (inboundDedupeClaim.status === "claimed") commitInboundDedupe(inboundDedupeClaim.key);
	};
	let pluginFallbackReason;
	if (pluginOwnedBinding) {
		touchConversationBindingRecord(pluginOwnedBinding.bindingId);
		if (shouldBypassPluginOwnedBindingForCommand(ctx)) logVerbose(`plugin-bound inbound command escaped plugin binding (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to command processing`);
		else if (suppressDelivery) logVerbose(`plugin-bound inbound skipped under ${deliverySuppressionReason} (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to suppressed agent processing`);
		else {
			logVerbose(`plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`);
			const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome ? await hookRunner.runInboundClaimForPluginOutcome(pluginOwnedBinding.pluginId, inboundClaimEvent, {
				...inboundClaimContext,
				pluginBinding: pluginOwnedBinding
			}) : getGlobalPluginRegistry()?.plugins.some((plugin) => plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded") ?? false ? { status: "no_handler" } : { status: "missing_plugin" };
			switch (targetedClaimOutcome.status) {
				case "handled":
					if (targetedClaimOutcome.result.reply) await sendBindingNotice(targetedClaimOutcome.result.reply, "terminal");
					markIdle("plugin_binding_dispatch");
					recordProcessed("completed", { reason: "plugin-bound-handled" });
					commitInboundDedupeIfClaimed();
					return attachSourceReplyDeliveryMode({
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					});
				case "missing_plugin":
				case "no_handler":
					pluginFallbackReason = targetedClaimOutcome.status === "missing_plugin" ? "plugin-bound-fallback-missing-plugin" : "plugin-bound-fallback-no-handler";
					if (!hasShownPluginBindingFallbackNotice(pluginOwnedBinding.bindingId)) {
						if (await sendBindingNotice({ text: buildPluginBindingUnavailableText(pluginOwnedBinding) }, "additive")) markPluginBindingFallbackNoticeShown(pluginOwnedBinding.bindingId);
					}
					break;
				case "declined":
					await sendBindingNotice({ text: buildPluginBindingDeclinedText(pluginOwnedBinding) }, "terminal");
					markIdle("plugin_binding_declined");
					recordProcessed("completed", { reason: "plugin-bound-declined" });
					commitInboundDedupeIfClaimed();
					return attachSourceReplyDeliveryMode({
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					});
				case "error":
					logVerbose(`plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`);
					await sendBindingNotice({ text: buildPluginBindingErrorText(pluginOwnedBinding) }, "terminal");
					markIdle("plugin_binding_error");
					recordProcessed("completed", { reason: "plugin-bound-error" });
					commitInboundDedupeIfClaimed();
					return attachSourceReplyDeliveryMode({
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					});
			}
		}
	}
	if (hookRunner?.hasHooks("message_received")) fireAndForgetHook(hookRunner.runMessageReceived(toPluginMessageReceivedEvent(hookContext), toPluginMessageContext(hookContext)), "dispatch-from-config: message_received plugin hook failed");
	if (sessionKey) fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "received", sessionKey, {
		...toInternalMessageReceivedContext(hookContext),
		timestamp
	})), "dispatch-from-config: message_received internal hook failed");
	markProcessing();
	try {
		const abortRuntime = params.fastAbortResolver ? null : await loadAbortRuntime();
		const fastAbortResolver = params.fastAbortResolver ?? abortRuntime?.tryFastAbortFromMessage;
		const formatAbortReplyTextResolver = params.formatAbortReplyTextResolver ?? abortRuntime?.formatAbortReplyText;
		if (!fastAbortResolver || !formatAbortReplyTextResolver) throw new Error("abort runtime unavailable");
		const fastAbort = await fastAbortResolver({
			ctx,
			cfg
		});
		if (fastAbort.handled) {
			let queuedFinal = false;
			let routedFinalCount = 0;
			if (!suppressDelivery) {
				const payload = { text: formatAbortReplyTextResolver(fastAbort.stoppedSubagents) };
				const result = await routeReplyToOriginating(payload);
				if (result) {
					queuedFinal = result.ok;
					if (result.ok) routedFinalCount += 1;
					if (!result.ok) logVerbose(`dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`);
				} else {
					markInboundDedupeReplayUnsafe();
					queuedFinal = dispatcher.sendFinalReply(payload);
				}
			} else logVerbose(`dispatch-from-config: fast_abort reply suppressed by ${deliverySuppressionReason} (session=${sessionKey ?? "unknown"})`);
			const counts = dispatcher.getQueuedCounts();
			counts.final += routedFinalCount;
			recordProcessed("completed", { reason: "fast_abort" });
			markIdle("message_completed");
			commitInboundDedupeIfClaimed();
			completeDispatchReplyOperation();
			return attachSourceReplyDeliveryMode({
				queuedFinal,
				counts
			});
		}
		ensureDispatchReplyOperation();
		const shouldSendVerboseProgressMessages = !((ctx.Surface === "slack" || ctx.Provider === "slack") && ctx.ChatType !== "direct") && (ctx.ChatType !== "group" || ctx.IsForum === true);
		const shouldSendToolSummaries = shouldSendVerboseProgressMessages;
		const shouldDeliverVerboseProgressDespiteSourceSuppression = () => suppressAutomaticSourceDelivery && sourceReplyDeliveryMode === "message_tool_only" && ctx.InboundEventKind !== "room_event" && !sendPolicyDenied && shouldEmitVerboseProgress() && shouldSendVerboseProgressMessages;
		let finalReplyDeliveryStarted = false;
		const hasExecApprovalPayload = (payload) => {
			const execApproval = payload.channelData && typeof payload.channelData === "object" && !Array.isArray(payload.channelData) ? payload.channelData.execApproval : void 0;
			return execApproval && typeof execApproval === "object" && !Array.isArray(execApproval);
		};
		const shouldSuppressLateTextOnlyToolProgress = (payload) => {
			if (!finalReplyDeliveryStarted) return false;
			return !resolveSendableOutboundReplyParts(payload).hasMedia && !hasExecApprovalPayload(payload);
		};
		const shouldSuppressMessageToolOnlyTextErrorProgress = (payload) => {
			if (sourceReplyDeliveryMode !== "message_tool_only" || shouldEmitFullVerboseProgress() || payload.isError !== true) return false;
			return !resolveSendableOutboundReplyParts(payload).hasMedia && !hasExecApprovalPayload(payload);
		};
		const sendFinalPayload = async (payload) => {
			throwIfDispatchOperationAborted();
			const sourceReplyTranscriptMirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
			if (hasOutboundReplyContent(payload, { trimText: true })) {
				markInboundDedupeReplayUnsafe();
				finalReplyDeliveryStarted = true;
			}
			const ttsPayload = await maybeApplyTtsToReplyPayload({
				payload,
				cfg,
				channel: deliveryChannel,
				kind: "final",
				inboundAudio,
				ttsAuto: sessionTtsAuto,
				agentId: sessionAgentId,
				accountId: replyRoute.accountId
			});
			throwIfDispatchOperationAborted();
			const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
			throwIfDispatchOperationAborted();
			const result = await routeReplyToOriginating(normalizedPayload, { abortSignal: dispatchAbortOperation?.abortSignal });
			if (result) {
				if (!result.ok) logVerbose(`dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`);
				if (result.ok) await mirrorInternalSourceReplyToTranscript({
					metadata: sourceReplyTranscriptMirror,
					cfg
				});
				return {
					queuedFinal: result.ok,
					routedFinalCount: result.ok ? 1 : 0
				};
			}
			throwIfDispatchOperationAborted();
			markInboundDedupeReplayUnsafe();
			const queuedFinal = dispatcher.sendFinalReply(normalizedPayload);
			if (queuedFinal) await mirrorInternalSourceReplyToTranscript({
				metadata: sourceReplyTranscriptMirror,
				cfg
			});
			return {
				queuedFinal,
				routedFinalCount: 0
			};
		};
		if (hookRunner?.hasHooks("before_dispatch")) {
			const beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () => runWithReplyOperationAbort(dispatchAbortOperation, () => hookRunner.runBeforeDispatch({
				content: hookContext.content,
				body: hookContext.bodyForAgent ?? hookContext.body,
				channel: hookContext.channelId,
				sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
				senderId: hookContext.senderId,
				isGroup: hookContext.isGroup,
				timestamp: hookContext.timestamp
			}, {
				channelId: hookContext.channelId,
				accountId: hookContext.accountId,
				conversationId: inboundClaimContext.conversationId,
				sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
				senderId: hookContext.senderId
			})));
			if (beforeDispatchResult?.handled) {
				const text = beforeDispatchResult.text;
				let queuedFinal = false;
				let routedFinalCount = 0;
				if (text && !suppressDelivery) {
					const handledReply = await sendFinalPayload({ text });
					queuedFinal = handledReply.queuedFinal;
					routedFinalCount += handledReply.routedFinalCount;
				}
				const counts = dispatcher.getQueuedCounts();
				counts.final += routedFinalCount;
				recordProcessed("completed", { reason: "before_dispatch_handled" });
				markIdle("message_completed");
				commitInboundDedupeIfClaimed();
				completeDispatchReplyOperation();
				return attachSourceReplyDeliveryMode({
					queuedFinal,
					counts
				});
			}
		}
		if (hookRunner?.hasHooks("reply_dispatch")) {
			const replyDispatchResult = await traceReplyPhase("reply.reply_dispatch_hooks", () => runWithReplyOperationAbort(dispatchAbortOperation, () => hookRunner.runReplyDispatch({
				ctx,
				runId: params.replyOptions?.runId,
				sessionKey: acpDispatchSessionKey,
				images: params.replyOptions?.images,
				inboundAudio,
				sessionTtsAuto,
				ttsChannel: deliveryChannel,
				suppressUserDelivery: suppressHookUserDelivery,
				suppressReplyLifecycle: suppressHookReplyLifecycle,
				sourceReplyDeliveryMode,
				shouldRouteToOriginating,
				originatingChannel: routeReplyChannel,
				originatingTo: routeReplyTo,
				shouldSendToolSummaries,
				sendPolicy
			}, {
				cfg,
				dispatcher: dispatchHookDispatcher,
				abortSignal: dispatchAbortOperation?.abortSignal ?? params.replyOptions?.abortSignal,
				onReplyStart: params.replyOptions?.onReplyStart,
				recordProcessed,
				markIdle
			})));
			if (replyDispatchResult?.handled) {
				commitInboundDedupeIfClaimed();
				completeDispatchReplyOperation();
				return attachSourceReplyDeliveryMode({
					queuedFinal: replyDispatchResult.queuedFinal,
					counts: replyDispatchResult.counts
				});
			}
		}
		if (suppressDelivery) logVerbose(`Delivery suppressed by ${deliverySuppressionReason} for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`);
		const toolStartStatusesSent = /* @__PURE__ */ new Set();
		let toolStartStatusCount = 0;
		let didSendPlanStatusNotice = false;
		const normalizeWorkingLabel = (label) => {
			const collapsed = label.replace(/\s+/g, " ").trim();
			if (collapsed.length <= 80) return collapsed;
			return `${collapsed.slice(0, 77).trimEnd()}...`;
		};
		const formatPlanUpdateText = (payload) => {
			const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
			const steps = (payload.steps ?? []).map((step) => step.replace(/\s+/g, " ").trim()).filter(Boolean);
			if (steps.length > 0) return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
			return explanation || "Planning next steps.";
		};
		const maybeSendWorkingStatus = async (label) => {
			if (shouldSuppressProgressDelivery()) return;
			const normalizedLabel = normalizeWorkingLabel(label);
			if (!shouldEmitVerboseProgress() || true) return;
			toolStartStatusesSent.add(normalizedLabel);
			toolStartStatusCount += 1;
			const payload = { text: `Working: ${normalizedLabel}` };
			if (shouldRouteToOriginating) {
				await sendPayloadAsync(payload, void 0, false);
				return;
			}
			markInboundDedupeReplayUnsafe();
			dispatcher.sendToolResult(payload);
		};
		const sendPlanUpdate = async (payload) => {
			if (shouldSuppressProgressDelivery() || !shouldSendVerboseProgressMessages || didSendPlanStatusNotice) return;
			didSendPlanStatusNotice = true;
			const replyPayload = {
				text: formatPlanUpdateText(payload),
				isStatusNotice: true
			};
			if (shouldRouteToOriginating) {
				await sendPayloadAsync(replyPayload, void 0, false);
				return;
			}
			markInboundDedupeReplayUnsafe();
			dispatcher.sendToolResult(replyPayload);
		};
		const summarizeApprovalLabel = (payload) => {
			if (payload.status === "pending") {
				const command = normalizeOptionalString(payload.command);
				if (command) return normalizeWorkingLabel(`awaiting approval: ${command}`);
				return "awaiting approval";
			}
			if (payload.status === "unavailable") {
				const message = normalizeOptionalString(payload.message);
				if (message) return normalizeWorkingLabel(message);
				return "approval unavailable";
			}
			return "";
		};
		const summarizePatchLabel = (payload) => {
			const summary = normalizeOptionalString(payload.summary);
			if (summary) return normalizeWorkingLabel(summary);
			const title = normalizeOptionalString(payload.title);
			if (title) return normalizeWorkingLabel(title);
			return "";
		};
		let accumulatedBlockText = "";
		let accumulatedBlockTtsText = "";
		let blockCount = 0;
		const cleanBlockTtsDirectiveText = shouldCleanTtsDirectiveText({
			cfg,
			ttsAuto: sessionTtsAuto,
			agentId: sessionAgentId,
			channelId: deliveryChannel,
			accountId: replyRoute.accountId
		}) ? createTtsDirectiveTextStreamCleaner() : void 0;
		const resolveToolDeliveryPayload = (payload) => {
			if (shouldSuppressLocalExecApprovalPrompt({
				channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
				cfg,
				accountId: ctx.AccountId,
				payload
			})) return null;
			if (shouldSendToolSummaries) return payload;
			const execApproval = payload.channelData && typeof payload.channelData === "object" && !Array.isArray(payload.channelData) ? payload.channelData.execApproval : void 0;
			if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) return payload;
			if (!resolveSendableOutboundReplyParts(payload).hasMedia) return null;
			return {
				...payload,
				text: void 0
			};
		};
		const typing = resolveRunTypingPolicy({
			requestedPolicy: params.replyOptions?.typingPolicy,
			suppressTyping: sourceReplyPolicy.suppressTyping,
			originatingChannel: routeReplyChannel,
			systemEvent: shouldRouteToOriginating
		});
		const suppressDefaultToolProgressMessages = params.replyOptions?.suppressDefaultToolProgressMessages === true;
		const shouldSuppressDefaultToolProgressMessages = () => suppressDefaultToolProgressMessages && !shouldEmitVerboseProgress();
		const shouldSuppressProgressDelivery = () => sendPolicyDenied || suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression();
		const hasVisibleRegularVerboseToolProgress = shouldEmitVerboseProgress() && !shouldEmitFullVerboseProgress() && shouldSendVerboseProgressMessages && ctx.InboundEventKind !== "room_event" && !shouldSuppressProgressDelivery();
		const suppressToolErrorWarnings = params.replyOptions?.suppressToolErrorWarnings ?? (hasVisibleRegularVerboseToolProgress ? true : void 0);
		const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
		const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
		const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
		const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
		const allowSuppressedSourceProgressCallbacks = params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
		const shouldForwardProgressCallback = (options) => !suppressAutomaticSourceDelivery || allowSuppressedSourceProgressCallbacks && options?.forwardWhenSourceDeliverySuppressed === true;
		const wrapProgressCallback = (callback, options) => {
			if (!callback && (!suppressAutomaticSourceDelivery || !canTrackSession)) return;
			return async (...args) => {
				if (isDispatchOperationAborted()) return;
				markProgress();
				if (shouldForwardProgressCallback(options)) await callback?.(...args);
			};
		};
		const replyResolver = params.replyResolver ?? (await traceReplyPhase("reply.load_reply_resolver", () => loadGetReplyFromConfigRuntime())).getReplyFromConfig;
		const replyConfig = withFullRuntimeReplyConfig(params.configOverride ? applyMergePatch(cfg, params.configOverride) : cfg);
		recordAgentDispatchStarted();
		const replyResult = await runWithReplyOperationAbort(dispatchAbortOperation, () => traceReplyPhase("reply.run_reply_resolver", () => replyResolver(ctx, {
			...getReplyOptions(),
			sourceReplyDeliveryMode,
			suppressToolErrorWarnings,
			typingPolicy: typing.typingPolicy,
			suppressTyping: typing.suppressTyping,
			onPartialReply: wrapProgressCallback(params.replyOptions?.onPartialReply),
			onReasoningStream: wrapProgressCallback(params.replyOptions?.onReasoningStream),
			onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
			onAssistantMessageStart: wrapProgressCallback(params.replyOptions?.onAssistantMessageStart),
			onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
			onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart, { forwardWhenSourceDeliverySuppressed: true }),
			onItemEvent: wrapProgressCallback(params.replyOptions?.onItemEvent, { forwardWhenSourceDeliverySuppressed: true }),
			onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput, { forwardWhenSourceDeliverySuppressed: true }),
			onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart, { forwardWhenSourceDeliverySuppressed: true }),
			onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd, { forwardWhenSourceDeliverySuppressed: true }),
			onToolResult: (payload) => {
				markProgress();
				const run = async () => {
					if (isDispatchOperationAborted()) return;
					markInboundDedupeReplayUnsafe();
					if (!suppressAutomaticSourceDelivery) await onToolResultFromReplyOptions?.(payload);
					if (isDispatchOperationAborted()) return;
					if (shouldSuppressProgressDelivery()) return;
					const deliveryPayload = resolveToolDeliveryPayload(await normalizeReplyMediaPayload(await maybeApplyTtsToReplyPayload({
						payload,
						cfg,
						channel: deliveryChannel,
						kind: "tool",
						inboundAudio,
						ttsAuto: sessionTtsAuto,
						agentId: sessionAgentId,
						accountId: replyRoute.accountId
					})));
					if (!deliveryPayload) return;
					if (isDispatchOperationAborted()) return;
					if (shouldSuppressLateTextOnlyToolProgress(deliveryPayload)) return;
					if (shouldSuppressMessageToolOnlyTextErrorProgress(deliveryPayload)) return;
					if (shouldSuppressDefaultToolProgressMessages()) {
						if (!resolveSendableOutboundReplyParts(deliveryPayload).hasMedia && !hasExecApprovalPayload(deliveryPayload)) return;
					}
					if (shouldRouteToOriginating) await sendPayloadAsync(deliveryPayload, void 0, false);
					else {
						markInboundDedupeReplayUnsafe();
						dispatcher.sendToolResult(deliveryPayload);
					}
				};
				return run();
			},
			onPlanUpdate: async (payload) => {
				if (isDispatchOperationAborted()) return;
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true })) await onPlanUpdateFromReplyOptions?.(payload);
				if (isDispatchOperationAborted()) return;
				if (payload.phase !== "update" || shouldSuppressDefaultToolProgressMessages()) return;
				await sendPlanUpdate({
					explanation: payload.explanation,
					steps: payload.steps
				});
			},
			onApprovalEvent: async (payload) => {
				if (isDispatchOperationAborted()) return;
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true })) await onApprovalEventFromReplyOptions?.(payload);
				if (isDispatchOperationAborted()) return;
				if (payload.phase !== "requested" || shouldSuppressDefaultToolProgressMessages()) return;
				const label = summarizeApprovalLabel({
					status: payload.status,
					command: payload.command,
					message: payload.message
				});
				if (!label) return;
				await maybeSendWorkingStatus(label);
			},
			onPatchSummary: async (payload) => {
				if (isDispatchOperationAborted()) return;
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true })) await onPatchSummaryFromReplyOptions?.(payload);
				if (isDispatchOperationAborted()) return;
				if (payload.phase !== "end" || shouldSuppressDefaultToolProgressMessages()) return;
				const label = summarizePatchLabel({
					summary: payload.summary,
					title: payload.title
				});
				if (!label) return;
				await maybeSendWorkingStatus(label);
			},
			onBlockReply: (payload, context) => {
				markProgress();
				const run = async () => {
					if (isDispatchOperationAborted()) return;
					if (payload.isReasoning !== true && hasOutboundReplyContent(payload, { trimText: true })) markInboundDedupeReplayUnsafe();
					if (suppressDelivery) return;
					if (payload.isReasoning === true) return;
					const isStatusNotice = isReplyPayloadStatusNotice(payload);
					if (payload.text && !isStatusNotice) {
						const joinsBufferedTtsDirective = cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
						if (accumulatedBlockText.length > 0) accumulatedBlockText += "\n";
						accumulatedBlockText += payload.text;
						if (accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) accumulatedBlockTtsText += "\n";
						accumulatedBlockTtsText += payload.text;
						blockCount++;
					}
					const visiblePayload = payload.text && cleanBlockTtsDirectiveText && !isStatusNotice ? (() => {
						const text = cleanBlockTtsDirectiveText.push(payload.text);
						return {
							...payload,
							text: text.trim() ? text : void 0
						};
					})() : payload;
					if (!hasOutboundReplyContent(visiblePayload, { trimText: true })) return;
					const payloadMetadata = getReplyPayloadMetadata(payload);
					const queuedContext = payloadMetadata?.assistantMessageIndex !== void 0 ? {
						...context,
						assistantMessageIndex: payloadMetadata.assistantMessageIndex
					} : context;
					if (!suppressAutomaticSourceDelivery) await params.replyOptions?.onBlockReplyQueued?.(visiblePayload, queuedContext);
					if (isDispatchOperationAborted()) return;
					const normalizedPayload = await normalizeReplyMediaPayload(await maybeApplyTtsToReplyPayload({
						payload: visiblePayload,
						cfg,
						channel: deliveryChannel,
						kind: "block",
						inboundAudio,
						ttsAuto: sessionTtsAuto,
						agentId: sessionAgentId,
						accountId: replyRoute.accountId
					}));
					if (isDispatchOperationAborted()) return;
					if (shouldRouteToOriginating) await sendPayloadAsync(normalizedPayload, context?.abortSignal, false);
					else {
						markInboundDedupeReplayUnsafe();
						if (dispatcher.sendBlockReply(normalizedPayload)) await waitForReplyDispatcherIdle(dispatcher, context?.abortSignal);
					}
				};
				return run();
			}
		}, replyConfig)));
		ensureDispatchReplyOperation();
		if (ctx.AcpDispatchTailAfterReset === true) {
			ctx.AcpDispatchTailAfterReset = false;
			if (hookRunner?.hasHooks("reply_dispatch")) {
				const tailDispatchResult = await runWithReplyOperationAbort(dispatchAbortOperation, () => hookRunner.runReplyDispatch({
					ctx,
					runId: params.replyOptions?.runId,
					sessionKey: acpDispatchSessionKey,
					images: params.replyOptions?.images,
					inboundAudio,
					sessionTtsAuto,
					ttsChannel: deliveryChannel,
					suppressUserDelivery: suppressHookUserDelivery,
					suppressReplyLifecycle: suppressHookReplyLifecycle,
					sourceReplyDeliveryMode,
					shouldRouteToOriginating,
					originatingChannel: routeReplyChannel,
					originatingTo: routeReplyTo,
					shouldSendToolSummaries,
					sendPolicy,
					isTailDispatch: true
				}, {
					cfg,
					dispatcher: dispatchHookDispatcher,
					abortSignal: dispatchAbortOperation?.abortSignal ?? params.replyOptions?.abortSignal,
					onReplyStart: params.replyOptions?.onReplyStart,
					recordProcessed,
					markIdle
				}));
				if (tailDispatchResult?.handled) {
					recordAgentDispatchCompleted("completed");
					completeDispatchReplyOperation();
					return attachSourceReplyDeliveryMode({
						queuedFinal: tailDispatchResult.queuedFinal,
						counts: tailDispatchResult.counts
					});
				}
			}
		}
		const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : [];
		const beforeAgentRunBlocked = replies.some((reply) => getReplyPayloadMetadata(reply)?.beforeAgentRunBlocked === true);
		let queuedFinal = false;
		let routedFinalCount = 0;
		let attemptedFinalDelivery = false;
		let finalDeliveryFailed = false;
		const shouldDeliverDespiteSourceReplySuppression = (reply) => suppressAutomaticSourceDelivery && ctx.InboundEventKind !== "room_event" && !sendPolicyDenied && getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression === true;
		for (const reply of replies) {
			throwIfDispatchOperationAborted();
			if (reply.isReasoning === true) continue;
			if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
				if (hasOutboundReplyContent(reply, { trimText: true })) logVerbose([
					`dispatch-from-config: final reply suppressed by ${deliverySuppressionReason || "source delivery policy"}`,
					`(session=${acpDispatchSessionKey ?? sessionKey ?? "unknown"}`,
					`provider=${ctx.Provider ?? "unknown"}`,
					`surface=${ctx.Surface ?? "unknown"}`,
					`chatType=${chatType ?? "unknown"}`,
					`inboundEventKind=${ctx.InboundEventKind ?? "unknown"}`,
					`message=${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"}`,
					`${formatSuppressedReplyPayloadForLog(reply)})`
				].join(" "));
				continue;
			}
			attemptedFinalDelivery = true;
			const finalReply = await sendFinalPayload(reply);
			queuedFinal = finalReply.queuedFinal || queuedFinal;
			routedFinalCount += finalReply.routedFinalCount;
			if (!finalReply.queuedFinal && finalReply.routedFinalCount === 0) finalDeliveryFailed = true;
		}
		if (attemptedFinalDelivery && !finalDeliveryFailed) {
			throwIfDispatchOperationAborted();
			await clearPendingFinalDeliveryAfterSuccess({
				storePath: sessionStoreEntry.storePath,
				sessionKey: sessionStoreEntry.sessionKey ?? sessionKey
			});
		}
		if (!suppressDelivery) {
			if (resolveConfiguredTtsMode(cfg, {
				agentId: sessionAgentId,
				channelId: deliveryChannel,
				accountId: replyRoute.accountId
			}) === "final" && replies.length === 0 && blockCount > 0 && accumulatedBlockTtsText.trim()) try {
				throwIfDispatchOperationAborted();
				const ttsSyntheticReply = await maybeApplyTtsToReplyPayload({
					payload: { text: accumulatedBlockTtsText },
					cfg,
					channel: deliveryChannel,
					kind: "final",
					inboundAudio,
					ttsAuto: sessionTtsAuto,
					agentId: sessionAgentId,
					accountId: replyRoute.accountId
				});
				throwIfDispatchOperationAborted();
				if (ttsSyntheticReply.mediaUrl) {
					const normalizedTtsOnlyPayload = await normalizeReplyMediaPayload(markReplyPayloadAsTtsSupplement({
						mediaUrl: ttsSyntheticReply.mediaUrl,
						audioAsVoice: ttsSyntheticReply.audioAsVoice,
						spokenText: accumulatedBlockTtsText,
						trustedLocalMedia: true
					}, accumulatedBlockTtsText, { visibleTextAlreadyDelivered: true }));
					throwIfDispatchOperationAborted();
					const result = await routeReplyToOriginating(normalizedTtsOnlyPayload, { abortSignal: dispatchAbortOperation?.abortSignal });
					if (result) {
						queuedFinal = result.ok || queuedFinal;
						if (result.ok) routedFinalCount += 1;
						if (!result.ok) logVerbose(`dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`);
					} else {
						throwIfDispatchOperationAborted();
						markInboundDedupeReplayUnsafe();
						queuedFinal = dispatcher.sendFinalReply(normalizedTtsOnlyPayload) || queuedFinal;
					}
				}
			} catch (err) {
				if (isDispatchReplyOperationAbortedError(err)) throw err;
				logVerbose(`dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`);
			}
		}
		const counts = dispatcher.getQueuedCounts();
		counts.final += routedFinalCount;
		commitInboundDedupeIfClaimed();
		recordAgentDispatchCompleted("completed");
		recordProcessed("completed", pluginFallbackReason ? { reason: pluginFallbackReason } : void 0);
		markIdle("message_completed");
		completeDispatchReplyOperation();
		return attachSourceReplyDeliveryMode({
			queuedFinal,
			counts,
			...beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}
		});
	} catch (err) {
		if (isDispatchReplyOperationAbortedError(err)) {
			commitInboundDedupeIfClaimed();
			recordProcessed("completed", { reason: "reply_operation_aborted" });
			markIdle("message_completed");
			completeDispatchReplyOperation();
			return attachSourceReplyDeliveryMode({
				queuedFinal: false,
				counts: dispatcher.getQueuedCounts()
			});
		}
		if (inboundDedupeClaim.status === "claimed") if (inboundDedupeReplayUnsafe) commitInboundDedupe(inboundDedupeClaim.key);
		else releaseInboundDedupe(inboundDedupeClaim.key);
		recordAgentDispatchCompleted("error", { error: String(err) });
		recordProcessed("error", { error: String(err) });
		markIdle("message_error");
		failDispatchReplyOperation(err);
		throw err;
	}
}
//#endregion
//#region src/auto-reply/dispatch.ts
const foregroundReplyFenceByKey = /* @__PURE__ */ new Map();
function normalizeForegroundReplyFencePart(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveForegroundReplyFenceKey(finalized) {
	const sessionKey = normalizeForegroundReplyFencePart(finalized.SessionKey);
	const channel = normalizeForegroundReplyFencePart(finalized.OriginatingChannel) ?? normalizeForegroundReplyFencePart(finalized.Surface) ?? normalizeForegroundReplyFencePart(finalized.Provider);
	const target = normalizeForegroundReplyFencePart(finalized.OriginatingTo) ?? normalizeForegroundReplyFencePart(finalized.NativeChannelId) ?? normalizeForegroundReplyFencePart(finalized.From) ?? normalizeForegroundReplyFencePart(finalized.To);
	if (!sessionKey || !channel || !target) return;
	return JSON.stringify([
		"foreground",
		channel,
		normalizeForegroundReplyFencePart(finalized.AccountId) ?? "default",
		sessionKey,
		normalizeChatType(finalized.ChatType) ?? "unknown",
		target
	]);
}
function beginForegroundReplyFence(finalized) {
	const key = resolveForegroundReplyFenceKey(finalized);
	if (!key) return;
	const state = foregroundReplyFenceByKey.get(key) ?? {
		generation: 0,
		activeDispatches: 0
	};
	state.generation += 1;
	state.activeDispatches += 1;
	foregroundReplyFenceByKey.set(key, state);
	return {
		key,
		generation: state.generation
	};
}
function isForegroundReplyFenceSuperseded(snapshot) {
	return Boolean(snapshot && (foregroundReplyFenceByKey.get(snapshot.key)?.generation ?? 0) !== snapshot.generation);
}
function endForegroundReplyFence(snapshot) {
	const state = foregroundReplyFenceByKey.get(snapshot.key);
	if (!state) return;
	state.activeDispatches -= 1;
	if (state.activeDispatches <= 0) foregroundReplyFenceByKey.delete(snapshot.key);
}
function resolveDispatcherSilentReplyContext(ctx, cfg) {
	const finalized = finalizeInboundContext(ctx);
	const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
	const policySessionKey = commandTargetSessionKey ?? finalized.SessionKey;
	const chatType = normalizeChatType(finalized.ChatType);
	const conversationType = commandTargetSessionKey && commandTargetSessionKey !== finalized.SessionKey ? void 0 : chatType === "direct" ? "direct" : chatType === "group" || chatType === "channel" ? "group" : void 0;
	return {
		cfg,
		sessionKey: policySessionKey,
		surface: finalized.Surface ?? finalized.Provider,
		conversationType
	};
}
function resolveInboundReplyHookTarget(finalized, hookCtx) {
	if (typeof finalized.OriginatingTo === "string" && finalized.OriginatingTo.trim()) return finalized.OriginatingTo;
	if (hookCtx.isGroup) return hookCtx.conversationId ?? hookCtx.to ?? hookCtx.from;
	return hookCtx.from || hookCtx.conversationId || hookCtx.to || "";
}
function buildMessageSendingBeforeDeliver(ctx) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("message_sending")) return;
	const finalized = finalizeInboundContext(ctx);
	const hookCtx = deriveInboundMessageHookContext(finalized);
	const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
	return async (payload) => {
		if (!payload.text) return payload;
		const result = await hookRunner.runMessageSending({
			content: payload.text,
			to: replyTarget
		}, toPluginMessageContext(hookCtx));
		if (result?.cancel) return null;
		if (result?.content != null) return {
			...payload,
			text: result.content
		};
		return payload;
	};
}
function buildDispatchTimelineAttributes(ctx) {
	const commandTurn = resolveCommandTurnContext(ctx);
	return {
		surface: typeof ctx.Surface === "string" ? ctx.Surface : typeof ctx.Provider === "string" ? ctx.Provider : "unknown",
		hasSessionKey: typeof ctx.SessionKey === "string" || typeof ctx.CommandTargetSessionKey === "string",
		commandSource: commandTurn.source
	};
}
function finalizeDispatchResult(result, dispatcher) {
	const cancelledCounts = dispatcher.getCancelledCounts?.();
	const failedCounts = dispatcher.getFailedCounts?.();
	if (!cancelledCounts && !failedCounts) return result;
	const resultCounts = {
		tool: result.counts?.tool ?? 0,
		block: result.counts?.block ?? 0,
		final: result.counts?.final ?? 0
	};
	const counts = {
		tool: Math.max(0, resultCounts.tool - (cancelledCounts?.tool ?? 0) - (failedCounts?.tool ?? 0)),
		block: Math.max(0, resultCounts.block - (cancelledCounts?.block ?? 0) - (failedCounts?.block ?? 0)),
		final: Math.max(0, resultCounts.final - (cancelledCounts?.final ?? 0) - (failedCounts?.final ?? 0))
	};
	const hasFailedCounts = (failedCounts?.tool ?? 0) > 0 || (failedCounts?.block ?? 0) > 0 || (failedCounts?.final ?? 0) > 0;
	return {
		...result,
		queuedFinal: result.queuedFinal && counts.final > 0,
		counts,
		...hasFailedCounts ? { failedCounts } : {}
	};
}
async function dispatchInboundMessage(params) {
	const finalized = measureDiagnosticsTimelineSpanSync("auto_reply.finalize_context", () => finalizeInboundContext(params.ctx), {
		phase: "agent-turn",
		config: params.cfg,
		attributes: buildDispatchTimelineAttributes(params.ctx)
	});
	if (isDiagnosticsEnabled(params.cfg)) logMessageReceived({
		sessionKey: finalized.SessionKey,
		channel: finalized.Surface ?? finalized.Provider,
		chatId: finalized.To ?? finalized.From,
		messageId: finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast,
		source: "dispatchInboundMessage"
	});
	return finalizeDispatchResult(await withReplyDispatcher({
		dispatcher: params.dispatcher,
		run: () => measureDiagnosticsTimelineSpan("auto_reply.dispatch_reply_from_config", () => dispatchReplyFromConfig({
			ctx: finalized,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions,
			replyResolver: params.replyResolver
		}), {
			phase: "agent-turn",
			config: params.cfg,
			attributes: buildDispatchTimelineAttributes(finalized)
		})
	}), params.dispatcher);
}
async function dispatchInboundMessageWithBufferedDispatcher(params) {
	const finalized = finalizeInboundContext(params.ctx);
	const foregroundReplyFence = beginForegroundReplyFence(finalized);
	const silentReplyContext = resolveDispatcherSilentReplyContext(finalized, params.cfg);
	const configuredBeforeDeliver = params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(finalized);
	const beforeDeliver = foregroundReplyFence || configuredBeforeDeliver ? async (payload, info) => {
		if (isForegroundReplyFenceSuperseded(foregroundReplyFence)) return null;
		const deliverPayload = configuredBeforeDeliver ? await configuredBeforeDeliver(payload, info) : payload;
		if (!deliverPayload || isForegroundReplyFenceSuperseded(foregroundReplyFence)) return null;
		return deliverPayload;
	} : void 0;
	const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
		...params.dispatcherOptions,
		beforeDeliver,
		silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext
	});
	try {
		return await dispatchInboundMessage({
			ctx: finalized,
			cfg: params.cfg,
			dispatcher,
			replyResolver: params.replyResolver,
			replyOptions: {
				...params.replyOptions,
				...replyOptions
			}
		});
	} finally {
		if (foregroundReplyFence) endForegroundReplyFence(foregroundReplyFence);
		markRunComplete();
		markDispatchIdle();
	}
}
async function dispatchInboundMessageWithDispatcher(params) {
	const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
	const dispatcher = createReplyDispatcher({
		...params.dispatcherOptions,
		beforeDeliver: params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx),
		silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext
	});
	return await dispatchInboundMessage({
		ctx: params.ctx,
		cfg: params.cfg,
		dispatcher,
		replyResolver: params.replyResolver,
		replyOptions: params.replyOptions
	});
}
//#endregion
export { settleReplyDispatcher as a, dispatchReplyFromConfig as i, dispatchInboundMessageWithBufferedDispatcher as n, withReplyDispatcher as o, dispatchInboundMessageWithDispatcher as r, dispatchInboundMessage as t };
