import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as appendRegularFileSync } from "./regular-file-DaVeNX32.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { m as sanitizeAgentId, p as resolveThreadSessionKeys, r as buildAgentMainSessionKey } from "./session-key-Bte0mmcq.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { i as replaceFileAtomicSync } from "./replace-file-C7_Inj8B.js";
import { t as createNonExitingRuntime } from "./runtime-yzlkhCoS.js";
import { r as getChildLogger } from "./logger-Dg9dVaLI.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn, t as danger } from "./globals-YU5FjfZK.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { i as getRuntimeConfigSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { n as mutateConfigFile } from "./mutate-DLC8bveh.js";
import { u as fireAndForgetHook } from "./hook-runner-global-BkXXy1ub.js";
import { t as createDedupeCache } from "./dedupe-BD30U36x.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { s as resolveSessionTranscriptPathInDir, u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { F as resolveSessionStoreEntry } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { c as appendSessionTranscriptMessage, d as resolveAndPersistSessionFile, r as readLatestAssistantTextFromSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { C as findModelInCatalog } from "./model-selection-shared-ClxdEp4X.js";
import { h as resolveThinkingDefaultWithRuntimeCatalog, s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { i as modelSupportsVision, n as loadModelCatalog } from "./model-catalog-DhWpNp70.js";
import { h as isInsideCode, m as findCodeRegions, u as stripReasoningTagsFromText } from "./assistant-visible-text-BoF6Ixue.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-BQ4uO4hX.js";
import { a as getReplyPayloadTtsSupplement, n as buildTtsSupplementMediaPayload } from "./reply-payload-CiT5mlcY.js";
import { i as toInternalMessageReceivedContext } from "./message-hook-mappers-CNfn6PTM.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-sKF5rlUN.js";
import { s as formatReasoningMessage } from "./pi-embedded-utils-D6gJe2Np.js";
import { a as projectOutboundPayloadPlanForDelivery, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { D as resolveChannelStreamingPreviewNativeToolProgress, M as selectLongerFinalText, O as resolveChannelStreamingPreviewNativeToolProgressAllowFrom, S as resolveChannelStreamingBlockEnabled, a as createChannelProgressDraftGate, c as formatChannelProgressDraftText, d as isPotentialTruncatedFinal, f as mergeChannelProgressDraftLine, i as buildChannelProgressDraftLineForEntry, j as resolveTranscriptBackedChannelFinalText, k as resolveChannelStreamingPreviewToolProgress, o as formatChannelProgressDraftLine, s as formatChannelProgressDraftLineForEntry, u as isChannelProgressDraftWorkToolName, y as resolveChannelProgressDraftMaxLines } from "./channel-streaming-BKIuGSWW.js";
import { i as resolveAgentRoute, n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import { n as firstDefined } from "./allow-from-D1f7S_rf.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-jPMfFWFn.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-3P8aSD7o.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver } from "./runtime-BUVuto5K.js";
import { n as MediaFetchError } from "./fetch-C0wRQZuz.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { t as resolveAckReaction } from "./identity-nYw-h8DL.js";
import { t as deriveDurableFinalDeliveryRequirements } from "./capabilities-B3ut6ovI.js";
import { c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
import { n as createPreviewMessageReceipt } from "./live-CF0ee90S.js";
import { h as resolveChannelConfigWrites } from "./channel-config-helpers-xZ4-bv2H.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-CUnMI0Oj.js";
import { c as resolveThreadBindingMaxAgeMsForChannel, o as resolveThreadBindingIdleTimeoutMsForChannel, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-BAuuUJk1.js";
import { f as parsePluginBindingApprovalCustomId, i as buildPluginBindingResolvedText, m as resolvePluginConversationBindingApproval } from "./conversation-binding-CMioKWCr.js";
import { t as getPluginCommandSpecs } from "./command-specs-ByDvK7rB.js";
import { n as listChatCommands } from "./commands-registry-list--98FRviq.js";
import { n as maybeResolveTextAlias, r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
import { c as parseCommandArgs, i as formatCommandArgMenuTitle, n as buildCommandTextFromArgs, o as listNativeCommandSpecs, r as findCommandByNativeName, s as listNativeCommandSpecsForConfig, u as resolveCommandArgMenu } from "./commands-registry-Bthd8JBl.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes } from "./mentions-DmNrCnsQ.js";
import { n as resolveStoredModelOverride } from "./stored-model-override-DwKmC9nn.js";
import { n as isAbortRequestText } from "./abort-primitives-BPrDmF9O.js";
import { o as normalizeTelegramApiRoot, r as resolveTelegramTransport } from "./fetch-Dy1LisTE.js";
import { t as isApprovalNotFoundError } from "./approval-errors-s6AXlG1x.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { t as hasControlCommand } from "./command-detection-CC0FOFv2.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope } from "./envelope-DUI2KFD9.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-DQpLvByk.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply } from "./ack-reactions-BceP3SaE.js";
import "./history-BD_TtuvO.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-C9pX_aod.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import "./channel-policy-pv8ZpZxj.js";
import "./reply-history-Dd_Mx-HZ.js";
import { m as parseExecApprovalCommandText } from "./exec-approval-reply-DtVFspP8.js";
import "./approval-reply-runtime-BcbfBw2t.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-Si-TIKp_.js";
import { n as resolveNativeCommandsEnabled, r as resolveNativeSkillsEnabled, t as isNativeCommandsExplicitlyDisabled } from "./commands-BZM3rtIy.js";
import "./config-mutation-C9bUHI1l.js";
import { n as isBtwRequestText } from "./btw-command-cHadZPW0.js";
import { t as generateConversationLabel } from "./conversation-label-generator-DwVmuLPz.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./reply-dispatch-runtime-Brv61pKL.js";
import "./reply-chunking-D-imiKW4.js";
import { d as runInboundReplyTurn } from "./inbound-reply-dispatch-Bi01ox5N.js";
import "./outbound-runtime-CGgaScW3.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import "./model-session-runtime-B9_KVsJx.js";
import "./media-runtime-BheBFFxc.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute } from "./binding-routing-DfoE5KF_.js";
import "./conversation-runtime-guwDSNIo.js";
import "./text-chunking-C154U6-i.js";
import "./agent-runtime-Lc7H-PlR.js";
import { i as createInteractiveConversationBindingHelpers, r as dispatchPluginInteractiveHandler } from "./plugin-runtime-DG_BosJY.js";
import "./security-runtime-CcSekjBd.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import "./hook-runtime-aHFg3hJ2.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import { n as buildCommandsMessagePaginated } from "./command-status-builders-DIS2PKOq.js";
import { t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-Bjf_5-ck.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-dLqoqLxl.js";
import { n as formatModelsAvailableHeader } from "./commands-models-C5hB5Z12.js";
import "./command-auth-native-BhcKSceK.js";
import "./command-primitives-runtime-C3gr1zxr.js";
import "./command-status-te9AhsVD.js";
import "./command-detection-Bt7CPsF0.js";
import "./command-surface-DmBXtV5m.js";
import { n as logInboundDrop, r as logTypingFailure, t as logAckFailure } from "./logging-Dr3f0mtP.js";
import { a as DEFAULT_TIMING, i as DEFAULT_EMOJIS } from "./channel-feedback-Bn34MjYD.js";
import { i as resolveUnmentionedGroupInboundPolicy, r as classifyChannelInboundEvent, s as shouldDebounceTextInbound } from "./channel-inbound-C7GtKjtG.js";
import { n as toLocationContext, t as formatLocationText } from "./location-B0jdizlz.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { h as createMessageReceiveContext } from "./channel-message-DMGbyII_.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-N4dBc-K-.js";
import { t as loadSessionStore } from "./session-store-runtime-DCQkOAps.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-DaB2erKZ.js";
import "./models-provider-runtime-C1991Wgv.js";
import "./skill-commands-runtime-kLiYfwxC.js";
import "./native-command-config-runtime-DjDvteb8.js";
import { t as mergeTelegramAccountConfig } from "./account-config-Bxlwl4Ps.js";
import { a as resolveDefaultTelegramAccountId, o as resolveTelegramAccount, s as resolveTelegramMediaRuntimeOptions } from "./accounts-CYn64t2S.js";
import { r as resolveTelegramInlineButtonsScope } from "./inline-buttons-BoL8hmdC.js";
import { f as shouldSuppressLocalTelegramExecApprovalPrompt, l as shouldEnableTelegramExecApprovalButtons, n as isTelegramExecApprovalApprover, r as isTelegramExecApprovalAuthorizedSender } from "./exec-approvals-BrzHfHZV.js";
import { A as shouldUseTelegramDmThreadSession, C as resolveTelegramForumFlag, D as resolveTelegramReplyId, E as resolveTelegramMessageForumFlagHint, F as extractTelegramLocation, G as normalizeAllowFrom, H as expandTelegramAllowFromWithAccessGroups, I as getTelegramTextParts, K as normalizeDmAllowFromWithStore, L as hasBotMention, M as buildSenderLabel, N as buildSenderName, O as resolveTelegramStreamMode, P as expandTextLinks, S as resolveTelegramDirectPeerId, T as resolveTelegramGroupAllowFromContext, U as resolveTelegramDmAllow, V as resolveTelegramPrimaryMedia, W as isSenderAllowed, _ as describeReplyTarget, a as renderTelegramHtmlText, d as buildTelegramGroupPeerId, f as buildTelegramInboundOriginTarget, g as buildTypingThreadParams, h as buildTelegramThreadParams, j as withResolvedTelegramForumFlag, k as resolveTelegramThreadSpec, l as buildGroupLabel, m as buildTelegramRoutingTarget, n as markdownToTelegramChunks, p as buildTelegramParentPeer, q as resolveTelegramEffectiveDmPolicy, u as buildTelegramGroupFrom, v as extractTelegramForumFlag, w as resolveTelegramForumThreadId, x as resolveTelegramCommandAuthorization, y as isTelegramCommandsAllowFromConfigured, z as normalizeForwardedContext } from "./format-B4PA8GD8.js";
import { t as resolveTelegramInlineButtons } from "./button-types-C0Gyj4Tz.js";
import { d as buildModelsKeyboard, g as resolveModelSelection, h as parseModelCallbackData, m as getModelsPageSize, o as buildTelegramModelsMenuButtons, p as calculateTotalPages, t as buildCommandsPaginationKeyboard } from "./command-ui-Cfv5GGb1.js";
import { i as resolveTelegramCustomCommands, r as normalizeTelegramCommandName, t as TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config-Chnooecx.js";
import { t as createTelegramThreadBindingManager } from "./thread-bindings-BeWYXr8h.js";
import { n as cacheSticker, t as describeStickerImage } from "./sticker-cache-qT7KSXbD.js";
import { n as evaluateTelegramGroupPolicyAccess, t as evaluateTelegramGroupBaseAccess } from "./group-access-BA67uoV7.js";
import { A as Bot, C as createTelegramClientFetch, E as resolveTelegramOutboundClientTimeoutFloorSeconds, M as sequentialize, O as withTelegramApiErrorLogging, S as asTelegramClientFetch, T as resolveTelegramClientTimeoutSeconds, a as editMessageTelegram, g as recordSentMessage, j as apiThrottler, k as getOrCreateAccountThrottler, w as resolveTelegramClientTimeoutMinimumSeconds, x as buildInlineKeyboard } from "./send-HzJbRmiM.js";
import { t as beginTelegramInboundEventDeliveryCorrelation } from "./inbound-event-delivery-CU-tJK1Q.js";
import { a as buildCappedTelegramMenuCommands, i as createTelegramDraftStream, n as createNativeTelegramToolProgressDraft, o as buildPluginTelegramMenuCommands, r as resolveTelegramExecApproval, s as syncTelegramMenuCommands, t as defaultTelegramBotDeps } from "./bot-deps-D1DzQ4CT.js";
import { n as deliverReplies, r as emitInternalMessageSentHook, t as resolveMedia } from "./delivery-DDhvFfD2.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region extensions/telegram/src/bot-handlers.debounce-key.ts
function buildTelegramInboundDebounceKey(params) {
	return `telegram:${params.accountId?.trim() || "default"}:${params.conversationKey}:${params.senderId}:${params.debounceLane}`;
}
function buildTelegramInboundDebounceConversationKey(params) {
	return params.threadId != null ? `${params.chatId}:topic:${params.threadId}` : String(params.chatId);
}
//#endregion
//#region extensions/telegram/src/bot-handlers.media.ts
function isMediaSizeLimitError(err) {
	const errMsg = String(err);
	return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}
function isRecoverableMediaGroupError(err) {
	return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}
function hasInboundMedia(msg) {
	return Boolean(msg.media_group_id) || Array.isArray(msg.photo) && msg.photo.length > 0 || Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker);
}
function hasReplyTargetMedia(msg) {
	const externalReply = msg.external_reply;
	const replyTarget = msg.reply_to_message ?? externalReply;
	return Boolean(replyTarget && hasInboundMedia(replyTarget));
}
function resolveInboundMediaFileId(msg) {
	return msg.sticker?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id ?? msg.video?.file_id ?? msg.video_note?.file_id ?? msg.document?.file_id ?? msg.audio?.file_id ?? msg.voice?.file_id;
}
//#endregion
//#region extensions/telegram/src/bot-native-command-deps.runtime.ts
let telegramSendRuntimePromise;
async function loadTelegramSendRuntime() {
	telegramSendRuntimePromise ??= import("./send-DC1zAoDQ.js");
	return await telegramSendRuntimePromise;
}
const defaultTelegramNativeCommandDeps = {
	get getRuntimeConfig() {
		return getRuntimeConfig;
	},
	get readChannelAllowFromStore() {
		return readChannelAllowFromStore;
	},
	get dispatchReplyWithBufferedBlockDispatcher() {
		return dispatchReplyWithBufferedBlockDispatcher;
	},
	get listSkillCommandsForAgents() {
		return listSkillCommandsForAgents;
	},
	get syncTelegramMenuCommands() {
		return syncTelegramMenuCommands;
	},
	get getPluginCommandSpecs() {
		return getPluginCommandSpecs;
	},
	async editMessageTelegram(...args) {
		const { editMessageTelegram } = await loadTelegramSendRuntime();
		return await editMessageTelegram(...args);
	}
};
//#endregion
//#region extensions/telegram/src/conversation-route.ts
function resolveTelegramConversationRoute(params) {
	const peerId = params.isGroup ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId) : resolveTelegramDirectPeerId({
		chatId: params.chatId,
		senderId: params.senderId
	});
	const parentPeer = buildTelegramParentPeer({
		isGroup: params.isGroup,
		resolvedThreadId: params.resolvedThreadId,
		chatId: params.chatId
	});
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "telegram",
		accountId: params.accountId,
		peer: {
			kind: params.isGroup ? "group" : "direct",
			id: peerId
		},
		parentPeer
	});
	const rawTopicAgentId = params.topicAgentId?.trim();
	if (rawTopicAgentId) {
		const topicAgentId = sanitizeAgentId(rawTopicAgentId);
		const sessionKey = normalizeLowercaseStringOrEmpty(buildAgentSessionKey({
			agentId: topicAgentId,
			channel: "telegram",
			accountId: params.accountId,
			peer: {
				kind: params.isGroup ? "group" : "direct",
				id: peerId
			},
			dmScope: params.cfg.session?.dmScope,
			identityLinks: params.cfg.session?.identityLinks
		}));
		const mainSessionKey = normalizeLowercaseStringOrEmpty(buildAgentMainSessionKey({ agentId: topicAgentId }));
		route = {
			...route,
			agentId: topicAgentId,
			sessionKey,
			mainSessionKey,
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey,
				mainSessionKey
			})
		};
		logVerbose(`telegram: topic route override: topic=${params.resolvedThreadId ?? params.replyThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`);
	}
	const configuredRoute = resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "telegram",
			accountId: params.accountId,
			conversationId: peerId,
			parentConversationId: params.isGroup ? String(params.chatId) : void 0
		}
	});
	let configuredBinding = configuredRoute.bindingResolution;
	let configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
	route = configuredRoute.route;
	const runtimeBindingConversationId = params.replyThreadId != null ? `${params.chatId}:topic:${params.replyThreadId}` : String(params.chatId);
	const runtimeRoute = resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "telegram",
			accountId: params.accountId,
			conversationId: runtimeBindingConversationId
		}
	});
	route = runtimeRoute.route;
	if (runtimeRoute.bindingRecord) {
		configuredBinding = null;
		configuredBindingSessionKey = "";
		logVerbose(runtimeRoute.boundSessionKey ? `telegram: routed via bound conversation ${runtimeBindingConversationId} -> ${runtimeRoute.boundSessionKey}` : `telegram: plugin-bound conversation ${runtimeBindingConversationId}`);
	}
	return {
		route,
		configuredBinding,
		configuredBindingSessionKey
	};
}
function resolveTelegramConversationBaseSessionKey(params) {
	if (!(normalizeAccountId(params.route.accountId) !== normalizeAccountId(resolveDefaultTelegramAccountId(params.cfg)) && params.route.matchedBy === "default") || params.isGroup) return params.route.sessionKey;
	return normalizeLowercaseStringOrEmpty(buildAgentSessionKey({
		agentId: params.route.agentId,
		channel: "telegram",
		accountId: params.route.accountId,
		peer: {
			kind: "direct",
			id: resolveTelegramDirectPeerId({
				chatId: params.chatId,
				senderId: params.senderId
			})
		},
		dmScope: "per-account-channel-peer",
		identityLinks: params.cfg.session?.identityLinks
	}));
}
//#endregion
//#region extensions/telegram/src/group-config-helpers.ts
function resolveTelegramGroupPromptSettings(params) {
	const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
	const systemPromptParts = [params.groupConfig?.systemPrompt?.trim() || null, params.topicConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
	return {
		skillFilter,
		groupSystemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0
	};
}
//#endregion
//#region extensions/telegram/src/ingress.ts
const TELEGRAM_CHANNEL_ID = "telegram";
const telegramIngressIdentity = defineStableChannelIngressIdentity({
	key: "telegram-user-id",
	normalize: (value) => {
		const normalized = normalizeAllowFrom([value]);
		return normalized.entries[0] ?? (normalized.hasWildcard ? "*" : null);
	},
	sensitivity: "pii"
});
function createTelegramIngressSubject(senderId) {
	return { stableId: senderId };
}
function createTelegramIngressResolver(params) {
	return createChannelIngressResolver({
		channelId: TELEGRAM_CHANNEL_ID,
		accountId: params.accountId ?? "default",
		identity: telegramIngressIdentity,
		cfg: params.cfg
	});
}
function telegramAllowEntries(allow) {
	return [...allow.hasWildcard ? ["*"] : [], ...allow.entries];
}
function telegramConversation(params) {
	return {
		kind: params.isGroup ? "group" : "direct",
		id: String(params.chatId),
		...params.resolvedThreadId != null ? { threadId: String(params.resolvedThreadId) } : {}
	};
}
async function resolveTelegramCommandIngressAuthorization(params) {
	const commandOwner = [...params.isGroup && params.includeDmAllowForGroupCommands === false ? [] : telegramAllowEntries(params.effectiveDmAllow), ...params.ownerAccess.senderIsOwner ? [params.senderId || "*"] : params.ownerAccess.ownerList];
	return (await createTelegramIngressResolver({
		accountId: params.accountId,
		cfg: params.cfg
	}).command({
		subject: createTelegramIngressSubject(params.senderId),
		conversation: telegramConversation(params),
		event: { kind: params.eventKind ?? "native-command" },
		dmPolicy: params.dmPolicy,
		groupPolicy: "allowlist",
		allowFrom: commandOwner,
		groupAllowFrom: params.isGroup ? telegramAllowEntries(params.effectiveGroupAllow) : [],
		command: {
			allowTextCommands: params.allowTextCommands ?? false,
			hasControlCommand: params.hasControlCommand ?? false,
			modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff ?? "configured"
		}
	})).commandAccess;
}
async function resolveTelegramEventIngressAuthorization(params) {
	return (await createTelegramIngressResolver({ accountId: params.accountId }).event({
		subject: createTelegramIngressSubject(params.senderId),
		conversation: telegramConversation(params),
		event: {
			kind: params.eventKind,
			authMode: "inbound"
		},
		dmPolicy: params.dmPolicy,
		groupPolicy: params.enforceGroupAuthorization ? "allowlist" : "open",
		allowFrom: telegramAllowEntries(params.effectiveDmAllow),
		groupAllowFrom: params.enforceGroupAuthorization ? telegramAllowEntries(params.effectiveGroupAllow) : []
	})).ingress;
}
//#endregion
//#region extensions/telegram/src/bot-native-commands.ts
const EMPTY_RESPONSE_FALLBACK$1 = "No response generated. Please try again.";
const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";
let telegramNativeCommandDeliveryRuntimePromise;
async function loadTelegramNativeCommandDeliveryRuntime() {
	telegramNativeCommandDeliveryRuntimePromise ??= import("./bot-native-commands.delivery.runtime.js");
	return await telegramNativeCommandDeliveryRuntimePromise;
}
let telegramNativeCommandRuntimePromise;
async function loadTelegramNativeCommandRuntime() {
	telegramNativeCommandRuntimePromise ??= import("./bot-native-commands.runtime.js");
	return await telegramNativeCommandRuntimePromise;
}
function resolveTelegramProgressPlaceholder(command) {
	const text = command.nativeProgressMessages?.telegram?.trim() ?? command.nativeProgressMessages?.default?.trim();
	return text ? text : null;
}
async function resolveTelegramCommandSessionFile(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) return {};
	try {
		const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
		const store = loadSessionStore(storePath);
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const sessionId = resolved.existing?.sessionId?.trim() || randomUUID();
		const sessionsDir = path.dirname(storePath);
		const fallbackSessionFile = resolveSessionTranscriptPathInDir(sessionId, sessionsDir, params.threadId);
		return {
			sessionId,
			sessionFile: (await resolveAndPersistSessionFile({
				sessionId,
				sessionKey: resolved.normalizedKey,
				sessionStore: store,
				storePath,
				sessionEntry: resolved.existing,
				agentId: params.agentId,
				sessionsDir,
				fallbackSessionFile
			})).sessionFile
		};
	} catch {
		return {};
	}
}
function resolveTelegramCommandMenuModelContext(params) {
	if (!params.sessionKey.trim()) return {};
	try {
		const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
		const defaultModel = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId: params.agentId
		});
		const store = loadSessionStore(storePath);
		const entry = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		}).existing;
		const thinkingLevel = normalizeOptionalString(entry?.thinkingLevel);
		if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) return {
			provider: defaultModel.provider,
			model: defaultModel.model,
			...thinkingLevel ? { thinkingLevel } : {}
		};
		const override = resolveStoredModelOverride({
			sessionEntry: entry,
			sessionStore: store,
			sessionKey: params.sessionKey,
			defaultProvider: defaultModel.provider
		});
		if (override?.model) return {
			provider: override.provider || defaultModel.provider,
			model: override.model,
			...thinkingLevel ? { thinkingLevel } : {}
		};
		const provider = normalizeOptionalString(entry?.providerOverride) ?? normalizeOptionalString(entry?.modelProvider);
		const model = normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
		return {
			...provider ? { provider } : {},
			...model ? { model } : {},
			...thinkingLevel ? { thinkingLevel } : {}
		};
	} catch {
		return {};
	}
}
async function resolveTelegramDefaultThinkingLevel(params) {
	return resolveThinkingDefaultWithRuntimeCatalog({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		loadModelCatalog: () => loadModelCatalog({ config: params.cfg })
	});
}
async function resolveTelegramThinkMenuCurrentLevel(params) {
	const explicit = normalizeOptionalString(params.thinkingLevel);
	if (explicit) return explicit;
	const agentThinkingDefault = normalizeOptionalString(resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault);
	if (agentThinkingDefault) return agentThinkingDefault;
	const defaultModel = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	return await resolveTelegramDefaultThinkingLevel({
		cfg: params.cfg,
		provider: params.provider ?? defaultModel.provider,
		model: params.model ?? defaultModel.model
	});
}
function formatTelegramCommandArgMenuTitle(params) {
	const title = formatCommandArgMenuTitle({
		command: params.command,
		menu: params.menu
	});
	if (params.command.key !== "think" || !params.currentThinkingLevel) return title;
	return `Current thinking level: ${params.currentThinkingLevel}.\n${title}`;
}
function resolveTelegramNativeReplyChannelData(result) {
	return result.channelData?.telegram;
}
function normalizeTelegramNativeReplyPayload(result) {
	return result && typeof result === "object" ? result : {};
}
function hasRenderableTelegramNativeReplyPayload(result) {
	return resolveSendableOutboundReplyParts(result).hasContent;
}
function isEditableTelegramProgressResult(result) {
	const telegramData = resolveTelegramNativeReplyChannelData(result);
	return Boolean(typeof result.text === "string" && result.text.trim() && !result.mediaUrl && (!result.mediaUrls || result.mediaUrls.length === 0) && !result.presentation && !result.interactive && !result.btw && telegramData?.pin !== true);
}
async function cleanupTelegramProgressPlaceholder(params) {
	const progressMessageId = params.progressMessageId;
	if (progressMessageId == null) return;
	try {
		await withTelegramApiErrorLogging({
			operation: "deleteMessage",
			runtime: params.runtime,
			fn: () => params.bot.api.deleteMessage(params.chatId, progressMessageId)
		});
	} catch {}
}
async function resolveTelegramNativeCommandThreadContext(params) {
	const { msg, bot } = params;
	const chatId = msg.chat.id;
	const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
	const messageThreadId = msg.message_thread_id;
	const getChat = typeof bot.api.getChat === "function" ? bot.api.getChat.bind(bot.api) : void 0;
	const isForum = await resolveTelegramForumFlag({
		chatId,
		chatType: msg.chat.type,
		isGroup,
		isForum: extractTelegramForumFlag(msg.chat),
		isTopicMessage: msg.is_topic_message,
		getChat
	});
	const threadSpec = resolveTelegramThreadSpec({
		isGroup,
		isForum,
		messageThreadId
	});
	return {
		chatId,
		isGroup,
		isForum,
		messageThreadId,
		threadSpec,
		threadParams: buildTelegramThreadParams(threadSpec)
	};
}
function buildTelegramNativeCommandCallbackData(commandText) {
	return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}
