import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { _ as sleep } from "./utils-CCskKJVV.js";
import { i as isDiagnosticsEnabled } from "./diagnostic-events-DrCvmHmj.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { r as logVerbose } from "./globals-C7I_COwU.js";
import { n as isAcpSessionKey } from "./session-key-utils-C1mGpjUn.js";
import { p as resolveSessionAgentId, v as resolveAgentConfig, x as resolveAgentWorkspaceDir } from "./agent-scope-CbabgXwH.js";
import { t as applyMergePatch } from "./merge-patch-BzwP7uYW.js";
import "./message-channel-core-C7rda51s.js";
import { u as normalizeMessageChannel } from "./message-channel-CxR7kyT3.js";
import { l as fireAndForgetHook, n as getGlobalPluginRegistry, t as getGlobalHookRunner } from "./hook-runner-global-DHhbAIJU.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-zZSBgwJK.js";
import { u as resolveStorePath } from "./paths-Dl79wsM6.js";
import { d as parseSessionThreadInfoFast, t as loadSessionStore } from "./store-load-BJuxv-vp.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Cl8KmGKt.js";
import { b as resolveGroupSessionKey, p as resolveSessionStoreEntry } from "./store-IyLBOjUO.js";
import { t as normalizeChatType } from "./chat-type-BrFPcj8_.js";
import { h as normalizeVerboseLevel } from "./thinking-DXB3ip3_.js";
import { f as markDiagnosticSessionProgress, i as logMessageQueued, r as logMessageProcessed, s as logSessionStateChange } from "./diagnostic-OnLcowA0.js";
import { i as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-CRsJHE3b.js";
import { a as resolveToolProfilePolicy } from "./tool-policy-shared-ywrO5Obc.js";
import { c as mergeAlsoAllowPolicy } from "./tool-policy-Gps1tVLh.js";
import { a as isSilentReplyText, n as SILENT_REPLY_TOKEN } from "./tokens-B5LCdh_k.js";
import { n as isParentOwnedBackgroundAcpSession } from "./openclaw-tools-2DL7Ok1u.js";
import { i as selectAgentHarness } from "./selection-BdMNZw6y.js";
import { t as getReplyPayloadMetadata } from "./reply-payload-DE5sgXDk.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-B61Gbdzt.js";
import { i as generateSecureInt } from "./secure-random-CGoq01ar.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-CrMH8bQo.js";
import { i as resolveSubagentToolPolicyForSession, n as resolveEffectiveToolPolicy, r as resolveGroupToolPolicy } from "./pi-tools.policy-BFxN7KEs.js";
import { c as toPluginInboundClaimEvent, i as toInternalMessageReceivedContext, l as toPluginMessageContext, n as deriveInboundMessageHookContext, s as toPluginInboundClaimContext, u as toPluginMessageReceivedEvent } from "./message-hook-mappers-C9fthQYG.js";
import { n as resolveSilentReplySettings, r as resolveSilentReplyRewriteText } from "./silent-reply-DwFsV-oP.js";
import { t as normalizeReplyPayload } from "./normalize-reply-BlhvC6sE.js";
import { r as getSessionBindingService } from "./session-binding-service-DssF7JYi.js";
import { n as resolveOriginMessageProvider } from "./origin-routing-0wLhlJId.js";
import { t as finalizeInboundContext } from "./inbound-context-7ossg2z_.js";
import { a as buildPluginBindingUnavailableText, b as touchConversationBindingRecord, c as hasShownPluginBindingFallbackNotice, d as markPluginBindingFallbackNoticeShown, h as toPluginConversationBinding, n as buildPluginBindingDeclinedText, r as buildPluginBindingErrorText, u as isPluginOwnedSessionBindingRecord, y as resolveConversationBindingRecord } from "./conversation-binding-Cn476Ys4.js";
import { n as hasActiveApprovalNativeRouteRuntime } from "./approval-native-route-coordinator-CNLzFPlo.js";
import { n as resolveSendPolicy } from "./send-policy-C0LXm5Me.js";
import { t as createTtsDirectiveTextStreamCleaner } from "./directives-Bir8UM26.js";
import { n as normalizeTtsAutoMode } from "./tts-auto-mode-CLePZX35.js";
import { i as shouldCleanTtsDirectiveText, r as shouldAttemptTtsPayload, t as resolveConfiguredTtsMode } from "./tts-config-BQeqR0d6.js";
import { i as resolveConversationBindingContextFromMessage } from "./conversation-binding-input-BNwNcdzp.js";
import { d as resolveEffectiveReplyRoute, l as withFullRuntimeReplyConfig, t as resolveRunTypingPolicy } from "./typing-policy-DLcqOiEj.js";
import { n as commitInboundDedupe, r as releaseInboundDedupe, t as claimInboundDedupe } from "./inbound-dedupe-B7pzw4oC.js";
import { n as resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode-BHOX-BYB.js";
import { n as registerDispatcher } from "./dispatcher-registry-Cfi_yr3Z.js";
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
const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const getReplyFromConfigRuntimeLoader = createLazyImportLoader(() => import("./get-reply-from-config.runtime.js"));
const abortRuntimeLoader = createLazyImportLoader(() => import("./abort.runtime.js"));
const ttsRuntimeLoader = createLazyImportLoader(() => import("./tts.runtime-nbR4Elrd.js"));
const runtimePluginsLoader = createLazyImportLoader(() => import("./runtime-plugins.runtime.js"));
const replyMediaPathsRuntimeLoader = createLazyImportLoader(() => import("./reply-media-paths.runtime-D3c5sqAI.js"));
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
async function maybeApplyTtsToReplyPayload(params) {
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
	if (ctx.CommandSource === "native" && ctx.CommandTargetSessionKey && ctx.CommandTargetSessionKey !== ctx.SessionKey) return;
	const chatType = normalizeChatType(ctx.ChatType);
	if (chatType === "direct") return "direct";
	if (chatType === "group" || chatType === "channel") return "group";
};
const resolveSessionStoreLookup = (ctx, cfg) => {
	const sessionKey = normalizeOptionalString((ctx.CommandSource === "native" ? normalizeOptionalString(ctx.CommandTargetSessionKey) : void 0) ?? ctx.SessionKey);
	if (!sessionKey) return {};
	const agentId = resolveSessionAgentId({
		sessionKey,
		config: cfg
	});
	const storePath = resolveStorePath(cfg.session?.store, { agentId });
	try {
		return {
			sessionKey,
			storePath,
			entry: resolveSessionStoreEntry({
				store: loadSessionStore(storePath),
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
	return () => {
		if (params.sessionKey && params.storePath) try {
			const entry = resolveSessionStoreEntry({
				store: loadSessionStore(params.storePath),
				sessionKey: params.sessionKey
			}).existing;
			const currentLevel = normalizeVerboseLevel(entry?.verboseLevel ?? "");
			if (currentLevel) return currentLevel !== "off";
		} catch {}
		return params.fallbackLevel !== "off";
	};
};
const resolveHarnessSourceVisibleRepliesDefault = (params) => {
	if (params.ctx.CommandSource === "native") return;
	try {
		return selectAgentHarness({
			provider: normalizeOptionalString(params.entry?.modelProvider) ?? normalizeOptionalString(params.ctx.Provider) ?? normalizeOptionalString(params.ctx.Surface) ?? "",
			modelId: normalizeOptionalString(params.entry?.model),
			config: params.cfg,
			agentId: params.sessionAgentId,
			sessionKey: params.sessionKey,
			agentHarnessId: normalizeOptionalString(params.entry?.agentHarnessId) ?? normalizeOptionalString(params.entry?.agentRuntimeOverride)
		}).deliveryDefaults?.sourceVisibleReplies;
	} catch (error) {
		logVerbose(`dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`);
		return;
	}
};
async function dispatchReplyFromConfig(params) {
	const { ctx, cfg, dispatcher } = params;
	const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
	const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
	const chatId = ctx.To ?? ctx.From;
	const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
	const sessionKey = normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
	const startTime = diagnosticsEnabled ? Date.now() : 0;
	const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);
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
	const inboundDedupeClaim = claimInboundDedupe(ctx);
	if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
		recordProcessed("skipped", { reason: "duplicate" });
		return {
			queuedFinal: false,
			counts: dispatcher.getQueuedCounts()
		};
	}
	let inboundDedupeReplayUnsafe = false;
	const markInboundDedupeReplayUnsafe = () => {
		inboundDedupeReplayUnsafe = true;
	};
	const commitInboundDedupeIfClaimed = () => {
		if (inboundDedupeClaim.status === "claimed") commitInboundDedupe(inboundDedupeClaim.key);
	};
	const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
	const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({
		ctx,
		cfg
	});
	const acpDispatchSessionKey = boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
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
	const shouldEmitVerboseProgress = createShouldEmitVerboseProgress({
		sessionKey: acpDispatchSessionKey,
		storePath: sessionStoreEntry.storePath,
		fallbackLevel: normalizeVerboseLevel(sessionStoreEntry.entry?.verboseLevel ?? sessionAgentCfg?.verboseDefault ?? cfg.agents?.defaults?.verboseDefault ?? "") ?? "off"
	});
	const replyRoute = resolveEffectiveReplyRoute({
		ctx,
		entry: sessionStoreEntry.entry
	});
	const routeThreadId = ctx.MessageThreadId ?? parseSessionThreadInfoFast(acpDispatchSessionKey).threadId;
	const inboundAudio = isInboundAudioContext(ctx);
	const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
	const { ensureRuntimePluginsLoaded } = await loadRuntimePlugins();
	ensureRuntimePluginsLoaded({
		config: cfg,
		workspaceDir
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
			policySessionKey: ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey ?? ctx.SessionKey : ctx.SessionKey,
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
		if (abortSignal?.aborted) return;
		const result = await routeReplyToOriginating(payload, {
			abortSignal,
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
		sessionKey: acpDispatchSessionKey
	}) : void 0;
	const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
	const runtimeProfileAlsoAllow = params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" || params.replyOptions?.sourceReplyDeliveryMode === void 0 && ctx.CommandSource !== "native" && (chatType === "group" || chatType === "channel" ? effectiveVisibleReplies !== "automatic" : effectiveVisibleReplies === "message_tool") ? ["message"] : [];
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
		}) ? resolveSubagentToolPolicyForSession(cfg, acpDispatchSessionKey, { store: subagentStore }) : void 0
	]);
	const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
		cfg,
		ctx,
		requested: params.replyOptions?.sourceReplyDeliveryMode,
		sendPolicy,
		suppressAcpChildUserDelivery,
		explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
		shouldSuppressTyping,
		messageToolAvailable,
		defaultVisibleReplies: harnessDefaultVisibleReplies
	});
	const { sourceReplyDeliveryMode, suppressAutomaticSourceDelivery, suppressDelivery, deliverySuppressionReason, suppressHookUserDelivery, suppressHookReplyLifecycle } = sourceReplyPolicy;
	let pluginFallbackReason;
	if (pluginOwnedBinding) {
		touchConversationBindingRecord(pluginOwnedBinding.bindingId);
		if (suppressDelivery) logVerbose(`plugin-bound inbound skipped under ${deliverySuppressionReason} (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to suppressed agent processing`);
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
					return {
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					};
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
					return {
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					};
				case "error":
					logVerbose(`plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`);
					await sendBindingNotice({ text: buildPluginBindingErrorText(pluginOwnedBinding) }, "terminal");
					markIdle("plugin_binding_error");
					recordProcessed("completed", { reason: "plugin-bound-error" });
					commitInboundDedupeIfClaimed();
					return {
						queuedFinal: false,
						counts: dispatcher.getQueuedCounts()
					};
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
			return {
				queuedFinal,
				counts
			};
		}
		const shouldSendVerboseProgressMessages = !((ctx.Surface === "slack" || ctx.Provider === "slack") && ctx.ChatType !== "direct") && (ctx.ChatType !== "group" || ctx.IsForum === true);
		const shouldSendToolSummaries = shouldSendVerboseProgressMessages;
		const shouldSendToolStartStatuses = shouldSendVerboseProgressMessages;
		const sendFinalPayload = async (payload) => {
			if (resolveSendableOutboundReplyParts(payload).hasContent) markInboundDedupeReplayUnsafe();
			const normalizedPayload = await normalizeReplyMediaPayload(await maybeApplyTtsToReplyPayload({
				payload,
				cfg,
				channel: deliveryChannel,
				kind: "final",
				inboundAudio,
				ttsAuto: sessionTtsAuto,
				agentId: sessionAgentId,
				accountId: replyRoute.accountId
			}));
			const result = await routeReplyToOriginating(normalizedPayload);
			if (result) {
				if (!result.ok) logVerbose(`dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`);
				return {
					queuedFinal: result.ok,
					routedFinalCount: result.ok ? 1 : 0
				};
			}
			markInboundDedupeReplayUnsafe();
			return {
				queuedFinal: dispatcher.sendFinalReply(normalizedPayload),
				routedFinalCount: 0
			};
		};
		if (hookRunner?.hasHooks("before_dispatch")) {
			const beforeDispatchResult = await hookRunner.runBeforeDispatch({
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
			});
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
				return {
					queuedFinal,
					counts
				};
			}
		}
		if (hookRunner?.hasHooks("reply_dispatch")) {
			const replyDispatchResult = await hookRunner.runReplyDispatch({
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
				dispatcher,
				abortSignal: params.replyOptions?.abortSignal,
				onReplyStart: params.replyOptions?.onReplyStart,
				recordProcessed,
				markIdle
			});
			if (replyDispatchResult?.handled) {
				commitInboundDedupeIfClaimed();
				return {
					queuedFinal: replyDispatchResult.queuedFinal,
					counts: replyDispatchResult.counts
				};
			}
		}
		if (suppressDelivery) logVerbose(`Delivery suppressed by ${deliverySuppressionReason} for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`);
		const toolStartStatusesSent = /* @__PURE__ */ new Set();
		let toolStartStatusCount = 0;
		const normalizeWorkingLabel = (label) => {
			const collapsed = label.replace(/\s+/g, " ").trim();
			if (collapsed.length <= 80) return collapsed;
			return `${collapsed.slice(0, 77).trimEnd()}...`;
		};
		const formatPlanUpdateText = (payload) => {
			const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
			const steps = (payload.steps ?? []).map((step) => step.replace(/\s+/g, " ").trim()).filter(Boolean);
			const parts = [];
			if (explanation) parts.push(explanation);
			if (steps.length > 0) parts.push(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
			return parts.join("\n\n").trim() || "Planning next steps.";
		};
		const maybeSendWorkingStatus = async (label) => {
			if (suppressDelivery) return;
			const normalizedLabel = normalizeWorkingLabel(label);
			if (!shouldEmitVerboseProgress() || !shouldSendToolStartStatuses || !normalizedLabel || toolStartStatusCount >= 2 || toolStartStatusesSent.has(normalizedLabel)) return;
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
			if (suppressDelivery || !shouldEmitVerboseProgress() || !shouldSendVerboseProgressMessages) return;
			const replyPayload = { text: formatPlanUpdateText(payload) };
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
		const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
		const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
		const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
		const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
		const wrapProgressCallback = (callback) => {
			if (!callback && (!suppressAutomaticSourceDelivery || !canTrackSession)) return;
			return async (...args) => {
				markProgress();
				if (!suppressAutomaticSourceDelivery) await callback?.(...args);
			};
		};
		const replyResolver = params.replyResolver ?? (await loadGetReplyFromConfigRuntime()).getReplyFromConfig;
		const replyConfig = withFullRuntimeReplyConfig(params.configOverride ? applyMergePatch(cfg, params.configOverride) : cfg);
		const replyResult = await replyResolver(ctx, {
			...params.replyOptions,
			sourceReplyDeliveryMode,
			typingPolicy: typing.typingPolicy,
			suppressTyping: typing.suppressTyping,
			onPartialReply: wrapProgressCallback(params.replyOptions?.onPartialReply),
			onReasoningStream: wrapProgressCallback(params.replyOptions?.onReasoningStream),
			onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
			onAssistantMessageStart: wrapProgressCallback(params.replyOptions?.onAssistantMessageStart),
			onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
			onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart),
			onItemEvent: wrapProgressCallback(params.replyOptions?.onItemEvent),
			onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput),
			onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart),
			onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd),
			onToolResult: (payload) => {
				markProgress();
				const run = async () => {
					markInboundDedupeReplayUnsafe();
					if (!suppressAutomaticSourceDelivery) await onToolResultFromReplyOptions?.(payload);
					if (suppressDelivery) return;
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
					if (suppressDefaultToolProgressMessages) {
						const hasMedia = resolveSendableOutboundReplyParts(deliveryPayload).hasMedia;
						const execApproval = deliveryPayload.channelData && typeof deliveryPayload.channelData === "object" && !Array.isArray(deliveryPayload.channelData) ? deliveryPayload.channelData.execApproval : void 0;
						if (!hasMedia && !(execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) && deliveryPayload.isError !== true) return;
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
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (!suppressAutomaticSourceDelivery) await onPlanUpdateFromReplyOptions?.(payload);
				if (payload.phase !== "update" || suppressDefaultToolProgressMessages) return;
				await sendPlanUpdate({
					explanation: payload.explanation,
					steps: payload.steps
				});
			},
			onApprovalEvent: async (payload) => {
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (!suppressAutomaticSourceDelivery) await onApprovalEventFromReplyOptions?.(payload);
				if (payload.phase !== "requested" || suppressDefaultToolProgressMessages) return;
				const label = summarizeApprovalLabel({
					status: payload.status,
					command: payload.command,
					message: payload.message
				});
				if (!label) return;
				await maybeSendWorkingStatus(label);
			},
			onPatchSummary: async (payload) => {
				markProgress();
				markInboundDedupeReplayUnsafe();
				if (!suppressAutomaticSourceDelivery) await onPatchSummaryFromReplyOptions?.(payload);
				if (payload.phase !== "end" || suppressDefaultToolProgressMessages) return;
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
					if (payload.isReasoning !== true && resolveSendableOutboundReplyParts(payload).hasContent) markInboundDedupeReplayUnsafe();
					if (suppressDelivery) return;
					if (payload.isReasoning === true) return;
					if (payload.text && !payload.isCompactionNotice) {
						const joinsBufferedTtsDirective = cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
						if (accumulatedBlockText.length > 0) accumulatedBlockText += "\n";
						accumulatedBlockText += payload.text;
						if (accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) accumulatedBlockTtsText += "\n";
						accumulatedBlockTtsText += payload.text;
						blockCount++;
					}
					const visiblePayload = payload.text && cleanBlockTtsDirectiveText && !payload.isCompactionNotice ? (() => {
						const text = cleanBlockTtsDirectiveText.push(payload.text);
						return {
							...payload,
							text: text.trim() ? text : void 0
						};
					})() : payload;
					if (!resolveSendableOutboundReplyParts(visiblePayload).hasContent) return;
					const payloadMetadata = getReplyPayloadMetadata(payload);
					const queuedContext = payloadMetadata?.assistantMessageIndex !== void 0 ? {
						...context,
						assistantMessageIndex: payloadMetadata.assistantMessageIndex
					} : context;
					if (!suppressAutomaticSourceDelivery) await params.replyOptions?.onBlockReplyQueued?.(visiblePayload, queuedContext);
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
					if (shouldRouteToOriginating) await sendPayloadAsync(normalizedPayload, context?.abortSignal, false);
					else {
						markInboundDedupeReplayUnsafe();
						dispatcher.sendBlockReply(normalizedPayload);
					}
				};
				return run();
			}
		}, replyConfig);
		if (ctx.AcpDispatchTailAfterReset === true) {
			ctx.AcpDispatchTailAfterReset = false;
			if (hookRunner?.hasHooks("reply_dispatch")) {
				const tailDispatchResult = await hookRunner.runReplyDispatch({
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
					dispatcher,
					abortSignal: params.replyOptions?.abortSignal,
					onReplyStart: params.replyOptions?.onReplyStart,
					recordProcessed,
					markIdle
				});
				if (tailDispatchResult?.handled) return {
					queuedFinal: tailDispatchResult.queuedFinal,
					counts: tailDispatchResult.counts
				};
			}
		}
		const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : [];
		let queuedFinal = false;
		let routedFinalCount = 0;
		if (!suppressDelivery) {
			for (const reply of replies) {
				if (reply.isReasoning === true) continue;
				const finalReply = await sendFinalPayload(reply);
				queuedFinal = finalReply.queuedFinal || queuedFinal;
				routedFinalCount += finalReply.routedFinalCount;
			}
			if (resolveConfiguredTtsMode(cfg, {
				agentId: sessionAgentId,
				channelId: deliveryChannel,
				accountId: replyRoute.accountId
			}) === "final" && replies.length === 0 && blockCount > 0 && accumulatedBlockTtsText.trim()) try {
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
				if (ttsSyntheticReply.mediaUrl) {
					const normalizedTtsOnlyPayload = await normalizeReplyMediaPayload({
						mediaUrl: ttsSyntheticReply.mediaUrl,
						audioAsVoice: ttsSyntheticReply.audioAsVoice,
						spokenText: accumulatedBlockTtsText
					});
					const result = await routeReplyToOriginating(normalizedTtsOnlyPayload);
					if (result) {
						queuedFinal = result.ok || queuedFinal;
						if (result.ok) routedFinalCount += 1;
						if (!result.ok) logVerbose(`dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`);
					} else {
						markInboundDedupeReplayUnsafe();
						queuedFinal = dispatcher.sendFinalReply(normalizedTtsOnlyPayload) || queuedFinal;
					}
				}
			} catch (err) {
				logVerbose(`dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`);
			}
		}
		const counts = dispatcher.getQueuedCounts();
		counts.final += routedFinalCount;
		commitInboundDedupeIfClaimed();
		recordProcessed("completed", pluginFallbackReason ? { reason: pluginFallbackReason } : void 0);
		markIdle("message_completed");
		return {
			queuedFinal,
			counts
		};
	} catch (err) {
		if (inboundDedupeClaim.status === "claimed") if (inboundDedupeReplayUnsafe) commitInboundDedupe(inboundDedupeClaim.key);
		else releaseInboundDedupe(inboundDedupeClaim.key);
		recordProcessed("error", { error: String(err) });
		markIdle("message_error");
		throw err;
	}
}
//#endregion
//#region src/auto-reply/reply/reply-dispatcher.ts
const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");
/** Generate a random delay within the configured range. */
function getHumanDelay(config) {
	const mode = config?.mode ?? "off";
	if (mode === "off") return 0;
	const min = mode === "custom" ? config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS : DEFAULT_HUMAN_DELAY_MIN_MS;
	const max = mode === "custom" ? config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS : DEFAULT_HUMAN_DELAY_MAX_MS;
	if (max <= min) return min;
	return min + generateSecureInt(max - min + 1);
}
function normalizeReplyPayloadInternal(payload, opts) {
	const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;
	return normalizeReplyPayload(payload, {
		responsePrefix: opts.responsePrefix,
		responsePrefixContext: prefixContext,
		onHeartbeatStrip: opts.onHeartbeatStrip,
		transformReplyPayload: opts.transformReplyPayload,
		onSkip: opts.onSkip
	});
}
function resolveSilentFinalPayload(params) {
	if (params.kind !== "final") return;
	if (!isSilentReplyText(params.payload.text, "NO_REPLY")) return;
	const context = params.silentReplyContext;
	if (!context) return;
	const resolvedSettings = resolveSilentReplySettings({
		cfg: context.cfg,
		sessionKey: context.sessionKey,
		surface: context.surface,
		conversationType: context.conversationType
	});
	if (resolvedSettings.policy === "allow") return;
	if (resolvedSettings.rewrite) {
		silentReplyLogger.debug("rewriting exact NO_REPLY final payload before delivery", {
			hasSessionKey: Boolean(context.sessionKey),
			surface: context.surface,
			conversationType: context.conversationType,
			resolvedPolicy: resolvedSettings.policy
		});
		return {
			...params.payload,
			text: resolveSilentReplyRewriteText({ seed: `${context.sessionKey ?? context.surface ?? "silent-reply"}:${params.payload.text ?? ""}` })
		};
	}
	if (!resolvedSettings.rewrite) silentReplyLogger.debug("preserving exact NO_REPLY final payload before normalization", {
		hasSessionKey: Boolean(context.sessionKey),
		surface: context.surface,
		conversationType: context.conversationType,
		resolvedPolicy: resolvedSettings.policy
	});
	return {
		...params.payload,
		text: params.payload.text?.trim() || "NO_REPLY"
	};
}
function createReplyDispatcher(options) {
	let sendChain = Promise.resolve();
	let pending = 1;
	let completeCalled = false;
	let sentFirstBlock = false;
	const queuedCounts = {
		tool: 0,
		block: 0,
		final: 0
	};
	const failedCounts = {
		tool: 0,
		block: 0,
		final: 0
	};
	const cancelledCounts = {
		tool: 0,
		block: 0,
		final: 0
	};
	const { unregister } = registerDispatcher({
		pending: () => pending,
		waitForIdle: () => sendChain
	});
	const enqueue = (kind, payload) => {
		const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
		const normalized = resolveSilentFinalPayload({
			kind,
			payload,
			silentReplyContext: options.silentReplyContext
		}) ?? normalizeReplyPayloadInternal(payload, {
			responsePrefix: options.responsePrefix,
			responsePrefixContext: options.responsePrefixContext,
			responsePrefixContextProvider: options.responsePrefixContextProvider,
			transformReplyPayload: options.transformReplyPayload,
			onHeartbeatStrip: options.onHeartbeatStrip,
			onSkip: (reason) => options.onSkip?.(payload, {
				kind,
				reason
			})
		});
		if (!normalized) {
			if (kind === "final" && originalWasExactSilent) silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
				hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
				surface: options.silentReplyContext?.surface,
				conversationType: options.silentReplyContext?.conversationType
			});
			return false;
		}
		queuedCounts[kind] += 1;
		pending += 1;
		const shouldDelay = kind === "block" && sentFirstBlock;
		if (kind === "block") sentFirstBlock = true;
		sendChain = sendChain.then(async () => {
			if (shouldDelay) {
				const delayMs = getHumanDelay(options.humanDelay);
				if (delayMs > 0) await sleep(delayMs);
			}
			let deliverPayload = normalized;
			if (options.beforeDeliver) {
				deliverPayload = await options.beforeDeliver(normalized, { kind });
				if (!deliverPayload) {
					cancelledCounts[kind] += 1;
					return;
				}
			}
			await options.deliver(deliverPayload, { kind });
		}).catch((err) => {
			failedCounts[kind] += 1;
			options.onError?.(err, { kind });
		}).finally(() => {
			pending -= 1;
			if (pending === 1 && completeCalled) pending -= 1;
			if (pending === 0) {
				unregister();
				options.onIdle?.();
			}
		});
		return true;
	};
	const markComplete = () => {
		if (completeCalled) return;
		completeCalled = true;
		Promise.resolve().then(() => {
			if (pending === 1 && completeCalled) {
				pending -= 1;
				if (pending === 0) {
					unregister();
					options.onIdle?.();
				}
			}
		});
	};
	return {
		sendToolResult: (payload) => enqueue("tool", payload),
		sendBlockReply: (payload) => enqueue("block", payload),
		sendFinalReply: (payload) => enqueue("final", payload),
		waitForIdle: () => sendChain,
		getQueuedCounts: () => ({ ...queuedCounts }),
		getCancelledCounts: () => ({ ...cancelledCounts }),
		getFailedCounts: () => ({ ...failedCounts }),
		markComplete
	};
}
function createReplyDispatcherWithTyping(options) {
	const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
	const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
	const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
	const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
	let typingController;
	return {
		dispatcher: createReplyDispatcher({
			...dispatcherOptions,
			onIdle: () => {
				typingController?.markDispatchIdle();
				resolvedOnIdle?.();
			}
		}),
		replyOptions: {
			onReplyStart: resolvedOnReplyStart,
			onTypingCleanup: resolvedOnCleanup,
			onTypingController: (typing) => {
				typingController = typing;
			}
		},
		markDispatchIdle: () => {
			typingController?.markDispatchIdle();
			resolvedOnIdle?.();
		},
		markRunComplete: () => {
			typingController?.markRunComplete();
		}
	};
}
//#endregion
//#region src/auto-reply/dispatch.ts
function resolveDispatcherSilentReplyContext(ctx, cfg) {
	const finalized = finalizeInboundContext(ctx);
	const policySessionKey = finalized.CommandSource === "native" ? finalized.CommandTargetSessionKey ?? finalized.SessionKey : finalized.SessionKey;
	const chatType = normalizeChatType(finalized.ChatType);
	const conversationType = finalized.CommandSource === "native" && finalized.CommandTargetSessionKey && finalized.CommandTargetSessionKey !== finalized.SessionKey ? void 0 : chatType === "direct" ? "direct" : chatType === "group" || chatType === "channel" ? "group" : void 0;
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
function finalizeDispatchResult(result, dispatcher) {
	const cancelledCounts = dispatcher.getCancelledCounts?.();
	if (!cancelledCounts) return result;
	const counts = {
		tool: Math.max(0, result.counts.tool - cancelledCounts.tool),
		block: Math.max(0, result.counts.block - cancelledCounts.block),
		final: Math.max(0, result.counts.final - cancelledCounts.final)
	};
	return {
		queuedFinal: result.queuedFinal && counts.final > 0,
		counts
	};
}
async function dispatchInboundMessage(params) {
	const finalized = finalizeInboundContext(params.ctx);
	return finalizeDispatchResult(await withReplyDispatcher({
		dispatcher: params.dispatcher,
		run: () => dispatchReplyFromConfig({
			ctx: finalized,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions,
			replyResolver: params.replyResolver
		})
	}), params.dispatcher);
}
async function dispatchInboundMessageWithBufferedDispatcher(params) {
	const silentReplyContext = resolveDispatcherSilentReplyContext(params.ctx, params.cfg);
	const beforeDeliver = params.dispatcherOptions.beforeDeliver ?? buildMessageSendingBeforeDeliver(params.ctx);
	const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
		...params.dispatcherOptions,
		beforeDeliver,
		silentReplyContext: params.dispatcherOptions.silentReplyContext ?? silentReplyContext
	});
	try {
		return await dispatchInboundMessage({
			ctx: params.ctx,
			cfg: params.cfg,
			dispatcher,
			replyResolver: params.replyResolver,
			replyOptions: {
				...params.replyOptions,
				...replyOptions
			}
		});
	} finally {
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
export { createReplyDispatcherWithTyping as a, withReplyDispatcher as c, createReplyDispatcher as i, dispatchInboundMessageWithBufferedDispatcher as n, dispatchReplyFromConfig as o, dispatchInboundMessageWithDispatcher as r, settleReplyDispatcher as s, dispatchInboundMessage as t };