function parseTelegramNativeCommandCallbackData(data) {
	if (!data) return null;
	const trimmed = data.trim();
	if (!trimmed.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) return null;
	const commandText = trimmed.slice(6).trim();
	return commandText.startsWith("/") ? commandText : null;
}
function resolveTelegramNativeCommandDisableBlockStreaming(telegramCfg) {
	const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
	return typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : void 0;
}
async function resolveTelegramCommandAuth(params) {
	const { msg, bot, cfg, accountId, telegramCfg, readChannelAllowFromStore, allowFrom, groupAllowFrom, useAccessGroups, resolveGroupPolicy, resolveTelegramGroupConfig, requireAuth } = params;
	const { chatId, isGroup, isForum, messageThreadId, threadParams } = await resolveTelegramNativeCommandThreadContext({
		msg,
		bot
	});
	const senderId = msg.from?.id ? String(msg.from.id) : "";
	const senderUsername = msg.from?.username ?? "";
	const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramGroupAllowFromContext({
		cfg,
		chatId,
		accountId,
		senderId,
		isGroup,
		isForum,
		messageThreadId,
		groupAllowFrom,
		readChannelAllowFromStore,
		resolveTelegramGroupConfig
	});
	const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
		isGroup,
		groupConfig,
		dmPolicy: telegramCfg.dmPolicy
	});
	const requireTopic = !isGroup && groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : void 0;
	if (!isGroup && requireTopic === true && dmThreadId == null) {
		logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
		return null;
	}
	const dmAllowFrom = groupAllowOverride ?? allowFrom;
	const commandsAllowFromConfigured = isTelegramCommandsAllowFromConfigured(cfg);
	const commandsAllowFromAccess = commandsAllowFromConfigured ? resolveTelegramCommandAuthorization({
		cfg,
		accountId,
		chatId,
		isGroup,
		resolvedThreadId,
		senderId,
		senderUsername
	}) : null;
	const ownerAccess = resolveTelegramCommandAuthorization({
		cfg,
		accountId,
		chatId,
		isGroup,
		resolvedThreadId,
		senderId,
		senderUsername
	});
	const sendAuthMessage = async (text) => {
		await withTelegramApiErrorLogging({
			operation: "sendMessage",
			fn: () => bot.api.sendMessage(chatId, text, threadParams ?? {})
		});
		return null;
	};
	const rejectNotAuthorized = async () => {
		return await sendAuthMessage("You are not authorized to use this command.");
	};
	const baseAccess = evaluateTelegramGroupBaseAccess({
		isGroup,
		groupConfig,
		topicConfig,
		hasGroupAllowOverride,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		enforceAllowOverride: requireAuth,
		requireSenderForAllowOverride: true
	});
	if (!baseAccess.allowed) {
		if (baseAccess.reason === "group-disabled") return await sendAuthMessage("This group is disabled.");
		if (baseAccess.reason === "topic-disabled") return await sendAuthMessage("This topic is disabled.");
		return await rejectNotAuthorized();
	}
	const policyAccess = evaluateTelegramGroupPolicyAccess({
		isGroup,
		chatId,
		cfg,
		telegramCfg,
		topicConfig,
		groupConfig,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		resolveGroupPolicy,
		enforcePolicy: useAccessGroups,
		useTopicAndGroupOverrides: false,
		enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
		allowEmptyAllowlistEntries: true,
		requireSenderForAllowlistAuthorization: true,
		checkChatAllowlist: useAccessGroups
	});
	if (!policyAccess.allowed) {
		if (policyAccess.reason === "group-policy-disabled") return await sendAuthMessage("Telegram group commands are disabled.");
		if (policyAccess.reason === "group-policy-allowlist-no-sender" || policyAccess.reason === "group-policy-allowlist-unauthorized") return await rejectNotAuthorized();
		if (policyAccess.reason === "group-chat-not-allowed") return await sendAuthMessage("This group is not allowed.");
	}
	const dmAllow = normalizeDmAllowFromWithStore({
		allowFrom: await expandTelegramAllowFromWithAccessGroups({
			cfg,
			allowFrom: dmAllowFrom,
			accountId,
			senderId
		}),
		storeAllowFrom: isGroup ? [] : storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const commandAuthorized = commandsAllowFromConfigured ? Boolean(commandsAllowFromAccess?.isAuthorizedSender) : (await resolveTelegramCommandIngressAuthorization({
		accountId,
		cfg,
		dmPolicy: effectiveDmPolicy,
		isGroup,
		chatId,
		resolvedThreadId,
		senderId,
		effectiveDmAllow: dmAllow,
		effectiveGroupAllow,
		ownerAccess,
		eventKind: "native-command"
	})).authorized;
	if (requireAuth && !commandAuthorized) return await rejectNotAuthorized();
	return {
		chatId,
		isGroup,
		isForum,
		resolvedThreadId,
		senderId,
		senderUsername,
		groupConfig,
		topicConfig,
		commandAuthorized,
		senderIsOwner: ownerAccess.senderIsOwner
	};
}
const registerTelegramNativeCommands = ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, mediaMaxBytes, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, telegramDeps = defaultTelegramNativeCommandDeps, opts }) => {
	const boundRoute = nativeEnabled && nativeSkillsEnabled ? resolveAgentRoute({
		cfg,
		channel: "telegram",
		accountId
	}) : null;
	if (nativeEnabled && nativeSkillsEnabled && !boundRoute) runtime.log?.("nativeSkillsEnabled is true but no agent route is bound for this Telegram account; skill commands will not appear in the native menu.");
	const skillCommands = nativeEnabled && nativeSkillsEnabled && boundRoute ? telegramDeps.listSkillCommandsForAgents({
		cfg,
		agentIds: [boundRoute.agentId]
	}) : [];
	const nativeCommands = nativeEnabled ? listNativeCommandSpecsForConfig(cfg, {
		skillCommands,
		provider: "telegram"
	}) : [];
	const reservedCommands = new Set(listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)));
	for (const command of skillCommands) reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
	const customResolution = resolveTelegramCustomCommands({
		commands: telegramCfg.customCommands,
		reservedCommands
	});
	for (const issue of customResolution.issues) runtime.error?.(danger(issue.message));
	const customCommands = customResolution.commands;
	const pluginCatalog = buildPluginTelegramMenuCommands({
		specs: (telegramDeps.getPluginCommandSpecs ?? defaultTelegramNativeCommandDeps.getPluginCommandSpecs)?.("telegram", { config: cfg }) ?? [],
		existingCommands: new Set([...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)), ...customCommands.map((command) => command.command)].map((command) => normalizeLowercaseStringOrEmpty(command)))
	});
	for (const issue of pluginCatalog.issues) runtime.error?.(danger(issue));
	const loadFreshRuntimeConfig = () => telegramDeps.getRuntimeConfig();
	const resolveFreshTelegramConfig = (runtimeCfg) => {
		try {
			return resolveTelegramAccount({
				cfg: runtimeCfg,
				accountId
			}).config;
		} catch (error) {
			logVerbose(`telegram native command: failed to load fresh account config for ${accountId}; using startup snapshot: ${String(error)}`);
			return telegramCfg;
		}
	};
	const { commandsToRegister, totalCommands, maxCommands, overflowCount, maxTotalChars, descriptionTrimmed, textBudgetDropCount } = buildCappedTelegramMenuCommands({ allCommands: [
		...nativeCommands.map((command) => {
			const normalized = normalizeTelegramCommandName(command.name);
			if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
				runtime.error?.(danger(`Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`));
				return null;
			}
			const menuCommand = {
				command: normalized,
				description: command.description
			};
			if (command.descriptionLocalizations) menuCommand.descriptionLocalizations = command.descriptionLocalizations;
			return menuCommand;
		}).filter((cmd) => cmd !== null),
		...nativeEnabled ? pluginCatalog.commands : [],
		...customCommands
	] });
	if (overflowCount > 0) runtime.log?.(`Telegram limits bots to ${maxCommands} commands. ${totalCommands} configured; registering first ${maxCommands}. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`);
	if (descriptionTrimmed) runtime.log?.(`Telegram menu text exceeded the conservative ${maxTotalChars}-character payload budget; shortening descriptions to keep ${commandsToRegister.length} commands visible.`);
	if (textBudgetDropCount > 0) runtime.log?.(`Telegram menu text still exceeded the conservative ${maxTotalChars}-character payload budget after shortening descriptions; registering first ${commandsToRegister.length} commands.`);
	(telegramDeps.syncTelegramMenuCommands ?? syncTelegramMenuCommands)({
		bot,
		runtime,
		commandsToRegister,
		accountId,
		botIdentity: opts.token
	});
	const resolveCommandRuntimeContext = async (params) => {
		const { msg, runtimeCfg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
		const chatId = msg.chat.id;
		const messageThreadId = msg.message_thread_id;
		const threadSpec = resolveTelegramThreadSpec({
			isGroup,
			isForum,
			messageThreadId: resolvedThreadId ?? messageThreadId
		});
		let { route, configuredBinding } = resolveTelegramConversationRoute({
			cfg: runtimeCfg,
			accountId,
			chatId,
			isGroup,
			resolvedThreadId,
			replyThreadId: threadSpec.id,
			senderId,
			topicAgentId
		});
		const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
		if (configuredBinding) {
			const ensured = await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
				cfg: runtimeCfg,
				bindingResolution: configuredBinding
			});
			if (!ensured.ok) {
				logVerbose(`telegram native command: configured ACP binding unavailable for topic ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`);
				await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(chatId, "Configured ACP binding is unavailable right now. Please try again.", buildTelegramThreadParams(threadSpec) ?? {})
				});
				return null;
			}
		}
		return {
			chatId,
			threadSpec,
			route,
			mediaLocalRoots: nativeCommandRuntime.getAgentScopedMediaLocalRoots(runtimeCfg, route.agentId),
			tableMode: resolveMarkdownTableMode({
				cfg: runtimeCfg,
				channel: "telegram",
				accountId: route.accountId
			}),
			chunkMode: nativeCommandRuntime.resolveChunkMode(runtimeCfg, "telegram", route.accountId)
		};
	};
	const buildCommandDeliveryBaseOptions = (params) => ({
		cfg: params.cfg,
		chatId: String(params.chatId),
		accountId: params.accountId,
		sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
		policySessionKey: params.policySessionKey,
		mirrorIsGroup: params.mirrorIsGroup,
		mirrorGroupId: params.mirrorGroupId,
		token: opts.token,
		runtime,
		bot,
		mediaLocalRoots: params.mediaLocalRoots,
		mediaMaxBytes,
		replyToMode,
		textLimit,
		thread: params.threadSpec,
		tableMode: params.tableMode,
		chunkMode: params.chunkMode,
		linkPreview: params.linkPreview
	});
	if (commandsToRegister.length > 0 || pluginCatalog.commands.length > 0) {
		for (const command of nativeCommands) {
			const normalizedCommandName = normalizeTelegramCommandName(command.name);
			bot.command(normalizedCommandName, async (ctx) => {
				const msg = ctx.message;
				if (!msg) return;
				if (shouldSkipUpdate(ctx)) return;
				const runtimeCfg = loadFreshRuntimeConfig();
				const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
				const auth = await resolveTelegramCommandAuth({
					msg,
					bot,
					cfg: runtimeCfg,
					accountId,
					telegramCfg: runtimeTelegramCfg,
					readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
					allowFrom,
					groupAllowFrom,
					useAccessGroups,
					resolveGroupPolicy,
					resolveTelegramGroupConfig,
					requireAuth: true
				});
				if (!auth) return;
				const { chatId, isGroup, isForum, resolvedThreadId, senderId, senderUsername, groupConfig, topicConfig, commandAuthorized } = auth;
				const runtimeContext = await resolveCommandRuntimeContext({
					msg,
					runtimeCfg,
					isGroup,
					isForum,
					resolvedThreadId,
					senderId,
					topicAgentId: topicConfig?.agentId
				});
				if (!runtimeContext) return;
				const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
				const threadParams = buildTelegramThreadParams(threadSpec) ?? {};
				const originatingTo = buildTelegramRoutingTarget(chatId, threadSpec);
				const executionCfg = getRuntimeConfigSnapshot() ?? cfg;
				const commandDefinition = findCommandByNativeName(command.name, "telegram");
				const rawText = ctx.match?.trim() ?? "";
				const commandArgs = commandDefinition ? parseCommandArgs(commandDefinition, rawText) : rawText ? { raw: rawText } : void 0;
				const prompt = commandDefinition ? buildCommandTextFromArgs(commandDefinition, commandArgs) : rawText ? `/${command.name} ${rawText}` : `/${command.name}`;
				let cachedTargetSessionKey;
				let cachedNativeCommandRuntime;
				const resolveNativeCommandRuntime = async () => {
					cachedNativeCommandRuntime ??= await loadTelegramNativeCommandRuntime();
					return cachedNativeCommandRuntime;
				};
				const resolveTargetSessionKey = async () => {
					if (cachedTargetSessionKey) return cachedTargetSessionKey;
					const baseSessionKey = resolveTelegramConversationBaseSessionKey({
						cfg: runtimeCfg,
						route,
						chatId,
						isGroup,
						senderId
					});
					const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
					cachedTargetSessionKey = (shouldUseTelegramDmThreadSession({
						dmThreadId,
						accountConfig: runtimeTelegramCfg,
						directConfig: !isGroup ? groupConfig : void 0,
						topicConfig
					}) && dmThreadId != null ? (await resolveNativeCommandRuntime()).resolveThreadSessionKeys({
						baseSessionKey,
						threadId: `${chatId}:${dmThreadId}`
					}) : null)?.sessionKey ?? baseSessionKey;
					return cachedTargetSessionKey;
				};
				const menuNeedsModelContext = commandDefinition?.argsMenu && !(commandArgs?.raw && !commandArgs.values) && commandDefinition.args?.some((arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null);
				const menuModelContext = commandDefinition && menuNeedsModelContext ? resolveTelegramCommandMenuModelContext({
					cfg: runtimeCfg,
					agentId: route.agentId,
					sessionKey: await resolveTargetSessionKey()
				}) : {};
				const menu = commandDefinition ? resolveCommandArgMenu({
					command: commandDefinition,
					args: commandArgs,
					cfg: runtimeCfg,
					...menuModelContext
				}) : null;
				if (menu && commandDefinition) {
					const title = formatTelegramCommandArgMenuTitle({
						command: commandDefinition,
						menu,
						currentThinkingLevel: commandDefinition.key === "think" ? await resolveTelegramThinkMenuCurrentLevel({
							cfg: runtimeCfg,
							agentId: route.agentId,
							...menuModelContext
						}) : void 0
					});
					const rows = [];
					for (let i = 0; i < menu.choices.length; i += 2) {
						const slice = menu.choices.slice(i, i + 2);
						rows.push(slice.map((choice) => {
							const args = { values: { [menu.arg.name]: choice.value } };
							return {
								text: choice.label,
								callback_data: buildTelegramNativeCommandCallbackData(buildCommandTextFromArgs(commandDefinition, args))
							};
						}));
					}
					const replyMarkup = buildInlineKeyboard(rows);
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						runtime,
						fn: () => bot.api.sendMessage(chatId, title, {
							...replyMarkup ? { reply_markup: replyMarkup } : {},
							...threadParams
						})
					});
					return;
				}
				const nativeCommandRuntime = await resolveNativeCommandRuntime();
				const sessionKey = await resolveTargetSessionKey();
				const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
					groupConfig,
					topicConfig
				});
				const { sessionKey: commandSessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
					agentId: route.agentId,
					sessionPrefix: "telegram:slash",
					userId: String(senderId || chatId),
					targetSessionKey: sessionKey
				});
				const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
					cfg: executionCfg,
					chatId,
					accountId: route.accountId,
					sessionKeyForInternalHooks: commandSessionKey,
					policySessionKey: commandTargetSessionKey,
					mirrorIsGroup: isGroup,
					mirrorGroupId: isGroup ? String(chatId) : void 0,
					mediaLocalRoots,
					threadSpec,
					tableMode,
					chunkMode,
					linkPreview: runtimeTelegramCfg.linkPreview
				});
				const conversationLabel = isGroup ? msg.chat.title ? `${msg.chat.title} id:${chatId}` : `group:${chatId}` : buildSenderName(msg) ?? String(senderId || chatId);
				const ctxPayload = nativeCommandRuntime.finalizeInboundContext({
					Body: prompt,
					BodyForAgent: prompt,
					RawBody: prompt,
					CommandBody: prompt,
					CommandArgs: commandArgs,
					From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
					To: `slash:${senderId || chatId}`,
					ChatType: isGroup ? "group" : "direct",
					ConversationLabel: conversationLabel,
					GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
					GroupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
					SenderName: buildSenderName(msg),
					SenderId: senderId || void 0,
					SenderUsername: senderUsername || void 0,
					Surface: "telegram",
					Provider: "telegram",
					MessageSid: String(msg.message_id),
					Timestamp: msg.date ? msg.date * 1e3 : void 0,
					WasMentioned: true,
					CommandAuthorized: commandAuthorized,
					CommandTurn: {
						kind: "native",
						source: "native",
						authorized: commandAuthorized,
						body: prompt
					},
					CommandSource: "native",
					SessionKey: commandSessionKey,
					AccountId: route.accountId,
					CommandTargetSessionKey: commandTargetSessionKey,
					MessageThreadId: threadSpec.id,
					IsForum: isForum,
					OriginatingChannel: "telegram",
					OriginatingTo: originatingTo
				});
				await nativeCommandRuntime.recordInboundSessionMetaSafe({
					cfg: executionCfg,
					agentId: route.agentId,
					sessionKey: commandTargetSessionKey,
					ctx: ctxPayload,
					onError: (err) => runtime.error?.(danger(`telegram slash: failed updating session meta: ${String(err)}`))
				});
				const disableBlockStreaming = resolveTelegramNativeCommandDisableBlockStreaming(runtimeTelegramCfg);
				const deliveryState = {
					delivered: false,
					skippedNonSilent: 0
				};
				const { createChannelMessageReplyPipeline, deliverReplies } = await loadTelegramNativeCommandDeliveryRuntime();
				const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
					cfg: executionCfg,
					agentId: route.agentId,
					channel: "telegram",
					accountId: route.accountId
				});
				await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
					ctx: ctxPayload,
					cfg: executionCfg,
					dispatcherOptions: {
						...replyPipeline,
						beforeDeliver: async (payload) => payload,
						deliver: async (payload, _info) => {
							if (shouldSuppressLocalTelegramExecApprovalPrompt({
								cfg: executionCfg,
								accountId: route.accountId,
								payload
							})) {
								deliveryState.delivered = true;
								return;
							}
							if ((await deliverReplies({
								replies: [payload.replyToId ? payload : {
									...payload,
									replyToId: String(msg.message_id)
								}],
								...deliveryBaseOptions,
								silent: runtimeTelegramCfg.silentErrorReplies === true && payload.isError === true
							})).delivered) deliveryState.delivered = true;
						},
						onSkip: (_payload, info) => {
							if (info.reason !== "silent") deliveryState.skippedNonSilent += 1;
						},
						onError: (err, info) => {
							runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
						}
					},
					replyOptions: {
						skillFilter,
						disableBlockStreaming,
						onModelSelected
					}
				});
				if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) await deliverReplies({
					replies: [{ text: EMPTY_RESPONSE_FALLBACK$1 }],
					...deliveryBaseOptions
				});
			});
		}
		for (const pluginCommand of pluginCatalog.commands) bot.command(pluginCommand.command, async (ctx) => {
			const msg = ctx.message;
			if (!msg) return;
			if (shouldSkipUpdate(ctx)) return;
			const chatId = msg.chat.id;
			const runtimeCfg = loadFreshRuntimeConfig();
			const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
			const { threadParams } = await resolveTelegramNativeCommandThreadContext({
				msg,
				bot
			});
			const rawText = ctx.match?.trim() ?? "";
			const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
			const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
			const match = nativeCommandRuntime.matchPluginCommand(commandBody);
			if (!match) {
				await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(chatId, "Command not found.", threadParams ?? {})
				});
				return;
			}
			const auth = await resolveTelegramCommandAuth({
				msg,
				bot,
				cfg: runtimeCfg,
				accountId,
				telegramCfg: runtimeTelegramCfg,
				readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
				allowFrom,
				groupAllowFrom,
				useAccessGroups,
				resolveGroupPolicy,
				resolveTelegramGroupConfig,
				requireAuth: match.command.requireAuth !== false
			});
			if (!auth) return;
			const { senderId, commandAuthorized, senderIsOwner, isGroup, isForum, resolvedThreadId } = auth;
			const runtimeContext = await resolveCommandRuntimeContext({
				msg,
				runtimeCfg,
				isGroup,
				isForum,
				resolvedThreadId,
				senderId,
				topicAgentId: auth.topicConfig?.agentId
			});
			if (!runtimeContext) return;
			const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
			const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
				cfg: runtimeCfg,
				chatId,
				accountId: route.accountId,
				sessionKeyForInternalHooks: route.sessionKey,
				policySessionKey: route.sessionKey,
				mirrorIsGroup: isGroup,
				mirrorGroupId: isGroup ? String(chatId) : void 0,
				mediaLocalRoots,
				threadSpec,
				tableMode,
				chunkMode,
				linkPreview: runtimeTelegramCfg.linkPreview
			});
			const from = isGroup ? buildTelegramGroupFrom(chatId, threadSpec.id) : `telegram:${chatId}`;
			const to = `telegram:${chatId}`;
			const { deliverReplies, emitTelegramMessageSentHooks } = await loadTelegramNativeCommandDeliveryRuntime();
			let progressMessageId;
			const progressPlaceholder = resolveTelegramProgressPlaceholder(match.command);
			if (progressPlaceholder) try {
				const maybeMessageId = (await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(chatId, progressPlaceholder, buildTelegramThreadParams(threadSpec))
				}))?.message_id;
				if (typeof maybeMessageId === "number") progressMessageId = maybeMessageId;
			} catch {}
			const sessionFileContext = await resolveTelegramCommandSessionFile({
				cfg: runtimeCfg,
				agentId: route.agentId,
				sessionKey: route.sessionKey,
				threadId: threadSpec.id
			});
			const result = normalizeTelegramNativeReplyPayload(await nativeCommandRuntime.executePluginCommand({
				command: match.command,
				args: match.args,
				senderId,
				channel: "telegram",
				isAuthorizedSender: commandAuthorized,
				senderIsOwner,
				sessionKey: route.sessionKey,
				sessionId: sessionFileContext.sessionId,
				sessionFile: sessionFileContext.sessionFile,
				commandBody,
				config: runtimeCfg,
				from,
				to,
				accountId,
				messageThreadId: threadSpec.id
			}));
			if (shouldSuppressLocalTelegramExecApprovalPrompt({
				cfg: runtimeCfg,
				accountId: route.accountId,
				payload: result
			})) {
				await cleanupTelegramProgressPlaceholder({
					bot,
					chatId,
					progressMessageId,
					runtime
				});
				return;
			}
			const deliverableResult = hasRenderableTelegramNativeReplyPayload(result) ? result : { text: EMPTY_RESPONSE_FALLBACK$1 };
			const progressResultText = typeof deliverableResult.text === "string" && deliverableResult.text.trim().length > 0 ? deliverableResult.text : null;
			const telegramResultData = resolveTelegramNativeReplyChannelData(deliverableResult);
			if (progressMessageId != null && telegramDeps.editMessageTelegram && progressResultText && isEditableTelegramProgressResult(deliverableResult)) try {
				await telegramDeps.editMessageTelegram(chatId, progressMessageId, progressResultText, {
					cfg: runtimeCfg,
					accountId: route.accountId,
					textMode: "markdown",
					linkPreview: runtimeTelegramCfg.linkPreview,
					buttons: telegramResultData?.buttons
				});
				recordSentMessage(chatId, progressMessageId, runtimeCfg);
				emitTelegramMessageSentHooks({
					sessionKeyForInternalHooks: route.sessionKey,
					chatId: String(chatId),
					accountId: route.accountId,
					content: progressResultText,
					success: true,
					messageId: progressMessageId,
					isGroup,
					groupId: isGroup ? String(chatId) : void 0
				});
				return;
			} catch {}
			await cleanupTelegramProgressPlaceholder({
				bot,
				chatId,
				progressMessageId,
				runtime
			});
			await deliverReplies({
				replies: [deliverableResult],
				...deliveryBaseOptions,
				silent: runtimeTelegramCfg.silentErrorReplies === true && deliverableResult.isError === true
			});
		});
	} else if (nativeDisabledExplicit) {
		withTelegramApiErrorLogging({
			operation: "setMyCommands",
			runtime,
			fn: () => bot.api.setMyCommands([])
		}).catch(() => {});
		withTelegramApiErrorLogging({
			operation: "setMyCommands(all_group_chats)",
			runtime,
			fn: () => bot.api.setMyCommands([], { scope: { type: "all_group_chats" } })
		}).catch(() => {});
	}
};
//#endregion
//#region extensions/telegram/src/bot-updates.ts
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 6e4;
const RECENT_TELEGRAM_UPDATE_MAX = 2e3;
const resolveTelegramUpdateId = (ctx) => ctx.update?.update_id ?? ctx.update_id;
const buildTelegramUpdateKey = (ctx) => {
	const updateId = resolveTelegramUpdateId(ctx);
	if (typeof updateId === "number") return `update:${updateId}`;
	const callbackId = ctx.callbackQuery?.id;
	if (callbackId) return `callback:${callbackId}`;
	const editedMsg = ctx.editedMessage ?? ctx.editedChannelPost ?? ctx.update?.edited_message ?? ctx.update?.edited_channel_post;
	const editedChatId = editedMsg?.chat?.id;
	const editedMessageId = editedMsg?.message_id;
	if (editedChatId !== void 0 && typeof editedMessageId === "number") return `edited-message:${editedChatId}:${editedMessageId}`;
	const msg = ctx.message ?? ctx.channelPost ?? ctx.update?.message ?? ctx.update?.channel_post ?? ctx.callbackQuery?.message;
	const chatId = msg?.chat?.id;
	const messageId = msg?.message_id;
	if (chatId !== void 0 && typeof messageId === "number") return `message:${chatId}:${messageId}`;
};
const createTelegramUpdateDedupe = () => createDedupeCache({
	ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
	maxSize: RECENT_TELEGRAM_UPDATE_MAX
});
//#endregion
//#region extensions/telegram/src/dm-access.ts
function resolveTelegramSenderIdentity(msg, chatId) {
	const from = msg.from;
	const userId = from?.id != null ? String(from.id) : null;
	return {
		username: from?.username ?? "",
		userId,
		candidateId: userId ?? String(chatId),
		firstName: from?.first_name,
		lastName: from?.last_name
	};
}
async function decideTelegramDmAccess(params) {
	return (await createTelegramIngressResolver({ accountId: params.accountId }).message({
		subject: createTelegramIngressSubject(params.sender.candidateId),
		conversation: {
			kind: "direct",
			id: params.sender.candidateId
		},
		dmPolicy: params.dmPolicy,
		groupPolicy: "disabled",
		allowFrom: telegramAllowEntries(params.effectiveDmAllow)
	})).ingress;
}
async function enforceTelegramDmAccess(params) {
	const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger, upsertPairingRequest } = params;
	if (isGroup) return true;
	if (dmPolicy === "disabled") return false;
	const sender = resolveTelegramSenderIdentity(msg, chatId);
	const access = await decideTelegramDmAccess({
		accountId,
		dmPolicy,
		sender,
		effectiveDmAllow
	});
	if (access.decision === "allow") return true;
	if (dmPolicy === "open") {
		logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=open)`);
		return false;
	}
	if (access.decision === "pairing") {
		try {
			const telegramUserId = sender.userId ?? sender.candidateId;
			await createChannelPairingChallengeIssuer({
				channel: "telegram",
				upsertPairingRequest: async ({ id, meta }) => await (upsertPairingRequest ?? upsertChannelPairingRequest)({
					channel: "telegram",
					id,
					accountId,
					meta
				})
			})({
				senderId: telegramUserId,
				senderIdLine: `Your Telegram user id: ${telegramUserId}`,
				meta: {
					username: sender.username || void 0,
					firstName: sender.firstName,
					lastName: sender.lastName
				},
				onCreated: () => {
					logger.info({
						chatId: String(chatId),
						senderUserId: sender.userId ?? void 0,
						username: sender.username || void 0,
						firstName: sender.firstName,
						lastName: sender.lastName
					}, "telegram pairing request");
				},
				sendPairingReply: async (text) => {
					const html = renderTelegramHtmlText(text);
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						fn: () => bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })
					});
				},
				onReplyError: (err) => {
					logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
				}
			});
		} catch (err) {
			logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
		}
		return false;
	}
	logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy})`);
	return false;
}
//#endregion
//#region extensions/telegram/src/forum-service-message.ts
/** Telegram forum-topic service-message fields (Bot API). */
const TELEGRAM_FORUM_SERVICE_FIELDS = [
	"forum_topic_created",
	"forum_topic_edited",
	"forum_topic_closed",
	"forum_topic_reopened",
	"general_forum_topic_hidden",
	"general_forum_topic_unhidden"
];
/**
* Returns `true` when the message is a Telegram forum service message (e.g.
* "Topic created"). These auto-generated messages carry one of the
* `forum_topic_*` / `general_forum_topic_*` fields and should not count as
* regular bot replies for implicit-mention purposes.
*/
function isTelegramForumServiceMessage(msg) {
	if (!msg || typeof msg !== "object") return false;
	const messageRecord = msg;
	return TELEGRAM_FORUM_SERVICE_FIELDS.some((field) => field in messageRecord && messageRecord[field] != null);
}
//#endregion
//#region extensions/telegram/src/group-migration.ts
function resolveAccountGroups(cfg, accountId) {
	if (!accountId) return {};
	const normalized = normalizeAccountId(accountId);
	const accounts = cfg.channels?.telegram?.accounts;
	if (!accounts || typeof accounts !== "object") return {};
	const exact = accounts[normalized];
	if (exact?.groups) return { groups: exact.groups };
	const matchKey = Object.keys(accounts).find((key) => normalizeLowercaseStringOrEmpty(key) === normalizeLowercaseStringOrEmpty(normalized));
	return { groups: matchKey ? accounts[matchKey]?.groups : void 0 };
}
function migrateTelegramGroupsInPlace(groups, oldChatId, newChatId) {
	if (!groups) return {
		migrated: false,
		skippedExisting: false
	};
	if (oldChatId === newChatId) return {
		migrated: false,
		skippedExisting: false
	};
	if (!Object.hasOwn(groups, oldChatId)) return {
		migrated: false,
		skippedExisting: false
	};
	if (Object.hasOwn(groups, newChatId)) return {
		migrated: false,
		skippedExisting: true
	};
	groups[newChatId] = groups[oldChatId];
	delete groups[oldChatId];
	return {
		migrated: true,
		skippedExisting: false
	};
}
function migrateTelegramGroupConfig(params) {
	const scopes = [];
	let migrated = false;
	let skippedExisting = false;
	const migrationTargets = [{
		scope: "account",
		groups: resolveAccountGroups(params.cfg, params.accountId).groups
	}, {
		scope: "global",
		groups: params.cfg.channels?.telegram?.groups
	}];
	for (const target of migrationTargets) {
		const result = migrateTelegramGroupsInPlace(target.groups, params.oldChatId, params.newChatId);
		if (result.migrated) {
			migrated = true;
			scopes.push(target.scope);
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	return {
		migrated,
		skippedExisting,
		scopes
	};
}
//#endregion
//#region extensions/telegram/src/interactive-dispatch.ts
async function dispatchTelegramPluginInteractiveHandler(params) {
	return await dispatchPluginInteractiveHandler({
		channel: "telegram",
		data: params.data,
		dedupeId: params.callbackId,
		onMatched: params.onMatched,
		invoke: ({ registration, namespace, payload }) => {
			const { callbackMessage, ...handlerContext } = params.ctx;
			return registration.handler({
				...handlerContext,
				channel: "telegram",
				callback: {
					data: params.data,
					namespace,
					payload,
					messageId: callbackMessage.messageId,
					chatId: callbackMessage.chatId,
					messageText: callbackMessage.messageText
				},
				respond: params.respond,
				...createInteractiveConversationBindingHelpers({
					registration,
					senderId: handlerContext.senderId,
					conversation: {
						channel: "telegram",
						accountId: handlerContext.accountId,
						conversationId: handlerContext.conversationId,
						parentConversationId: handlerContext.parentConversationId,
						threadId: handlerContext.threadId
					}
				})
			});
		}
	});
}
//#endregion
//#region extensions/telegram/src/message-cache.ts
const DEFAULT_MAX_MESSAGES = 5e3;
const COMPACT_THRESHOLD_RATIO = 2;
const persistedMessageCacheBuckets = /* @__PURE__ */ new Map();
function telegramMessageCacheKey(params) {
	return `${params.accountId}:${params.chatId}:${params.messageId}`;
}
function telegramMessageCacheKeyPrefix(params) {
	return `${params.accountId}:${params.chatId}:`;
}
function resolveTelegramMessageCachePath(storePath) {
	return `${storePath}.telegram-messages.json`;
}
function resolveReplyMessage(msg) {
	const externalReply = msg.external_reply;
	return msg.reply_to_message ?? externalReply;
}
function resolveEmbeddedReplyMessage(msg) {
	return msg.reply_to_message;
}
function resolveMessageBody(msg) {
	const text = getTelegramTextParts(msg).text.trim();
	if (text) return text;
	const location = extractTelegramLocation(msg);
	if (location) return formatLocationText(location);
	return resolveTelegramPrimaryMedia(msg)?.placeholder;
}
function resolveMediaType(placeholder) {
	return placeholder?.match(/^<media:([^>]+)>$/)?.[1];
}
function normalizeMessageNode(msg, params) {
	if (typeof msg.message_id !== "number") return null;
	const media = resolveTelegramPrimaryMedia(msg);
	const fileId = media?.fileRef.file_id;
	const forwardedFrom = normalizeForwardedContext(msg);
	const replyMessage = resolveReplyMessage(msg);
	const body = resolveMessageBody(msg);
	return {
		sourceMessage: msg,
		messageId: String(msg.message_id),
		sender: buildSenderName(msg) ?? "unknown sender",
		...msg.from?.id != null ? { senderId: String(msg.from.id) } : {},
		...msg.from?.username ? { senderUsername: msg.from.username } : {},
		...msg.date ? { timestamp: msg.date * 1e3 } : {},
		...body ? { body } : {},
		...media ? { mediaType: resolveMediaType(media.placeholder) ?? media.placeholder } : {},
		...fileId ? { mediaRef: `telegram:file/${fileId}` } : {},
		...replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {},
		...forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {},
		...forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {},
		...forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {},
		...forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1e3 } : {},
		...params.threadId != null ? { threadId: String(params.threadId) } : {}
	};
}
function normalizeRequiredMessageNode(msg, params) {
	const node = normalizeMessageNode(msg, params);
	if (!node) throw new Error("Telegram message cache node missing message id");
	return node;
}
function resolveMessageThreadId(msg) {
	const threadId = msg.message_thread_id;
	return typeof threadId === "number" && Number.isFinite(threadId) ? Math.trunc(threadId) : void 0;
}
function normalizeMessageNodes(msg, params) {
	const observations = [];
	const visited = /* @__PURE__ */ new Set();
	const nodeThreadId = (node) => {
		const threadId = Number(node.threadId);
		return Number.isFinite(threadId) ? threadId : void 0;
	};
	const visit = (message, inheritedThreadId, mode) => {
		const node = normalizeMessageNode(message, { threadId: resolveMessageThreadId(message) ?? inheritedThreadId });
		if (!node?.messageId || visited.has(node.messageId)) return;
		visited.add(node.messageId);
		const replyMessage = resolveEmbeddedReplyMessage(message);
		if (replyMessage?.message_id != null) visit(replyMessage, nodeThreadId(node) ?? inheritedThreadId, "partial");
		observations.push({
			node,
			mode
		});
	};
	visit(msg, params.threadId, "authoritative");
	return observations;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
	return typeof value === "string" && value.length > 0;
}
function readOptionalString(record, key) {
	const value = record[key];
	return isString(value) ? value : void 0;
}
function isTelegramSourceMessage(value) {
	return isRecord(value) && typeof value.message_id === "number" && Number.isFinite(value.message_id) && typeof value.date === "number" && Number.isFinite(value.date);
}
function parsePersistedEntry(value) {
	if (!isRecord(value) || !isString(value.key)) return [];
	const separatorIndex = value.key.lastIndexOf(":");
	if (separatorIndex === -1 || !isRecord(value.node) || !isTelegramSourceMessage(value.node.sourceMessage)) return [];
	const keyPrefix = value.key.slice(0, separatorIndex + 1);
	const threadId = Number(readOptionalString(value.node, "threadId"));
	const sourceMessageId = String(value.node.sourceMessage.message_id);
	return normalizeMessageNodes(value.node.sourceMessage, Number.isFinite(threadId) ? { threadId } : {}).map(({ node, mode }) => ({
		key: `${keyPrefix}${node.messageId}`,
		node,
		mode: node.messageId === sourceMessageId ? "authoritative" : mode
	}));
}
function findJsonArrayEnd(text) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let started = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (!started) {
			if (char.trim() === "") continue;
			if (char !== "[") return -1;
			started = true;
			depth = 1;
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") inString = true;
		else if (char === "[") depth++;
		else if (char === "]") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}
function readPersistedEntryValues(raw) {
	const values = [];
	let needsRewrite = false;
	const readLines = (text) => {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const value = JSON.parse(line);
				values.push(value);
			} catch {
				needsRewrite = true;
			}
		}
	};
	const trimmedStart = raw.trimStart();
	if (trimmedStart.startsWith("[")) {
		const startOffset = raw.length - trimmedStart.length;
		const arrayEnd = findJsonArrayEnd(raw.slice(startOffset));
		if (arrayEnd === -1) {
			needsRewrite = true;
			readLines(raw);
			return {
				values,
				needsRewrite
			};
		}
		const legacyValue = JSON.parse(raw.slice(startOffset, startOffset + arrayEnd));
		if (Array.isArray(legacyValue)) values.push(...legacyValue);
		needsRewrite = true;
		readLines(raw.slice(startOffset + arrayEnd));
		return {
			values,
			needsRewrite
		};
	}
	readLines(raw);
	return {
		values,
		needsRewrite
	};
}
function trimMessages(messages, maxMessages) {
	while (messages.size > maxMessages) {
		const oldest = messages.keys().next().value;
		if (oldest === void 0) break;
		messages.delete(oldest);
	}
}
function mergeTelegramSourceMessage(existing, incoming) {
	const existingReply = resolveEmbeddedReplyMessage(existing);
	const incomingReply = resolveEmbeddedReplyMessage(incoming);
	if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) return Object.assign({}, existing, incoming, { reply_to_message: mergeTelegramSourceMessage(existingReply, incomingReply) });
	return Object.assign({}, existing, incoming);
}
function mergeAuthoritativeTelegramSourceMessage(existing, incoming) {
	const existingReply = resolveEmbeddedReplyMessage(existing);
	const incomingReply = resolveEmbeddedReplyMessage(incoming);
	if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) return Object.assign({}, incoming, { reply_to_message: mergeTelegramSourceMessage(existingReply, incomingReply) });
	return incoming;
}
function mergeCachedMessageNode(existing, incoming, mode) {
	const threadId = Number(incoming.threadId ?? existing.threadId);
	return normalizeRequiredMessageNode(mode === "authoritative" ? mergeAuthoritativeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage) : mergeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage), Number.isFinite(threadId) ? { threadId } : {});
}
function upsertCachedMessageNode(params) {
	const existing = params.messages.get(params.key);
	const node = existing ? mergeCachedMessageNode(existing, params.node, params.mode) : params.node;
	params.messages.delete(params.key);
	params.messages.set(params.key, node);
	return node;
}
function readPersistedMessages(filePath, maxMessages) {
	const messages = /* @__PURE__ */ new Map();
	let persistedEntryCount = 0;
	let needsRewrite = false;
	if (!fs.existsSync(filePath)) return {
		messages,
		persistedEntryCount,
		needsRewrite
	};
	try {
		const persisted = readPersistedEntryValues(fs.readFileSync(filePath, "utf-8"));
		needsRewrite = persisted.needsRewrite;
		for (const value of persisted.values) for (const entry of parsePersistedEntry(value)) {
			persistedEntryCount++;
			upsertCachedMessageNode({
				messages,
				key: entry.key,
				node: entry.node,
				mode: entry.mode
			});
			trimMessages(messages, maxMessages);
		}
	} catch (error) {
		logVerbose(`telegram: failed to read message cache: ${String(error)}`);
		needsRewrite = true;
	}
	return {
		messages,
		persistedEntryCount,
		needsRewrite
	};
}
function serializePersistedEntry(key, node) {
	return `${JSON.stringify({
		key,
		node: {
			sourceMessage: node.sourceMessage,
			...node.threadId ? { threadId: node.threadId } : {}
		}
	})}\n`;
}
function replacePersistedMessages(params) {
	const { persistedPath, messages } = params;
	if (!persistedPath) return messages.size;
	if (messages.size === 0) {
		fs.rmSync(persistedPath, { force: true });
		return 0;
	}
	replaceFileAtomicSync({
		filePath: persistedPath,
		content: Array.from(messages, ([key, node]) => serializePersistedEntry(key, node)).join(""),
		tempPrefix: ".telegram-message-cache"
	});
	return messages.size;
}
function appendPersistedMessage(params) {
	const { persistedPath } = params;
	if (!persistedPath) return 0;
	appendRegularFileSync({
		filePath: persistedPath,
		content: serializePersistedEntry(params.key, params.node)
	});
	return 1;
}
function resolveMessageCacheBucket(params) {
	const { persistedPath, maxMessages } = params;
	if (!persistedPath) return {
		messages: /* @__PURE__ */ new Map(),
		persistedEntryCount: 0
	};
	const existing = persistedMessageCacheBuckets.get(persistedPath);
	if (existing) {
		if (!fs.existsSync(persistedPath)) {
			existing.messages.clear();
			existing.persistedEntryCount = 0;
		}
		return existing;
	}
	const persisted = readPersistedMessages(persistedPath, maxMessages);
	const bucket = {
		messages: persisted.messages,
		persistedEntryCount: persisted.persistedEntryCount
	};
	if (persisted.needsRewrite) try {
		bucket.persistedEntryCount = replacePersistedMessages({
			messages: bucket.messages,
			persistedPath
		});
	} catch (error) {
		logVerbose(`telegram: failed to compact message cache: ${String(error)}`);
	}
	persistedMessageCacheBuckets.set(persistedPath, bucket);
	return bucket;
}
function createTelegramMessageCache(params) {
	const maxMessages = params?.maxMessages ?? DEFAULT_MAX_MESSAGES;
	const bucket = resolveMessageCacheBucket({
		persistedPath: params?.persistedPath,
		maxMessages
	});
	const { messages } = bucket;
	const get = ({ accountId, chatId, messageId }) => {
		if (!messageId) return null;
		const key = telegramMessageCacheKey({
			accountId,
			chatId,
			messageId
		});
		const entry = messages.get(key);
		if (!entry) return null;
		messages.delete(key);
		messages.set(key, entry);
		return entry;
	};
	const listChatMessages = (params) => {
		const prefix = telegramMessageCacheKeyPrefix(params);
		const threadId = params.threadId != null ? String(params.threadId) : void 0;
		return Array.from(messages, ([key, node]) => ({
			key,
			node
		})).filter(({ key, node }) => {
			if (!key.startsWith(prefix)) return false;
			return threadId === void 0 || node.threadId === threadId;
		}).map(({ node }) => node).toSorted(compareCachedMessageNodes);
	};
	return {
		record: ({ accountId, chatId, msg, threadId }) => {
			const observations = normalizeMessageNodes(msg, { threadId });
			const currentObservation = observations.at(-1);
			if (!currentObservation) return null;
			let recordedEntry = null;
			for (const { node, mode } of observations) {
				const { messageId } = node;
				if (!messageId) continue;
				const key = telegramMessageCacheKey({
					accountId,
					chatId,
					messageId
				});
				const cachedNode = upsertCachedMessageNode({
					messages,
					key,
					node,
					mode
				});
				if (messageId === currentObservation.node.messageId) recordedEntry = cachedNode;
				trimMessages(messages, maxMessages);
				try {
					bucket.persistedEntryCount += appendPersistedMessage({
						key,
						node: cachedNode,
						persistedPath: params?.persistedPath
					});
					if (bucket.persistedEntryCount > maxMessages * COMPACT_THRESHOLD_RATIO) bucket.persistedEntryCount = replacePersistedMessages({
						messages,
						persistedPath: params?.persistedPath
					});
				} catch (error) {
					logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
				}
			}
			return recordedEntry ?? currentObservation.node;
		},
		get,
		recentBefore: ({ accountId, chatId, messageId, threadId, limit }) => {
			if (!messageId || limit <= 0) return [];
			const targetId = Number(messageId);
			if (!Number.isFinite(targetId)) return [];
			return listChatMessages({
				accountId,
				chatId,
				threadId
			}).filter((entry) => {
				const entryId = Number(entry.messageId);
				return Number.isFinite(entryId) && entryId < targetId;
			}).slice(-limit);
		},
		around: ({ accountId, chatId, messageId, threadId, before, after }) => {
			if (!messageId) return [];
			const entries = listChatMessages({
				accountId,
				chatId,
				threadId
			});
			const targetIndex = entries.findIndex((entry) => entry.messageId === messageId);
			if (targetIndex === -1) return [];
			return entries.slice(Math.max(0, targetIndex - Math.max(0, before)), targetIndex + Math.max(0, after) + 1);
		}
	};
}
function compareCachedMessageNodes(left, right) {
	const leftId = Number(left.messageId);
	const rightId = Number(right.messageId);
	if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
	return (left.messageId ?? "").localeCompare(right.messageId ?? "");
}
const SESSION_BOUNDARY_COMMAND_RE = /^\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const SOFT_RESET_COMMAND_RE = /^\/reset(?:@[A-Za-z0-9_]+)?\s+soft(?:\s|$)/i;
function isSessionBoundaryCommandNode(node) {
	const body = node.body?.trim();
	return Boolean(body && SESSION_BOUNDARY_COMMAND_RE.test(body) && !SOFT_RESET_COMMAND_RE.test(body));
}
function isAfterSessionBoundary(node, boundary) {
	if (!boundary) return true;
	const nodeId = Number(node.messageId);
	const boundaryId = Number(boundary.messageId);
	if (Number.isFinite(nodeId) && Number.isFinite(boundaryId)) return nodeId > boundaryId;
	if (typeof node.timestamp === "number" && Number.isFinite(node.timestamp) && typeof boundary.timestamp === "number" && Number.isFinite(boundary.timestamp)) return node.timestamp > boundary.timestamp;
	return true;
}
function normalizeSessionBoundaryTimestamp(timestampMs) {
	if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return;
	return Math.floor(timestampMs / 1e3) * 1e3;
}
function isAtOrAfterSessionBoundaryTimestamp(node, boundaryTimestampMs) {
	if (boundaryTimestampMs === void 0) return true;
	return typeof node.timestamp !== "number" || !Number.isFinite(node.timestamp) ? true : node.timestamp >= boundaryTimestampMs;
}
function resolveSessionBoundaryNode(params) {
	if (!params.messageId) return;
	const { messageId } = params;
	const candidates = params.cache.recentBefore({
		accountId: params.accountId,
		chatId: params.chatId,
		messageId,
		...params.threadId !== void 0 ? { threadId: params.threadId } : {},
		limit: Number.MAX_SAFE_INTEGER
	}).filter(isSessionBoundaryCommandNode);
	const current = params.cache.get({
		accountId: params.accountId,
		chatId: params.chatId,
		messageId
	});
	if (current && isSessionBoundaryCommandNode(current)) candidates.push(current);
	return candidates.toSorted(compareCachedMessageNodes).at(-1);
}
function buildTelegramReplyChain(params) {
	const replyMessage = resolveReplyMessage(params.msg);
	if (!replyMessage?.message_id) return [];
	const maxDepth = params.maxDepth ?? 4;
	const visited = /* @__PURE__ */ new Set();
	const chain = [];
	let current = params.cache.get({
		accountId: params.accountId,
		chatId: params.chatId,
		messageId: String(replyMessage.message_id)
	}) ?? normalizeMessageNode(replyMessage, {});
	while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
		visited.add(current.messageId);
		chain.push(current);
		current = params.cache.get({
			accountId: params.accountId,
			chatId: params.chatId,
			messageId: current.replyToId
		});
	}
	return chain;
}
function buildTelegramConversationContext(params) {
	const selected = /* @__PURE__ */ new Map();
	const replyTargetIds = /* @__PURE__ */ new Set();
	const sessionBoundary = resolveSessionBoundaryNode(params);
	const sessionBoundaryTimestamp = normalizeSessionBoundaryTimestamp(params.minTimestampMs);
	const addNode = (node, flags) => {
		if (!node.messageId || node.messageId === params.messageId) return;
		if (!isAfterSessionBoundary(node, sessionBoundary)) return;
		if (!isAtOrAfterSessionBoundaryTimestamp(node, sessionBoundaryTimestamp)) return;
		const existing = selected.get(node.messageId);
		const isReplyTarget = existing?.isReplyTarget === true || flags?.replyTarget === true;
		selected.set(node.messageId, {
			node: existing?.node ?? node,
			isReplyTarget: isReplyTarget ? true : void 0
		});
	};
	const addReplyTargetWindow = (messageId) => {
		replyTargetIds.add(messageId);
		for (const node of params.cache.around({
			accountId: params.accountId,
			chatId: params.chatId,
			messageId,
			...params.threadId !== void 0 ? { threadId: params.threadId } : {},
			before: params.replyTargetWindowSize,
			after: params.replyTargetWindowSize
		})) addNode(node, { replyTarget: node.messageId === messageId });
	};
	const currentWindow = params.cache.recentBefore({
		accountId: params.accountId,
		chatId: params.chatId,
		messageId: params.messageId,
		...params.threadId !== void 0 ? { threadId: params.threadId } : {},
		limit: params.recentLimit
	});
	for (const node of currentWindow) {
		addNode(node);
		if (node.replyToId) addReplyTargetWindow(node.replyToId);
	}
	params.replyChainNodes.forEach((node, index) => {
		addNode(node, { replyTarget: index === 0 });
		if (index === 0 && node.messageId) addReplyTargetWindow(node.messageId);
		if (node.replyToId) replyTargetIds.add(node.replyToId);
	});
	for (const messageId of replyTargetIds) {
		const node = params.cache.get({
			accountId: params.accountId,
			chatId: params.chatId,
			messageId
		});
		if (node) addNode(node, { replyTarget: true });
	}
	return Array.from(selected.values()).toSorted((left, right) => compareCachedMessageNodes(left.node, right.node));
}
//#endregion
//#region extensions/telegram/src/message-dispatch-dedupe.ts
const TELEGRAM_MESSAGE_DISPATCH_TTL_MS = 10080 * 60 * 1e3;
const TELEGRAM_MESSAGE_DISPATCH_MEMORY_MAX = 5e3;
const TELEGRAM_MESSAGE_DISPATCH_FILE_MAX = 5e4;
function sanitizeFileSegment(value) {
	const trimmed = value.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function buildTelegramMessageDispatchReplayKey(msg) {
	const chatId = msg.chat?.id;
	const messageId = msg.message_id;
	if (chatId == null || typeof messageId !== "number" || messageId <= 0) return null;
	return JSON.stringify([
		"message",
		String(chatId),
		messageId
	]);
}
function createTelegramMessageDispatchReplayGuard(params) {
	return createClaimableDedupe({
		ttlMs: TELEGRAM_MESSAGE_DISPATCH_TTL_MS,
		memoryMaxSize: TELEGRAM_MESSAGE_DISPATCH_MEMORY_MAX,
		fileMaxEntries: TELEGRAM_MESSAGE_DISPATCH_FILE_MAX,
		resolveFilePath: (namespace) => path.join(path.dirname(params.storePath), `${path.basename(params.storePath)}.telegram-message-dispatch-${sanitizeFileSegment(namespace)}.json`),
		onDiskError: params.onDiskError
	});
}
async function claimTelegramMessageDispatchReplay(params) {
	const key = buildTelegramMessageDispatchReplayKey(params.msg);
	if (!key) return { kind: "invalid" };
	let releaseRetries = 0;
	while (true) {
		const claim = await params.guard.claim(key, { namespace: params.accountId });
		if (claim.kind === "claimed") return {
			kind: "claimed",
			key
		};
		if (claim.kind === "duplicate") return { kind: "duplicate" };
		try {
			await claim.pending;
			return { kind: "duplicate" };
		} catch {
			releaseRetries += 1;
			if (releaseRetries > 1) return { kind: "duplicate" };
		}
	}
}
function normalizeReplayKeys(keys) {
	return [...new Set((keys ?? []).map((key) => key.trim()).filter(Boolean))];
}
async function commitTelegramMessageDispatchReplay(params) {
	const keys = normalizeReplayKeys(params.keys);
	await Promise.all(keys.map((key) => params.guard.commit(key, { namespace: params.accountId })));
}
function releaseTelegramMessageDispatchReplay(params) {
	const keys = normalizeReplayKeys(params.keys);
	for (const key of keys) params.guard.release(key, {
		namespace: params.accountId,
		error: params.error
	});
}
//#endregion
//#region extensions/telegram/src/bot-handlers.runtime.ts
const registerTelegramHandlers = ({ cfg, accountId, bot, opts, telegramTransport, runtime, mediaMaxBytes, telegramCfg, allowFrom, groupAllowFrom, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, processMessage, logger, telegramDeps, resolveGroupActivation, resolveGroupRequireMention }) => {
	const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
		cfg,
		accountId,
		token: opts.token,
		transport: telegramTransport
	});
	const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
	const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4e3;
	const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = typeof opts.testTimings?.textFragmentGapMs === "number" && Number.isFinite(opts.testTimings.textFragmentGapMs) ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs)) : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
	const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
	const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
	const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 5e4;
	const mediaGroupTimeoutMs = typeof opts.testTimings?.mediaGroupFlushMs === "number" && Number.isFinite(opts.testTimings.mediaGroupFlushMs) ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs)) : typeof telegramCfg.mediaGroupFlushMs === "number" && Number.isFinite(telegramCfg.mediaGroupFlushMs) ? Math.max(10, Math.floor(telegramCfg.mediaGroupFlushMs)) : 500;
	const mediaGroupBuffer = /* @__PURE__ */ new Map();
	const mediaGroupProcessingByKey = /* @__PURE__ */ new Map();
	const messageCache = createTelegramMessageCache({ persistedPath: resolveTelegramMessageCachePath(telegramDeps.resolveStorePath(cfg.session?.store)) });
	const messageDispatchReplayGuard = createTelegramMessageDispatchReplayGuard({
		storePath: telegramDeps.resolveStorePath(cfg.session?.store),
		onDiskError: (error) => {
			runtime.error?.(danger(`[telegram] message dispatch dedupe store failed: ${String(error)}`));
		}
	});
	const textFragmentBuffer = /* @__PURE__ */ new Map();
	const textFragmentProcessingByKey = /* @__PURE__ */ new Map();
	const queueBufferedProcessing = async (processingByKey, key, task) => {
		const current = (processingByKey.get(key) ?? Promise.resolve()).then(task).catch(() => void 0);
		processingByKey.set(key, current);
		await current;
		if (processingByKey.get(key) === current) processingByKey.delete(key);
	};
	const debounceMs = resolveInboundDebounceMs({
		cfg,
		channel: "telegram"
	});
	const FORWARD_BURST_DEBOUNCE_MS = 80;
	const normalizePromptContextMinTimestampMs = (timestampMs) => typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : void 0;
	const promptContextBoundaryOptions = (timestampMs) => {
		const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(timestampMs);
		return promptContextMinTimestampMs === void 0 ? {} : { promptContextMinTimestampMs };
	};
	const latestPromptContextMinTimestampMs = (...timestamps) => {
		let latest;
		for (const timestampMs of timestamps) {
			const normalized = normalizePromptContextMinTimestampMs(timestampMs);
			if (normalized === void 0) continue;
			latest = latest === void 0 ? normalized : Math.max(latest, normalized);
		}
		return latest;
	};
	const mergeDispatchDedupeKeys = (...groups) => [...new Set(groups.flatMap((group) => group ?? []).map((key) => key.trim()).filter(Boolean))];
	const releaseDispatchDedupeKeys = (keys, error) => {
		releaseTelegramMessageDispatchReplay({
			guard: messageDispatchReplayGuard,
			accountId,
			keys,
			error
		});
	};
	const commitDispatchDedupeKeys = async (keys) => {
		await commitTelegramMessageDispatchReplay({
			guard: messageDispatchReplayGuard,
			accountId,
			keys
		});
	};
	const claimMessageDispatchDedupe = async (msg) => {
		const claim = await claimTelegramMessageDispatchReplay({
			guard: messageDispatchReplayGuard,
			accountId,
			msg
		});
		if (claim.kind === "duplicate") {
			logVerbose(`telegram dispatch dedupe: skipped message ${msg.chat.id}:${msg.message_id}`);
			return { process: false };
		}
		return {
			process: true,
			keys: claim.kind === "claimed" ? [claim.key] : []
		};
	};
	const resolveTelegramDebounceLane = (msg) => {
		const forwardMeta = msg;
		return forwardMeta.forward_origin ?? forwardMeta.forward_from ?? forwardMeta.forward_from_chat ?? forwardMeta.forward_sender_name ?? forwardMeta.forward_date ? "forward" : "default";
	};
	const buildSyntheticTextMessage = (params) => ({
		...params.base,
		...params.from ? { from: params.from } : {},
		text: params.text,
		caption: void 0,
		caption_entities: void 0,
		entities: void 0,
		...params.date != null ? { date: params.date } : {}
	});
	const buildSyntheticContext = (ctx, message) => {
		const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
		return {
			message,
			me: ctx.me,
			getFile
		};
	};
	const MULTI_SELECT_PREFIX = "OC_MULTI|";
	const MULTI_SELECT_TOGGLE_PREFIX = `${MULTI_SELECT_PREFIX}toggle|`;
	const SELECT_PREFIX = "OC_SELECT|";
	const SELECTED_PREFIX = "✅ ";
	const parseTelegramManagedSelectCallback = (data) => {
		if (data.startsWith(MULTI_SELECT_TOGGLE_PREFIX)) return {
			type: "multi-toggle",
			value: data.slice(MULTI_SELECT_TOGGLE_PREFIX.length)
		};
		if (data === `${MULTI_SELECT_PREFIX}clear`) return { type: "multi-clear" };
		if (data === `${MULTI_SELECT_PREFIX}submit`) return { type: "multi-submit" };
		if (data.startsWith(SELECT_PREFIX)) return {
			type: "select",
			value: data.slice(10)
		};
	};
	const cloneInlineKeyboardButtons = (message) => {
		const rows = message.reply_markup?.inline_keyboard;
		if (!Array.isArray(rows)) return [];
		return rows.map((row) => Array.isArray(row) ? row.map((button) => {
			const candidate = button;
			if (typeof candidate.text !== "string" || typeof candidate.callback_data !== "string") return null;
			const style = candidate.style === "danger" || candidate.style === "success" || candidate.style === "primary" ? candidate.style : void 0;
			return {
				text: candidate.text,
				callback_data: candidate.callback_data,
				...style ? { style } : {}
			};
		}).filter((button) => button !== null) : []).filter((row) => row.length > 0);
	};
	const stripMultiSelectPrefix = (text) => text.replace(/^✅\s*/, "");
	const isSelectedMultiButton = (button) => /^✅\s*/.test(button.text);
	const isMultiToggleButton = (button) => button.callback_data.startsWith(MULTI_SELECT_TOGGLE_PREFIX);
	const resolveMultiSelectedValues = (buttons) => buttons.flatMap((row) => row.flatMap((button) => {
		if (!isMultiToggleButton(button) || !isSelectedMultiButton(button)) return [];
		return [button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length)];
	}));
	const updateMultiSelectKeyboard = (message, action, value = "") => cloneInlineKeyboardButtons(message).map((row) => row.map((button) => {
		if (!isMultiToggleButton(button)) return button;
		const buttonValue = button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length);
		const baseText = stripMultiSelectPrefix(button.text);
		const selected = action === "clear" ? false : buttonValue === value ? !isSelectedMultiButton(button) : isSelectedMultiButton(button);
		return {
			...button,
			text: selected ? `${SELECTED_PREFIX}${baseText}` : baseText
		};
	}));
	const buildCallbackSyntheticTextContext = (params) => {
		const message = buildSyntheticTextMessage({
			base: withResolvedTelegramForumFlag(params.callbackMessage, params.isForum),
			from: params.callback.from,
			text: params.text
		});
		return {
			ctx: buildSyntheticContext(params.ctx, message),
			message
		};
	};
	const inboundDebouncer = createInboundDebouncer({
		debounceMs,
		serializeImmediate: true,
		resolveDebounceMs: (entry) => entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
		buildKey: (entry) => entry.debounceKey,
		shouldDebounce: (entry) => {
			const text = getTelegramTextParts(entry.msg).text;
			const hasDebounceableText = shouldDebounceTextInbound({
				text,
				cfg,
				commandOptions: { botUsername: entry.botUsername }
			});
			if (entry.debounceLane === "forward") return hasDebounceableText || entry.allMedia.length > 0;
			if (!hasDebounceableText) return false;
			return entry.allMedia.length === 0;
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await processMessageWithReplyChain({
					ctx: last.ctx,
					msg: last.msg,
					allMedia: last.allMedia,
					storeAllowFrom: last.storeAllowFrom,
					options: {
						receivedAtMs: last.receivedAtMs,
						ingressBuffer: "inbound-debounce",
						...promptContextBoundaryOptions(last.promptContextMinTimestampMs)
					},
					dispatchDedupeKeys: last.dispatchDedupeKeys
				});
				return;
			}
			const combinedText = entries.map((entry) => getTelegramTextParts(entry.msg).text).filter(Boolean).join("\n");
			const combinedMedia = entries.flatMap((entry) => entry.allMedia);
			if (!combinedText.trim() && combinedMedia.length === 0) return;
			const first = entries[0];
			const promptContextMinTimestampMs = latestPromptContextMinTimestampMs(...entries.map((entry) => entry.promptContextMinTimestampMs));
			const baseCtx = first.ctx;
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : void 0;
			await processMessageWithReplyChain({
				ctx: buildSyntheticContext(baseCtx, syntheticMessage),
				msg: syntheticMessage,
				allMedia: combinedMedia,
				storeAllowFrom: first.storeAllowFrom,
				options: {
					...messageIdOverride ? { messageIdOverride } : {},
					receivedAtMs: first.receivedAtMs,
					ingressBuffer: "inbound-debounce",
					...promptContextBoundaryOptions(promptContextMinTimestampMs)
				},
				dispatchDedupeKeys: mergeDispatchDedupeKeys(...entries.map((entry) => entry.dispatchDedupeKeys))
			});
		},
		onError: (err, items) => {
			runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
			const chatId = items[0]?.msg.chat.id;
			if (chatId != null) {
				const threadId = items[0]?.msg.message_thread_id;
				bot.api.sendMessage(chatId, "Something went wrong while processing your message. Please try again.", threadId != null ? { message_thread_id: threadId } : void 0).catch((sendErr) => {
					logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
				});
			}
		},
		onCancel: (items) => {
			releaseDispatchDedupeKeys(mergeDispatchDedupeKeys(...items.map((item) => item.dispatchDedupeKeys)));
		}
	});
	const resolveTelegramSessionState = (params) => {
		const runtimeCfg = params.runtimeCfg ?? telegramDeps.getRuntimeConfig();
		const resolvedThreadId = params.resolvedThreadId ?? resolveTelegramForumThreadId({
			isForum: params.isForum,
			messageThreadId: params.messageThreadId
		});
		const dmThreadId = !params.isGroup ? params.messageThreadId : void 0;
		const topicThreadId = resolvedThreadId ?? dmThreadId;
		const { groupConfig, topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId);
		const directConfig = !params.isGroup ? groupConfig : void 0;
		let accountConfig = telegramCfg;
		try {
			accountConfig = resolveTelegramAccount({
				cfg: runtimeCfg,
				accountId
			}).config;
		} catch {}
		const { route } = resolveTelegramConversationRoute({
			cfg: runtimeCfg,
			accountId,
			chatId: params.chatId,
			isGroup: params.isGroup,
			resolvedThreadId,
			replyThreadId: topicThreadId,
			senderId: params.senderId,
			topicAgentId: topicConfig?.agentId
		});
		const baseSessionKey = resolveTelegramConversationBaseSessionKey({
			cfg: runtimeCfg,
			route,
			chatId: params.chatId,
			isGroup: params.isGroup,
			senderId: params.senderId
		});
		const sessionKey = (shouldUseTelegramDmThreadSession({
			dmThreadId,
			accountConfig,
			directConfig,
			topicConfig
		}) && dmThreadId != null ? resolveThreadSessionKeys({
			baseSessionKey,
			threadId: `${params.chatId}:${dmThreadId}`
		}) : null)?.sessionKey ?? baseSessionKey;
		const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, { agentId: route.agentId });
		const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath);
		const entry = resolveSessionStoreEntry({
			store,
			sessionKey
		}).existing;
		const storedOverride = resolveStoredModelOverride({
			sessionEntry: entry,
			sessionStore: store,
			sessionKey,
			defaultProvider: resolveDefaultModelForAgent({
				cfg: runtimeCfg,
				agentId: route.agentId
			}).provider
		});
		if (storedOverride) return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: storedOverride.provider ? `${storedOverride.provider}/${storedOverride.model}` : storedOverride.model
		};
		const provider = entry?.modelProvider?.trim();
		const model = entry?.model?.trim();
		if (provider && model) return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: `${provider}/${model}`
		};
		const modelCfg = runtimeCfg.agents?.defaults?.model;
		return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary
		};
	};
	const mediaMayNeedDownloadForMentionDetection = (msg) => {
		if (getTelegramTextParts(msg).text.trim()) return false;
		const documentMime = msg.document?.mime_type?.split(";")[0]?.trim().toLowerCase();
		return Boolean(msg.audio ?? msg.voice ?? documentMime?.startsWith("audio/"));
	};
	const shouldSkipMediaDownloadForUnaddressedMentionGroup = async (params) => {
		const { ctx, msg, chatId, isGroup, isForum, resolvedThreadId, dmThreadId, senderId, effectiveGroupAllow, effectiveDmAllow, groupConfig, topicConfig } = params;
		if (!isGroup || mediaMayNeedDownloadForMentionDetection(msg)) return false;
		const runtimeCfg = telegramDeps.getRuntimeConfig();
		const sessionState = resolveTelegramSessionState({
			chatId,
			isGroup,
			isForum,
			resolvedThreadId,
			messageThreadId: resolvedThreadId ?? dmThreadId,
			senderId,
			runtimeCfg
		});
		const activationOverride = resolveGroupActivation({
			chatId,
			messageThreadId: resolvedThreadId,
			sessionKey: sessionState.sessionKey,
			agentId: sessionState.agentId
		});
		if (!firstDefined(topicConfig?.requireMention, activationOverride, groupConfig?.requireMention, resolveGroupRequireMention(chatId))) return false;
		const botUsername = ctx.me?.username?.trim().toLowerCase();
		const mentionRegexes = buildMentionRegexes(runtimeCfg, sessionState.agentId);
		const messageTextParts = getTelegramTextParts(msg);
		const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
		const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
		const wasMentioned = matchesMentionWithExplicit({
			text: messageTextParts.text,
			mentionRegexes,
			explicit: {
				hasAnyMention,
				isExplicitlyMentioned: explicitlyMentioned,
				canResolveExplicit: Boolean(botUsername)
			}
		});
		const botId = ctx.me?.id;
		const replyFromId = msg.reply_to_message?.from?.id;
		const replyToBotMessage = botId != null && replyFromId === botId;
		const isReplyToServiceMessage = replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
		const implicitMentionKinds = implicitMentionKindWhen("reply_to_bot", replyToBotMessage && !isReplyToServiceMessage);
		const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
		const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, runtimeCfg, { botUsername });
		const commandGate = await resolveTelegramCommandIngressAuthorization({
			accountId,
			cfg: runtimeCfg,
			dmPolicy: "pairing",
			isGroup,
			chatId,
			resolvedThreadId,
			senderId,
			effectiveDmAllow,
			effectiveGroupAllow,
			ownerAccess: {
				ownerList: [],
				senderIsOwner: false
			},
			eventKind: "message",
			allowTextCommands: true,
			hasControlCommand: hasControlCommandInMessage,
			modeWhenAccessGroupsOff: "allow",
			includeDmAllowForGroupCommands: false
		});
		if (resolveInboundMentionDecision({
			facts: {
				canDetectMention,
				wasMentioned,
				hasAnyMention,
				implicitMentionKinds
			},
			policy: {
				isGroup,
				requireMention: true,
				allowTextCommands: true,
				hasControlCommand: hasControlCommandInMessage,
				commandAuthorized: commandGate.authorized
			}
		}).shouldSkip) {
			logger.info({
				chatId,
				reason: "no-mention"
			}, "skipping group media before download");
			return true;
		}
		return false;
	};
	const processMediaGroup = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const primaryEntry = entry.messages.find((m) => m.msg.caption || m.msg.text) ?? entry.messages[0];
			if (!primaryEntry) {
				releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
				return;
			}
			if (await shouldSkipMediaDownloadForUnaddressedMentionGroup({
				ctx: primaryEntry.ctx,
				msg: primaryEntry.msg,
				chatId: primaryEntry.msg.chat.id,
				isGroup: entry.isGroup,
				isForum: entry.isForum,
				resolvedThreadId: entry.resolvedThreadId,
				dmThreadId: entry.dmThreadId,
				senderId: entry.senderId,
				effectiveGroupAllow: entry.effectiveGroupAllow,
				effectiveDmAllow: entry.effectiveDmAllow,
				groupConfig: entry.groupConfig,
				topicConfig: entry.topicConfig
			})) {
				releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
				return;
			}
			const allMedia = [];
			let skippedCount = 0;
			for (const { ctx } of entry.messages) {
				let media;
				try {
					media = await resolveMedia({
						ctx,
						maxBytes: mediaMaxBytes,
						...mediaRuntimeOptions
					});
				} catch (mediaErr) {
					if (!isRecoverableMediaGroupError(mediaErr)) throw mediaErr;
					runtime.log?.(warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`));
					skippedCount++;
					continue;
				}
				if (media) allMedia.push({
					path: media.path,
					contentType: media.contentType,
					stickerMetadata: media.stickerMetadata
				});
				else skippedCount++;
			}
			if (skippedCount > 0) {
				const total = entry.messages.length;
				const wasOrWere = skippedCount === 1 ? "was" : "were";
				await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(primaryEntry.msg.chat.id, `⚠️ Received ${allMedia.length} of ${total} images — ${skippedCount} could not be fetched and ${wasOrWere} skipped.`, { reply_parameters: {
						message_id: primaryEntry.msg.message_id,
						allow_sending_without_reply: true
					} })
				}).catch(() => {});
			}
			await processMessageWithReplyChain({
				ctx: primaryEntry.ctx,
				msg: primaryEntry.msg,
				allMedia,
				storeAllowFrom: entry.storeAllowFrom,
				options: promptContextBoundaryOptions(entry.promptContextMinTimestampMs),
				dispatchDedupeKeys: entry.dispatchDedupeKeys
			});
		} catch (err) {
			releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
			runtime.error?.(danger(`media group handler failed: ${String(err)}`));
		}
	};
	const flushTextFragments = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const first = entry.messages[0];
			const last = entry.messages.at(-1);
			if (!first || !last) {
				releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
				return;
			}
			const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
			if (!combinedText.trim()) {
				releaseDispatchDedupeKeys(entry.dispatchDedupeKeys);
				return;
			}
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const storeAllowFrom = await loadStoreAllowFrom();
			const baseCtx = first.ctx;
			await processMessageWithReplyChain({
				ctx: buildSyntheticContext(baseCtx, syntheticMessage),
				msg: syntheticMessage,
				allMedia: [],
				storeAllowFrom,
				options: {
					messageIdOverride: String(last.msg.message_id),
					receivedAtMs: first.receivedAtMs,
					ingressBuffer: "text-fragment",
					...promptContextBoundaryOptions(entry.promptContextMinTimestampMs)
				},
				dispatchDedupeKeys: entry.dispatchDedupeKeys
			});
		} catch (err) {
			releaseDispatchDedupeKeys(entry.dispatchDedupeKeys, err);
			runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
		}
	};
	const queueTextFragmentFlush = async (entry) => {
		await queueBufferedProcessing(textFragmentProcessingByKey, entry.key, async () => {
			await flushTextFragments(entry);
		});
	};
	const runTextFragmentFlush = async (entry) => {
		textFragmentBuffer.delete(entry.key);
		await queueTextFragmentFlush(entry);
	};
	const scheduleTextFragmentFlush = (entry) => {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(async () => {
			await runTextFragmentFlush(entry);
		}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
	};
	const loadStoreAllowFrom = async () => telegramDeps.readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
	const recordMessageForReplyChain = (msg, threadId) => messageCache.record({
		accountId,
		chatId: msg.chat.id,
		msg,
		...threadId != null ? { threadId } : {}
	});
	const buildReplyChainForMessage = (msg) => buildTelegramReplyChain({
		cache: messageCache,
		accountId,
		chatId: msg.chat.id,
		msg
	});
	const toReplyChainEntry = (node, media) => {
		const { sourceMessage: _sourceMessage, ...entry } = node;
		return {
			...entry,
			...media?.path ? { mediaPath: media.path } : {},
			...media?.contentType ? { mediaType: media.contentType } : {}
		};
	};
	const toPromptContextMessage = (node, flags) => ({
		message_id: node.messageId,
		thread_id: node.threadId,
		sender: node.sender,
		sender_id: node.senderId,
		sender_username: node.senderUsername,
		timestamp_ms: node.timestamp,
		body: node.body,
		media_type: node.mediaType,
		media_ref: node.mediaRef,
		reply_to_id: node.replyToId,
		is_reply_target: flags?.replyTarget === true ? true : void 0
	});
	const buildPromptContextForMessage = (msg, replyChainNodes, options) => {
		const messageId = typeof msg.message_id === "number" ? String(msg.message_id) : void 0;
		const currentNode = messageCache.get({
			accountId,
			chatId: msg.chat.id,
			messageId
		});
		const threadId = currentNode?.threadId ? Number(currentNode.threadId) : void 0;
		const conversationContext = buildTelegramConversationContext({
			cache: messageCache,
			messageId,
			accountId,
			chatId: msg.chat.id,
			...Number.isFinite(threadId) ? { threadId } : {},
			replyChainNodes,
			recentLimit: 10,
			replyTargetWindowSize: 2,
			...options?.promptContextMinTimestampMs !== void 0 ? { minTimestampMs: options.promptContextMinTimestampMs } : {}
		});
		return conversationContext.length > 0 ? [{
			label: "Conversation context",
			source: "telegram",
			type: "chat_window",
			payload: {
				order: "chronological",
				relation: "selected_for_current_message",
				messages: conversationContext.map((entry) => toPromptContextMessage(entry.node, { replyTarget: entry.isReplyTarget }))
			}
		}] : [];
	};
	const resolveReplyMediaForChain = async (ctx, chain) => {
		const replyMedia = [];
		const replyChain = [];
		for (const node of chain) {
			let mediaRef;
			const replyFileId = resolveInboundMediaFileId(node.sourceMessage);
			if (replyFileId && hasInboundMedia(node.sourceMessage)) try {
				const media = await resolveMedia({
					ctx: {
						message: node.sourceMessage,
						me: ctx.me,
						getFile: async () => await bot.api.getFile(replyFileId)
					},
					maxBytes: mediaMaxBytes,
					...mediaRuntimeOptions
				});
				mediaRef = media ? {
					path: media.path,
					...media.contentType ? { contentType: media.contentType } : {},
					...media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}
				} : void 0;
			} catch (err) {
				logger.warn({
					chatId: ctx.message.chat.id,
					error: String(err)
				}, "reply media fetch failed");
			}
			if (mediaRef) replyMedia.push(mediaRef);
			replyChain.push(toReplyChainEntry(node, mediaRef));
		}
		return {
			replyMedia,
			replyChain
		};
	};
	const processMessageWithReplyChain = async (params) => {
		let dispatchDedupeCommitted = false;
		try {
			const replyChainNodes = buildReplyChainForMessage(params.msg);
			const { replyMedia, replyChain } = await resolveReplyMediaForChain(params.ctx, replyChainNodes);
			const promptContext = buildPromptContextForMessage(params.msg, replyChainNodes, params.options);
			if (!await processMessage(params.ctx, params.allMedia, params.storeAllowFrom, params.options, replyMedia, replyChain, promptContext, { onDispatchStart: async () => {
				await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
				dispatchDedupeCommitted = true;
			} }) && !dispatchDedupeCommitted) releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
		} catch (err) {
			if (!dispatchDedupeCommitted) releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? [], err);
			throw err;
		}
	};
	const shouldSkipGroupMessage = (params) => {
		const { isGroup, chatId, chatTitle, resolvedThreadId, senderId, senderUsername, effectiveGroupAllow, hasGroupAllowOverride, groupConfig, topicConfig } = params;
		const baseAccess = evaluateTelegramGroupBaseAccess({
			isGroup,
			groupConfig,
			topicConfig,
			hasGroupAllowOverride,
			effectiveGroupAllow,
			senderId,
			senderUsername,
			enforceAllowOverride: true,
			requireSenderForAllowOverride: true
		});
		if (!baseAccess.allowed) {
			if (baseAccess.reason === "group-disabled") {
				logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
				return true;
			}
			if (baseAccess.reason === "topic-disabled") {
				logVerbose(`Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`);
				return true;
			}
			logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`);
			return true;
		}
		if (!isGroup) return false;
		const policyAccess = evaluateTelegramGroupPolicyAccess({
			isGroup,
			chatId,
			cfg,
			telegramCfg,
			topicConfig,
			groupConfig,
			effectiveGroupAllow,
			senderId,
			senderUsername,
			resolveGroupPolicy,
			enforcePolicy: true,
			useTopicAndGroupOverrides: true,
			enforceAllowlistAuthorization: true,
			allowEmptyAllowlistEntries: false,
			requireSenderForAllowlistAuthorization: true,
			checkChatAllowlist: true
		});
		if (!policyAccess.allowed) {
			if (policyAccess.reason === "group-policy-disabled") {
				logVerbose("Blocked telegram group message (groupPolicy: disabled)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-no-sender") {
				logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-empty") {
				logVerbose("Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
				logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
				return true;
			}
			logger.info({
				chatId,
				title: chatTitle,
				reason: "not-allowed"
			}, "skipping group message");
			return true;
		}
		return false;
	};
	const getChat = typeof bot.api.getChat === "function" ? bot.api.getChat.bind(bot.api) : void 0;
	const TELEGRAM_EVENT_AUTH_RULES = {
		reaction: {
			enforceDirectAuthorization: true,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "reaction unauthorized by dm policy/allowlist",
			deniedGroupReason: "reaction unauthorized by group allowlist"
		},
		"callback-scope": {
			enforceDirectAuthorization: false,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "callback unauthorized by inlineButtonsScope",
			deniedGroupReason: "callback unauthorized by inlineButtonsScope"
		},
		"callback-allowlist": {
			enforceDirectAuthorization: true,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
			deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist"
		}
	};
	class TelegramRetryableCallbackError extends Error {
		constructor(cause) {
			super(String(cause));
			this.cause = cause;
			this.name = "TelegramRetryableCallbackError";
		}
	}
	const TELEGRAM_PERMANENT_CALLBACK_EDIT_ERROR_RE = /400:\s*Bad Request:\s*message to edit not found|400:\s*Bad Request:\s*there is no text in the message to edit|MESSAGE_ID_INVALID|400:\s*Bad Request:\s*message can't be edited/i;
	const isPermanentTelegramCallbackEditError = (err) => TELEGRAM_PERMANENT_CALLBACK_EDIT_ERROR_RE.test(String(err));
	const resolveTelegramEventAuthorizationContext = async (params) => {
		const groupAllowContext = params.groupAllowContext ?? await resolveTelegramGroupAllowFromContext({
			cfg,
			chatId: params.chatId,
			accountId,
			senderId: params.senderId,
			isGroup: params.isGroup,
			isForum: params.isForum,
			messageThreadId: params.messageThreadId,
			groupAllowFrom,
			readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
			resolveTelegramGroupConfig
		});
		return {
			dmPolicy: resolveTelegramEffectiveDmPolicy({
				isGroup: params.isGroup,
				groupConfig: groupAllowContext.groupConfig,
				dmPolicy: telegramCfg.dmPolicy
			}),
			...groupAllowContext
		};
	};
	const authorizeTelegramEventSender = async (params) => {
		const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
		const { dmPolicy, resolvedThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = context;
		const { enforceDirectAuthorization, enforceGroupAllowlistAuthorization, deniedDmReason, deniedGroupReason } = TELEGRAM_EVENT_AUTH_RULES[mode];
		if (shouldSkipGroupMessage({
			isGroup,
			chatId,
			chatTitle,
			resolvedThreadId,
			senderId,
			senderUsername,
			effectiveGroupAllow,
			hasGroupAllowOverride,
			groupConfig,
			topicConfig
		})) return false;
		if (!isGroup && enforceDirectAuthorization) {
			const eventAccess = await resolveTelegramEventIngressAuthorization({
				accountId,
				dmPolicy,
				isGroup,
				chatId,
				resolvedThreadId,
				senderId,
				effectiveDmAllow: normalizeDmAllowFromWithStore({
					allowFrom: await expandTelegramAllowFromWithAccessGroups({
						cfg,
						allowFrom: groupAllowOverride ?? allowFrom,
						accountId,
						senderId
					}),
					storeAllowFrom,
					dmPolicy
				}),
				effectiveGroupAllow,
				enforceGroupAuthorization: false,
				eventKind: mode === "reaction" ? "reaction" : "button"
			});
			if (eventAccess.decision !== "allow") {
				if (eventAccess.reasonCode === "dm_policy_disabled") {
					logVerbose(`Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`);
					return false;
				}
				logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
				return false;
			}
		}
		if (isGroup && enforceGroupAllowlistAuthorization) {
			if ((await resolveTelegramEventIngressAuthorization({
				accountId,
				dmPolicy,
				isGroup,
				chatId,
				resolvedThreadId,
				senderId,
				effectiveDmAllow: normalizeDmAllowFromWithStore({
					allowFrom: [],
					dmPolicy
				}),
				effectiveGroupAllow,
				enforceGroupAuthorization: true,
				eventKind: mode === "reaction" ? "reaction" : "button"
			})).decision !== "allow") {
				logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
				return false;
			}
		}
		return true;
	};
	const isTelegramModelCallbackAuthorized = async (params) => {
		const { chatId, isGroup, senderId, senderUsername, context, cfg } = params;
		const dmAllowFrom = context.groupAllowOverride ?? allowFrom;
		if (isTelegramCommandsAllowFromConfigured(cfg)) return resolveTelegramCommandAuthorization({
			cfg,
			accountId,
			chatId,
			isGroup,
			resolvedThreadId: context.resolvedThreadId,
			senderId,
			senderUsername
		}).isAuthorizedSender;
		const dmAllow = normalizeDmAllowFromWithStore({
			allowFrom: await expandTelegramAllowFromWithAccessGroups({
				cfg,
				allowFrom: dmAllowFrom,
				accountId,
				senderId
			}),
			storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
			dmPolicy: context.dmPolicy
		});
		return (await resolveTelegramCommandIngressAuthorization({
			accountId,
			cfg,
			dmPolicy: context.dmPolicy,
			isGroup,
			chatId,
			resolvedThreadId: context.resolvedThreadId,
			senderId,
			effectiveDmAllow: dmAllow,
			effectiveGroupAllow: context.effectiveGroupAllow,
			ownerAccess: {
				ownerList: [],
				senderIsOwner: false
			},
			eventKind: "button"
		})).authorized;
	};
	bot.on("message_reaction", async (ctx) => {
		try {
			const reaction = ctx.messageReaction;
			if (!reaction) return;
			if (shouldSkipUpdate(ctx)) return;
			const chatId = reaction.chat.id;
			const messageId = reaction.message_id;
			const user = reaction.user;
			const senderId = user?.id != null ? String(user.id) : "";
			const senderUsername = user?.username ?? "";
			const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
			const isForum = reaction.chat.is_forum === true;
			const reactionMode = telegramCfg.reactionNotifications ?? "own";
			if (reactionMode === "off") return;
			if (user?.is_bot) return;
			if (reactionMode === "own" && !telegramDeps.wasSentByBot(chatId, messageId, cfg)) {
				logVerbose(`telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`);
				return;
			}
			const eventAuthContext = await resolveTelegramEventAuthorizationContext({
				chatId,
				isGroup,
				isForum,
				senderId
			});
			if (!await authorizeTelegramEventSender({
				chatId,
				chatTitle: reaction.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: "reaction",
				context: eventAuthContext
			})) return;
			if (!isGroup) {
				if (eventAuthContext.groupConfig?.requireTopic === true) {
					logVerbose(`Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`);
					return;
				}
			}
			const oldEmojis = new Set(reaction.old_reaction.filter((r) => r.type === "emoji").map((r) => r.emoji));
			const addedReactions = reaction.new_reaction.filter((r) => r.type === "emoji").filter((r) => !oldEmojis.has(r.emoji));
			if (addedReactions.length === 0) return;
			const senderName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username : void 0;
			const senderUsernameLabel = user?.username ? `@${user.username}` : void 0;
			let senderLabel = senderName;
			if (senderName && senderUsernameLabel) senderLabel = `${senderName} (${senderUsernameLabel})`;
			else if (!senderName && senderUsernameLabel) senderLabel = senderUsernameLabel;
			if (!senderLabel && user?.id) senderLabel = `id:${user.id}`;
			senderLabel = senderLabel || "unknown";
			const resolvedThreadId = isForum ? resolveTelegramForumThreadId({
				isForum,
				messageThreadId: void 0
			}) : void 0;
			const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
			const parentPeer = buildTelegramParentPeer({
				isGroup,
				resolvedThreadId,
				chatId
			});
			const sessionKey = resolveAgentRoute({
				cfg: telegramDeps.getRuntimeConfig(),
				channel: "telegram",
				accountId,
				peer: {
					kind: isGroup ? "group" : "direct",
					id: peerId
				},
				parentPeer
			}).sessionKey;
			for (const r of addedReactions) {
				const emoji = r.emoji;
				const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
				telegramDeps.enqueueSystemEvent(text, {
					sessionKey,
					contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`
				});
				logVerbose(`telegram: reaction event enqueued: ${text}`);
			}
		} catch (err) {
			runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
			throw err;
		}
	});
	const processInboundMessage = async (params) => {
		const { ctx, msg, chatId, isGroup, isForum, resolvedThreadId, dmThreadId, dmPolicy, storeAllowFrom, senderId, effectiveGroupAllow, effectiveDmAllow, groupConfig, topicConfig, sendOversizeWarning, oversizeLogMessage, promptContextMinTimestampMs, dispatchDedupeKeys } = params;
		const messageText = getTelegramTextParts(msg).text;
		const botUsername = ctx.me?.username;
		const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
		let abortControlAuthorized;
		const isAuthorizedAbortControlMessage = () => {
			if (!isAbortControlMessage || !senderId) return Promise.resolve(false);
			abortControlAuthorized ??= resolveTelegramCommandIngressAuthorization({
				accountId,
				cfg,
				dmPolicy,
				isGroup,
				chatId,
				resolvedThreadId,
				senderId,
				effectiveDmAllow,
				effectiveGroupAllow,
				ownerAccess: {
					ownerList: [],
					senderIsOwner: false
				},
				eventKind: "message",
				allowTextCommands: true,
				hasControlCommand: true,
				modeWhenAccessGroupsOff: "allow",
				includeDmAllowForGroupCommands: false
			}).then((gate) => gate.authorized);
			return abortControlAuthorized;
		};
		const text = typeof msg.text === "string" ? msg.text : void 0;
		const isCommandLike = (text ?? "").trim().startsWith("/");
		if (text && !isCommandLike && !isAbortControlMessage) {
			const nowMs = Date.now();
			const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
			const key = `text:${chatId}:${resolvedThreadId ?? dmThreadId ?? "main"}:${senderId}`;
			const existing = textFragmentBuffer.get(key);
			if (existing) {
				const last = existing.messages.at(-1);
				const lastMsgId = last?.msg.message_id;
				const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
				const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
				const timeGapMs = nowMs - lastReceivedAtMs;
				if (idGap > 0 && idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP && timeGapMs >= 0 && timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS) {
					const nextTotalChars = existing.messages.reduce((sum, m) => sum + (m.msg.text?.length ?? 0), 0) + text.length;
					if (existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS && nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS) {
						existing.messages.push({
							msg,
							ctx,
							receivedAtMs: nowMs
						});
						existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(existing.promptContextMinTimestampMs, promptContextMinTimestampMs);
						existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(existing.dispatchDedupeKeys, dispatchDedupeKeys);
						scheduleTextFragmentFlush(existing);
						return;
					}
				}
				clearTimeout(existing.timer);
				textFragmentBuffer.delete(key);
				await queueTextFragmentFlush(existing);
			}
			if (text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS) {
				const entry = {
					key,
					messages: [{
						msg,
						ctx,
						receivedAtMs: nowMs
					}],
					dispatchDedupeKeys,
					...promptContextBoundaryOptions(promptContextMinTimestampMs),
					timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS)
				};
				textFragmentBuffer.set(key, entry);
				scheduleTextFragmentFlush(entry);
				return;
			}
		} else if (text && isAbortControlMessage && await isAuthorizedAbortControlMessage()) {
			const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
			const key = `text:${chatId}:${resolvedThreadId ?? dmThreadId ?? "main"}:${senderId}`;
			const existing = textFragmentBuffer.get(key);
			if (existing) {
				clearTimeout(existing.timer);
				textFragmentBuffer.delete(key);
				releaseDispatchDedupeKeys(existing.dispatchDedupeKeys);
			}
		}
		const mediaGroupId = msg.media_group_id;
		if (mediaGroupId) {
			const mediaGroupKey = `media:${chatId}:${resolvedThreadId ?? dmThreadId ?? "main"}:${mediaGroupId}`;
			const existing = mediaGroupBuffer.get(mediaGroupKey);
			if (existing) {
				clearTimeout(existing.timer);
				existing.messages.push({
					msg,
					ctx
				});
				existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(existing.promptContextMinTimestampMs, promptContextMinTimestampMs);
				existing.dispatchDedupeKeys = mergeDispatchDedupeKeys(existing.dispatchDedupeKeys, dispatchDedupeKeys);
				existing.timer = setTimeout(async () => {
					mediaGroupBuffer.delete(mediaGroupKey);
					await queueBufferedProcessing(mediaGroupProcessingByKey, mediaGroupKey, async () => {
						await processMediaGroup(existing);
					});
				}, mediaGroupTimeoutMs);
			} else {
				const entry = {
					messages: [{
						msg,
						ctx
					}],
					storeAllowFrom,
					isGroup,
					isForum,
					resolvedThreadId,
					dmThreadId,
					senderId,
					effectiveGroupAllow,
					effectiveDmAllow,
					groupConfig,
					topicConfig,
					dispatchDedupeKeys,
					...promptContextBoundaryOptions(promptContextMinTimestampMs),
					timer: setTimeout(async () => {
						mediaGroupBuffer.delete(mediaGroupKey);
						await queueBufferedProcessing(mediaGroupProcessingByKey, mediaGroupKey, async () => {
							await processMediaGroup(entry);
						});
					}, mediaGroupTimeoutMs)
				};
				mediaGroupBuffer.set(mediaGroupKey, entry);
			}
			return;
		}
		if (await shouldSkipMediaDownloadForUnaddressedMentionGroup({
			ctx,
			msg,
			chatId,
			isGroup,
			isForum,
			resolvedThreadId,
			dmThreadId,
			senderId,
			effectiveGroupAllow,
			effectiveDmAllow,
			groupConfig,
			topicConfig
		})) {
			releaseDispatchDedupeKeys(dispatchDedupeKeys);
			return;
		}
		let media = null;
		try {
			media = await resolveMedia({
				ctx,
				maxBytes: mediaMaxBytes,
				...mediaRuntimeOptions
			});
		} catch (mediaErr) {
			if (isMediaSizeLimitError(mediaErr)) {
				if (sendOversizeWarning) {
					const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						runtime,
						fn: () => bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, { reply_parameters: {
							message_id: msg.message_id,
							allow_sending_without_reply: true
						} })
					}).catch(() => {});
				}
				logger.warn({
					chatId,
					error: String(mediaErr)
				}, oversizeLogMessage);
				releaseDispatchDedupeKeys(dispatchDedupeKeys);
				return;
			}
			logger.warn({
				chatId,
				error: String(mediaErr)
			}, "media fetch failed");
			await withTelegramApiErrorLogging({
				operation: "sendMessage",
				runtime,
				fn: () => bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", { reply_parameters: {
					message_id: msg.message_id,
					allow_sending_without_reply: true
				} })
			}).catch(() => {});
			releaseDispatchDedupeKeys(dispatchDedupeKeys);
			return;
		}
		const hasText = Boolean(getTelegramTextParts(msg).text.trim());
		if (msg.sticker && !media && !hasText) {
			logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
			releaseDispatchDedupeKeys(dispatchDedupeKeys);
			return;
		}
		const allMedia = media ? [{
			path: media.path,
			contentType: media.contentType,
			stickerMetadata: media.stickerMetadata
		}] : [];
		const conversationKey = buildTelegramInboundDebounceConversationKey({
			chatId,
			threadId: resolvedThreadId ?? dmThreadId
		});
		const debounceLane = resolveTelegramDebounceLane(msg);
		const debounceKey = senderId ? buildTelegramInboundDebounceKey({
			accountId,
			conversationKey,
			senderId,
			debounceLane
		}) : null;
		if (senderId && await isAuthorizedAbortControlMessage()) for (const lane of ["default", "forward"]) inboundDebouncer.cancelKey(buildTelegramInboundDebounceKey({
			accountId,
			conversationKey,
			senderId,
			debounceLane: lane
		}));
		await inboundDebouncer.enqueue({
			ctx,
			msg,
			allMedia,
			storeAllowFrom,
			receivedAtMs: Date.now(),
			debounceKey: isAbortControlMessage ? null : debounceKey,
			debounceLane,
			botUsername,
			...promptContextBoundaryOptions(promptContextMinTimestampMs),
			dispatchDedupeKeys
		});
	};
	bot.on("callback_query", async (ctx) => {
		const callback = ctx.callbackQuery;
		if (!callback) return;
		if (shouldSkipUpdate(ctx)) return;
		await withTelegramApiErrorLogging({
			operation: "answerCallbackQuery",
			runtime,
			fn: typeof ctx.answerCallbackQuery === "function" ? () => ctx.answerCallbackQuery() : () => bot.api.answerCallbackQuery(callback.id)
		}).catch(() => {});
		try {
			const data = (callback.data ?? "").trim();
			const callbackMessage = callback.message;
			if (!data || !callbackMessage) return;
			const editCallbackMessage = async (text, params) => {
				if (typeof ctx.editMessageText === "function") return await ctx.editMessageText(text, params);
				return await bot.api.editMessageText(callbackMessage.chat.id, callbackMessage.message_id, text, params);
			};
			const clearCallbackButtons = async () => {
				const replyMarkup = { reply_markup: { inline_keyboard: [] } };
				if (typeof ctx.editMessageReplyMarkup === "function") return await ctx.editMessageReplyMarkup(replyMarkup);
				if (typeof bot.api.editMessageReplyMarkup === "function") return await bot.api.editMessageReplyMarkup(callbackMessage.chat.id, callbackMessage.message_id, replyMarkup);
				const messageText = callbackMessage.text ?? callbackMessage.caption;
				if (typeof messageText !== "string" || messageText.trim().length === 0) return;
				return await editCallbackMessage(messageText, replyMarkup);
			};
			const editCallbackButtons = async (buttons) => {
				const replyMarkup = { reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] } };
				if (typeof ctx.editMessageReplyMarkup === "function") return await ctx.editMessageReplyMarkup(replyMarkup);
				return await bot.api.editMessageReplyMarkup(callbackMessage.chat.id, callbackMessage.message_id, replyMarkup);
			};
			const deleteCallbackMessage = async () => {
				if (typeof ctx.deleteMessage === "function") return await ctx.deleteMessage();
				return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
			};
			const replyToCallbackChat = async (text, params) => {
				if (typeof ctx.reply === "function") return await ctx.reply(text, params);
				return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
			};
			const chatId = callbackMessage.chat.id;
			const isGroup = callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
			const approvalCallback = parseExecApprovalCommandText(data);
			const isApprovalCallback = approvalCallback !== null;
			const inlineButtonsScope = resolveTelegramInlineButtonsScope({
				cfg,
				accountId
			});
			const execApprovalButtonsEnabled = isApprovalCallback && shouldEnableTelegramExecApprovalButtons({
				cfg,
				accountId,
				to: String(chatId)
			});
			if (!execApprovalButtonsEnabled) {
				if (inlineButtonsScope === "off") return;
				if (inlineButtonsScope === "dm" && isGroup) return;
				if (inlineButtonsScope === "group" && !isGroup) return;
			}
			const messageThreadId = callbackMessage.message_thread_id;
			const isForum = await resolveTelegramForumFlag({
				chatId,
				chatType: callbackMessage.chat.type,
				isGroup,
				isForum: callbackMessage.chat.is_forum,
				isTopicMessage: callbackMessage.is_topic_message,
				getChat
			});
			const senderId = callback.from?.id ? String(callback.from.id) : "";
			const senderUsername = callback.from?.username ?? "";
			const eventAuthContext = await resolveTelegramEventAuthorizationContext({
				chatId,
				isGroup,
				isForum,
				senderId,
				messageThreadId
			});
			const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
			const requireTopic = groupConfig?.requireTopic;
			if (!isGroup && requireTopic === true && dmThreadId == null) {
				logVerbose(`Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`);
				return;
			}
			const authorizationMode = !isGroup || !execApprovalButtonsEnabled && inlineButtonsScope === "allowlist" ? "callback-allowlist" : "callback-scope";
			if (!await authorizeTelegramEventSender({
				chatId,
				chatTitle: callbackMessage.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: authorizationMode,
				context: eventAuthContext
			})) return;
			const callbackThreadId = resolvedThreadId ?? dmThreadId;
			const callbackConversationId = callbackThreadId != null ? `${chatId}:topic:${callbackThreadId}` : String(chatId);
			const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
			if (pluginBindingApproval) {
				let resolved;
				try {
					resolved = await resolvePluginConversationBindingApproval({
						approvalId: pluginBindingApproval.approvalId,
						decision: pluginBindingApproval.decision,
						senderId: senderId || void 0
					});
				} catch (err) {
					throw new TelegramRetryableCallbackError(err);
				}
				await clearCallbackButtons();
				await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
				return;
			}
			const runtimeCfg = telegramDeps.getRuntimeConfig();
			if ((await dispatchTelegramPluginInteractiveHandler({
				data,
				callbackId: callback.id,
				ctx: {
					accountId,
					callbackId: callback.id,
					conversationId: callbackConversationId,
					parentConversationId: callbackThreadId != null ? String(chatId) : void 0,
					senderId: senderId || void 0,
					senderUsername: senderUsername || void 0,
					threadId: callbackThreadId,
					isGroup,
					isForum,
					auth: { isAuthorizedSender: await isTelegramModelCallbackAuthorized({
						chatId,
						isGroup,
						senderId,
						senderUsername,
						context: eventAuthContext,
						cfg: runtimeCfg
					}) },
					callbackMessage: {
						messageId: callbackMessage.message_id,
						chatId: String(chatId),
						messageText: callbackMessage.text ?? callbackMessage.caption
					}
				},
				respond: {
					reply: async ({ text, buttons }) => {
						await replyToCallbackChat(text, buttons ? { reply_markup: buildInlineKeyboard(buttons) } : void 0);
					},
					editMessage: async ({ text, buttons }) => {
						await editCallbackMessage(text, buttons ? { reply_markup: buildInlineKeyboard(buttons) } : void 0);
					},
					editButtons: async ({ buttons }) => {
						await editCallbackButtons(buttons);
					},
					clearButtons: async () => {
						await clearCallbackButtons();
					},
					deleteMessage: async () => {
						await deleteCallbackMessage();
					}
				}
			})).handled) return;
			const managedSelectCallback = parseTelegramManagedSelectCallback(data);
			if (managedSelectCallback) {
				if (managedSelectCallback.type === "multi-toggle" || managedSelectCallback.type === "multi-clear") {
					const buttons = updateMultiSelectKeyboard(callbackMessage, managedSelectCallback.type === "multi-clear" ? "clear" : "toggle", managedSelectCallback.type === "multi-toggle" ? managedSelectCallback.value : "");
					if (buttons.length > 0) try {
						await editCallbackButtons(buttons);
					} catch (editErr) {
						if (!String(editErr).includes("message is not modified")) throw new TelegramRetryableCallbackError(editErr);
					}
					return;
				}
				if (managedSelectCallback.type === "multi-submit") {
					const selected = resolveMultiSelectedValues(cloneInlineKeyboardButtons(callbackMessage));
					const synthetic = buildCallbackSyntheticTextContext({
						ctx,
						callbackMessage,
						callback,
						text: `Multi-select submitted: ${selected.length > 0 ? selected.join(", ") : "none"}`,
						isForum
					});
					await processMessageWithReplyChain({
						ctx: synthetic.ctx,
						msg: synthetic.message,
						allMedia: [],
						storeAllowFrom,
						options: {
							forceWasMentioned: true,
							messageIdOverride: callback.id
						}
					});
					return;
				}
				try {
					await clearCallbackButtons();
				} catch (editErr) {
					const errStr = String(editErr);
					if (!errStr.includes("message is not modified") && !errStr.includes("there is no text in the message to edit")) throw new TelegramRetryableCallbackError(editErr);
				}
				const synthetic = buildCallbackSyntheticTextContext({
					ctx,
					callbackMessage,
					callback,
					text: `Single-select submitted: ${managedSelectCallback.value}`,
					isForum
				});
				await processMessageWithReplyChain({
					ctx: synthetic.ctx,
					msg: synthetic.message,
					allMedia: [],
					storeAllowFrom,
					options: {
						forceWasMentioned: true,
						messageIdOverride: callback.id
					}
				});
				return;
			}
			if (approvalCallback) {
				const isPluginApproval = approvalCallback.approvalId.startsWith("plugin:");
				const pluginApprovalAuthorizedSender = isTelegramExecApprovalApprover({
					cfg: runtimeCfg,
					accountId,
					senderId
				});
				const execApprovalAuthorizedSender = isTelegramExecApprovalAuthorizedSender({
					cfg: runtimeCfg,
					accountId,
					senderId
				});
				if (!(isPluginApproval ? pluginApprovalAuthorizedSender : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender)) {
					logVerbose(`Blocked telegram approval callback from ${senderId || "unknown"} (not authorized)`);
					return;
				}
				try {
					await (telegramDeps.resolveExecApproval ?? resolveTelegramExecApproval)({
						cfg: runtimeCfg,
						approvalId: approvalCallback.approvalId,
						decision: approvalCallback.decision,
						senderId,
						allowPluginFallback: pluginApprovalAuthorizedSender
					});
				} catch (resolveErr) {
					const errStr = String(resolveErr);
					logVerbose(`telegram: failed to resolve approval callback ${approvalCallback.approvalId}: ${errStr}`);
					if (isApprovalNotFoundError(resolveErr)) {
						if (isPluginApproval || pluginApprovalAuthorizedSender) try {
							await clearCallbackButtons();
						} catch (editErr) {
							logVerbose(`telegram: failed to clear expired approval callback buttons: ${String(editErr)}`);
						}
						return;
					}
					throw new TelegramRetryableCallbackError(resolveErr);
				}
				try {
					await clearCallbackButtons();
				} catch (editErr) {
					const errStr = String(editErr);
					if (errStr.includes("message is not modified") || errStr.includes("there is no text in the message to edit")) return;
					logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
				}
				return;
			}
			const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
			if (paginationMatch) {
				const pageValue = paginationMatch[1];
				if (pageValue === "noop") return;
				const page = Number.parseInt(pageValue, 10);
				if (Number.isNaN(page) || page < 1) return;
				const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(runtimeCfg);
				let result;
				try {
					result = buildCommandsMessagePaginated(runtimeCfg, telegramDeps.listSkillCommandsForAgents({
						cfg: runtimeCfg,
						agentIds: [agentId]
					}), {
						page,
						forcePaginatedList: true,
						surface: "telegram"
					});
				} catch (err) {
					throw new TelegramRetryableCallbackError(err);
				}
				const keyboard = result.totalPages > 1 ? buildInlineKeyboard(buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)) : void 0;
				try {
					await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : void 0);
				} catch (editErr) {
					if (!String(editErr).includes("message is not modified")) throw new TelegramRetryableCallbackError(editErr);
				}
				return;
			}
			const modelCallback = parseModelCallbackData(data);
			if (modelCallback) {
				if (!await isTelegramModelCallbackAuthorized({
					chatId,
					isGroup,
					senderId,
					senderUsername,
					context: eventAuthContext,
					cfg: runtimeCfg
				})) {
					logVerbose(`Blocked telegram model callback from ${senderId || "unknown"} (not authorized for /models)`);
					return;
				}
				let sessionState;
				let modelData;
				try {
					sessionState = resolveTelegramSessionState({
						chatId,
						isGroup,
						isForum,
						messageThreadId,
						resolvedThreadId,
						senderId
					});
					modelData = await telegramDeps.buildModelsProviderData(runtimeCfg, sessionState.agentId);
				} catch (err) {
					throw new TelegramRetryableCallbackError(err);
				}
				const { byProvider, providers, modelNames } = modelData;
				const editMessageWithButtons = async (text, buttons, extra) => {
					const keyboard = buildInlineKeyboard(buttons);
					const editParams = keyboard ? {
						reply_markup: keyboard,
						...extra
					} : extra;
					try {
						await editCallbackMessage(text, editParams);
					} catch (editErr) {
						const errStr = String(editErr);
						if (errStr.includes("no text in the message")) {
							try {
								await deleteCallbackMessage();
							} catch {}
							await replyToCallbackChat(text, keyboard ? {
								reply_markup: keyboard,
								...extra
							} : extra);
						} else if (!errStr.includes("message is not modified")) throw editErr;
					}
				};
				if (modelCallback.type === "providers" || modelCallback.type === "back") {
					if (providers.length === 0) {
						try {
							await editMessageWithButtons("No providers available.", []);
						} catch (err) {
							throw new TelegramRetryableCallbackError(err);
						}
						return;
					}
					const buttons = buildTelegramModelsMenuButtons({ providers: providers.map((p) => ({
						id: p,
						count: byProvider.get(p)?.size ?? 0
					})) });
					try {
						await editMessageWithButtons("Select a provider:", buttons);
					} catch (err) {
						throw new TelegramRetryableCallbackError(err);
					}
					return;
				}
				if (modelCallback.type === "list") {
					const { provider, page } = modelCallback;
					const modelSet = byProvider.get(provider);
					if (!modelSet || modelSet.size === 0) {
						const buttons = buildTelegramModelsMenuButtons({ providers: providers.map((p) => ({
							id: p,
							count: byProvider.get(p)?.size ?? 0
						})) });
						try {
							await editMessageWithButtons(`Unknown provider: ${provider}\n\nSelect a provider:`, buttons);
						} catch (err) {
							throw new TelegramRetryableCallbackError(err);
						}
						return;
					}
					const models = [...modelSet].toSorted((left, right) => left.localeCompare(right));
					const pageSize = getModelsPageSize();
					const totalPages = calculateTotalPages(models.length, pageSize);
					const safePage = Math.max(1, Math.min(page, totalPages));
					const currentModel = sessionState.model;
					const buttons = buildModelsKeyboard({
						provider,
						models,
						currentModel,
						currentPage: safePage,
						totalPages,
						pageSize,
						modelNames
					});
					const text = formatModelsAvailableHeader({
						provider,
						total: models.length,
						cfg,
						agentDir: resolveAgentDir(cfg, sessionState.agentId),
						sessionEntry: sessionState.sessionEntry
					});
					try {
						await editMessageWithButtons(text, buttons);
					} catch (err) {
						throw new TelegramRetryableCallbackError(err);
					}
					return;
				}
				if (modelCallback.type === "select") {
					const selection = resolveModelSelection({
						callback: modelCallback,
						providers,
						byProvider
					});
					if (selection.kind !== "resolved") {
						const buttons = buildTelegramModelsMenuButtons({ providers: providers.map((p) => ({
							id: p,
							count: byProvider.get(p)?.size ?? 0
						})) });
						try {
							await editMessageWithButtons(`Could not resolve model "${selection.model}".\n\nSelect a provider:`, buttons);
						} catch (err) {
							throw new TelegramRetryableCallbackError(err);
						}
						return;
					}
					if (!byProvider.get(selection.provider)?.has(selection.model)) {
						try {
							await editMessageWithButtons(`❌ Model "${selection.provider}/${selection.model}" is not allowed.`, []);
						} catch (err) {
							throw new TelegramRetryableCallbackError(err);
						}
						return;
					}
					try {
						const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, { agentId: sessionState.agentId });
						const resolvedDefault = resolveDefaultModelForAgent({
							cfg: runtimeCfg,
							agentId: sessionState.agentId
						});
						const isDefaultSelection = selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
						try {
							await updateSessionStore(storePath, (store) => {
								const sessionKey = sessionState.sessionKey;
								const entry = store[sessionKey] ?? {};
								store[sessionKey] = entry;
								applyModelOverrideToSessionEntry({
									entry,
									selection: {
										provider: selection.provider,
										model: selection.model,
										isDefault: isDefaultSelection
									}
								});
							});
						} catch (err) {
							throw new TelegramRetryableCallbackError(err);
						}
						const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
						await editMessageWithButtons(`✅ Model ${isDefaultSelection ? "reset to default" : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`}\n\n${isDefaultSelection ? "Session selection cleared. Runtime unchanged. New replies use the agent's configured default." : `Session-only model selection. Runtime unchanged. Use /model ${escapeHtml(selection.provider)}/${escapeHtml(selection.model)} --runtime &lt;runtime&gt; to switch harnesses. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default.`}`, [], { parse_mode: "HTML" });
					} catch (err) {
						if (err instanceof TelegramRetryableCallbackError) throw err;
						await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
					}
					return;
				}
				return;
			}
			const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
			const syntheticMessage = buildSyntheticTextMessage({
				base: withResolvedTelegramForumFlag(callbackMessage, isForum),
				from: callback.from,
				text: nativeCallbackCommand ?? data
			});
			await processMessageWithReplyChain({
				ctx: buildSyntheticContext(ctx, syntheticMessage),
				msg: syntheticMessage,
				allMedia: [],
				storeAllowFrom,
				options: {
					...nativeCallbackCommand ? { commandSource: "native" } : {},
					forceWasMentioned: true,
					messageIdOverride: callback.id
				}
			});
		} catch (err) {
			if (err instanceof TelegramRetryableCallbackError) {
				if (isPermanentTelegramCallbackEditError(err.cause)) {
					logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
					return;
				}
				runtime.error?.(danger(`callback handler failed: ${String(err)}`));
				throw err.cause;
			}
			runtime.error?.(danger(`callback handler failed: ${String(err)}`));
		}
	});
	bot.on("message:migrate_to_chat_id", async (ctx) => {
		try {
			const msg = ctx.message;
			if (!msg?.migrate_to_chat_id) return;
			if (shouldSkipUpdate(ctx)) return;
			const oldChatId = String(msg.chat.id);
			const newChatId = String(msg.migrate_to_chat_id);
			const chatTitle = msg.chat.title ?? "Unknown";
			runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));
			if (!resolveChannelConfigWrites({
				cfg,
				channelId: "telegram",
				accountId
			})) {
				runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
				return;
			}
			const migration = migrateTelegramGroupConfig({
				cfg: telegramDeps.getRuntimeConfig(),
				accountId,
				oldChatId,
				newChatId
			});
			if (migration.migrated) {
				runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
				migrateTelegramGroupConfig({
					cfg,
					accountId,
					oldChatId,
					newChatId
				});
				await mutateConfigFile({
					afterWrite: { mode: "auto" },
					mutate: (draft) => {
						migrateTelegramGroupConfig({
							cfg: draft,
							accountId,
							oldChatId,
							newChatId
						});
					}
				});
				runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
			} else if (migration.skippedExisting) runtime.log?.(warn(`[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`));
			else runtime.log?.(warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`));
		} catch (err) {
			runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
			throw err;
		}
	});
	const normalizeChannelPostMessage = (post) => {
		const chatId = post.chat.id;
		const syntheticFrom = post.sender_chat ? {
			id: post.sender_chat.id,
			is_bot: true,
			first_name: post.sender_chat.title || "Channel",
			username: post.sender_chat.username
		} : {
			id: chatId,
			is_bot: true,
			first_name: post.chat.title || "Channel",
			username: post.chat.username
		};
		return {
			...post,
			from: post.from ?? syntheticFrom,
			chat: {
				...post.chat,
				type: "supergroup"
			}
		};
	};
	const recordEditedMessageForReplyChain = async (ctxForDedupe, msg) => {
		if (shouldSkipUpdate(ctxForDedupe)) return;
		const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
		const isForum = await resolveTelegramForumFlag({
			chatId: msg.chat.id,
			chatType: msg.chat.type,
			isGroup,
			isForum: msg.chat.is_forum,
			isTopicMessage: msg.is_topic_message,
			getChat
		});
		const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
		const resolvedThreadId = resolveTelegramForumThreadId({
			isForum,
			messageThreadId: normalizedMsg.message_thread_id
		});
		const dmThreadId = !isGroup ? normalizedMsg.message_thread_id : void 0;
		recordMessageForReplyChain(normalizedMsg, resolvedThreadId ?? dmThreadId);
	};
	const handleInboundMessageLike = async (event) => {
		let dispatchDedupeKeys = [];
		try {
			if (shouldSkipUpdate(event.ctxForDedupe)) return;
			const { dmPolicy, resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramEventAuthorizationContext({
				chatId: event.chatId,
				isGroup: event.isGroup,
				isForum: event.isForum,
				senderId: event.senderId,
				messageThreadId: event.messageThreadId
			});
			const effectiveDmAllow = normalizeDmAllowFromWithStore({
				allowFrom: await expandTelegramAllowFromWithAccessGroups({
					cfg,
					allowFrom: groupAllowOverride ?? allowFrom,
					accountId,
					senderId: event.senderId
				}),
				storeAllowFrom,
				dmPolicy
			});
			if (event.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
				logVerbose(`Blocked telegram channel ${event.chatId} (channel disabled)`);
				return;
			}
			if (shouldSkipGroupMessage({
				isGroup: event.isGroup,
				chatId: event.chatId,
				chatTitle: event.msg.chat.title,
				resolvedThreadId,
				senderId: event.senderId,
				senderUsername: event.senderUsername,
				effectiveGroupAllow,
				hasGroupAllowOverride,
				groupConfig,
				topicConfig
			})) return;
			if (!event.isGroup && (hasInboundMedia(event.msg) || hasReplyTargetMedia(event.msg))) {
				if (!await enforceTelegramDmAccess({
					isGroup: event.isGroup,
					dmPolicy,
					msg: event.msg,
					chatId: event.chatId,
					effectiveDmAllow,
					accountId,
					bot,
					logger,
					upsertPairingRequest: telegramDeps.upsertChannelPairingRequest
				})) return;
			}
			const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(resolveTelegramSessionState({
				chatId: event.chatId,
				isGroup: event.isGroup,
				isForum: event.isForum,
				messageThreadId: event.messageThreadId,
				resolvedThreadId,
				senderId: event.senderId,
				runtimeCfg: cfg
			}).sessionEntry?.sessionStartedAt);
			const dispatchDedupe = await claimMessageDispatchDedupe(event.msg);
			if (!dispatchDedupe.process) return;
			dispatchDedupeKeys = dispatchDedupe.keys;
			recordMessageForReplyChain(event.msg, resolvedThreadId ?? dmThreadId);
			await processInboundMessage({
				ctx: event.ctx,
				msg: event.msg,
				chatId: event.chatId,
				isGroup: event.isGroup,
				isForum: event.isForum,
				resolvedThreadId,
				dmThreadId,
				dmPolicy,
				storeAllowFrom,
				senderId: event.senderId,
				effectiveGroupAllow,
				effectiveDmAllow,
				groupConfig: event.isGroup ? groupConfig : void 0,
				topicConfig,
				sendOversizeWarning: event.sendOversizeWarning,
				oversizeLogMessage: event.oversizeLogMessage,
				dispatchDedupeKeys,
				...promptContextBoundaryOptions(promptContextMinTimestampMs)
			});
		} catch (err) {
			releaseDispatchDedupeKeys(dispatchDedupeKeys, err);
			runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
		}
	};
	bot.on("message", async (ctx) => {
		const msg = ctx.message;
		if (!msg) return;
		const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
		const isForum = await resolveTelegramForumFlag({
			chatId: msg.chat.id,
			chatType: msg.chat.type,
			isGroup,
			isForum: msg.chat.is_forum,
			isTopicMessage: msg.is_topic_message,
			getChat
		});
		const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
		if (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) return;
		await handleInboundMessageLike({
			ctxForDedupe: ctx,
			ctx: buildSyntheticContext(ctx, normalizedMsg),
			msg: normalizedMsg,
			chatId: normalizedMsg.chat.id,
			isGroup,
			isForum,
			messageThreadId: normalizedMsg.message_thread_id,
			senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
			senderUsername: normalizedMsg.from?.username ?? "",
			requireConfiguredGroup: false,
			sendOversizeWarning: true,
			oversizeLogMessage: "media exceeds size limit",
			errorMessage: "handler failed"
		});
	});
	bot.on("edited_message", async (ctx) => {
		const msg = ctx.editedMessage;
		if (!msg) return;
		await recordEditedMessageForReplyChain(ctx, msg);
	});
	bot.on("channel_post", async (ctx) => {
		const post = ctx.channelPost;
		if (!post) return;
		const chatId = post.chat.id;
		const syntheticMsg = normalizeChannelPostMessage(post);
		await handleInboundMessageLike({
			ctxForDedupe: ctx,
			ctx: buildSyntheticContext(ctx, syntheticMsg),
			msg: syntheticMsg,
			chatId,
			isGroup: true,
			isForum: false,
			senderId: post.sender_chat?.id != null ? String(post.sender_chat.id) : post.from?.id != null ? String(post.from.id) : "",
			senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
			requireConfiguredGroup: true,
			sendOversizeWarning: false,
			oversizeLogMessage: "channel post media exceeds size limit",
			errorMessage: "channel_post handler failed"
		});
	});
	bot.on("edited_channel_post", async (ctx) => {
		const post = ctx.editedChannelPost;
		if (!post) return;
		await recordEditedMessageForReplyChain(ctx, normalizeChannelPostMessage(post));
	});
};
//#endregion
//#region extensions/telegram/src/bot-message-context.body.ts
let stickerVisionRuntimePromise;
let mediaUnderstandingRuntimePromise;
function loadStickerVisionRuntime() {
	stickerVisionRuntimePromise ??= import("./sticker-vision.runtime.js");
	return stickerVisionRuntimePromise;
}
function loadMediaUnderstandingRuntime() {
	mediaUnderstandingRuntimePromise ??= import("./media-understanding.runtime.js");
	return mediaUnderstandingRuntimePromise;
}
function formatAudioTranscriptForAgent(transcript) {
	return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}
function resolveSavedMediaKind(contentType) {
	const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
	if (normalized?.startsWith("audio/")) return "audio";
	if (normalized?.startsWith("image/")) return "image";
	if (normalized?.startsWith("video/")) return "video";
	return "document";
}
function formatSavedMediaPlaceholder(allMedia) {
	if (allMedia.length === 0) return;
	const kinds = allMedia.map((media) => resolveSavedMediaKind(media.contentType));
	const firstKind = kinds[0] ?? "document";
	const kind = kinds.every((candidate) => candidate === firstKind) ? firstKind : "document";
	if (allMedia.length === 1) return `<media:${kind}>`;
	if (kind === "image") return `<media:image> (${allMedia.length} images)`;
	if (kind === "video") return `<media:video> (${allMedia.length} videos)`;
	if (kind === "audio") return `<media:audio> (${allMedia.length} audio attachments)`;
	return `<media:document> (${allMedia.length} attachments)`;
}
async function resolveStickerVisionSupport$1(params) {
	try {
		const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
		return await resolveStickerVisionSupportRuntime(params);
	} catch {
		return false;
	}
}
async function resolveTelegramInboundBody(params) {
	const { cfg, primaryCtx, msg, allMedia, isGroup, chatId, accountId, senderId, senderUsername, sessionKey, resolvedThreadId, replyThreadId, originatingTo: providedOriginatingTo, routeAgentId, effectiveGroupAllow, effectiveDmAllow, groupConfig, topicConfig, requireMention, options, groupHistories, historyLimit, logger } = params;
	const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
	const mentionRegexes = buildMentionRegexes(cfg, routeAgentId);
	const messageTextParts = getTelegramTextParts(msg);
	const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, { botUsername });
	const commandGate = await resolveTelegramCommandIngressAuthorization({
		accountId: accountId ?? "default",
		cfg,
		dmPolicy: "pairing",
		isGroup,
		chatId,
		resolvedThreadId,
		senderId,
		effectiveDmAllow,
		effectiveGroupAllow,
		ownerAccess: {
			ownerList: [],
			senderIsOwner: false
		},
		eventKind: "message",
		allowTextCommands: true,
		hasControlCommand: hasControlCommandInMessage,
		modeWhenAccessGroupsOff: "allow",
		includeDmAllowForGroupCommands: false
	});
	const commandAuthorized = commandGate.authorized;
	const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : void 0;
	const originatingTo = providedOriginatingTo ?? buildTelegramInboundOriginTarget(chatId);
	const primaryMedia = resolveTelegramPrimaryMedia(msg);
	let placeholder = primaryMedia?.placeholder ?? "";
	const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
	const stickerSupportsVision = msg.sticker ? await resolveStickerVisionSupport$1({
		cfg,
		agentId: routeAgentId
	}) : false;
	const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
	if (stickerCacheHit) {
		const emoji = allMedia[0]?.stickerMetadata?.emoji;
		const setName = allMedia[0]?.stickerMetadata?.setName;
		const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
		placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
	}
	const locationData = extractTelegramLocation(msg);
	const locationText = locationData ? formatLocationText(locationData) : void 0;
	const rawText = expandTextLinks(messageTextParts.text, messageTextParts.entities).trim();
	const hasUserText = Boolean(rawText || locationText);
	let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
	if (!rawBody) rawBody = placeholder;
	if (!rawBody && allMedia.length === 0) return null;
	let bodyText = rawBody;
	if (allMedia.length === 0 && placeholder && rawBody !== placeholder) bodyText = `${primaryMedia?.fileRef.file_id ? `${placeholder} [file_id:${primaryMedia.fileRef.file_id}]` : placeholder}\n${bodyText}`.trim();
	const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));
	const disableAudioPreflight = (topicConfig?.disableAudioPreflight ?? groupConfig?.disableAudioPreflight) === true;
	const senderAllowedForAudioPreflight = !useAccessGroups || !allowForCommands.hasEntries || commandAuthorized;
	let preflightTranscript;
	if (hasAudio && !hasUserText && (!isGroup || requireMention && mentionRegexes.length > 0 && !disableAudioPreflight && senderAllowedForAudioPreflight)) try {
		const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
		preflightTranscript = await transcribeFirstAudio({
			ctx: {
				Provider: "telegram",
				Surface: "telegram",
				OriginatingChannel: "telegram",
				OriginatingTo: originatingTo,
				AccountId: accountId,
				MessageThreadId: replyThreadId,
				MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : void 0,
				MediaTypes: allMedia.length > 0 ? allMedia.map((m) => m.contentType).filter(Boolean) : void 0
			},
			cfg,
			agentDir: void 0
		});
	} catch (err) {
		logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
	}
	const audioTranscribedMediaIndex = preflightTranscript === void 0 ? void 0 : allMedia.findIndex((media) => media.contentType?.startsWith("audio/"));
	if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) bodyText = formatAudioTranscriptForAgent(preflightTranscript);
	const savedMediaPlaceholder = formatSavedMediaPlaceholder(allMedia);
	if (!hasAudio && savedMediaPlaceholder && placeholder && bodyText === placeholder) bodyText = savedMediaPlaceholder;
	if (!bodyText && allMedia.length > 0) if (hasAudio) bodyText = preflightTranscript ? formatAudioTranscriptForAgent(preflightTranscript) : "<media:audio>";
	else bodyText = savedMediaPlaceholder ?? "<media:document>";
	const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
	const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
	const computedWasMentioned = matchesMentionWithExplicit({
		text: messageTextParts.text,
		mentionRegexes,
		explicit: {
			hasAnyMention,
			isExplicitlyMentioned: explicitlyMentioned,
			canResolveExplicit: Boolean(botUsername)
		},
		transcript: preflightTranscript
	});
	const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
	if (isGroup && commandGate.shouldBlockControlCommand) {
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "control command (unauthorized)",
			target: senderId ?? "unknown"
		});
		return null;
	}
	const botId = primaryCtx.me?.id;
	const replyFromId = msg.reply_to_message?.from?.id;
	const replyToBotMessage = botId != null && replyFromId === botId;
	const isReplyToServiceMessage = replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
	const implicitMentionKinds = implicitMentionKindWhen("reply_to_bot", replyToBotMessage && !isReplyToServiceMessage);
	const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention,
			wasMentioned,
			hasAnyMention,
			implicitMentionKinds: isGroup ? implicitMentionKinds : []
		},
		policy: {
			isGroup,
			requireMention: Boolean(requireMention),
			allowTextCommands: true,
			hasControlCommand: hasControlCommandInMessage,
			commandAuthorized
		}
	});
	const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
	if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
		logger.info({
			chatId,
			reason: "no-mention"
		}, "skipping group message");
		createChannelHistoryWindow({ historyMap: groupHistories }).record({
			historyKey: historyKey ?? "",
			limit: historyLimit,
			entry: historyKey ? {
				sender: buildSenderLabel(msg, senderId || chatId),
				body: rawBody,
				timestamp: msg.date ? msg.date * 1e3 : void 0,
				messageId: typeof msg.message_id === "number" ? String(msg.message_id) : void 0
			} : null
		});
		const telegramGroupPolicy = resolveChannelGroupPolicy({
			cfg,
			channel: "telegram",
			groupId: String(chatId),
			accountId
		});
		if ((topicConfig?.ingest ?? telegramGroupPolicy.groupConfig?.ingest ?? telegramGroupPolicy.defaultConfig?.ingest) === true && sessionKey) fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "received", sessionKey, toInternalMessageReceivedContext({
			from: `telegram:group:${historyKey ?? chatId}`,
			to: originatingTo,
			content: rawBody,
			timestamp: msg.date ? msg.date * 1e3 : void 0,
			channelId: "telegram",
			accountId,
			conversationId: originatingTo,
			messageId: typeof msg.message_id === "number" ? String(msg.message_id) : void 0,
			senderId: senderId || void 0,
			senderName: buildSenderName(msg),
			senderUsername: senderUsername || void 0,
			provider: "telegram",
			surface: "telegram",
			threadId: resolvedThreadId,
			originatingChannel: "telegram",
			originatingTo,
			isGroup: true,
			groupId: `telegram:${chatId}`
		}))), "telegram: mention-skip message hook failed");
		return null;
	}
	return {
		bodyText,
		rawBody,
		historyKey,
		commandAuthorized,
		effectiveWasMentioned,
		canDetectMention,
		shouldBypassMention: mentionDecision.shouldBypassMention,
		hasControlCommand: hasControlCommandInMessage,
		...audioTranscribedMediaIndex !== void 0 && audioTranscribedMediaIndex >= 0 ? { audioTranscribedMediaIndex } : {},
		stickerCacheHit,
		locationData: locationData ?? void 0
	};
}
//#endregion
//#region extensions/telegram/src/bot-message-context.session.ts
const sessionRuntimeMethods = [
	"buildChannelInboundEventContext",
	"readSessionUpdatedAt",
	"recordInboundSession",
	"resolveInboundLastRouteSessionKey",
	"resolvePinnedMainDmOwnerFromAllowlist",
	"resolveStorePath"
];
function hasCompleteSessionRuntime(runtime) {
	return Boolean(runtime && sessionRuntimeMethods.every((method) => typeof runtime[method] === "function"));
}
async function loadTelegramMessageContextSessionRuntime(runtime) {
	if (hasCompleteSessionRuntime(runtime)) return runtime;
	return {
		...await import("./bot-message-context.session.runtime.js"),
		...runtime
	};
}
async function resolveTelegramMessageContextStorePath(params) {
	return (await loadTelegramMessageContextSessionRuntime(params.sessionRuntime)).resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
}
function replyTargetToChainEntry(replyTarget) {
	return {
		...replyTarget.id ? { messageId: replyTarget.id } : {},
		sender: replyTarget.sender,
		...replyTarget.senderId ? { senderId: replyTarget.senderId } : {},
		...replyTarget.senderUsername ? { senderUsername: replyTarget.senderUsername } : {},
		...replyTarget.body ? { body: replyTarget.body } : {},
		...replyTarget.kind === "quote" ? { isQuote: true } : {},
		...replyTarget.forwardedFrom?.from ? { forwardedFrom: replyTarget.forwardedFrom.from } : {},
		...replyTarget.forwardedFrom?.fromId ? { forwardedFromId: replyTarget.forwardedFrom.fromId } : {},
		...replyTarget.forwardedFrom?.fromUsername ? { forwardedFromUsername: replyTarget.forwardedFrom.fromUsername } : {},
		...replyTarget.forwardedFrom?.date ? { forwardedDate: replyTarget.forwardedFrom.date * 1e3 } : {}
	};
}
function stripReplyChainForwarded(entry) {
	const { forwardedFrom: _forwardedFrom, forwardedFromId: _forwardedFromId, forwardedFromUsername: _forwardedFromUsername, forwardedDate: _forwardedDate, ...withoutForwarded } = entry;
	return withoutForwarded;
}
function formatReplyChainEntry(entry, index) {
	const labels = [
		`${index + 1}. ${entry.sender ?? "unknown sender"}`,
		entry.messageId ? `id:${entry.messageId}` : void 0,
		entry.replyToId ? `reply_to:${entry.replyToId}` : void 0,
		entry.timestamp ? new Date(entry.timestamp).toISOString() : void 0
	].filter(Boolean);
	const bodyLines = [
		entry.forwardedFrom ? `[Forwarded from ${entry.forwardedFrom}${entry.forwardedDate ? ` at ${new Date(entry.forwardedDate).toISOString()}` : ""}]` : void 0,
		entry.isQuote && entry.body ? `"${entry.body}"` : entry.body,
		entry.mediaType ? `<media:${entry.mediaType}>` : void 0,
		entry.mediaPath ? `[media_path:${entry.mediaPath}]` : void 0,
		entry.mediaRef ? `[media_ref:${entry.mediaRef}]` : void 0
	].filter(Boolean);
	return `[${labels.join(" ")}]\n${bodyLines.join("\n")}`;
}
async function buildTelegramInboundContextPayload(params) {
	const { cfg, primaryCtx, msg, allMedia, replyMedia, replyChain, promptContext, isGroup, isForum, chatId, senderId, senderUsername, resolvedThreadId, dmThreadId, threadSpec, route, rawBody, bodyText, historyKey, historyLimit, groupHistories, groupConfig, topicConfig, stickerCacheHit, effectiveWasMentioned, hasControlCommand, audioTranscribedMediaIndex, commandAuthorized, locationData, options, dmAllowFrom, effectiveGroupAllow, topicName, sessionRuntime: sessionRuntimeOverride } = params;
	const replyTarget = describeReplyTarget(msg);
	const forwardOrigin = normalizeForwardedContext(msg);
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg,
		channel: "telegram",
		accountId: route.accountId
	});
	const shouldIncludeGroupSupplementalContext = (params) => {
		if (!isGroup) return true;
		const senderAllowed = effectiveGroupAllow?.hasEntries ? isSenderAllowed({
			allow: effectiveGroupAllow,
			senderId: params.senderId,
			senderUsername: params.senderUsername
		}) : true;
		return evaluateSupplementalContextVisibility({
			mode: contextVisibilityMode,
			kind: params.kind,
			senderAllowed
		}).include;
	};
	const includeReplyTarget = replyTarget ? shouldIncludeGroupSupplementalContext({
		kind: "quote",
		senderId: replyTarget.senderId,
		senderUsername: replyTarget.senderUsername
	}) : false;
	const includeForwardOrigin = forwardOrigin ? shouldIncludeGroupSupplementalContext({
		kind: "forwarded",
		senderId: forwardOrigin.fromId,
		senderUsername: forwardOrigin.fromUsername
	}) : false;
	const visibleReplyForwardedFrom = includeReplyTarget && replyTarget?.forwardedFrom ? shouldIncludeGroupSupplementalContext({
		kind: "forwarded",
		senderId: replyTarget.forwardedFrom.fromId,
		senderUsername: replyTarget.forwardedFrom.fromUsername
	}) ? replyTarget.forwardedFrom : void 0 : void 0;
	const visibleReplyTarget = includeReplyTarget && replyTarget ? {
		...replyTarget,
		forwardedFrom: visibleReplyForwardedFrom
	} : null;
	const visibleReplyTargetEntry = visibleReplyTarget ? replyTargetToChainEntry(visibleReplyTarget) : void 0;
	const visibleReplyTargetById = new Map(visibleReplyTargetEntry?.messageId ? [[visibleReplyTargetEntry.messageId, visibleReplyTargetEntry]] : []);
	const visibleReplyChain = (replyChain.length > 0 ? replyChain : visibleReplyTargetEntry ? [visibleReplyTargetEntry] : []).flatMap((entry) => {
		const visibleEntry = {
			...entry,
			...entry.messageId ? visibleReplyTargetById.get(entry.messageId) : void 0
		};
		if (!shouldIncludeGroupSupplementalContext({
			kind: "quote",
			senderId: visibleEntry.senderId,
			senderUsername: visibleEntry.senderUsername
		})) return [];
		return [visibleEntry.forwardedFrom && shouldIncludeGroupSupplementalContext({
			kind: "forwarded",
			senderId: visibleEntry.forwardedFromId,
			senderUsername: visibleEntry.forwardedFromUsername
		}) ? visibleEntry : stripReplyChainForwarded(visibleEntry)];
	});
	const visibleForwardOrigin = includeForwardOrigin ? forwardOrigin : null;
	const replySuffix = visibleReplyChain.length > 0 ? `\n\n[Reply chain - nearest first]\n${visibleReplyChain.map(formatReplyChainEntry).join("\n")}\n[/Reply chain]` : "";
	const forwardPrefix = visibleForwardOrigin ? `[Forwarded from ${visibleForwardOrigin.from}${visibleForwardOrigin.date ? ` at ${(/* @__PURE__ */ new Date(visibleForwardOrigin.date * 1e3)).toISOString()}` : ""}]\n` : "";
	const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : void 0;
	const senderName = buildSenderName(msg);
	const conversationLabel = isGroup ? groupLabel ?? `group:${chatId}` : buildSenderLabel(msg, senderId || chatId);
	const sessionRuntime = await loadTelegramMessageContextSessionRuntime(sessionRuntimeOverride);
	const storePath = await resolveTelegramMessageContextStorePath({
		cfg,
		agentId: route.agentId,
		sessionRuntime: sessionRuntimeOverride
	});
	const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
	const previousTimestamp = sessionRuntime.readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = formatInboundEnvelope({
		channel: "Telegram",
		from: conversationLabel,
		timestamp: msg.date ? msg.date * 1e3 : void 0,
		body: `${forwardPrefix}${bodyText}${replySuffix}`,
		chatType: isGroup ? "group" : "direct",
		sender: {
			name: senderName,
			username: senderUsername || void 0,
			id: senderId || void 0
		},
		previousTimestamp,
		envelope: envelopeOptions
	});
	const channelHistory = createChannelHistoryWindow({ historyMap: groupHistories });
	let combinedBody = body;
	if (isGroup && historyKey && historyLimit > 0) combinedBody = channelHistory.buildPendingContext({
		historyKey,
		limit: historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Telegram",
			from: groupLabel ?? `group:${chatId}`,
			timestamp: entry.timestamp,
			body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
			chatType: "group",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
		groupConfig,
		topicConfig
	});
	const commandBody = normalizeCommandBody(rawBody, { botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username) });
	const inboundHistory = isGroup && historyKey && historyLimit > 0 ? channelHistory.buildInboundHistory({
		historyKey,
		limit: historyLimit
	}) : void 0;
	const contextMedia = [...stickerCacheHit ? [] : allMedia, ...replyMedia];
	const replyHead = visibleReplyChain[0];
	const telegramFrom = isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`;
	const telegramTo = buildTelegramInboundOriginTarget(chatId, threadSpec);
	const locationContext = locationData ? toLocationContext(locationData) : void 0;
	const commandSource = options?.commandSource;
	const unmentionedGroupPolicy = resolveUnmentionedGroupInboundPolicy({
		cfg,
		agentId: route.agentId
	});
	const hasAbortRequest = isAbortRequestText(rawBody, { botUsername: normalizeOptionalLowercaseString(primaryCtx.me?.username) });
	const conversationKind = isGroup ? "group" : "direct";
	const inboundEventKind = classifyChannelInboundEvent({
		conversation: { kind: conversationKind },
		unmentionedGroupPolicy,
		wasMentioned: effectiveWasMentioned,
		hasControlCommand,
		hasAbortRequest,
		commandSource
	});
	const ctxPayload = sessionRuntime.buildChannelInboundEventContext({
		channel: "telegram",
		accountId: route.accountId,
		provider: "telegram",
		surface: "telegram",
		messageId: options?.messageIdOverride ?? String(msg.message_id),
		timestamp: msg.date ? msg.date * 1e3 : void 0,
		from: telegramFrom,
		sender: {
			...senderId ? { id: senderId } : {},
			name: senderName,
			username: senderUsername || void 0
		},
		conversation: {
			kind: conversationKind,
			id: String(chatId),
			label: conversationLabel,
			threadId: threadSpec.id != null ? String(threadSpec.id) : void 0,
			routePeer: {
				kind: conversationKind,
				id: String(chatId)
			}
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey,
			mainSessionKey: route.mainSessionKey
		},
		reply: {
			to: telegramTo,
			originatingTo: telegramTo,
			replyToId: replyHead?.messageId ?? visibleReplyTarget?.id,
			messageThreadId: threadSpec.id
		},
		message: {
			inboundEventKind,
			body: combinedBody,
			rawBody,
			bodyForAgent: bodyText,
			commandBody,
			envelopeFrom: conversationLabel,
			inboundHistory
		},
		access: { commands: {
			authorized: commandAuthorized,
			allowTextCommands: true,
			useAccessGroups: cfg.commands?.useAccessGroups !== false,
			authorizers: []
		} },
		command: commandSource === "native" ? {
			kind: "native",
			authorized: commandAuthorized,
			body: commandBody
		} : commandSource === "text" ? {
			kind: "text-slash",
			authorized: commandAuthorized,
			body: commandBody
		} : void 0,
		media: contextMedia.map((media, index) => ({
			path: media.path,
			url: media.path,
			contentType: media.contentType,
			transcribed: audioTranscribedMediaIndex === index
		})),
		supplemental: {
			quote: replyHead || visibleReplyTarget ? {
				id: replyHead?.messageId ?? visibleReplyTarget?.id,
				body: replyHead?.body ?? visibleReplyTarget?.body,
				sender: replyHead?.sender ?? visibleReplyTarget?.sender,
				senderAllowed: true,
				isQuote: replyHead?.isQuote ?? (visibleReplyTarget?.kind === "quote" ? true : void 0)
			} : void 0,
			forwarded: visibleForwardOrigin ? {
				from: visibleForwardOrigin.from,
				fromType: visibleForwardOrigin.fromType,
				fromId: visibleForwardOrigin.fromId,
				date: visibleForwardOrigin.date ? visibleForwardOrigin.date * 1e3 : void 0,
				senderAllowed: true
			} : void 0,
			groupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
			untrustedContext: promptContext.length > 0 ? promptContext : void 0
		},
		contextVisibility: contextVisibilityMode,
		extra: {
			BotUsername: primaryCtx.me?.username ?? void 0,
			GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
			ReplyChain: visibleReplyChain.length > 0 ? visibleReplyChain : void 0,
			ReplyToIsExternal: visibleReplyTarget?.source === "external_reply" ? true : void 0,
			ReplyToQuoteText: visibleReplyTarget?.quoteText,
			ReplyToQuotePosition: visibleReplyTarget?.quotePosition,
			ReplyToQuoteEntities: visibleReplyTarget?.quoteEntities,
			ReplyToQuoteSourceText: visibleReplyTarget?.quoteSourceText,
			ReplyToQuoteSourceEntities: visibleReplyTarget?.quoteSourceEntities,
			ReplyToForwardedFrom: visibleReplyTarget?.forwardedFrom?.from,
			ReplyToForwardedFromType: visibleReplyTarget?.forwardedFrom?.fromType,
			ReplyToForwardedFromId: visibleReplyTarget?.forwardedFrom?.fromId,
			ReplyToForwardedFromUsername: visibleReplyTarget?.forwardedFrom?.fromUsername,
			ReplyToForwardedFromTitle: visibleReplyTarget?.forwardedFrom?.fromTitle,
			ReplyToForwardedDate: visibleReplyTarget?.forwardedFrom?.date ? visibleReplyTarget.forwardedFrom.date * 1e3 : void 0,
			ForwardedFromUsername: visibleForwardOrigin?.fromUsername,
			ForwardedFromTitle: visibleForwardOrigin?.fromTitle,
			ForwardedFromSignature: visibleForwardOrigin?.fromSignature,
			ForwardedFromChatType: visibleForwardOrigin?.fromChatType,
			ForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
			WasMentioned: isGroup ? effectiveWasMentioned : void 0,
			Sticker: allMedia[0]?.stickerMetadata,
			StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : void 0,
			...locationContext,
			IsForum: isForum,
			TopicName: isForum && topicName ? topicName : void 0
		}
	});
	if (inboundEventKind === "room_event" && historyKey) channelHistory.record({
		historyKey,
		limit: historyLimit,
		entry: {
			sender: buildSenderLabel(msg, senderId || chatId),
			body: rawBody,
			timestamp: msg.date ? msg.date * 1e3 : void 0,
			messageId: typeof msg.message_id === "number" ? String(msg.message_id) : void 0
		}
	});
	const pinnedMainDmOwner = !isGroup ? sessionRuntime.resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: cfg.session?.dmScope,
		allowFrom: dmAllowFrom,
		normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0]
	}) : null;
	const updateLastRouteSessionKey = sessionRuntime.resolveInboundLastRouteSessionKey({
		route,
		sessionKey: route.sessionKey
	});
	const shouldPersistGroupLastRouteThread = isGroup && route.matchedBy !== "binding.channel";
	const updateLastRouteThreadId = isGroup ? shouldPersistGroupLastRouteThread && resolvedThreadId != null ? String(resolvedThreadId) : void 0 : dmThreadId != null ? String(dmThreadId) : void 0;
	const updateLastRoute = !isGroup || updateLastRouteThreadId != null ? {
		sessionKey: updateLastRouteSessionKey,
		channel: "telegram",
		to: isGroup && updateLastRouteThreadId != null ? `telegram:${chatId}:topic:${updateLastRouteThreadId}` : `telegram:${chatId}`,
		accountId: route.accountId,
		threadId: updateLastRouteThreadId,
		mainDmOwnerPin: !isGroup && updateLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner && senderId ? {
			ownerRecipient: pinnedMainDmOwner,
			senderRecipient: senderId,
			onSkip: (skipParams) => {
				logVerbose(`telegram: skip main-session last route for ${skipParams.senderRecipient} (pinned owner ${skipParams.ownerRecipient})`);
			}
		} : void 0
	} : void 0;
	if (visibleReplyTarget && shouldLogVerbose()) {
		const preview = (visibleReplyTarget.body ?? "").replace(/\s+/g, " ").slice(0, 120);
		logVerbose(`telegram reply-context: replyToId=${visibleReplyTarget.id} replyToSender=${visibleReplyTarget.sender} replyToBody="${preview}"`);
	}
	if (visibleForwardOrigin && shouldLogVerbose()) logVerbose(`telegram forward-context: forwardedFrom="${visibleForwardOrigin.from}" type=${visibleForwardOrigin.fromType}`);
	if (shouldLogVerbose()) {
		const preview = body.slice(0, 200).replace(/\n/g, "\\n");
		const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
		const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
		logVerbose(`telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`);
	}
	return {
		ctxPayload,
		skillFilter,
		turn: {
			storePath,
			recordInboundSession: sessionRuntime.recordInboundSession,
			record: {
				updateLastRoute,
				onRecordError: (err) => {
					logVerbose(`telegram: failed updating session meta: ${String(err)}`);
				}
			}
		}
	};
}
//#endregion
//#region extensions/telegram/src/status-reaction-variants.ts
const TELEGRAM_GENERIC_REACTION_FALLBACKS = [
	"👍",
	"👀",
	"🔥"
];
const TELEGRAM_SUPPORTED_REACTION_EMOJIS = new Set([
	"❤",
	"👍",
	"👎",
	"🔥",
	"🥰",
	"👏",
	"😁",
	"🤔",
	"🤯",
	"😱",
	"🤬",
	"😢",
	"🎉",
	"🤩",
	"🤮",
	"💩",
	"🙏",
	"👌",
	"🕊",
	"🤡",
	"🥱",
	"🥴",
	"😍",
	"🐳",
	"❤‍🔥",
	"🌚",
	"🌭",
	"💯",
	"🤣",
	"⚡",
	"🍌",
	"🏆",
	"💔",
	"🤨",
	"😐",
	"🍓",
	"🍾",
	"💋",
	"🖕",
	"😈",
	"😴",
	"😭",
	"🤓",
	"👻",
	"👨‍💻",
	"👀",
	"🎃",
	"🙈",
	"😇",
	"😨",
	"🤝",
	"✍",
	"🤗",
	"🫡",
	"🎅",
	"🎄",
	"☃",
	"💅",
	"🤪",
	"🗿",
	"🆒",
	"💘",
	"🙉",
	"🦄",
	"😘",
	"💊",
	"🙊",
	"😎",
	"👾",
	"🤷‍♂",
	"🤷",
	"🤷‍♀",
	"😡"
]);
const TELEGRAM_STATUS_REACTION_VARIANTS = {
	queued: [
		"👀",
		"👍",
		"🔥"
	],
	thinking: [
		"🤔",
		"🤓",
		"👀"
	],
	tool: [
		"🔥",
		"⚡",
		"👍"
	],
	coding: [
		"👨‍💻",
		"🔥",
		"⚡"
	],
	web: [
		"⚡",
		"🔥",
		"👍"
	],
	deploy: [
		"🔥",
		"⚡",
		"👍"
	],
	build: [
		"🔥",
		"👨‍💻",
		"⚡"
	],
	concierge: [
		"👀",
		"🔥",
		"⚡"
	],
	done: [
		"👍",
		"🎉",
		"💯"
	],
	error: [
		"😱",
		"😨",
		"🤯"
	],
	stallSoft: [
		"🥱",
		"😴",
		"🤔"
	],
	stallHard: [
		"😨",
		"😱",
		"⚡"
	],
	compacting: [
		"✍",
		"🤔",
		"🤯"
	]
};
const STATUS_REACTION_EMOJI_KEYS = [
	"queued",
	"thinking",
	"tool",
	"coding",
	"web",
	"deploy",
	"build",
	"concierge",
	"done",
	"error",
	"stallSoft",
	"stallHard",
	"compacting"
];
function toUniqueNonEmpty(values) {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
function resolveTelegramStatusReactionEmojis(params) {
	const { overrides } = params;
	const queuedFallback = normalizeOptionalString(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
	return {
		queued: normalizeOptionalString(overrides?.queued) ?? queuedFallback,
		thinking: normalizeOptionalString(overrides?.thinking) ?? DEFAULT_EMOJIS.thinking,
		tool: normalizeOptionalString(overrides?.tool) ?? DEFAULT_EMOJIS.tool,
		coding: normalizeOptionalString(overrides?.coding) ?? DEFAULT_EMOJIS.coding,
		web: normalizeOptionalString(overrides?.web) ?? DEFAULT_EMOJIS.web,
		deploy: normalizeOptionalString(overrides?.deploy) ?? DEFAULT_EMOJIS.deploy,
		build: normalizeOptionalString(overrides?.build) ?? DEFAULT_EMOJIS.build,
		concierge: normalizeOptionalString(overrides?.concierge) ?? DEFAULT_EMOJIS.concierge,
		done: normalizeOptionalString(overrides?.done) ?? DEFAULT_EMOJIS.done,
		error: normalizeOptionalString(overrides?.error) ?? DEFAULT_EMOJIS.error,
		stallSoft: normalizeOptionalString(overrides?.stallSoft) ?? DEFAULT_EMOJIS.stallSoft,
		stallHard: normalizeOptionalString(overrides?.stallHard) ?? DEFAULT_EMOJIS.stallHard,
		compacting: normalizeOptionalString(overrides?.compacting) ?? DEFAULT_EMOJIS.compacting
	};
}
function buildTelegramStatusReactionVariants(emojis) {
	const variantsByRequested = /* @__PURE__ */ new Map();
	for (const key of STATUS_REACTION_EMOJI_KEYS) {
		const requested = normalizeOptionalString(emojis[key]);
		if (!requested) continue;
		const candidates = toUniqueNonEmpty([requested, ...TELEGRAM_STATUS_REACTION_VARIANTS[key] ?? []]);
		variantsByRequested.set(requested, candidates);
	}
	return variantsByRequested;
}
function isTelegramSupportedReactionEmoji(emoji) {
	return TELEGRAM_SUPPORTED_REACTION_EMOJIS.has(emoji);
}
function extractTelegramAllowedEmojiReactions(chat) {
	if (!chat) return;
	const availableReactions = chat.available_reactions;
	if (availableReactions === void 0) return;
	if (availableReactions == null) return null;
	if (!Array.isArray(availableReactions)) return /* @__PURE__ */ new Set();
	const allowed = /* @__PURE__ */ new Set();
	for (const reaction of availableReactions) {
		if (reaction.type !== "emoji") continue;
		const emoji = reaction.emoji.trim();
		if (emoji && isTelegramSupportedReactionEmoji(emoji)) allowed.add(emoji);
	}
	return allowed;
}
async function resolveTelegramAllowedEmojiReactions(params) {
	const fromMessage = extractTelegramAllowedEmojiReactions(params.chat);
	if (fromMessage !== void 0) return fromMessage;
	if (params.getChat) try {
		const fromLookup = extractTelegramAllowedEmojiReactions(await params.getChat(params.chatId));
		if (fromLookup !== void 0) return fromLookup;
	} catch {
		return null;
	}
	return null;
}
function resolveTelegramReactionVariant(params) {
	const requestedEmoji = normalizeOptionalString(params.requestedEmoji);
	if (!requestedEmoji) return;
	const variants = toUniqueNonEmpty([...params.variantsByRequestedEmoji.get(requestedEmoji) ?? [requestedEmoji], ...TELEGRAM_GENERIC_REACTION_FALLBACKS]);
	for (const candidate of variants) {
		if (!isTelegramSupportedReactionEmoji(candidate)) continue;
		if (params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(candidate)) return candidate;
	}
}
//#endregion
//#region extensions/telegram/src/topic-name-cache.ts
const MAX_ENTRIES = 2048;
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_KEY = "__default__";
function createTopicNameStore() {
	return /* @__PURE__ */ new Map();
}
function createTopicNameStoreState() {
	return {
		lastUpdatedAt: 0,
		store: createTopicNameStore()
	};
}
function getTopicNameCacheState() {
	const globalStore = globalThis;
	const existing = globalStore[TOPIC_NAME_CACHE_STATE_KEY];
	if (existing) return existing;
	const state = { stores: /* @__PURE__ */ new Map() };
	globalStore[TOPIC_NAME_CACHE_STATE_KEY] = state;
	return state;
}
function cacheKey(chatId, threadId) {
	return `${chatId}:${threadId}`;
}
function resolveTopicNameCachePath(storePath) {
	return `${storePath}.telegram-topic-names.json`;
}
function evictOldest(store) {
	if (store.size <= MAX_ENTRIES) return;
	let oldestKey;
	let oldestTime = Infinity;
	for (const [key, entry] of store) if (entry.updatedAt < oldestTime) {
		oldestTime = entry.updatedAt;
		oldestKey = key;
	}
	if (oldestKey) store.delete(oldestKey);
}
function isTopicEntry(value) {
	if (!value || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.name === "string" && entry.name.length > 0 && typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt);
}
function readPersistedTopicNames(persistedPath) {
	if (!fs.existsSync(persistedPath)) return createTopicNameStore();
	try {
		const raw = fs.readFileSync(persistedPath, "utf-8");
		const parsed = JSON.parse(raw);
		const entries = Object.entries(parsed).filter((entry) => isTopicEntry(entry[1])).toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, MAX_ENTRIES);
		return new Map(entries);
	} catch (error) {
		logVerbose(`telegram: failed to read topic-name cache: ${String(error)}`);
		return createTopicNameStore();
	}
}
function getTopicStoreState(persistedPath) {
	const state = getTopicNameCacheState();
	const stateKey = persistedPath ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
	const existing = state.stores.get(stateKey);
	if (existing) return existing;
	const next = persistedPath ? {
		lastUpdatedAt: 0,
		store: readPersistedTopicNames(persistedPath)
	} : createTopicNameStoreState();
	next.lastUpdatedAt = Math.max(0, ...Array.from(next.store.values(), (entry) => entry.updatedAt));
	state.stores.set(stateKey, next);
	return next;
}
function getTopicStore(persistedPath) {
	return getTopicStoreState(persistedPath).store;
}
function nextUpdatedAt(persistedPath) {
	const state = getTopicStoreState(persistedPath);
	const now = Date.now();
	state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
	return state.lastUpdatedAt;
}
function persistTopicStore(persistedPath, store) {
	if (store.size === 0) {
		fs.rmSync(persistedPath, { force: true });
		return;
	}
	replaceFileAtomicSync({
		filePath: persistedPath,
		content: JSON.stringify(Object.fromEntries(store)),
		tempPrefix: ".telegram-topic-name-cache"
	});
}
function updateTopicName(chatId, threadId, patch, persistedPath) {
	const cache = getTopicStore(persistedPath);
	const key = cacheKey(chatId, threadId);
	const existing = cache.get(key);
	const merged = {
		name: patch.name ?? existing?.name ?? "",
		iconColor: patch.iconColor ?? existing?.iconColor,
		iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
		closed: patch.closed ?? existing?.closed,
		updatedAt: nextUpdatedAt(persistedPath)
	};
	if (!merged.name) return;
	cache.set(key, merged);
	evictOldest(cache);
	if (persistedPath) try {
		persistTopicStore(persistedPath, cache);
	} catch (error) {
		logVerbose(`telegram: failed to persist topic-name cache: ${String(error)}`);
	}
}
function getTopicName(chatId, threadId, persistedPath) {
	const entry = getTopicStore(persistedPath).get(cacheKey(chatId, threadId));
	if (entry) entry.updatedAt = nextUpdatedAt(persistedPath);
	return entry?.name;
}
//#endregion
//#region extensions/telegram/src/bot-message-context.ts
let telegramMessageContextRuntimePromise;
async function loadTelegramMessageContextRuntime() {
	telegramMessageContextRuntimePromise ??= import("./bot-message-context.runtime.js");
	return await telegramMessageContextRuntimePromise;
}
const buildTelegramMessageContext = async ({ primaryCtx, allMedia, replyMedia = [], replyChain = [], promptContext = [], storeAllowFrom, options, bot, cfg, account, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, loadFreshConfig, runtime, sessionRuntime, upsertPairingRequest, sendChatActionHandler }) => {
	const msg = primaryCtx.message;
	const chatId = msg.chat.id;
	const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
	const senderId = msg.from?.id ? String(msg.from.id) : "";
	const messageThreadId = msg.message_thread_id;
	const reactionApi = typeof bot.api.setMessageReaction === "function" ? bot.api.setMessageReaction.bind(bot.api) : null;
	const getChatApi = typeof bot.api.getChat === "function" ? bot.api.getChat.bind(bot.api) : void 0;
	const isForum = await resolveTelegramForumFlag({
		chatId,
		chatType: msg.chat.type,
		isGroup,
		isForum: extractTelegramForumFlag(msg.chat),
		isTopicMessage: msg.is_topic_message,
		getChat: getChatApi
	});
	const threadSpec = resolveTelegramThreadSpec({
		isGroup,
		isForum,
		messageThreadId
	});
	const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : void 0;
	const replyThreadId = threadSpec.id;
	const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
	let topicName;
	if (isForum && resolvedThreadId != null) {
		const topicNameCachePath = resolveTopicNameCachePath(await resolveTelegramMessageContextStorePath({
			cfg,
			agentId: account.accountId,
			sessionRuntime
		}));
		const ftCreated = msg.forum_topic_created;
		const ftEdited = msg.forum_topic_edited;
		const ftClosed = msg.forum_topic_closed;
		const ftReopened = msg.forum_topic_reopened;
		const topicPatch = ftCreated?.name ? {
			name: ftCreated.name,
			iconColor: ftCreated.icon_color,
			iconCustomEmojiId: ftCreated.icon_custom_emoji_id,
			closed: false
		} : ftEdited?.name ? {
			name: ftEdited.name,
			iconCustomEmojiId: ftEdited.icon_custom_emoji_id
		} : ftClosed ? { closed: true } : ftReopened ? { closed: false } : void 0;
		if (topicPatch) updateTopicName(chatId, resolvedThreadId, topicPatch, topicNameCachePath);
		topicName = getTopicName(chatId, resolvedThreadId, topicNameCachePath);
		if (!topicName) {
			const replyFtCreated = msg.reply_to_message?.forum_topic_created;
			if (replyFtCreated?.name) {
				updateTopicName(chatId, resolvedThreadId, {
					name: replyFtCreated.name,
					iconColor: replyFtCreated.icon_color,
					iconCustomEmojiId: replyFtCreated.icon_custom_emoji_id
				}, topicNameCachePath);
				topicName = replyFtCreated.name;
			}
		}
	}
	const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId ?? dmThreadId);
	const directConfig = !isGroup ? groupConfig : void 0;
	const telegramGroupConfig = isGroup ? groupConfig : void 0;
	const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
		isGroup,
		groupConfig,
		dmPolicy
	});
	const freshCfg = loadFreshConfig?.() ?? (runtime?.getRuntimeConfig ?? (await loadTelegramMessageContextRuntime()).getRuntimeConfig)();
	const telegramCfg = mergeTelegramAccountConfig(freshCfg, account.accountId);
	let { route, configuredBinding, configuredBindingSessionKey } = resolveTelegramConversationRoute({
		cfg: freshCfg,
		accountId: account.accountId,
		chatId,
		isGroup,
		resolvedThreadId,
		replyThreadId,
		senderId,
		topicAgentId: topicConfig?.agentId
	});
	const requiresExplicitAccountBinding = (candidate) => normalizeAccountId(candidate.accountId) !== normalizeAccountId(resolveDefaultTelegramAccountId(freshCfg)) && candidate.matchedBy === "default";
	if (requiresExplicitAccountBinding(route) && isGroup) {
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "non-default account requires explicit binding",
			target: route.accountId
		});
		return null;
	}
	const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
	const dmAllow = await resolveTelegramDmAllow({
		cfg: freshCfg,
		groupAllowOverride,
		allowFrom,
		accountId: account.accountId,
		senderId,
		storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const effectiveGroupAllow = normalizeAllowFrom(await expandTelegramAllowFromWithAccessGroups({
		cfg: freshCfg,
		allowFrom: groupAllowOverride ?? groupAllowFrom,
		accountId: account.accountId,
		senderId
	}));
	const hasGroupAllowOverride = groupAllowOverride !== void 0;
	const senderUsername = msg.from?.username ?? "";
	const baseAccess = evaluateTelegramGroupBaseAccess({
		isGroup,
		groupConfig,
		topicConfig,
		hasGroupAllowOverride,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		enforceAllowOverride: true,
		requireSenderForAllowOverride: false
	});
	if (!baseAccess.allowed) {
		if (baseAccess.reason === "group-disabled") {
			logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
			return null;
		}
		if (baseAccess.reason === "topic-disabled") {
			logVerbose(`Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`);
			return null;
		}
		logVerbose(isGroup ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)` : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`);
		return null;
	}
	const requireTopic = directConfig?.requireTopic;
	if (!isGroup && requireTopic === true && dmThreadId == null) {
		logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
		return null;
	}
	const sendTyping = async () => {
		await withTelegramApiErrorLogging({
			operation: "sendChatAction",
			fn: () => sendChatActionHandler.sendChatAction(chatId, "typing", buildTypingThreadParams(replyThreadId))
		});
	};
	const sendRecordVoice = async () => {
		try {
			await withTelegramApiErrorLogging({
				operation: "sendChatAction",
				fn: () => sendChatActionHandler.sendChatAction(chatId, "record_voice", buildTypingThreadParams(replyThreadId))
			});
		} catch (err) {
			logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
		}
	};
	if (!await enforceTelegramDmAccess({
		isGroup,
		dmPolicy: effectiveDmPolicy,
		msg,
		chatId,
		effectiveDmAllow: dmAllow.effectiveAllow,
		accountId: account.accountId,
		bot,
		logger,
		upsertPairingRequest
	})) return null;
	const ensureConfiguredBindingReady = async () => {
		if (!configuredBinding) return true;
		const ensured = await (runtime?.ensureConfiguredBindingRouteReady ?? (await loadTelegramMessageContextRuntime()).ensureConfiguredBindingRouteReady)({
			cfg: freshCfg,
			bindingResolution: configuredBinding
		});
		if (ensured.ok) {
			logVerbose(`telegram: using configured ACP binding for ${configuredBinding.record.conversation.conversationId} -> ${configuredBindingSessionKey}`);
			return true;
		}
		logVerbose(`telegram: configured ACP binding unavailable for ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`);
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "configured ACP binding unavailable",
			target: configuredBinding.record.conversation.conversationId
		});
		return false;
	};
	const baseSessionKey = resolveTelegramConversationBaseSessionKey({
		cfg: freshCfg,
		route,
		chatId,
		isGroup,
		senderId
	});
	const sessionKey = (shouldUseTelegramDmThreadSession({
		dmThreadId,
		accountConfig: telegramCfg,
		directConfig,
		topicConfig
	}) && dmThreadId != null ? resolveThreadSessionKeys({
		baseSessionKey,
		threadId: `${chatId}:${dmThreadId}`
	}) : null)?.sessionKey ?? baseSessionKey;
	route = {
		...route,
		sessionKey,
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey,
			mainSessionKey: route.mainSessionKey
		})
	};
	const activationOverride = resolveGroupActivation({
		chatId,
		messageThreadId: resolvedThreadId,
		sessionKey,
		agentId: route.agentId
	});
	const baseRequireMention = resolveGroupRequireMention(chatId);
	const requireMention = firstDefined(topicConfig?.requireMention, activationOverride, telegramGroupConfig?.requireMention, baseRequireMention);
	(runtime?.recordChannelActivity ?? (await loadTelegramMessageContextRuntime()).recordChannelActivity)({
		channel: "telegram",
		accountId: account.accountId,
		direction: "inbound"
	});
	const originatingTo = buildTelegramInboundOriginTarget(chatId, threadSpec);
	const bodyResult = await resolveTelegramInboundBody({
		cfg,
		primaryCtx,
		msg,
		allMedia,
		isGroup,
		chatId,
		accountId: account.accountId,
		senderId,
		senderUsername,
		resolvedThreadId,
		replyThreadId,
		originatingTo,
		routeAgentId: route.agentId,
		sessionKey,
		effectiveGroupAllow,
		effectiveDmAllow: dmAllow.effectiveAllow,
		groupConfig,
		topicConfig,
		requireMention,
		options,
		groupHistories,
		historyLimit,
		logger
	});
	if (!bodyResult) return null;
	if (!await ensureConfiguredBindingReady()) return null;
	const { ctxPayload, skillFilter, turn } = await buildTelegramInboundContextPayload({
		cfg,
		primaryCtx,
		msg,
		allMedia,
		replyMedia,
		replyChain,
		promptContext,
		isGroup,
		isForum,
		chatId,
		senderId,
		senderUsername,
		resolvedThreadId,
		dmThreadId,
		threadSpec,
		route,
		rawBody: bodyResult.rawBody,
		bodyText: bodyResult.bodyText,
		historyKey: bodyResult.historyKey ?? "",
		historyLimit,
		groupHistories,
		groupConfig,
		topicConfig,
		stickerCacheHit: bodyResult.stickerCacheHit,
		effectiveWasMentioned: bodyResult.effectiveWasMentioned,
		hasControlCommand: bodyResult.hasControlCommand,
		...bodyResult.audioTranscribedMediaIndex !== void 0 ? { audioTranscribedMediaIndex: bodyResult.audioTranscribedMediaIndex } : {},
		locationData: bodyResult.locationData,
		options,
		dmAllowFrom: dmAllow.allowFrom,
		effectiveGroupAllow,
		commandAuthorized: bodyResult.commandAuthorized,
		topicName,
		sessionRuntime
	});
	const canShowStatusReaction = ctxPayload.InboundEventKind !== "room_event";
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "telegram",
		accountId: account.accountId
	});
	const ackReactionEmoji = ackReaction && isTelegramSupportedReactionEmoji(ackReaction) ? ackReaction : void 0;
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const shouldSendAckReaction = Boolean(canShowStatusReaction && ackReaction && shouldAckReaction({
		scope: ackReactionScope,
		isDirect: !isGroup,
		isGroup,
		isMentionableGroup: isGroup,
		requireMention: Boolean(requireMention),
		canDetectMention: bodyResult.canDetectMention,
		effectiveWasMentioned: bodyResult.effectiveWasMentioned,
		shouldBypassMention: bodyResult.shouldBypassMention
	}));
	const statusReactionsConfig = cfg.messages?.statusReactions;
	const statusReactionsEnabled = statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldSendAckReaction;
	const resolvedStatusReactionEmojis = statusReactionsEnabled ? resolveTelegramStatusReactionEmojis({
		initialEmoji: ackReaction,
		overrides: statusReactionsConfig?.emojis
	}) : null;
	const statusReactionVariantsByEmoji = resolvedStatusReactionEmojis ? buildTelegramStatusReactionVariants(resolvedStatusReactionEmojis) : /* @__PURE__ */ new Map();
	let allowedStatusReactionEmojisPromise = null;
	const createStatusReactionController = statusReactionsEnabled && resolvedStatusReactionEmojis && msg.message_id ? runtime?.createStatusReactionController ?? (await loadTelegramMessageContextRuntime()).createStatusReactionController : null;
	const statusReactionController = createStatusReactionController ? createStatusReactionController({
		enabled: true,
		adapter: { setReaction: async (emoji) => {
			if (reactionApi) {
				if (!allowedStatusReactionEmojisPromise) allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
					chat: msg.chat,
					chatId,
					getChat: getChatApi ?? void 0
				}).catch((err) => {
					logVerbose(`telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`);
					return null;
				});
				const resolvedEmoji = resolveTelegramReactionVariant({
					requestedEmoji: emoji,
					variantsByRequestedEmoji: statusReactionVariantsByEmoji,
					allowedEmojiReactions: await allowedStatusReactionEmojisPromise
				});
				if (!resolvedEmoji) return;
				await reactionApi(chatId, msg.message_id, [{
					type: "emoji",
					emoji: resolvedEmoji
				}]);
			}
		} },
		initialEmoji: ackReaction,
		emojis: resolvedStatusReactionEmojis ?? void 0,
		timing: statusReactionsConfig?.timing,
		onError: (err) => {
			logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
		}
	}) : null;
	const ackReactionPromise = statusReactionController ? shouldSendAckReaction ? Promise.resolve(statusReactionController.setQueued()).then(() => true, () => false) : null : shouldSendAckReaction && msg.message_id && reactionApi && ackReactionEmoji ? withTelegramApiErrorLogging({
		operation: "setMessageReaction",
		fn: () => reactionApi(chatId, msg.message_id, [{
			type: "emoji",
			emoji: ackReactionEmoji
		}])
	}).then(() => true, (err) => {
		logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
		return false;
	}) : null;
	return {
		ctxPayload,
		turn,
		primaryCtx,
		msg,
		chatId,
		isGroup,
		groupConfig,
		topicConfig,
		resolvedThreadId,
		threadSpec,
		replyThreadId,
		isForum,
		historyKey: bodyResult.historyKey ?? "",
		historyLimit,
		groupHistories,
		route,
		skillFilter,
		sendTyping,
		sendRecordVoice,
		ackReactionPromise,
		reactionApi,
		removeAckAfterReply,
		statusReactionController,
		accountId: account.accountId
	};
};
//#endregion
//#region extensions/telegram/src/agent-config.ts
const DEFAULT_AGENT_ID = "main";
function normalizeAgentId(value) {
	return (value ?? "").trim().toLowerCase() || DEFAULT_AGENT_ID;
}
function resolveTelegramConfigReasoningDefault(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	return cfg.agents?.list?.find((entry) => normalizeAgentId(entry?.id) === id)?.reasoningDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
//#endregion
//#region extensions/telegram/src/bot-message-dispatch.media-dedup.ts
function deduplicateBlockSentMedia(payload, sentBlockMediaUrls) {
	if (!payload.mediaUrls?.length || sentBlockMediaUrls.size === 0) return payload;
	const remainingMedia = payload.mediaUrls.filter((url) => !sentBlockMediaUrls.has(url));
	if (remainingMedia.length === payload.mediaUrls.length) return payload;
	if (remainingMedia.length === 0 && !payload.text) return;
	return {
		...payload,
		mediaUrls: remainingMedia,
		mediaUrl: remainingMedia.length === 0 ? void 0 : payload.mediaUrl
	};
}
//#endregion
//#region extensions/telegram/src/bot-message-dispatch.media.ts
function pruneStickerMediaFromContext(ctxPayload, opts) {
	if (opts?.stickerMediaIncluded === false) return;
	const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths) ? ctxPayload.MediaPaths.slice(1) : void 0;
	const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls) ? ctxPayload.MediaUrls.slice(1) : void 0;
	const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes) ? ctxPayload.MediaTypes.slice(1) : void 0;
	ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : void 0;
	ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : void 0;
	ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : void 0;
	ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
	ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
	ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}
//#endregion
//#region extensions/telegram/src/auto-topic-label-config.ts
const AUTO_TOPIC_LABEL_DEFAULT_PROMPT = "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the user's first message below. No emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the topic name, nothing else.";
function resolveAutoTopicLabelConfig(directConfig, accountConfig) {
	const config = directConfig ?? accountConfig;
	if (config === void 0 || config === true) return {
		enabled: true,
		prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT
	};
	if (config === false || config.enabled === false) return null;
	return {
		enabled: true,
		prompt: config.prompt?.trim() || "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the user's first message below. No emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the topic name, nothing else."
	};
}
//#endregion
//#region extensions/telegram/src/auto-topic-label.ts
async function generateTelegramTopicLabel(params) {
	return await generateConversationLabel({
		...params,
		maxLength: 128
	});
}
//#endregion
//#region extensions/telegram/src/bot/native-quote.ts
const TELEGRAM_NATIVE_QUOTE_MAX_LENGTH = 1024;
function truncateUtf16Safe(value, maxLength) {
	if (value.length <= maxLength) return value;
	let end = Math.max(0, Math.trunc(maxLength));
	const lastCodeUnit = value.charCodeAt(end - 1);
	if (lastCodeUnit >= 55296 && lastCodeUnit <= 56319) end -= 1;
	return value.slice(0, end);
}
function sliceTelegramEntitiesForQuote(entities, quoteLength) {
	if (!entities?.length || quoteLength <= 0) return;
	const sliced = [];
	for (const entity of entities) {
		const offset = Number.isFinite(entity.offset) ? Math.trunc(entity.offset) : 0;
		const length = Number.isFinite(entity.length) ? Math.trunc(entity.length) : 0;
		const start = Math.max(0, offset);
		const end = Math.min(quoteLength, offset + length);
		if (end <= start) continue;
		sliced.push({
			...entity,
			offset: start,
			length: end - start
		});
	}
	return sliced.length > 0 ? sliced : void 0;
}
function buildTelegramNativeQuoteCandidate(params) {
	const source = params.text;
	if (!source?.trim()) return;
	const text = truncateUtf16Safe(source, params.maxLength ?? TELEGRAM_NATIVE_QUOTE_MAX_LENGTH);
	if (!text.trim()) return;
	const candidate = {
		text,
		position: 0
	};
	const entities = sliceTelegramEntitiesForQuote(params.entities, text.length);
	if (entities) candidate.entities = entities;
	return candidate;
}
function addTelegramNativeQuoteCandidate(target, messageId, candidate) {
	if (messageId == null || !candidate) return;
	const key = String(messageId).trim();
	if (!key || target[key]) return;
	target[key] = candidate;
}
//#endregion
//#region extensions/telegram/src/error-policy.ts
const errorCooldownStore = /* @__PURE__ */ new Map();
const DEFAULT_ERROR_COOLDOWN_MS = 144e5;
function pruneExpiredCooldowns(messageStore, now) {
	for (const [message, expiresAt] of messageStore) if (expiresAt <= now) messageStore.delete(message);
}
function resolveTelegramErrorPolicy(params) {
	const configs = [
		params.accountConfig,
		params.groupConfig,
		params.topicConfig
	];
	let policy = "always";
	let cooldownMs = DEFAULT_ERROR_COOLDOWN_MS;
	for (const config of configs) {
		if (config?.errorPolicy) policy = config.errorPolicy;
		if (typeof config?.errorCooldownMs === "number") cooldownMs = config.errorCooldownMs;
	}
	return {
		policy,
		cooldownMs
	};
}
function buildTelegramErrorScopeKey(params) {
	const threadId = params.threadId == null ? "main" : String(params.threadId);
	return `${params.accountId}:${String(params.chatId)}:${threadId}`;
}
function shouldSuppressTelegramError(params) {
	const { scopeKey, cooldownMs, errorMessage } = params;
	const now = Date.now();
	const messageKey = errorMessage ?? "";
	const scopeStore = errorCooldownStore.get(scopeKey);
	if (scopeStore) {
		pruneExpiredCooldowns(scopeStore, now);
		if (scopeStore.size === 0) errorCooldownStore.delete(scopeKey);
	}
	if (errorCooldownStore.size > 100) for (const [scope, messageStore] of errorCooldownStore) {
		pruneExpiredCooldowns(messageStore, now);
		if (messageStore.size === 0) errorCooldownStore.delete(scope);
	}
	const expiresAt = scopeStore?.get(messageKey);
	if (typeof expiresAt === "number" && expiresAt > now) return true;
	const nextScopeStore = scopeStore ?? /* @__PURE__ */ new Map();
	nextScopeStore.set(messageKey, now + cooldownMs);
	errorCooldownStore.set(scopeKey, nextScopeStore);
	return false;
}
function isSilentErrorPolicy(policy) {
	return policy === "silent";
}
//#endregion
//#region extensions/telegram/src/lane-delivery-text-deliverer.ts
function result(kind, delivery) {
	if (kind === "preview-finalized") {
		const finalized = delivery;
		return {
			kind,
			delivery: {
				...finalized,
				receipt: finalized.receipt ?? createPreviewMessageReceipt({ id: finalized.messageId })
			}
		};
	}
	return { kind };
}
function compactChunks(chunks) {
	const out = [];
	let whitespace = "";
	for (const chunk of chunks) {
		if (!chunk) continue;
		if (chunk.trim().length === 0) {
			whitespace += chunk;
			continue;
		}
		out.push(`${whitespace}${chunk}`);
		whitespace = "";
	}
	if (whitespace && out.length > 0) out[out.length - 1] = `${out[out.length - 1]}${whitespace}`;
	return out;
}
function createLaneTextDeliverer(params) {
	const followUpPayload = (payload, text) => params.applyTextToFollowUpPayload ? params.applyTextToFollowUpPayload(payload, text) : params.applyTextToPayload(payload, text);
	const textOnlyPayload = (payload) => {
		const { mediaUrl: _mediaUrl, mediaUrls: _mediaUrls, audioAsVoice: _audioAsVoice, spokenText: _spokenText, ...rest } = payload;
		return rest;
	};
	const mediaChannelData = (channelData, options) => {
		if (!options?.stripButtons) return channelData;
		const telegramData = channelData?.telegram;
		if (!telegramData || typeof telegramData !== "object" || Array.isArray(telegramData)) return channelData;
		const { buttons: _buttons, ...telegramRest } = telegramData;
		if (_buttons === void 0) return channelData;
		const next = { ...channelData };
		if (Object.keys(telegramRest).length > 0) next.telegram = telegramRest;
		else delete next.telegram;
		return Object.keys(next).length > 0 ? next : void 0;
	};
	const withMediaChannelData = (payload, options) => {
		const channelData = mediaChannelData(payload.channelData, options);
		if (channelData === payload.channelData) return payload;
		if (channelData) return {
			...payload,
			channelData
		};
		const { channelData: _channelData, ...rest } = payload;
		return rest;
	};
	const withFallbackTelegramButtons = (payload, buttons) => {
		if (!buttons) return payload;
		const channelData = payload.channelData ?? {};
		const telegramData = channelData.telegram;
		if (telegramData && typeof telegramData === "object" && !Array.isArray(telegramData) && "buttons" in telegramData) return payload;
		const telegramRest = telegramData && typeof telegramData === "object" && !Array.isArray(telegramData) ? telegramData : {};
		return {
			...payload,
			channelData: {
				...channelData,
				telegram: {
					...telegramRest,
					buttons
				}
			}
		};
	};
	const mediaOnlyPayload = (payload, text, options) => {
		if (getReplyPayloadTtsSupplement(payload)) return withFallbackTelegramButtons(withMediaChannelData(buildTtsSupplementMediaPayload(params.applyTextToPayload(payload, text)), options), options?.fallbackButtons);
		if (payload.audioAsVoice === true) {
			const { text: _text, presentation: _presentation, interactive: _interactive, btw: _btw, spokenText: _spokenText, ...voicePayload } = params.applyTextToPayload(payload, text);
			return withFallbackTelegramButtons(withMediaChannelData({
				...voicePayload,
				spokenText: text
			}, options), options?.fallbackButtons);
		}
		const { text: _text, presentation: _presentation, interactive: _interactive, btw: _btw, ...rest } = payload;
		return withFallbackTelegramButtons(withMediaChannelData(rest, options), options?.fallbackButtons);
	};
	const clearUnfinalizedStream = async (lane) => {
		if (!lane.stream || lane.finalized) return;
		await params.clearDraftLane(lane);
		lane.lastPartialText = "";
		lane.hasStreamedMessage = false;
	};
	const streamText = async (laneName, lane, text, payload, isFinal, buttons) => {
		const stream = lane.stream;
		if (!stream || text.length === 0 || payload.isError) return;
		const [firstChunk, ...remainingChunks] = text.length > params.draftMaxChars ? compactChunks(params.splitFinalTextForStream?.(text) ?? []) : [text];
		if (!firstChunk || firstChunk.length > params.draftMaxChars) return;
		const retainedPreview = isFinal && remainingChunks.length === 0 && isPotentialTruncatedFinal(text) ? selectLongerFinalText({
			finalText: text,
			candidateTexts: [
				await params.resolveFinalTextCandidate?.({
					finalText: text,
					laneName
				}),
				stream.lastDeliveredText?.(),
				lane.lastPartialText
			]
		}) : void 0;
		if (retainedPreview && (!buttons || retainedPreview.length <= params.draftMaxChars)) {
			const previewText = retainedPreview;
			lane.lastPartialText = previewText;
			lane.hasStreamedMessage = true;
			await params.stopDraftLane(lane);
			const messageId = stream.messageId();
			if (typeof messageId !== "number") {
				if (stream.sendMayHaveLanded?.()) {
					lane.finalized = true;
					params.markDelivered();
					return result("preview-retained");
				}
				return;
			}
			const deliveredStreamText = stream.lastDeliveredText?.();
			if (deliveredStreamText !== void 0 && deliveredStreamText !== previewText) return;
			let buttonsAttached = false;
			if (buttons) try {
				await params.editStreamMessage({
					laneName,
					messageId,
					text: previewText,
					buttons
				});
				buttonsAttached = true;
			} catch (err) {
				params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
			}
			for (const chunk of remainingChunks) {
				if (chunk.trim().length === 0) continue;
				await params.sendPayload(followUpPayload(payload, chunk));
			}
			lane.finalized = true;
			params.markDelivered();
			return result("preview-finalized", {
				content: previewText,
				messageId,
				buttonsAttached
			});
		}
		lane.lastPartialText = firstChunk;
		lane.hasStreamedMessage = true;
		lane.finalized = false;
		stream.update(firstChunk);
		if (isFinal) await params.stopDraftLane(lane);
		else await params.flushDraftLane(lane);
		const messageId = stream.messageId();
		if (typeof messageId !== "number") {
			if (isFinal && stream.sendMayHaveLanded?.()) {
				lane.finalized = true;
				params.markDelivered();
				return result("preview-retained");
			}
			return;
		}
		const deliveredStreamText = stream.lastDeliveredText?.();
		if (isFinal && deliveredStreamText !== void 0 && deliveredStreamText !== firstChunk.trimEnd()) return;
		params.markDelivered();
		let buttonsAttached = false;
		if (buttons) try {
			await params.editStreamMessage({
				laneName,
				messageId,
				text: firstChunk,
				buttons
			});
			buttonsAttached = true;
		} catch (err) {
			params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
		}
		if (isFinal) {
			lane.finalized = true;
			for (const chunk of remainingChunks) {
				if (chunk.trim().length === 0) continue;
				await params.sendPayload(followUpPayload(payload, chunk));
			}
			return result("preview-finalized", {
				content: text,
				messageId,
				buttonsAttached
			});
		}
		return result("preview-updated");
	};
	return async ({ laneName, text, payload, infoKind, buttons }) => {
		const lane = params.lanes[laneName];
		const reply = resolveSendableOutboundReplyParts(payload, { text });
		const isFinal = infoKind === "final";
		const streamed = !reply.hasMedia ? await streamText(laneName, lane, text, payload, isFinal, buttons) : void 0;
		if (streamed) return streamed;
		if (isFinal && reply.hasMedia && lane.stream && lane.hasStreamedMessage && !lane.finalized && text.trim().length > 0) {
			const finalizedPreview = await streamText(laneName, lane, text, textOnlyPayload(payload), true, buttons);
			if (finalizedPreview) {
				const stripButtons = finalizedPreview.kind === "preview-finalized" && finalizedPreview.delivery.buttonsAttached === true;
				const mediaText = finalizedPreview.kind === "preview-finalized" ? finalizedPreview.delivery.content : text;
				await params.sendPayload(mediaOnlyPayload(payload, mediaText, {
					stripButtons,
					fallbackButtons: stripButtons ? void 0 : buttons
				}), { durable: true });
				return finalizedPreview;
			}
		}
		if (isFinal) await clearUnfinalizedStream(lane);
		const delivered = await params.sendPayload(params.applyTextToPayload(payload, text), { durable: isFinal });
		if (delivered && isFinal) lane.finalized = true;
		return delivered ? result("sent") : result("skipped");
	};
}
//#endregion
//#region extensions/telegram/src/lane-delivery-state.ts
function createLaneDeliveryStateTracker() {
	const state = {
		delivered: false,
		skippedNonSilent: 0,
		failedNonSilent: 0
	};
	return {
		markDelivered: () => {
			state.delivered = true;
		},
		markNonSilentSkip: () => {
			state.skippedNonSilent += 1;
		},
		markNonSilentFailure: () => {
			state.failedNonSilent += 1;
		},
		snapshot: () => ({ ...state })
	};
}
//#endregion
//#region extensions/telegram/src/reasoning-lane-coordinator.ts
const REASONING_MESSAGE_RE = /^Thinking\.{0,3}\s*_/u;
const LEGACY_REASONING_MESSAGE_PREFIX = "Reasoning:\n";
const REASONING_TAG_PREFIXES = [
	"<think",
	"<thinking",
	"<thought",
	"<antthinking",
	"</think",
	"</thinking",
	"</thought",
	"</antthinking"
];
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
function extractThinkingFromTaggedStreamOutsideCode(text) {
	if (!text) return "";
	const codeRegions = findCodeRegions(text);
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	THINKING_TAG_RE.lastIndex = 0;
	for (const match of text.matchAll(THINKING_TAG_RE)) {
		const idx = match.index ?? 0;
		if (isInsideCode(idx, codeRegions)) continue;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = !(match[1] === "/");
		lastIndex = idx + match[0].length;
	}
	if (inThinking) result += text.slice(lastIndex);
	return result.trim();
}
function isPartialReasoningTagPrefix(text) {
	const trimmed = normalizeLowercaseStringOrEmpty(text.trimStart());
	if (!trimmed.startsWith("<")) return false;
	if (trimmed.includes(">")) return false;
	return REASONING_TAG_PREFIXES.some((prefix) => prefix.startsWith(trimmed));
}
function splitTelegramReasoningText(text, isReasoning) {
	if (typeof text !== "string") return {};
	const trimmed = text.trim();
	if (isPartialReasoningTagPrefix(trimmed)) return {};
	if (REASONING_MESSAGE_RE.test(trimmed)) return { reasoningText: trimmed };
	if (trimmed.startsWith(LEGACY_REASONING_MESSAGE_PREFIX) && trimmed.length > 11) return { reasoningText: trimmed };
	const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
	const strippedAnswer = stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
	if (isReasoning === true) return { reasoningText: formatReasoningMessage(taggedReasoning || strippedAnswer || text) };
	if (!taggedReasoning && strippedAnswer === text) return { answerText: text };
	return {
		reasoningText: taggedReasoning ? formatReasoningMessage(taggedReasoning) : void 0,
		answerText: strippedAnswer || void 0
	};
}
function createTelegramReasoningStepState() {
	let reasoningStatus = "none";
	let bufferedFinalAnswer;
	const noteReasoningHint = () => {
		if (reasoningStatus === "none") reasoningStatus = "hinted";
	};
	const noteReasoningDelivered = () => {
		reasoningStatus = "delivered";
	};
	const shouldBufferFinalAnswer = () => {
		return reasoningStatus === "hinted" && !bufferedFinalAnswer;
	};
	const bufferFinalAnswer = (value) => {
		bufferedFinalAnswer = value;
	};
	const takeBufferedFinalAnswer = (currentGeneration) => {
		if (currentGeneration !== void 0 && bufferedFinalAnswer?.bufferedGeneration !== void 0 && bufferedFinalAnswer.bufferedGeneration !== currentGeneration) return;
		const value = bufferedFinalAnswer;
		bufferedFinalAnswer = void 0;
		return value;
	};
	const resetForNextStep = () => {
		reasoningStatus = "none";
		bufferedFinalAnswer = void 0;
	};
	return {
		noteReasoningHint,
		noteReasoningDelivered,
		shouldBufferFinalAnswer,
		bufferFinalAnswer,
		takeBufferedFinalAnswer,
		resetForNextStep
	};
}
//#endregion
//#region extensions/telegram/src/sequential-key.ts
const TELEGRAM_READ_ONLY_STATUS_COMMAND_KEYS = new Set([
	"commands",
	"context",
	"help",
	"status",
	"tasks",
	"tools",
	"whoami"
]);
function isTelegramReadOnlyControlLaneText(params) {
	const alias = maybeResolveTextAlias(normalizeCommandBody(params.rawText?.trim() ?? "", params.botUsername ? { botUsername: params.botUsername } : void 0));
	if (!alias) return false;
	const command = listChatCommands().find((entry) => entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias));
	return command?.category === "status" && TELEGRAM_READ_ONLY_STATUS_COMMAND_KEYS.has(command.key);
}
function isTelegramTargetedStopCommand(rawText, botUsername) {
	const trimmed = rawText?.trim();
	if (!trimmed) return false;
	const match = trimmed.match(/^\/stop@([A-Za-z0-9_]+)(?:$|\s|[.!?…,，。;；:：'"’”)\]}])/iu);
	if (!match) return false;
	const normalizedBotUsername = botUsername?.trim().toLowerCase();
	if (!normalizedBotUsername) return true;
	return match[1]?.toLowerCase() === normalizedBotUsername;
}
function isTelegramControlLaneText(params) {
	if (isAbortRequestText(params.rawText, params.botUsername ? { botUsername: params.botUsername } : void 0)) return true;
	if (isTelegramTargetedStopCommand(params.rawText, params.botUsername)) return true;
	return isTelegramReadOnlyControlLaneText(params);
}
function getTelegramSequentialKey(ctx) {
	const reaction = ctx.update?.message_reaction;
	if (reaction?.chat?.id) return `telegram:${reaction.chat.id}`;
	const msg = ctx.message ?? ctx.channelPost ?? ctx.editedMessage ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.update?.callback_query?.message;
	const chatId = msg?.chat?.id ?? ctx.chat?.id;
	const rawText = msg?.text ?? msg?.caption;
	const botUsername = ctx.me?.username;
	if (isTelegramControlLaneText({
		rawText,
		botUsername
	})) {
		if (typeof chatId === "number") return `telegram:${chatId}:control`;
		return "telegram:control";
	}
	if (isBtwRequestText(rawText, botUsername ? { botUsername } : void 0)) {
		const messageId = msg?.message_id;
		if (typeof chatId === "number" && typeof messageId === "number") return `telegram:${chatId}:btw:${messageId}`;
		if (typeof chatId === "number") return `telegram:${chatId}:btw`;
		return "telegram:btw";
	}
	const callbackData = ctx.update?.callback_query?.data;
	if (callbackData && parseExecApprovalCommandText(callbackData) !== null) {
		if (typeof chatId === "number") return `telegram:${chatId}:approval`;
		return "telegram:approval";
	}
	const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
	const messageThreadId = msg?.message_thread_id;
	const isForum = resolveTelegramMessageForumFlagHint({
		chatType: msg?.chat?.type,
		isForum: msg?.chat?.is_forum,
		isTopicMessage: msg?.is_topic_message
	});
	const threadId = isGroup ? resolveTelegramForumThreadId({
		isForum,
		messageThreadId
	}) : messageThreadId;
	if (typeof chatId === "number") return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
	return "telegram:unknown";
}
//#endregion
//#region extensions/telegram/src/telegram-reply-fence.ts
const telegramReplyFenceByKey = /* @__PURE__ */ new Map();
const telegramReplyFenceKeysByLane = /* @__PURE__ */ new Map();
function buildTelegramReplyFenceLaneKey(params) {
	return `${params.accountId}\0${params.sequentialKey}`;
}
function buildTelegramNonInterruptingReplyFenceKey(params) {
	return `${buildTelegramNonInterruptingReplyFenceKeyPrefix(params.activeKey)}${params.laneKey}`;
}
function buildTelegramNonInterruptingReplyFenceKeyPrefix(activeKey) {
	return `${activeKey}\0non-interrupting\0`;
}
function normalizeTelegramFenceKey(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveTelegramReplyFenceKey(params) {
	const baseKey = normalizeTelegramFenceKey(params.ctxPayload.CommandTargetSessionKey) ?? normalizeTelegramFenceKey(params.ctxPayload.SessionKey) ?? `telegram:${String(params.chatId)}:${params.threadSpec.scope ?? "default"}:${params.threadSpec.id ?? "root"}`;
	const roomEventKey = `${baseKey}:room_event`;
	return {
		activeKey: params.ctxPayload.InboundEventKind === "room_event" ? roomEventKey : baseKey,
		roomEventKey
	};
}
function abortTelegramReplyFenceControllers(state) {
	for (const controller of state.abortControllers ?? []) controller.abort();
	state.abortControllers?.clear();
}
function deleteTelegramReplyFenceState(key, state) {
	telegramReplyFenceByKey.delete(key);
	for (const laneKey of state.laneKeys ?? []) {
		const keys = telegramReplyFenceKeysByLane.get(laneKey);
		keys?.delete(key);
		if (keys?.size === 0) telegramReplyFenceKeysByLane.delete(laneKey);
	}
}
function maybeDeleteTelegramReplyFenceState(key, state) {
	if (state.activeDispatches <= 0 && (state.abortControllers?.size ?? 0) === 0) deleteTelegramReplyFenceState(key, state);
	else telegramReplyFenceByKey.set(key, state);
}
function beginTelegramReplyFence(params) {
	const state = telegramReplyFenceByKey.get(params.key) ?? {
		generation: 0,
		activeDispatches: 0
	};
	if (params.supersede) {
		state.generation += 1;
		abortTelegramReplyFenceControllers(state);
		supersedeTelegramNonInterruptingReplyFenceChildren(params.key);
	}
	if (params.abortController) (state.abortControllers ??= /* @__PURE__ */ new Set()).add(params.abortController);
	const laneKey = normalizeTelegramFenceKey(params.laneKey);
	if (laneKey) {
		(state.laneKeys ??= /* @__PURE__ */ new Set()).add(laneKey);
		const keys = telegramReplyFenceKeysByLane.get(laneKey) ?? /* @__PURE__ */ new Set();
		keys.add(params.key);
		telegramReplyFenceKeysByLane.set(laneKey, keys);
	}
	state.activeDispatches += 1;
	telegramReplyFenceByKey.set(params.key, state);
	return state.generation;
}
function supersedeTelegramReplyFenceState(key) {
	const state = telegramReplyFenceByKey.get(key);
	if (!state) return false;
	state.generation += 1;
	abortTelegramReplyFenceControllers(state);
	maybeDeleteTelegramReplyFenceState(key, state);
	return true;
}
function supersedeTelegramNonInterruptingReplyFenceChildren(key) {
	let superseded = false;
	const childPrefix = buildTelegramNonInterruptingReplyFenceKeyPrefix(key);
	for (const childKey of telegramReplyFenceByKey.keys()) if (childKey.startsWith(childPrefix)) superseded = supersedeTelegramReplyFenceState(childKey) || superseded;
	return superseded;
}
function supersedeTelegramReplyFence(key) {
	let superseded = supersedeTelegramReplyFenceState(key);
	superseded = supersedeTelegramNonInterruptingReplyFenceChildren(key) || superseded;
	return superseded;
}
function supersedeTelegramReplyFenceLane(laneKey) {
	const keys = [...telegramReplyFenceKeysByLane.get(laneKey) ?? []];
	let superseded = false;
	for (const key of keys) superseded = supersedeTelegramReplyFence(key) || superseded;
	return superseded;
}
function isTelegramReplyFenceSuperseded(params) {
	return (telegramReplyFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}
function endTelegramReplyFence(key, abortController) {
	const state = telegramReplyFenceByKey.get(key);
	if (!state) return;
	if (abortController) state.abortControllers?.delete(abortController);
	state.activeDispatches = Math.max(0, state.activeDispatches - 1);
	maybeDeleteTelegramReplyFenceState(key, state);
}
function releaseTelegramReplyFenceAbortController(key, abortController) {
	if (!abortController) return;
	const state = telegramReplyFenceByKey.get(key);
	if (!state) return;
	state.abortControllers?.delete(abortController);
	maybeDeleteTelegramReplyFenceState(key, state);
}
function shouldSupersedeTelegramReplyFence(ctxPayload) {
	const dispatchText = ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "";
	if (isAbortRequestText(dispatchText)) return ctxPayload.CommandAuthorized;
	if (isBtwRequestText(dispatchText) || isTelegramReadOnlyControlLaneText({ rawText: dispatchText })) return false;
	return true;
}
//#endregion
//#region extensions/telegram/src/bot-message-dispatch.ts
const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");
/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;
function resolveDraftPartialText(previous, update) {
	const nextText = update.replace || update.delta === void 0 ? update.text : `${previous}${update.delta}`;
	if (nextText === previous) return;
	return nextText;
}
function resolvePayloadTelegramInlineButtons(payload) {
	const telegramData = payload.channelData?.telegram;
	const presentation = normalizeMessagePresentation(payload.presentation);
	return resolveTelegramInlineButtons({
		buttons: telegramData?.buttons,
		presentation,
		interactive: payload.interactive
	});
}
function hasExecApprovalPayload(payload) {
	const channelData = payload.channelData;
	if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) return false;
	const execApproval = channelData.execApproval;
	return Boolean(execApproval && typeof execApproval === "object" && !Array.isArray(execApproval));
}
function canUseNativeToolProgressDraft(params) {
	return !params.reply.hasMedia && params.payload.isError !== true && !hasExecApprovalPayload(params.payload) && params.buttons === void 0;
}
function canUseNativeToolProgressDraftForChat(params) {
	if (!resolveChannelStreamingPreviewNativeToolProgress(params.telegramCfg)) return false;
	const allowFrom = resolveChannelStreamingPreviewNativeToolProgressAllowFrom(params.telegramCfg);
	if (!allowFrom || allowFrom.length === 0) return true;
	const normalized = normalizeAllowFrom(allowFrom);
	return normalized.hasWildcard || normalized.entries.includes(String(params.chatId));
}
async function resolveStickerVisionSupport(cfg, agentId) {
	try {
		const catalog = await loadModelCatalog({ config: cfg });
		const defaultModel = resolveDefaultModelForAgent({
			cfg,
			agentId
		});
		const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
		if (!entry) return false;
		return modelSupportsVision(entry);
	} catch {
		return false;
	}
}
function resolveTelegramReasoningLevel(params) {
	const { cfg, sessionKey, agentId, telegramDeps } = params;
	const configDefault = resolveTelegramConfigReasoningDefault(cfg, agentId);
	if (!sessionKey) return configDefault;
	try {
		const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
		const level = resolveSessionStoreEntry({
			store: (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, { skipCache: true }),
			sessionKey
		}).existing?.reasoningLevel;
		if (level === "on" || level === "stream" || level === "off") return level;
	} catch {
		return "off";
	}
	return configDefault;
}
function resolveTelegramMirroredTranscriptText(payload) {
	const mediaUrls = payload.mediaUrls?.filter((url) => url.trim()) ?? [];
	if (mediaUrls.length > 0) return mediaUrls.map((url) => {
		const pathname = url.split("#")[0]?.split("?")[0] ?? url;
		const base = path.basename(pathname);
		return base && base !== "." && base !== "/" ? base : "media";
	}).join(", ");
	const text = payload.text?.trim();
	return text ? text : null;
}
async function mirrorTelegramAssistantReplyToTranscript(params) {
	const text = resolveTelegramMirroredTranscriptText(params.payload);
	if (!text) return;
	const storePath = params.telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
	const store = (params.telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, { skipCache: true });
	const sessionEntry = resolveSessionStoreEntry({
		store,
		sessionKey: params.sessionKey
	}).existing;
	if (!sessionEntry?.sessionId) return;
	const { sessionFile } = await resolveAndPersistSessionFile({
		sessionId: sessionEntry.sessionId,
		sessionKey: params.sessionKey,
		sessionStore: store,
		storePath,
		sessionEntry,
		agentId: params.route.agentId,
		sessionsDir: path.dirname(storePath)
	});
	const { messageId, message: appendedMessage } = await appendSessionTranscriptMessage({
		transcriptPath: sessionFile,
		message: {
			role: "assistant",
			content: [{
				type: "text",
				text
			}],
			api: "openai-responses",
			provider: "openclaw",
			model: "delivery-mirror",
			usage: {
				input: 0,
				output: 0,
				total: 0,
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				cache: {
					read: 0,
					write: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: "stop",
			timestamp: Date.now()
		},
		config: params.cfg
	});
	emitSessionTranscriptUpdate({
		sessionFile,
		sessionKey: params.sessionKey,
		message: appendedMessage,
		messageId
	});
}
const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;
function clipProgressMarkdownText(text) {
	if (text.length <= MAX_PROGRESS_MARKDOWN_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_PROGRESS_MARKDOWN_TEXT_CHARS - 1).trimEnd()}…`;
}
function sanitizeProgressMarkdownText(text) {
	return text.replaceAll("`", "'");
}
function formatProgressAsMarkdownCode(text) {
	return `\`${sanitizeProgressMarkdownText(clipProgressMarkdownText(text))}\``;
}
const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps: injectedTelegramDeps, opts }) => {
	const dispatchStartedAt = Date.now();
	const telegramDeps = injectedTelegramDeps ?? (await import("./bot-deps-DGegwXgk.js")).defaultTelegramBotDeps;
	const { ctxPayload, msg, chatId, isGroup, groupConfig, topicConfig, threadSpec, historyKey, historyLimit, groupHistories, route, skillFilter, sendTyping, sendRecordVoice, ackReactionPromise, reactionApi, removeAckAfterReply, statusReactionController: rawStatusReactionController } = context;
	const isRoomEvent = ctxPayload.InboundEventKind === "room_event";
	const statusReactionController = isRoomEvent ? null : rawStatusReactionController;
	const statusReactionTiming = {
		...DEFAULT_TIMING,
		...cfg.messages?.statusReactions?.timing
	};
	const clearTelegramStatusReaction = async () => {
		if (!msg.message_id || !reactionApi) return;
		await reactionApi(chatId, msg.message_id, []);
	};
	const finalizeTelegramStatusReaction = async (params) => {
		if (!statusReactionController) return;
		if (params.outcome === "done") {
			await statusReactionController.setDone();
			if (removeAckAfterReply) {
				await sleepWithAbort(statusReactionTiming.doneHoldMs);
				await clearTelegramStatusReaction();
			} else await statusReactionController.restoreInitial();
			return;
		}
		await statusReactionController.setError();
		if (params.hasFinalResponse) {
			if (removeAckAfterReply) {
				await sleepWithAbort(statusReactionTiming.errorHoldMs);
				await clearTelegramStatusReaction();
			} else await statusReactionController.restoreInitial();
			return;
		}
		if (removeAckAfterReply) await sleepWithAbort(statusReactionTiming.errorHoldMs);
		await statusReactionController.restoreInitial();
	};
	const replyFenceKey = resolveTelegramReplyFenceKey({
		ctxPayload,
		chatId,
		threadSpec
	});
	const replyFenceLaneKey = getTelegramSequentialKey({
		message: msg,
		...context.primaryCtx.me ? { me: context.primaryCtx.me } : {}
	});
	const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
		accountId: route.accountId,
		sequentialKey: replyFenceLaneKey
	});
	let activeReplyFenceKey = replyFenceKey.activeKey;
	let replyFenceGeneration;
	const replyAbortController = new AbortController();
	let replyAbortControllerQueued = false;
	let dispatchWasSuperseded = false;
	const isDispatchSuperseded = () => replyFenceGeneration !== void 0 && isTelegramReplyFenceSuperseded({
		key: activeReplyFenceKey,
		generation: replyFenceGeneration
	});
	const releaseReplyFence = () => {
		if (replyFenceGeneration === void 0) return;
		endTelegramReplyFence(activeReplyFenceKey, replyAbortControllerQueued ? void 0 : replyAbortController);
		replyFenceGeneration = void 0;
	};
	const draftMaxChars = Math.min(textLimit, 4096);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: route.accountId
	});
	const renderStreamText = (text) => ({
		text: renderTelegramHtmlText(text, { tableMode }),
		parseMode: "HTML"
	});
	const accountBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg) ?? cfg.agents?.defaults?.blockStreamingDefault === "on";
	const resolvedReasoningLevel = resolveTelegramReasoningLevel({
		cfg,
		sessionKey: ctxPayload.SessionKey,
		agentId: route.agentId,
		telegramDeps
	});
	const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
	const streamReasoningDraft = resolvedReasoningLevel === "stream";
	const streamDeliveryEnabled = !isRoomEvent && streamMode !== "off";
	const rawReplyQuoteText = ctxPayload.ReplyToIsQuote && typeof ctxPayload.ReplyToQuoteText === "string" ? ctxPayload.ReplyToQuoteText : void 0;
	const replyQuoteText = ctxPayload.ReplyToIsQuote ? rawReplyQuoteText?.trim() ? rawReplyQuoteText : ctxPayload.ReplyToBody?.trim() || void 0 : void 0;
	const replyQuoteMessageId = replyQuoteText && !ctxPayload.ReplyToIsExternal ? resolveTelegramReplyId(ctxPayload.ReplyToId) : void 0;
	const replyQuoteByMessageId = {};
	if (replyToMode !== "off") {
		if (replyQuoteText && replyQuoteMessageId != null) addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
			text: replyQuoteText,
			...typeof ctxPayload.ReplyToQuotePosition === "number" ? { position: ctxPayload.ReplyToQuotePosition } : {},
			...Array.isArray(ctxPayload.ReplyToQuoteEntities) ? { entities: ctxPayload.ReplyToQuoteEntities } : {}
		});
		addTelegramNativeQuoteCandidate(replyQuoteByMessageId, ctxPayload.MessageSid ?? msg.message_id, buildTelegramNativeQuoteCandidate(getTelegramTextParts(msg)));
		if (!ctxPayload.ReplyToIsExternal && typeof ctxPayload.ReplyToQuoteSourceText === "string") addTelegramNativeQuoteCandidate(replyQuoteByMessageId, ctxPayload.ReplyToId, buildTelegramNativeQuoteCandidate({
			text: ctxPayload.ReplyToQuoteSourceText,
			entities: Array.isArray(ctxPayload.ReplyToQuoteSourceEntities) ? ctxPayload.ReplyToQuoteSourceEntities : void 0
		}));
	}
	const canStreamAnswerDraft = streamDeliveryEnabled && !(replyToMode !== "off" && replyQuoteText != null) && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
	const canStreamReasoningDraft = !isRoomEvent && streamReasoningDraft;
	const draftReplyToMessageId = replyToMode !== "off" && typeof msg.message_id === "number" ? replyQuoteMessageId ?? msg.message_id : void 0;
	const draftMinInitialChars = streamMode === "progress" ? 0 : DRAFT_MIN_INITIAL_CHARS;
	const progressSeed = `${route.accountId}:${chatId}:${threadSpec.id ?? ""}`;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const createDraftLane = (laneName, enabled) => {
		return {
			stream: enabled ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
				api: bot.api,
				chatId,
				maxChars: draftMaxChars,
				thread: threadSpec,
				replyToMessageId: draftReplyToMessageId,
				minInitialChars: draftMinInitialChars,
				renderText: renderStreamText,
				onSupersededPreview: (superseded) => {
					if (superseded.retain) return;
					bot.api.deleteMessage(chatId, superseded.messageId).catch((err) => {
						logVerbose(`telegram: superseded ${laneName} stream cleanup failed (${superseded.messageId}): ${String(err)}`);
					});
				},
				log: logVerbose,
				warn: logVerbose
			}) : void 0,
			lastPartialText: "",
			hasStreamedMessage: false,
			finalized: false
		};
	};
	const lanes = {
		answer: createDraftLane("answer", canStreamAnswerDraft),
		reasoning: createDraftLane("reasoning", canStreamReasoningDraft)
	};
	const answerLane = lanes.answer;
	const reasoningLane = lanes.reasoning;
	const streamToolProgressEnabled = Boolean(answerLane.stream) && resolveChannelStreamingPreviewToolProgress(telegramCfg);
	const nativeToolProgressDraft = streamToolProgressEnabled && !isRoomEvent && !isGroup && threadSpec.scope === "dm" && canUseNativeToolProgressDraftForChat({
		telegramCfg,
		chatId
	}) ? (telegramDeps.createNativeTelegramToolProgressDraft ?? createNativeTelegramToolProgressDraft)({
		api: bot.api,
		chatId,
		thread: threadSpec,
		log: logVerbose
	}) : void 0;
	let streamToolProgressSuppressed = false;
	let streamToolProgressLines = [];
	let lastAnswerPartialText = "";
	let activeAnswerDraftIsToolProgressOnly = false;
	function resetAnswerToolProgressDraft() {
		activeAnswerDraftIsToolProgressOnly = false;
	}
	async function prepareAnswerLaneForToolProgress() {
		if (activeAnswerDraftIsToolProgressOnly) return;
		if (answerLane.hasStreamedMessage) await rotateLaneForNewMessage(answerLane);
		activeAnswerDraftIsToolProgressOnly = true;
	}
	const renderProgressDraft = async (options) => {
		if (!answerLane.stream || streamMode !== "progress") return false;
		const streamText = formatChannelProgressDraftText({
			entry: telegramCfg,
			lines: streamToolProgressLines,
			seed: progressSeed,
			formatLine: formatProgressAsMarkdownCode
		});
		if (!streamText || streamText === answerLane.lastPartialText) return false;
		await prepareAnswerLaneForToolProgress();
		answerLane.lastPartialText = streamText;
		answerLane.hasStreamedMessage = true;
		answerLane.finalized = false;
		answerLane.stream.update(streamText);
		if (options?.flush) await answerLane.stream.flush();
		return true;
	};
	const progressDraftGate = createChannelProgressDraftGate({ onStart: async () => {
		await renderProgressDraft({ flush: true });
	} });
	let finalAnswerDeliveryStarted = false;
	let finalAnswerDelivered = false;
	const pushStreamToolProgress = async (line, options) => {
		if (!answerLane.stream) return false;
		if (answerLane.finalized || finalAnswerDeliveryStarted || finalAnswerDelivered) return false;
		if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return false;
		const normalized = sanitizeProgressMarkdownText((typeof line === "string" ? line : line?.text)?.replace(/\s+/g, " ").trim() ?? "");
		if (streamToolProgressSuppressed) return false;
		if (streamMode !== "progress" && !streamToolProgressEnabled) return false;
		const shouldUpdateProgressLines = streamToolProgressEnabled && !streamToolProgressSuppressed && Boolean(normalized);
		if (!shouldUpdateProgressLines && streamMode !== "progress") return false;
		const progressLine = typeof line === "object" && line !== void 0 ? {
			...line,
			text: normalized
		} : normalized;
		const nextLines = shouldUpdateProgressLines ? mergeChannelProgressDraftLine(streamToolProgressLines, progressLine, { maxLines: resolveChannelProgressDraftMaxLines(telegramCfg) }) : streamToolProgressLines;
		if (shouldUpdateProgressLines && nextLines === streamToolProgressLines) return false;
		if (nativeToolProgressDraft && shouldUpdateProgressLines) {
			const streamText = formatChannelProgressDraftText({
				entry: telegramCfg,
				lines: nextLines,
				seed: progressSeed
			});
			if (streamText && await nativeToolProgressDraft.update(streamText)) {
				streamToolProgressLines = nextLines;
				return true;
			}
		}
		if (streamMode !== "progress") {
			streamToolProgressLines = nextLines;
			const streamText = formatChannelProgressDraftText({
				entry: telegramCfg,
				lines: streamToolProgressLines,
				seed: progressSeed,
				formatLine: formatProgressAsMarkdownCode
			});
			await prepareAnswerLaneForToolProgress();
			answerLane.lastPartialText = streamText;
			answerLane.hasStreamedMessage = true;
			answerLane.finalized = false;
			answerLane.stream.update(streamText);
			return true;
		}
		streamToolProgressLines = nextLines;
		if (options?.startImmediately) {
			const alreadyStarted = progressDraftGate.hasStarted;
			await progressDraftGate.startNow();
			if (alreadyStarted && progressDraftGate.hasStarted) {
				await renderProgressDraft();
				return true;
			}
			return progressDraftGate.hasStarted;
		}
		const alreadyStarted = progressDraftGate.hasStarted;
		await progressDraftGate.noteWork();
		if (alreadyStarted && progressDraftGate.hasStarted) {
			await renderProgressDraft();
			return true;
		}
		return false;
	};
	let splitReasoningOnNextStream = false;
	let draftLaneEventQueue = Promise.resolve();
	const reasoningStepState = createTelegramReasoningStepState();
	const enqueueDraftLaneEvent = (task) => {
		draftLaneEventQueue = draftLaneEventQueue.then(async () => {
			if (isDispatchSuperseded()) return;
			await task();
		}).catch((err) => {
			logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
		});
		return draftLaneEventQueue;
	};
	const splitTextIntoLaneSegments = (update, isReasoning) => {
		const split = splitTelegramReasoningText(update.text, isReasoning);
		const splitSegments = [];
		const useDelta = !update.replace && update.delta !== void 0;
		const segments = [];
		const suppressReasoning = resolvedReasoningLevel === "off";
		if (split.reasoningText && !suppressReasoning) splitSegments.push({
			lane: "reasoning",
			text: split.reasoningText
		});
		if (split.answerText) splitSegments.push({
			lane: "answer",
			text: split.answerText
		});
		for (const segment of splitSegments) {
			const canApplyDelta = useDelta && splitSegments.length === 1;
			segments.push({
				lane: segment.lane,
				update: {
					text: segment.text,
					...canApplyDelta ? { delta: update.delta } : {},
					...update.replace ? { replace: true } : {}
				}
			});
		}
		return {
			segments,
			suppressedReasoningOnly: Boolean(split.reasoningText) && suppressReasoning && !split.answerText
		};
	};
	const resetDraftLaneState = (lane) => {
		lane.lastPartialText = "";
		if (lane === answerLane) lastAnswerPartialText = "";
		lane.hasStreamedMessage = false;
		lane.finalized = false;
		if (lane === answerLane) resetAnswerToolProgressDraft();
	};
	const rotateLaneForNewMessage = async (lane) => {
		if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
			resetDraftLaneState(lane);
			return;
		}
		await lane.stream?.stop();
		lane.stream?.forceNewMessage();
		resetDraftLaneState(lane);
	};
	const rotateAnswerLaneAfterToolProgress = async () => {
		nativeToolProgressDraft?.stop();
		if (!activeAnswerDraftIsToolProgressOnly) return false;
		await answerLane.stream?.clear();
		answerLane.stream?.forceNewMessage();
		resetDraftLaneState(answerLane);
		streamToolProgressSuppressed = true;
		streamToolProgressLines = [];
		return true;
	};
	const prepareAnswerLaneForText = async () => {
		nativeToolProgressDraft?.stop();
		if (await rotateAnswerLaneAfterToolProgress()) return;
		if (!answerLane.finalized) return;
		await rotateLaneForNewMessage(answerLane);
	};
	const updateDraftFromPartial = (lane, update) => {
		const laneStream = lane.stream;
		if (!laneStream || !update.text) return;
		const nextText = resolveDraftPartialText(lane === answerLane ? lastAnswerPartialText : lane.lastPartialText, update);
		if (!nextText) return;
		if (lane === answerLane) {
			if (streamMode === "progress") return;
			resetAnswerToolProgressDraft();
			streamToolProgressSuppressed = true;
			streamToolProgressLines = [];
		}
		lane.hasStreamedMessage = true;
		lane.finalized = false;
		if (lane === answerLane) lastAnswerPartialText = nextText;
		lane.lastPartialText = nextText;
		laneStream.update(nextText);
	};
	const ingestDraftLaneSegments = async (update, isReasoning) => {
		const split = splitTextIntoLaneSegments(update, isReasoning);
		for (const segment of split.segments) {
			if (segment.lane === "answer") await prepareAnswerLaneForText();
			if (segment.lane === "reasoning") {
				reasoningStepState.noteReasoningHint();
				reasoningStepState.noteReasoningDelivered();
			}
			updateDraftFromPartial(lanes[segment.lane], segment.update);
		}
	};
	const flushDraftLane = async (lane) => {
		if (!lane.stream) return;
		await lane.stream.flush();
	};
	const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
	const disableBlockStreaming = !streamDeliveryEnabled ? true : forceBlockStreamingForReasoning ? false : typeof resolvedBlockStreamingEnabled === "boolean" ? !resolvedBlockStreamingEnabled : canStreamAnswerDraft ? true : void 0;
	const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
	const supersedeReplyFence = shouldSupersedeTelegramReplyFence(ctxPayload);
	activeReplyFenceKey = supersedeReplyFence ? replyFenceKey.activeKey : buildTelegramNonInterruptingReplyFenceKey({
		activeKey: replyFenceKey.activeKey,
		laneKey: scopedReplyFenceLaneKey
	});
	if (!isRoomEvent && supersedeReplyFence) supersedeTelegramReplyFence(replyFenceKey.roomEventKey);
	replyFenceGeneration = beginTelegramReplyFence({
		key: activeReplyFenceKey,
		supersede: supersedeReplyFence,
		abortController: replyAbortController,
		laneKey: scopedReplyFenceLaneKey
	});
	const implicitQuoteReplyTargetId = replyQuoteMessageId != null ? String(replyQuoteMessageId) : void 0;
	const currentMessageIdForQuoteReply = implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : void 0;
	const replyQuotePosition = typeof ctxPayload.ReplyToQuotePosition === "number" ? ctxPayload.ReplyToQuotePosition : void 0;
	const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities) ? ctxPayload.ReplyToQuoteEntities : void 0;
	const deliveryState = createLaneDeliveryStateTracker();
	const clearGroupHistory = () => {
		if (isGroup && historyKey) createChannelHistoryWindow({ historyMap: groupHistories }).clear({
			historyKey,
			limit: historyLimit
		});
	};
	const beginDeliveryCorrelation = () => beginTelegramInboundEventDeliveryCorrelation(ctxPayload.SessionKey, {
		outboundTo: historyKey || String(chatId),
		outboundAccountId: route.accountId,
		markInboundEventDelivered: () => {
			deliveryState.markDelivered();
			if (isRoomEvent) clearGroupHistory();
		}
	}, { inboundEventKind: ctxPayload.InboundEventKind });
	const endTelegramInboundEventDeliveryCorrelation = beginDeliveryCorrelation();
	const sessionKey = ctxPayload.SessionKey;
	const resolveCurrentTurnTranscriptFinalText = async () => {
		if (!sessionKey) return;
		try {
			const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
			const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, { skipCache: true });
			const sessionEntry = resolveSessionStoreEntry({
				store,
				sessionKey
			}).existing;
			if (!sessionEntry?.sessionId) return;
			const { sessionFile } = await resolveAndPersistSessionFile({
				sessionId: sessionEntry.sessionId,
				sessionKey,
				sessionStore: store,
				storePath,
				sessionEntry,
				agentId: route.agentId,
				sessionsDir: path.dirname(storePath)
			});
			const latest = await readLatestAssistantTextFromSessionTranscript(sessionFile);
			if (!latest?.timestamp || latest.timestamp < dispatchStartedAt) return;
			return latest.text;
		} catch (err) {
			logVerbose(`telegram transcript final candidate lookup failed: ${formatErrorMessage(err)}`);
			return;
		}
	};
	const deliveryBaseOptions = {
		chatId: String(chatId),
		accountId: route.accountId,
		sessionKeyForInternalHooks: ctxPayload.SessionKey,
		mirrorIsGroup: isGroup,
		mirrorGroupId: isGroup ? String(chatId) : void 0,
		token: opts.token,
		runtime,
		bot,
		mediaLocalRoots,
		mediaMaxBytes: (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
		replyToMode,
		textLimit,
		thread: threadSpec,
		tableMode,
		chunkMode,
		linkPreview: telegramCfg.linkPreview,
		replyQuoteMessageId,
		replyQuoteText,
		replyQuotePosition,
		replyQuoteEntities,
		replyQuoteByMessageId,
		transcriptMirror: sessionKey ? async (payload) => {
			await mirrorTelegramAssistantReplyToTranscript({
				cfg,
				route,
				sessionKey,
				telegramDeps,
				payload
			});
		} : void 0
	};
	const silentErrorReplies = telegramCfg.silentErrorReplies === true;
	const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
	let queuedFinal = false;
	let suppressSilentReplyFallback = false;
	let hadErrorReplyFailureOrSkip = false;
	let isFirstTurnInSession = false;
	let dispatchError;
	try {
		const sticker = ctxPayload.Sticker;
		if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
			const agentDir = resolveAgentDir(cfg, route.agentId);
			const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
			let description = sticker.cachedDescription ?? null;
			if (!description) description = await describeStickerImage({
				imagePath: ctxPayload.MediaPath,
				cfg,
				agentDir,
				agentId: route.agentId
			});
			if (description) {
				const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null].filter(Boolean).join(" ");
				const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
				sticker.cachedDescription = description;
				if (!stickerSupportsVision) {
					ctxPayload.Body = formattedDesc;
					ctxPayload.BodyForAgent = formattedDesc;
					pruneStickerMediaFromContext(ctxPayload, { stickerMediaIncluded: ctxPayload.StickerMediaIncluded });
				}
				cacheSticker({
					fileId: sticker.fileId,
					fileUniqueId: sticker.fileUniqueId,
					emoji: sticker.emoji,
					setName: sticker.setName,
					description,
					cachedAt: (/* @__PURE__ */ new Date()).toISOString(),
					receivedFrom: ctxPayload.From
				});
				logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
			}
		}
		const applyTextToPayload = (payload, text) => {
			if (payload.text === text) return payload;
			return {
				...payload,
				text
			};
		};
		const applyTextToFollowUpPayload = (payload, text) => {
			const { replyToId: _replyToId, replyToCurrent: _replyToCurrent, replyToTag: _replyToTag, ...followUp } = applyTextToPayload(payload, text);
			return followUp;
		};
		const splitFinalTextForStream = (text) => {
			return (chunkMode === "newline" ? chunkMarkdownTextWithMode(text, draftMaxChars, chunkMode) : [text]).flatMap((chunk) => markdownToTelegramChunks(chunk, draftMaxChars, { tableMode }).map((telegramChunk) => telegramChunk.text));
		};
		const applyQuoteReplyTarget = (payload) => {
			if (!implicitQuoteReplyTargetId || !currentMessageIdForQuoteReply || payload.replyToId !== currentMessageIdForQuoteReply || payload.replyToTag || payload.replyToCurrent) return payload;
			return {
				...payload,
				replyToId: implicitQuoteReplyTargetId
			};
		};
		const usesNativeTelegramQuote = (payload) => {
			if (replyQuoteText != null) return true;
			return payload.replyToId != null && replyQuoteByMessageId[payload.replyToId] != null;
		};
		const sendPayload = async (payload, options) => {
			if (isDispatchSuperseded()) return false;
			const deliverablePayload = applyQuoteReplyTarget(payload);
			const silent = options?.silent ?? (silentErrorReplies && payload.isError === true);
			const durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;
			if (options?.durable && durableDelivery) {
				const durable = await durableDelivery({
					cfg,
					channel: "telegram",
					to: String(chatId),
					accountId: route.accountId,
					agentId: route.agentId,
					ctxPayload,
					payload: deliverablePayload,
					info: { kind: "final" },
					replyToMode,
					threadId: threadSpec.id,
					formatting: {
						textLimit,
						tableMode,
						chunkMode
					},
					silent,
					requiredCapabilities: deriveDurableFinalDeliveryRequirements({
						payload: deliverablePayload,
						replyToId: deliverablePayload.replyToId,
						threadId: threadSpec.id,
						silent,
						payloadTransport: true,
						extraCapabilities: { nativeQuote: usesNativeTelegramQuote(deliverablePayload) }
					})
				});
				if (durable.status === "failed") throw durable.error;
				if (durable.status === "handled_visible") {
					deliveryState.markDelivered();
					return true;
				}
				if (durable.status === "handled_no_send") return false;
			}
			const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
				...deliveryBaseOptions,
				transcriptMirror: options?.durable ? deliveryBaseOptions.transcriptMirror : void 0,
				replies: [deliverablePayload],
				onVoiceRecording: sendRecordVoice,
				silent,
				mediaLoader: telegramDeps.loadWebMedia
			});
			if (result.delivered) deliveryState.markDelivered();
			return result.delivered;
		};
		const emitPreviewFinalizedHook = (result) => {
			if (isDispatchSuperseded() || result.kind !== "preview-finalized") return;
			(telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
				sessionKeyForInternalHooks: deliveryBaseOptions.sessionKeyForInternalHooks,
				chatId: deliveryBaseOptions.chatId,
				accountId: deliveryBaseOptions.accountId,
				content: result.delivery.content,
				success: true,
				messageId: result.delivery.messageId,
				isGroup: deliveryBaseOptions.mirrorIsGroup,
				groupId: deliveryBaseOptions.mirrorGroupId
			});
			if (deliveryBaseOptions.transcriptMirror && result.delivery.content) deliveryBaseOptions.transcriptMirror({ text: result.delivery.content }).catch((err) => {
				logVerbose(`telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`);
			});
		};
		const deliverLaneText = createLaneTextDeliverer({
			lanes,
			draftMaxChars,
			applyTextToPayload,
			applyTextToFollowUpPayload,
			splitFinalTextForStream,
			sendPayload,
			flushDraftLane,
			stopDraftLane: async (lane) => {
				await lane.stream?.stop();
			},
			clearDraftLane: async (lane) => {
				await lane.stream?.clear();
			},
			editStreamMessage: async ({ messageId, text, buttons }) => {
				if (isDispatchSuperseded()) return;
				await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
					api: bot.api,
					cfg,
					accountId: route.accountId,
					linkPreview: telegramCfg.linkPreview,
					buttons
				});
			},
			resolveFinalTextCandidate: () => resolveCurrentTurnTranscriptFinalText(),
			log: logVerbose,
			markDelivered: () => {
				deliveryState.markDelivered();
			}
		});
		const deliverProgressModeFinalAnswer = async (payload, text) => {
			if (activeAnswerDraftIsToolProgressOnly) await rotateAnswerLaneAfterToolProgress();
			else {
				await answerLane.stream?.clear();
				resetDraftLaneState(answerLane);
			}
			if (!await sendPayload(applyTextToPayload(payload, text), { durable: true })) return { kind: "skipped" };
			answerLane.finalized = true;
			finalAnswerDelivered = true;
			return { kind: "sent" };
		};
		const resolveTranscriptBackedFinalText = async (text) => await resolveTranscriptBackedChannelFinalText({
			finalText: text,
			resolveCandidateText: resolveCurrentTurnTranscriptFinalText
		});
		if (isDmTopic) try {
			const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
			const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, { skipCache: true });
			const sessionKey = ctxPayload.SessionKey;
			if (sessionKey) isFirstTurnInSession = !resolveSessionStoreEntry({
				store,
				sessionKey
			}).existing?.systemSent;
			else logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
		} catch (err) {
			logVerbose(`auto-topic-label: session store error: ${formatErrorMessage(err)}`);
		}
		if (statusReactionController && !isRoomEvent) statusReactionController.setThinking();
		const { onModelSelected, ...replyPipeline } = (telegramDeps.createChannelMessageReplyPipeline ?? createChannelReplyPipeline)({
			cfg,
			agentId: route.agentId,
			channel: "telegram",
			accountId: route.accountId,
			typing: {
				start: sendTyping,
				onStartError: (err) => {
					logTypingFailure({
						log: logVerbose,
						channel: "telegram",
						target: String(chatId),
						error: err
					});
				}
			}
		});
		try {
			const turnResult = await runInboundReplyTurn({
				channel: "telegram",
				accountId: route.accountId,
				raw: context,
				adapter: {
					ingest: () => ({
						id: ctxPayload.MessageSid ?? `${chatId}:${Date.now()}`,
						timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : void 0,
						rawText: ctxPayload.RawBody ?? "",
						textForAgent: ctxPayload.BodyForAgent,
						textForCommands: ctxPayload.CommandBody,
						raw: context
					}),
					resolveTurn: () => ({
						channel: "telegram",
						accountId: route.accountId,
						routeSessionKey: route.sessionKey,
						storePath: context.turn.storePath,
						ctxPayload,
						recordInboundSession: context.turn.recordInboundSession,
						record: context.turn.record,
						runDispatch: () => {
							const sentBlockMediaUrls = /* @__PURE__ */ new Set();
							return telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
								ctx: ctxPayload,
								cfg,
								dispatcherOptions: {
									...replyPipeline,
									beforeDeliver: async (payload) => payload,
									deliver: async (payload, info) => {
										if (isDispatchSuperseded()) return;
										if (payload.isError === true) hadErrorReplyFailureOrSkip = true;
										const deduped = info.kind === "final" ? deduplicateBlockSentMedia(payload, sentBlockMediaUrls) : payload;
										if (deduped === void 0) return;
										const effectivePayload = deduped;
										if (shouldSuppressLocalTelegramExecApprovalPrompt({
											cfg,
											accountId: route.accountId,
											payload
										})) {
											queuedFinal = true;
											return;
										}
										const telegramButtons = resolvePayloadTelegramInlineButtons(effectivePayload);
										const split = splitTextIntoLaneSegments({ text: effectivePayload.text }, payload.isReasoning);
										const segments = split.segments;
										const reply = resolveSendableOutboundReplyParts(effectivePayload);
										if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) finalAnswerDeliveryStarted = true;
										if (info.kind === "final") await enqueueDraftLaneEvent(async () => {});
										if (info.kind === "tool" && (finalAnswerDeliveryStarted || finalAnswerDelivered) && !reply.hasMedia && !hasExecApprovalPayload(effectivePayload)) return;
										const deliverFinalAnswerText = async (answerPayload, text, buttons) => {
											const finalText = await resolveTranscriptBackedFinalText(text);
											if (streamMode === "progress") return deliverProgressModeFinalAnswer(answerPayload, finalText);
											await rotateAnswerLaneAfterToolProgress();
											const result = await deliverLaneText({
												laneName: "answer",
												text: finalText,
												payload: answerPayload,
												infoKind: "final",
												buttons
											});
											if (result.kind !== "skipped") finalAnswerDelivered = true;
											return result;
										};
										const flushBufferedFinalAnswer = async () => {
											const buffered = reasoningStepState.takeBufferedFinalAnswer(replyFenceGeneration);
											if (!buffered) return;
											const bufferedButtons = resolvePayloadTelegramInlineButtons(buffered.payload);
											await deliverFinalAnswerText(buffered.payload, buffered.text, bufferedButtons);
											reasoningStepState.resetForNextStep();
										};
										let blockDelivered = false;
										for (const segment of segments) {
											if (segment.lane === "answer" && info.kind === "final" && reasoningStepState.shouldBufferFinalAnswer()) {
												reasoningStepState.bufferFinalAnswer({
													payload: effectivePayload,
													text: segment.update.text,
													bufferedGeneration: replyFenceGeneration
												});
												continue;
											}
											if (segment.lane === "reasoning") reasoningStepState.noteReasoningHint();
											if (segment.lane === "answer" && info.kind === "tool") {
												if (nativeToolProgressDraft && canUseNativeToolProgressDraft({
													payload: effectivePayload,
													reply,
													buttons: telegramButtons
												})) {
													if (await pushStreamToolProgress(segment.update.text)) {
														blockDelivered = true;
														continue;
													}
												}
												await prepareAnswerLaneForToolProgress();
											}
											const result = segment.lane === "answer" && info.kind === "final" ? await deliverFinalAnswerText(effectivePayload, segment.update.text, telegramButtons) : await deliverLaneText({
												laneName: segment.lane,
												text: segment.update.text,
												payload: effectivePayload,
												infoKind: info.kind,
												buttons: telegramButtons
											});
											if (info.kind === "final") emitPreviewFinalizedHook(result);
											blockDelivered = blockDelivered || result.kind !== "skipped";
											if (segment.lane === "reasoning") {
												if (result.kind !== "skipped") {
													reasoningStepState.noteReasoningDelivered();
													await flushBufferedFinalAnswer();
												}
												continue;
											}
											if (info.kind === "final") reasoningStepState.resetForNextStep();
										}
										const trackBlockMedia = (delivered) => {
											if (delivered && info.kind === "block" && payload.mediaUrls?.length) for (const url of payload.mediaUrls) sentBlockMediaUrls.add(url);
										};
										if (segments.length > 0) {
											trackBlockMedia(blockDelivered);
											return;
										}
										if (split.suppressedReasoningOnly) {
											let delivered = false;
											if (reply.hasMedia) delivered = await sendPayload(typeof effectivePayload.text === "string" ? {
												...effectivePayload,
												text: ""
											} : effectivePayload, { durable: info.kind === "final" });
											if (info.kind === "final" && delivered) finalAnswerDelivered = true;
											if (info.kind === "final") await flushBufferedFinalAnswer();
											trackBlockMedia(delivered);
											return;
										}
										if (info.kind === "final") {
											await rotateAnswerLaneAfterToolProgress();
											await answerLane.stream?.stop();
											await reasoningLane.stream?.stop();
											reasoningStepState.resetForNextStep();
										}
										if (!(reply.hasMedia || reply.text.length > 0)) {
											if (info.kind === "final") await flushBufferedFinalAnswer();
											return;
										}
										const delivered = await sendPayload(effectivePayload, { durable: info.kind === "final" });
										if (info.kind === "final" && delivered) finalAnswerDelivered = true;
										if (info.kind === "final") await flushBufferedFinalAnswer();
										trackBlockMedia(delivered);
									},
									onSkip: (payload, info) => {
										if (payload.isError === true) hadErrorReplyFailureOrSkip = true;
										if (info.reason !== "silent") deliveryState.markNonSilentSkip();
									},
									onError: (err, info) => {
										const errorPolicy = resolveTelegramErrorPolicy({
											accountConfig: telegramCfg,
											groupConfig,
											topicConfig
										});
										if (isSilentErrorPolicy(errorPolicy.policy)) return;
										if (errorPolicy.policy === "once" && shouldSuppressTelegramError({
											scopeKey: buildTelegramErrorScopeKey({
												accountId: route.accountId,
												chatId,
												threadId: threadSpec.id
											}),
											cooldownMs: errorPolicy.cooldownMs,
											errorMessage: String(err)
										})) return;
										deliveryState.markNonSilentFailure();
										runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
									}
								},
								replyOptions: {
									skillFilter,
									disableBlockStreaming,
									abortSignal: replyAbortController.signal,
									sourceReplyDeliveryMode: isRoomEvent ? "message_tool_only" : void 0,
									queuedDeliveryCorrelations: isRoomEvent ? [{ begin: beginDeliveryCorrelation }] : void 0,
									queuedFollowupLifecycle: isRoomEvent ? {
										onEnqueued: () => {
											replyAbortControllerQueued = true;
										},
										onComplete: () => {
											replyAbortControllerQueued = false;
											releaseTelegramReplyFenceAbortController(activeReplyFenceKey, replyAbortController);
										}
									} : void 0,
									suppressTyping: isRoomEvent,
									onPartialReply: answerLane.stream || reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
										await ingestDraftLaneSegments(payload);
									}) : void 0,
									onReasoningStream: reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
										if (splitReasoningOnNextStream) {
											reasoningLane.stream?.forceNewMessage();
											resetDraftLaneState(reasoningLane);
											splitReasoningOnNextStream = false;
										}
										await ingestDraftLaneSegments(payload, true);
									}) : void 0,
									onAssistantMessageStart: answerLane.stream ? () => enqueueDraftLaneEvent(async () => {
										reasoningStepState.resetForNextStep();
										streamToolProgressSuppressed = false;
										streamToolProgressLines = [];
										if (answerLane.finalized) await rotateLaneForNewMessage(answerLane);
									}) : void 0,
									onReasoningEnd: reasoningLane.stream ? () => enqueueDraftLaneEvent(async () => {
										splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
										streamToolProgressSuppressed = false;
										streamToolProgressLines = [];
									}) : void 0,
									suppressDefaultToolProgressMessages: !streamDeliveryEnabled || Boolean(answerLane.stream),
									allowProgressCallbacksWhenSourceDeliverySuppressed: !isRoomEvent && Boolean(answerLane.stream),
									onToolStart: async (payload) => {
										const toolName = payload.name?.trim();
										const progressPromise = pushStreamToolProgress(formatChannelProgressDraftLineForEntry(telegramCfg, {
											event: "tool",
											name: toolName,
											phase: payload.phase,
											args: payload.args
										}, payload.detailMode ? { detailMode: payload.detailMode } : void 0), {
											toolName,
											startImmediately: true
										});
										if (statusReactionController && toolName) await statusReactionController.setTool(toolName);
										await progressPromise;
									},
									onItemEvent: async (payload) => {
										await pushStreamToolProgress(buildChannelProgressDraftLineForEntry(telegramCfg, {
											event: "item",
											itemId: payload.itemId,
											itemKind: payload.kind,
											title: payload.title,
											name: payload.name,
											phase: payload.phase,
											status: payload.status,
											summary: payload.summary,
											progressText: payload.progressText,
											meta: payload.meta
										}));
									},
									onPlanUpdate: async (payload) => {
										if (payload.phase !== "update") return;
										await pushStreamToolProgress(formatChannelProgressDraftLine({
											event: "plan",
											phase: payload.phase,
											title: payload.title,
											explanation: payload.explanation,
											steps: payload.steps
										}));
									},
									onApprovalEvent: async (payload) => {
										if (payload.phase !== "requested") return;
										await pushStreamToolProgress(formatChannelProgressDraftLine({
											event: "approval",
											phase: payload.phase,
											title: payload.title,
											command: payload.command,
											reason: payload.reason,
											message: payload.message
										}));
									},
									onCommandOutput: async (payload) => {
										if (payload.phase !== "end") return;
										await pushStreamToolProgress(formatChannelProgressDraftLine({
											event: "command-output",
											phase: payload.phase,
											title: payload.title,
											name: payload.name,
											status: payload.status,
											exitCode: payload.exitCode
										}));
									},
									onPatchSummary: async (payload) => {
										if (payload.phase !== "end") return;
										await pushStreamToolProgress(formatChannelProgressDraftLine({
											event: "patch",
											phase: payload.phase,
											title: payload.title,
											name: payload.name,
											added: payload.added,
											modified: payload.modified,
											deleted: payload.deleted,
											summary: payload.summary
										}));
									},
									onCompactionStart: statusReactionController ? async () => {
										await statusReactionController.setCompacting();
									} : void 0,
									onCompactionEnd: statusReactionController ? async () => {
										statusReactionController.cancelPending();
										await statusReactionController.setThinking();
									} : void 0,
									onModelSelected
								}
							});
						}
					})
				}
			});
			if (!turnResult.dispatched) return;
			({queuedFinal} = turnResult.dispatchResult);
			suppressSilentReplyFallback = turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
		} catch (err) {
			dispatchError = err;
			runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
		} finally {
			progressDraftGate.cancel();
			await draftLaneEventQueue;
			nativeToolProgressDraft?.stop();
			const lanesToCleanup = [{
				laneName: "answer",
				lane: answerLane
			}, {
				laneName: "reasoning",
				lane: reasoningLane
			}];
			for (const { lane } of lanesToCleanup) {
				const stream = lane.stream;
				if (!stream) continue;
				if (isDispatchSuperseded()) {
					await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
					continue;
				}
				if (lane.finalized) await stream.stop();
				else await stream.clear();
			}
		}
	} finally {
		dispatchWasSuperseded = isDispatchSuperseded();
		releaseReplyFence();
		endTelegramInboundEventDeliveryCorrelation();
	}
	if (dispatchWasSuperseded) {
		if (statusReactionController) finalizeTelegramStatusReaction({
			outcome: "done",
			hasFinalResponse: true
		}).catch((err) => {
			logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
		});
		else removeAckReactionAfterReply({
			removeAfterReply: removeAckAfterReply,
			ackReactionPromise,
			ackReactionValue: ackReactionPromise ? "ack" : null,
			remove: () => (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
			onError: (err) => {
				if (!msg.message_id) return;
				logAckFailure({
					log: logVerbose,
					channel: "telegram",
					target: `${chatId}/${msg.message_id}`,
					error: err
				});
			}
		});
		if (!isRoomEvent || deliveryState.snapshot().delivered) clearGroupHistory();
		return;
	}
	let sentFallback = false;
	const deliverySummary = deliveryState.snapshot();
	if (!isRoomEvent && (dispatchError || !deliverySummary.delivered && (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0))) {
		const fallbackText = dispatchError ? "Something went wrong while processing your request. Please try again." : EMPTY_RESPONSE_FALLBACK;
		sentFallback = (await (telegramDeps.deliverReplies ?? deliverReplies)({
			replies: [{ text: fallbackText }],
			...deliveryBaseOptions,
			silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
			mediaLoader: telegramDeps.loadWebMedia
		})).delivered;
	}
	if (!sentFallback && !dispatchError && !deliverySummary.delivered && !suppressSilentReplyFallback && !queuedFinal && isGroup) {
		const policySessionKey = ctxPayload.CommandSource === "native" ? ctxPayload.CommandTargetSessionKey ?? ctxPayload.SessionKey : ctxPayload.SessionKey;
		const silentReplyFallback = projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
			cfg,
			sessionKey: policySessionKey,
			surface: "telegram"
		}));
		if (silentReplyFallback.length > 0) sentFallback = (await (telegramDeps.deliverReplies ?? deliverReplies)({
			replies: silentReplyFallback,
			...deliveryBaseOptions,
			silent: false,
			mediaLoader: telegramDeps.loadWebMedia
		})).delivered;
		silentReplyDispatchLogger.debug("telegram turn ended without visible final response", {
			hasSessionKey: Boolean(policySessionKey),
			hasChatId: chatId != null,
			queuedFinal,
			sentFallback
		});
	}
	const hasFinalResponse = deliverySummary.delivered || sentFallback || suppressSilentReplyFallback || queuedFinal;
	if (statusReactionController && !hasFinalResponse) finalizeTelegramStatusReaction({
		outcome: "error",
		hasFinalResponse: false
	}).catch((err) => {
		logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
	});
	const shouldClearGroupHistory = !isRoomEvent || deliverySummary.delivered || sentFallback || queuedFinal;
	if (!hasFinalResponse) {
		if (!shouldClearGroupHistory) return;
		clearGroupHistory();
		return;
	}
	if (isDmTopic && isFirstTurnInSession) {
		const userMessage = (ctxPayload.RawBody ?? ctxPayload.Body ?? "").slice(0, 500);
		if (userMessage.trim()) {
			const agentDir = resolveAgentDir(cfg, route.agentId);
			const directAutoTopicLabel = !isGroup && groupConfig && "autoTopicLabel" in groupConfig ? groupConfig.autoTopicLabel : void 0;
			const accountAutoTopicLabel = telegramCfg?.autoTopicLabel;
			const autoTopicConfig = resolveAutoTopicLabelConfig(directAutoTopicLabel, accountAutoTopicLabel);
			if (autoTopicConfig) {
				const topicThreadId = threadSpec.id;
				(async () => {
					try {
						const label = await generateTelegramTopicLabel({
							userMessage,
							prompt: autoTopicConfig.prompt,
							cfg,
							agentId: route.agentId,
							agentDir
						});
						if (!label) {
							logVerbose("auto-topic-label: LLM returned empty label");
							return;
						}
						logVerbose(`auto-topic-label: generated label (len=${label.length})`);
						await bot.api.editForumTopic(chatId, topicThreadId, { name: label });
						logVerbose(`auto-topic-label: renamed topic ${chatId}/${topicThreadId}`);
					} catch (err) {
						logVerbose(`auto-topic-label: failed: ${formatErrorMessage(err)}`);
					}
				})();
			}
		}
	}
	if (statusReactionController) finalizeTelegramStatusReaction({
		outcome: dispatchError || sentFallback ? "error" : "done",
		hasFinalResponse: true
	}).catch((err) => {
		logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
	});
	else removeAckReactionAfterReply({
		removeAfterReply: removeAckAfterReply,
		ackReactionPromise,
		ackReactionValue: ackReactionPromise ? "ack" : null,
		remove: () => (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
		onError: (err) => {
			if (!msg.message_id) return;
			logAckFailure({
				log: logVerbose,
				channel: "telegram",
				target: `${chatId}/${msg.message_id}`,
				error: err
			});
		}
	});
	if (shouldClearGroupHistory) clearGroupHistory();
};
//#endregion
//#region extensions/telegram/src/bot-message.ts
const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");
function formatTelegramInboundLogLine(params) {
	const kindLabel = params.mediaType ? `, ${params.mediaType}` : "";
	return `Inbound message ${params.from} -> ${params.to} (${params.chatType}${kindLabel}, ${params.body.length} chars)`;
}
const createTelegramMessageProcessor = (deps) => {
	const { bot, cfg, account, telegramCfg, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, loadFreshConfig, sendChatActionHandler, runtime, replyToMode, streamMode, textLimit, telegramDeps, opts } = deps;
	const sessionRuntime = {
		...telegramDeps.buildChannelInboundEventContext ? { buildChannelInboundEventContext: telegramDeps.buildChannelInboundEventContext } : {},
		...telegramDeps.readSessionUpdatedAt ? { readSessionUpdatedAt: telegramDeps.readSessionUpdatedAt } : {},
		...telegramDeps.recordInboundSession ? { recordInboundSession: telegramDeps.recordInboundSession } : {},
		...telegramDeps.resolveInboundLastRouteSessionKey ? { resolveInboundLastRouteSessionKey: telegramDeps.resolveInboundLastRouteSessionKey } : {},
		...telegramDeps.resolvePinnedMainDmOwnerFromAllowlist ? { resolvePinnedMainDmOwnerFromAllowlist: telegramDeps.resolvePinnedMainDmOwnerFromAllowlist } : {},
		resolveStorePath: telegramDeps.resolveStorePath
	};
	const contextRuntime = telegramDeps.recordChannelActivity ? { recordChannelActivity: telegramDeps.recordChannelActivity } : void 0;
	return async (primaryCtx, allMedia, storeAllowFrom, options, replyMedia, replyChain, promptContext, lifecycle) => {
		const ingressReceivedAtMs = typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs) ? options.receivedAtMs : void 0;
		const ingressDebugEnabled = shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
		const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : void 0;
		const context = await buildTelegramMessageContext({
			primaryCtx,
			allMedia,
			replyMedia,
			replyChain,
			promptContext,
			storeAllowFrom,
			options,
			bot,
			cfg,
			account,
			historyLimit,
			groupHistories,
			dmPolicy,
			allowFrom,
			groupAllowFrom,
			ackReactionScope,
			logger,
			resolveGroupActivation,
			resolveGroupRequireMention,
			resolveTelegramGroupConfig,
			sendChatActionHandler,
			loadFreshConfig,
			runtime: contextRuntime,
			sessionRuntime,
			upsertPairingRequest: telegramDeps.upsertChannelPairingRequest
		});
		if (!context) {
			if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) logVerbose(`telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""));
			return false;
		}
		if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) logVerbose(`telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs} preDispatchMs=${Date.now() - ingressContextStartMs}` + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""));
		if (context.ctxPayload.InboundEventKind !== "room_event") context.sendTyping().catch((err) => {
			logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
		});
		telegramInboundLog.info(formatTelegramInboundLogLine({
			from: context.ctxPayload.From,
			to: context.primaryCtx.me?.username ? `@${context.primaryCtx.me.username}` : context.ctxPayload.To,
			chatType: context.ctxPayload.ChatType,
			body: context.ctxPayload.RawBody,
			mediaType: allMedia[0]?.contentType
		}));
		await lifecycle?.onDispatchStart?.();
		try {
			await dispatchTelegramMessage({
				context,
				bot,
				cfg,
				runtime,
				replyToMode,
				streamMode,
				textLimit,
				telegramCfg,
				telegramDeps,
				opts
			});
			if (ingressDebugEnabled && ingressReceivedAtMs) logVerbose(`telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""));
		} catch (err) {
			runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
			try {
				await bot.api.sendMessage(context.chatId, "Something went wrong while processing your request. Please try again.", buildTelegramThreadParams(context.threadSpec));
			} catch {}
		}
		return true;
	};
};
//#endregion
//#region extensions/telegram/src/bot-update-tracker.ts
function sortedIds(ids) {
	return [...ids].toSorted((a, b) => a - b);
}
function createTelegramUpdateTracker(options = {}) {
	const initialUpdateId = typeof options.initialUpdateId === "number" ? options.initialUpdateId : null;
	const persistenceFloorUpdateId = typeof options.persistenceFloorUpdateId === "number" ? options.persistenceFloorUpdateId : initialUpdateId;
	const ackPolicy = options.ackPolicy ?? "after_receive_record";
	const recentUpdates = createTelegramUpdateDedupe();
	const pendingUpdateKeys = /* @__PURE__ */ new Set();
	const activeHandledUpdateKeys = /* @__PURE__ */ new Map();
	const pendingUpdateIds = /* @__PURE__ */ new Set();
	const failedUpdateIds = /* @__PURE__ */ new Set();
	const completedFloorReplayUpdateIds = /* @__PURE__ */ new Set();
	let highestAcceptedUpdateId = initialUpdateId;
	let highestPersistedAcceptedUpdateId = persistenceFloorUpdateId;
	let highestPersistenceRequestedUpdateId = persistenceFloorUpdateId;
	let highestCompletedUpdateId = persistenceFloorUpdateId;
	let persistInFlight = false;
	let persistTargetUpdateId = null;
	const skip = (key) => {
		options.onSkip?.(key);
	};
	const drainPersistQueue = async () => {
		const persist = options.onAcceptedUpdateId;
		if (persistInFlight || typeof persist !== "function") return;
		persistInFlight = true;
		try {
			while (persistTargetUpdateId !== null) {
				const updateId = persistTargetUpdateId;
				persistTargetUpdateId = null;
				try {
					await persist(updateId);
					if (highestPersistedAcceptedUpdateId === null || updateId > highestPersistedAcceptedUpdateId) highestPersistedAcceptedUpdateId = updateId;
				} catch (err) {
					options.onPersistError?.(err);
				}
			}
		} finally {
			persistInFlight = false;
		}
	};
	const requestPersistAcceptedUpdateId = (updateId) => {
		if (typeof options.onAcceptedUpdateId !== "function") return;
		if (highestPersistenceRequestedUpdateId !== null && updateId <= highestPersistenceRequestedUpdateId) return;
		highestPersistenceRequestedUpdateId = updateId;
		persistTargetUpdateId = updateId;
		drainPersistQueue().catch((err) => {
			options.onPersistError?.(err);
		});
	};
	const acceptUpdateId = (updateId) => {
		if (highestAcceptedUpdateId !== null && updateId <= highestAcceptedUpdateId) return;
		highestAcceptedUpdateId = updateId;
	};
	const isFloorReplayUpdateId = (updateId) => initialUpdateId === null && persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId;
	function resolveSafeCompletedUpdateId() {
		if (highestCompletedUpdateId === null) return null;
		let safeCompletedUpdateId = highestCompletedUpdateId;
		for (const updateId of pendingUpdateIds) {
			if (persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId) continue;
			if (updateId <= safeCompletedUpdateId) safeCompletedUpdateId = updateId - 1;
		}
		for (const updateId of failedUpdateIds) {
			if (persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId) continue;
			if (updateId <= safeCompletedUpdateId) safeCompletedUpdateId = updateId - 1;
		}
		return safeCompletedUpdateId;
	}
	const persistUpdateIdAfterAck = async (updateId) => {
		const persistUpdateId = ackPolicy === "after_agent_dispatch" ? resolveSafeCompletedUpdateId() : updateId;
		if (persistUpdateId !== null) requestPersistAcceptedUpdateId(persistUpdateId);
	};
	const ackUpdateAfterStage = (receiveContext, stage) => {
		if (!receiveContext?.shouldAckAfter(stage)) return;
		receiveContext.ack().catch((err) => {
			options.onPersistError?.(err);
		});
	};
	const beginUpdate = (ctx) => {
		const updateId = resolveTelegramUpdateId(ctx);
		const updateKey = buildTelegramUpdateKey(ctx);
		if (typeof updateId === "number") if (highestAcceptedUpdateId !== null && updateId <= highestAcceptedUpdateId) {
			const floorReplay = isFloorReplayUpdateId(updateId);
			if (!floorReplay && !failedUpdateIds.has(updateId)) {
				skip(`update:${updateId}`);
				return {
					accepted: false,
					reason: "accepted-watermark"
				};
			}
			if (floorReplay && completedFloorReplayUpdateIds.has(updateId)) {
				skip(`update:${updateId}`);
				return {
					accepted: false,
					reason: "accepted-watermark"
				};
			}
		} else failedUpdateIds.delete(updateId);
		if (updateKey) {
			if (pendingUpdateKeys.has(updateKey) || recentUpdates.peek(updateKey)) {
				skip(updateKey);
				return {
					accepted: false,
					reason: "semantic-dedupe"
				};
			}
			pendingUpdateKeys.add(updateKey);
			activeHandledUpdateKeys.set(updateKey, false);
		}
		let receiveContext;
		if (typeof updateId === "number") {
			pendingUpdateIds.add(updateId);
			acceptUpdateId(updateId);
			receiveContext = createMessageReceiveContext({
				id: updateKey ?? `telegram:update:${updateId}`,
				channel: "telegram",
				message: ctx,
				ackPolicy,
				onAck: () => persistUpdateIdAfterAck(updateId)
			});
			ackUpdateAfterStage(receiveContext, "receive_record");
		}
		return {
			accepted: true,
			update: {
				...updateKey ? { key: updateKey } : {},
				...typeof updateId === "number" ? { updateId } : {},
				...receiveContext ? { receiveContext } : {}
			}
		};
	};
	const finishUpdate = (update, finish) => {
		if (update.key) {
			activeHandledUpdateKeys.delete(update.key);
			if (finish.completed) recentUpdates.check(update.key);
			pendingUpdateKeys.delete(update.key);
		}
		if (typeof update.updateId === "number") {
			pendingUpdateIds.delete(update.updateId);
			if (finish.completed) {
				failedUpdateIds.delete(update.updateId);
				if (isFloorReplayUpdateId(update.updateId)) completedFloorReplayUpdateIds.add(update.updateId);
				if (highestCompletedUpdateId === null || update.updateId > highestCompletedUpdateId) highestCompletedUpdateId = update.updateId;
				ackUpdateAfterStage(update.receiveContext, "agent_dispatch");
			} else {
				failedUpdateIds.add(update.updateId);
				update.receiveContext?.nack(/* @__PURE__ */ new Error("Telegram update handler did not complete")).catch((err) => {
					options.onPersistError?.(err);
				});
			}
		}
	};
	const shouldSkipHandlerDispatch = (ctx) => {
		const updateId = resolveTelegramUpdateId(ctx);
		if (typeof updateId === "number" && initialUpdateId !== null && updateId <= initialUpdateId) return true;
		const key = buildTelegramUpdateKey(ctx);
		if (!key) return false;
		const handled = activeHandledUpdateKeys.get(key);
		if (handled != null) {
			if (handled) {
				skip(key);
				return true;
			}
			activeHandledUpdateKeys.set(key, true);
			return false;
		}
		const skipped = recentUpdates.check(key);
		if (skipped) skip(key);
		return skipped;
	};
	const getState = () => ({
		highestAcceptedUpdateId,
		highestPersistedAcceptedUpdateId,
		highestCompletedUpdateId,
		safeCompletedUpdateId: resolveSafeCompletedUpdateId(),
		pendingUpdateIds: sortedIds(pendingUpdateIds),
		failedUpdateIds: sortedIds(failedUpdateIds)
	});
	return {
		beginUpdate,
		finishUpdate,
		getState,
		shouldSkipHandlerDispatch
	};
}
//#endregion
//#region extensions/telegram/src/raw-update-log.ts
const MAX_RAW_UPDATE_STRING = 500;
const MAX_RAW_UPDATE_ARRAY = 20;
const REDACTED_TELEGRAM_FIELD = "[redacted]";
const TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS = new Set([
	"added_to_attachment_menu",
	"author_signature",
	"caption",
	"chat_instance",
	"data",
	"email",
	"bio",
	"description",
	"explanation",
	"file_id",
	"file_unique_id",
	"first_name",
	"invite_link",
	"is_premium",
	"language_code",
	"latitude",
	"last_name",
	"longitude",
	"name",
	"phone_number",
	"question",
	"query",
	"text",
	"title",
	"url",
	"username",
	"vcard"
]);
const TELEGRAM_RAW_UPDATE_ALLOWED_ID_KEYS = new Set(["message_id", "update_id"]);
const TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS = new Set([
	"chat_id",
	"custom_emoji_id",
	"inline_message_id",
	"migrate_from_chat_id",
	"migrate_to_chat_id",
	"option_ids",
	"poll_id",
	"sender_chat_id",
	"user_id",
	"user_chat_id"
]);
function shouldRedactTelegramRawUpdateValue(key, parentKey) {
	if (!key) return false;
	if (TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS.has(key)) return true;
	if (TELEGRAM_RAW_UPDATE_ALLOWED_ID_KEYS.has(key)) return false;
	if (TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS.has(key)) return true;
	if (key === "id" || key.endsWith("_id") || key.endsWith("_ids")) return parentKey !== void 0;
	return false;
}
function isTelegramUserObject(value) {
	return typeof value.id === "number" && typeof value.is_bot === "boolean" && typeof value.first_name === "string";
}
function stringifyTelegramRawUpdateForLog(update) {
	const seen = /* @__PURE__ */ new WeakSet();
	const transform = (value, key = "", parentKey) => {
		if (shouldRedactTelegramRawUpdateValue(key, parentKey)) return REDACTED_TELEGRAM_FIELD;
		if (typeof value === "string") return value.length > MAX_RAW_UPDATE_STRING ? `${value.slice(0, MAX_RAW_UPDATE_STRING)}...` : value;
		if (Array.isArray(value)) {
			const items = value.slice(0, MAX_RAW_UPDATE_ARRAY).map((item) => transform(item, key, key));
			if (value.length > MAX_RAW_UPDATE_ARRAY) items.push(`...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`);
			return items;
		}
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
			const record = value;
			if (isTelegramUserObject(record)) return REDACTED_TELEGRAM_FIELD;
			const redacted = {};
			for (const [entryKey, entryValue] of Object.entries(record)) redacted[entryKey] = transform(entryValue, entryKey, key);
			return redacted;
		}
		return value;
	};
	return JSON.stringify(transform(update ?? null));
}
//#endregion
//#region extensions/telegram/src/sendchataction-401-backoff.ts
const BACKOFF_POLICY = {
	initialMs: 1e3,
	maxMs: 3e5,
	factor: 2,
	jitter: .1
};
function is401Error(error) {
	if (!error) return false;
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	return message.includes("401") || normalizeLowercaseStringOrEmpty(message).includes("unauthorized");
}
/**
* Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
* across all message contexts. This prevents the infinite loop that caused Telegram
* to delete bots (issue #27092).
*
* When a 401 occurs, exponential backoff is applied (1s → 2s → 4s → ... → 5min).
* After maxConsecutive401 failures (default 10), all sendChatAction calls are
* suspended until reset() is called.
*/
function createTelegramSendChatActionHandler({ sendChatActionFn, logger, maxConsecutive401 = 10, minIntervalMs = 0, now = () => Date.now() }) {
	let consecutive401Failures = 0;
	let suspended = false;
	const blockedUntilByKey = /* @__PURE__ */ new Map();
	const reset = () => {
		consecutive401Failures = 0;
		suspended = false;
		blockedUntilByKey.clear();
	};
	const sendChatAction = async (chatId, action, threadParams) => {
		if (suspended) return;
		const key = minIntervalMs > 0 ? `${String(chatId)}:${action}` : void 0;
		const attemptedAt = key ? now() : 0;
		if (key) {
			const blockedUntil = blockedUntilByKey.get(key);
			if (blockedUntil !== void 0 && attemptedAt < blockedUntil) return;
			blockedUntilByKey.set(key, Number.POSITIVE_INFINITY);
		}
		if (consecutive401Failures > 0) {
			const backoffMs = computeBackoff(BACKOFF_POLICY, consecutive401Failures);
			logger(`sendChatAction backoff: waiting ${backoffMs}ms before retry (failure ${consecutive401Failures}/${maxConsecutive401})`);
			await sleepWithAbort(backoffMs);
		}
		try {
			await sendChatActionFn(chatId, action, threadParams);
			if (consecutive401Failures > 0) {
				logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
				consecutive401Failures = 0;
			}
		} catch (error) {
			if (is401Error(error)) {
				consecutive401Failures++;
				if (consecutive401Failures >= maxConsecutive401) {
					suspended = true;
					logger(`CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. Bot token is likely invalid. Telegram may DELETE the bot if requests continue. Replace the token and restart: openclaw channels restart telegram`);
				} else logger(`sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). Retrying with exponential backoff.`);
			}
			throw error;
		} finally {
			if (key) blockedUntilByKey.set(key, attemptedAt + minIntervalMs);
		}
	};
	return {
		sendChatAction,
		isSuspended: () => suspended,
		reset
	};
}
//#endregion
//#region extensions/telegram/src/bot-core.ts
function resolveTelegramScopedGroupConfig(telegramCfg, chatId, messageThreadId) {
	const groups = telegramCfg.groups;
	const direct = telegramCfg.direct;
	const chatIdStr = String(chatId);
	if (!chatIdStr.startsWith("-")) {
		const groupConfig = direct?.[chatIdStr] ?? direct?.["*"];
		return {
			groupConfig,
			topicConfig: groupConfig && messageThreadId != null ? groupConfig.topics?.[String(messageThreadId)] : void 0
		};
	}
	const groupConfig = groups?.[chatIdStr] ?? groups?.["*"];
	return {
		groupConfig,
		topicConfig: groupConfig && messageThreadId != null ? groupConfig.topics?.[String(messageThreadId)] : void 0
	};
}
const DEFAULT_TELEGRAM_BOT_RUNTIME = {
	Bot,
	sequentialize,
	apiThrottler
};
const TELEGRAM_TYPING_COALESCE_MS = 4e3;
function createTelegramBotCore(opts) {
	const botRuntime = DEFAULT_TELEGRAM_BOT_RUNTIME;
	const runtime = opts.runtime ?? createNonExitingRuntime();
	const telegramDeps = opts.telegramDeps;
	const cfg = opts.config ?? telegramDeps.getRuntimeConfig();
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const threadBindingManager = resolveThreadBindingSpawnPolicy({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		kind: "subagent"
	}).enabled ? createTelegramThreadBindingManager({
		cfg,
		accountId: account.accountId,
		idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		}),
		maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		})
	}) : null;
	const telegramCfg = account.config;
	const telegramTransport = opts.telegramTransport ?? resolveTelegramTransport(opts.proxyFetch, { network: telegramCfg.network });
	const finalFetch = createTelegramClientFetch({
		fetchImpl: asTelegramClientFetch(telegramTransport.fetch),
		timeoutSeconds: telegramCfg?.timeoutSeconds,
		shutdownSignal: opts.fetchAbortSignal,
		transport: telegramTransport
	});
	const timeoutSeconds = resolveTelegramClientTimeoutSeconds({
		value: telegramCfg?.timeoutSeconds,
		minimum: resolveTelegramClientTimeoutMinimumSeconds([opts.minimumClientTimeoutSeconds, resolveTelegramOutboundClientTimeoutFloorSeconds(telegramCfg?.timeoutSeconds)])
	});
	const apiRoot = normalizeOptionalString(telegramCfg.apiRoot);
	const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : void 0;
	const client = finalFetch || timeoutSeconds || normalizedApiRoot ? {
		...finalFetch ? { fetch: asTelegramClientFetch(finalFetch) } : {},
		...timeoutSeconds ? { timeoutSeconds } : {},
		...normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}
	} : void 0;
	const botConfig = client || opts.botInfo ? {
		...client ? { client } : {},
		...opts.botInfo ? { botInfo: opts.botInfo } : {}
	} : void 0;
	const bot = new botRuntime.Bot(opts.token, botConfig);
	bot.api.config.use(getOrCreateAccountThrottler(opts.token, botRuntime.apiThrottler));
	bot.catch((err) => {
		runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
	});
	const initialUpdateId = typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
	const logSkippedUpdate = (key) => {
		if (shouldLogVerbose()) logVerbose(`telegram dedupe: skipped ${key}`);
	};
	const updateTracker = createTelegramUpdateTracker({
		initialUpdateId,
		persistenceFloorUpdateId: typeof opts.updateOffset?.persistenceFloorUpdateId === "number" ? opts.updateOffset.persistenceFloorUpdateId : initialUpdateId,
		ackPolicy: "after_agent_dispatch",
		...typeof opts.updateOffset?.onUpdateId === "function" ? { onAcceptedUpdateId: opts.updateOffset.onUpdateId } : {},
		onPersistError: (err) => {
			runtime.error?.(`telegram: failed to persist update watermark: ${formatErrorMessage(err)}`);
		},
		onSkip: logSkippedUpdate
	});
	const shouldSkipUpdate = (ctx) => updateTracker.shouldSkipHandlerDispatch(ctx);
	bot.use(async (ctx, next) => {
		const begin = updateTracker.beginUpdate(ctx);
		if (!begin.accepted) return;
		let completed = false;
		try {
			await next();
			completed = true;
		} finally {
			updateTracker.finishUpdate(begin.update, { completed });
		}
	});
	bot.use(botRuntime.sequentialize(getTelegramSequentialKey));
	const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
	const MAX_RAW_UPDATE_CHARS = 8e3;
	bot.use(async (ctx, next) => {
		if (shouldLogVerbose()) try {
			const raw = stringifyTelegramRawUpdateForLog(ctx.update);
			const preview = raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
			rawUpdateLogger.debug(`telegram update: ${preview}`);
		} catch (err) {
			rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
		}
		await next();
	});
	const historyLimit = Math.max(0, telegramCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
	const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
	const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
	const groupAllowFrom = opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
	const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
	const nativeEnabled = resolveNativeCommandsEnabled({
		providerId: "telegram",
		providerSetting: telegramCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = resolveNativeSkillsEnabled({
		providerId: "telegram",
		providerSetting: telegramCfg.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
		providerSetting: telegramCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
	const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
	const logger = getChildLogger({ module: "telegram-auto-reply" });
	const streamMode = resolveTelegramStreamMode(telegramCfg);
	const resolveGroupPolicy = (chatId) => resolveChannelGroupPolicy({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		groupId: String(chatId)
	});
	const resolveGroupActivation = (params) => {
		const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
		const sessionKey = params.sessionKey ?? `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
		const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
		try {
			const loadSessionStore = telegramDeps.loadSessionStore;
			if (!loadSessionStore) return;
			const entry = loadSessionStore(storePath)[sessionKey];
			if (entry?.groupActivation === "always") return false;
			if (entry?.groupActivation === "mention") return true;
		} catch (err) {
			logVerbose(`Failed to load session for activation check: ${String(err)}`);
		}
	};
	const resolveGroupRequireMention = (chatId) => resolveChannelGroupRequireMention({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		groupId: String(chatId),
		requireMentionOverride: opts.requireMention,
		overrideOrder: "after-config"
	});
	const loadFreshTelegramAccountConfig = () => {
		try {
			return resolveTelegramAccount({
				cfg: telegramDeps.getRuntimeConfig(),
				accountId: account.accountId
			}).config;
		} catch (error) {
			logVerbose(`telegram: failed to load fresh config for account ${account.accountId}; using startup snapshot: ${String(error)}`);
			return telegramCfg;
		}
	};
	const resolveTelegramGroupConfig = (chatId, messageThreadId) => {
		return resolveTelegramScopedGroupConfig(loadFreshTelegramAccountConfig(), chatId, messageThreadId);
	};
	const processMessage = createTelegramMessageProcessor({
		bot,
		cfg,
		account,
		telegramCfg,
		historyLimit,
		groupHistories,
		dmPolicy,
		allowFrom,
		groupAllowFrom,
		ackReactionScope,
		logger,
		resolveGroupActivation,
		resolveGroupRequireMention,
		resolveTelegramGroupConfig,
		loadFreshConfig: () => telegramDeps.getRuntimeConfig(),
		sendChatActionHandler: createTelegramSendChatActionHandler({
			sendChatActionFn: (chatId, action, threadParams) => bot.api.sendChatAction(chatId, action, threadParams),
			logger: (message) => logVerbose(`telegram: ${message}`),
			minIntervalMs: TELEGRAM_TYPING_COALESCE_MS
		}),
		runtime,
		replyToMode,
		streamMode,
		textLimit,
		opts,
		telegramDeps
	});
	registerTelegramNativeCommands({
		bot,
		cfg,
		runtime,
		accountId: account.accountId,
		telegramCfg,
		allowFrom,
		groupAllowFrom,
		replyToMode,
		textLimit,
		mediaMaxBytes,
		useAccessGroups,
		nativeEnabled,
		nativeSkillsEnabled,
		nativeDisabledExplicit,
		resolveGroupPolicy,
		resolveTelegramGroupConfig,
		shouldSkipUpdate,
		opts,
		telegramDeps
	});
	registerTelegramHandlers({
		cfg,
		accountId: account.accountId,
		bot,
		opts,
		telegramTransport,
		runtime,
		mediaMaxBytes,
		telegramCfg,
		allowFrom,
		groupAllowFrom,
		resolveGroupPolicy,
		resolveGroupActivation,
		resolveGroupRequireMention,
		resolveTelegramGroupConfig,
		shouldSkipUpdate,
		processMessage,
		logger,
		telegramDeps
	});
	const originalStop = bot.stop.bind(bot);
	bot.stop = ((...args) => {
		threadBindingManager?.stop();
		return originalStop(...args);
	});
	return bot;
}
//#endregion
//#region extensions/telegram/src/bot.ts
function createTelegramBot(opts) {
	return createTelegramBotCore({
		...opts,
		telegramDeps: opts.telegramDeps ?? defaultTelegramBotDeps
	});
}
//#endregion
export { getTelegramSequentialKey as i, buildTelegramReplyFenceLaneKey as n, supersedeTelegramReplyFenceLane as r, createTelegramBot as t };
