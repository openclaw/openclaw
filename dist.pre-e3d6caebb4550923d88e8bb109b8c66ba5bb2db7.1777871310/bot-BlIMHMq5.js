import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as createNonExitingRuntime } from "./runtime-Dv8n03pi.js";
import { i as getChildLogger } from "./logger-BK1OY7lv.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn, t as danger } from "./globals-C7I_COwU.js";
import { n as normalizeAccountId } from "./account-id-DUpVOe8L.js";
import { d as resolveThreadSessionKeys, f as sanitizeAgentId, r as buildAgentMainSessionKey } from "./session-key-BSgfYlBK.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir } from "./agent-scope-CbabgXwH.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import { i as getRuntimeConfigSnapshot } from "./runtime-snapshot-BXa0Udtg.js";
import { r as replaceConfigFile } from "./mutate-BCZFK4XP.js";
import { l as fireAndForgetHook } from "./hook-runner-global-DHhbAIJU.js";
import { t as createDedupeCache } from "./dedupe-sHm32Eje.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-zZSBgwJK.js";
import { s as resolveSessionTranscriptPathInDir, u as resolveStorePath } from "./paths-Dl79wsM6.js";
import { t as loadSessionStore } from "./store-load-BJuxv-vp.js";
import { o as updateSessionStore, p as resolveSessionStoreEntry } from "./store-IyLBOjUO.js";
import { t as resolveAndPersistSessionFile } from "./session-file-CN2NCCW3.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-cuqj1EHH.js";
import { _ as findModelInCatalog } from "./model-selection-shared-DbwzllLp.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-aDhlumjq.js";
import { c as resolveThreadBindingMaxAgeMsForChannel, o as resolveThreadBindingIdleTimeoutMsForChannel, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-CAviF5AZ.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-DH6dOsB0.js";
import { f as findCodeRegions, p as isInsideCode, u as stripReasoningTagsFromText } from "./assistant-visible-text-BbjDz5HF.js";
import { s as formatReasoningMessage } from "./pi-embedded-utils-Cz1rJRIQ.js";
import { n as createOutboundPayloadPlan, o as projectOutboundPayloadPlanForDelivery } from "./deliver-BKaUMp20.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-B61Gbdzt.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-CUkWYVtg.js";
import { n as MediaFetchError } from "./fetch-BTZkN_s3.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-Dt9d4O7b.js";
import { c as resolveChannelStreamingPreviewToolProgress, i as resolveChannelStreamingBlockEnabled } from "./channel-streaming-BFQKL9hJ.js";
import { c as resolveTextChunkLimit, s as resolveChunkMode } from "./chunk-D2H_19Xb.js";
import { i as toInternalMessageReceivedContext } from "./message-hook-mappers-C9fthQYG.js";
import { h as resolveChannelConfigWrites } from "./channel-config-helpers-PRwm72zi.js";
import { i as resolveAgentRoute, n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-CgJzhPkB.js";
import { t as resolveAckReaction } from "./identity-Be40H-5J.js";
import { t as applyModelOverrideToSessionEntry } from "./model-overrides-CkZPuP21.js";
import "./text-runtime-icMZVCaq.js";
import "./routing-CvMyJlKL.js";
import { a as getPluginCommandSpecs } from "./commands-BaRGDodV.js";
import { f as parsePluginBindingApprovalCustomId, i as buildPluginBindingResolvedText, m as resolvePluginConversationBindingApproval } from "./conversation-binding-Cn476Ys4.js";
import "./error-runtime-B9i9dR6-.js";
import { n as listChatCommands } from "./commands-registry-list-WbnkArsp.js";
import { n as maybeResolveTextAlias, r as normalizeCommandBody } from "./commands-registry-normalize-CNDADEeJ.js";
import { n as isAbortRequestText } from "./abort-primitives-DJV77eQY.js";
import { t as hasControlCommand } from "./command-detection-gUkJJxto.js";
import { c as parseCommandArgs, i as formatCommandArgMenuTitle, n as buildCommandTextFromArgs, o as listNativeCommandSpecs, r as findCommandByNativeName, s as listNativeCommandSpecsForConfig, u as resolveCommandArgMenu } from "./commands-registry-Bv9Wm6ed.js";
import { i as matchesMentionWithExplicit, n as buildMentionRegexes } from "./mentions-BmUnlrE8.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope } from "./envelope-D8z1xEXs.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-BST7kouS.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply } from "./ack-reactions-C-NmIsUB.js";
import { n as resolveControlCommandGate, t as resolveCommandAuthorizedFromAuthorizers } from "./command-gating-oWXnovrh.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "./mention-gating-CNABrTOg.js";
import { c as clearHistoryEntriesIfEnabled, d as recordPendingHistoryEntryIfEnabled, o as buildPendingHistoryContextFromMap } from "./history-BNSb9V71.js";
import { n as hasFinalChannelTurnDispatch } from "./dispatch-result-vD_r1T2i.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-CPmLQtEe.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DOmSgsqv.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-BI1ByK4W.js";
import { t as createChannelReplyPipeline } from "./channel-reply-pipeline-o-LATR-A.js";
import { t as firstDefined } from "./allow-from-CZulnYsH.js";
import "./channel-policy-CrpCRRGP.js";
import "./reply-history-DcELOn43.js";
import { n as logInboundDrop, r as logTypingFailure, t as logAckFailure } from "./logging-C5DdZpTX.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-HNgb0OrQ.js";
import "./runtime-env-BBcuHj0d.js";
import { d as parseExecApprovalCommandText } from "./exec-approval-reply-ABF0LE59.js";
import "./approval-reply-runtime-CC5M2Scd.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-C-GvM6x1.js";
import { n as resolveNativeCommandsEnabled, r as resolveNativeSkillsEnabled, t as isNativeCommandsExplicitlyDisabled } from "./commands-_Unj9Xju.js";
import "./config-mutation-tGvZfeDw.js";
import { t as resolveCommandAuthorization } from "./command-auth-D4GV03Z1.js";
import { t as resolveStoredModelOverride } from "./stored-model-override-CgVs9lIg.js";
import { n as isBtwRequestText } from "./btw-command-D26nmNgn.js";
import { t as generateConversationLabel } from "./conversation-label-generator-CtjnGjxS.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./reply-dispatch-runtime-cklIBnF0.js";
import "./reply-chunking-CRxdpUGk.js";
import { a as runInboundReplyTurn } from "./inbound-reply-dispatch-N--Oj9Dq.js";
import "./outbound-runtime-BskDzI5r.js";
import "./runtime-config-snapshot-BZ-P9buD.js";
import "./model-session-runtime-CxIwLaKR.js";
import "./media-runtime-5rxXL-Os.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute } from "./binding-routing-Be6UzDGC.js";
import "./conversation-runtime-CTtOJ2PO.js";
import "./agent-runtime-Bf__bzN6.js";
import { i as createInteractiveConversationBindingHelpers, r as dispatchPluginInteractiveHandler } from "./plugin-runtime-6wbumXyv.js";
import "./security-runtime-UeJYXWvz.js";
import "./hook-runtime-Bo6mea9h.js";
import "./markdown-table-runtime-BCQyeDEk.js";
import { n as buildCommandsMessagePaginated } from "./command-status-builders-BWb4A0Bo.js";
import "./command-auth-DSPGkUB8.js";
import { t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-CD274bSJ.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-uLqfOmUz.js";
import { n as formatModelsAvailableHeader } from "./commands-models-CBprL0LT.js";
import "./command-auth-native-C1lZjPAg.js";
import "./command-primitives-runtime-CH24M8_I.js";
import "./command-status-C6_4B7Ra.js";
import "./command-detection-BUc_84OH.js";
import "./command-surface-BAn5iaer.js";
import { n as DEFAULT_EMOJIS, r as DEFAULT_TIMING } from "./channel-feedback-BC9FQHoQ.js";
import { r as shouldDebounceTextInbound } from "./channel-inbound-C9i5zNo5.js";
import { n as toLocationContext, t as formatLocationText } from "./location-Fu8_hadL.js";
import "./session-store-runtime-kmcykxzs.js";
import "./models-provider-runtime-DKLd1I_k.js";
import "./skill-commands-runtime-rxxYuzZO.js";
import "./native-command-config-runtime-DLK_Z9Av.js";
import { t as mergeTelegramAccountConfig } from "./account-config-CxjXZVNY.js";
import { a as resolveDefaultTelegramAccountId, o as resolveTelegramAccount, s as resolveTelegramMediaRuntimeOptions } from "./accounts-D6pgD_pT.js";
import { $ as shouldUseTelegramDmThreadSession, A as isSafeToRetrySendError, B as buildTelegramRoutingTarget, C as withTelegramApiErrorLogging, D as renderTelegramHtmlText, F as tagTelegramNetworkError, H as buildTypingThreadParams, I as buildGroupLabel, J as resolveTelegramForumThreadId, K as resolveTelegramDirectPeerId, L as buildTelegramGroupFrom, Q as resolveTelegramThreadSpec, R as buildTelegramGroupPeerId, U as describeReplyTarget, V as buildTelegramThreadParams, W as extractTelegramForumFlag, X as resolveTelegramReplyId, Y as resolveTelegramGroupAllowFromContext, Z as resolveTelegramStreamMode, a as editMessageTelegram, at as getTelegramTextParts, ct as normalizeForwardedContext, dt as isSenderAllowed, et as withResolvedTelegramForumFlag, ft as normalizeAllowFrom, g as recordSentMessage, it as extractTelegramLocation, j as isTelegramClientRejection, k as isRecoverableTelegramNetworkError, mt as resolveSenderAllowMatch, nt as buildSenderName, ot as hasBotMention, pt as normalizeDmAllowFromWithStore, q as resolveTelegramForumFlag, rt as expandTextLinks, tt as buildSenderLabel, ut as resolveTelegramPrimaryMedia, x as buildInlineKeyboard, z as buildTelegramParentPeer } from "./send-Caopnqrq.js";
import { o as normalizeTelegramApiRoot, r as resolveTelegramTransport } from "./fetch-DvEYx6zp.js";
import { r as resolveTelegramInlineButtonsScope } from "./inline-buttons-BG3-SlfF.js";
import { f as shouldSuppressLocalTelegramExecApprovalPrompt, l as shouldEnableTelegramExecApprovalButtons, n as isTelegramExecApprovalApprover, r as isTelegramExecApprovalAuthorizedSender } from "./exec-approvals-CP_jRuHR.js";
import { n as resolveTelegramRequestTimeoutMs } from "./request-timeouts-B0tn3SUu.js";
import { d as buildModelsKeyboard, g as resolveModelSelection, h as parseModelCallbackData, m as getModelsPageSize, o as buildTelegramModelsMenuButtons, p as calculateTotalPages, t as buildCommandsPaginationKeyboard } from "./command-ui-CSeZgoHg.js";
import { i as resolveTelegramCustomCommands, r as normalizeTelegramCommandName, t as TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config-Cbidgf1p.js";
import { t as createTelegramThreadBindingManager } from "./thread-bindings-Cec0q6_t.js";
import { n as cacheSticker, t as describeStickerImage } from "./sticker-cache-DEks3u01.js";
import { n as evaluateTelegramGroupPolicyAccess, t as evaluateTelegramGroupBaseAccess } from "./group-access-BQDIbbIj.js";
import { a as buildPluginTelegramMenuCommands, i as buildCappedTelegramMenuCommands, n as resolveTelegramExecApproval, o as syncTelegramMenuCommands, r as createTelegramDraftStream, t as defaultTelegramBotDeps } from "./bot-deps-CCpL9FrK.js";
import { n as deliverReplies, r as emitInternalMessageSentHook, t as resolveMedia } from "./delivery-11DL_XNP.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Bot as Bot$1 } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
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
	telegramSendRuntimePromise ??= import("./send-R-p83Zhc.js");
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
		if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) return {
			provider: defaultModel.provider,
			model: defaultModel.model
		};
		const override = resolveStoredModelOverride({
			sessionEntry: entry,
			sessionStore: store,
			sessionKey: params.sessionKey,
			defaultProvider: defaultModel.provider
		});
		if (override?.model) return {
			provider: override.provider || defaultModel.provider,
			model: override.model
		};
		const provider = normalizeOptionalString(entry?.providerOverride) ?? normalizeOptionalString(entry?.modelProvider);
		const model = normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
		return {
			...provider ? { provider } : {},
			...model ? { model } : {}
		};
	} catch {
		return {};
	}
}
function resolveTelegramNativeReplyChannelData(result) {
	return result.channelData?.telegram;
}
function isEditableTelegramProgressResult(result) {
	const telegramData = resolveTelegramNativeReplyChannelData(result);
	return Boolean(typeof result.text === "string" && result.text.trim() && !result.mediaUrl && (!result.mediaUrls || result.mediaUrls.length === 0) && !result.interactive && !result.btw && telegramData?.pin !== true);
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
	const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramGroupAllowFromContext({
		chatId,
		accountId,
		isGroup,
		isForum,
		messageThreadId,
		groupAllowFrom,
		readChannelAllowFromStore,
		resolveTelegramGroupConfig
	});
	const effectiveDmPolicy = !isGroup && groupConfig && "dmPolicy" in groupConfig ? groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing" : telegramCfg.dmPolicy ?? "pairing";
	const requireTopic = !isGroup && groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : void 0;
	if (!isGroup && requireTopic === true && dmThreadId == null) {
		logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
		return null;
	}
	const dmAllowFrom = groupAllowOverride ?? allowFrom;
	const senderId = msg.from?.id ? String(msg.from.id) : "";
	const senderUsername = msg.from?.username ?? "";
	const commandsAllowFrom = cfg.commands?.allowFrom;
	const commandsAllowFromConfigured = commandsAllowFrom != null && typeof commandsAllowFrom === "object" && (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
	const commandsAllowFromAccess = commandsAllowFromConfigured ? resolveCommandAuthorization({
		ctx: {
			Provider: "telegram",
			Surface: "telegram",
			OriginatingChannel: "telegram",
			AccountId: accountId,
			ChatType: isGroup ? "group" : "direct",
			From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
			SenderId: senderId || void 0,
			SenderUsername: senderUsername || void 0
		},
		cfg,
		commandAuthorized: false
	}) : null;
	const ownerAccess = resolveCommandAuthorization({
		ctx: {
			Provider: "telegram",
			Surface: "telegram",
			OriginatingChannel: "telegram",
			AccountId: accountId,
			ChatType: isGroup ? "group" : "direct",
			From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
			SenderId: senderId || void 0,
			SenderUsername: senderUsername || void 0
		},
		cfg,
		commandAuthorized: false
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
		allowFrom: dmAllowFrom,
		storeAllowFrom: isGroup ? [] : storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const senderAllowed = isSenderAllowed({
		allow: dmAllow,
		senderId,
		senderUsername
	});
	const groupSenderAllowed = isGroup ? isSenderAllowed({
		allow: effectiveGroupAllow,
		senderId,
		senderUsername
	}) : false;
	const ownerAuthorizerConfigured = ownerAccess.senderIsOwner || ownerAccess.ownerList.length > 0;
	const commandAuthorized = commandsAllowFromConfigured ? Boolean(commandsAllowFromAccess?.isAuthorizedSender) : resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		authorizers: [
			{
				configured: dmAllow.hasEntries,
				allowed: senderAllowed
			},
			...isGroup ? [{
				configured: effectiveGroupAllow.hasEntries,
				allowed: groupSenderAllowed
			}] : [],
			{
				configured: ownerAuthorizerConfigured,
				allowed: ownerAccess.senderIsOwner
			}
		],
		modeWhenAccessGroupsOff: "configured"
	});
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
const registerTelegramNativeCommands = ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, telegramDeps = defaultTelegramNativeCommandDeps, opts }) => {
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
		specs: (telegramDeps.getPluginCommandSpecs ?? defaultTelegramNativeCommandDeps.getPluginCommandSpecs)?.("telegram") ?? [],
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
			return {
				command: normalized,
				description: command.description
			};
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
					const title = formatCommandArgMenuTitle({
						command: commandDefinition,
						menu
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
				const { createChannelReplyPipeline, deliverReplies } = await loadTelegramNativeCommandDeliveryRuntime();
				const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
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
			const result = await nativeCommandRuntime.executePluginCommand({
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
			});
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
			const progressResultText = typeof result.text === "string" && result.text.trim().length > 0 ? result.text : null;
			const telegramResultData = resolveTelegramNativeReplyChannelData(result);
			if (progressMessageId != null && telegramDeps.editMessageTelegram && progressResultText && isEditableTelegramProgressResult(result)) try {
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
				replies: [result],
				...deliveryBaseOptions,
				silent: runtimeTelegramCfg.silentErrorReplies === true && result.isError === true
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
	const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.callbackQuery?.message;
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
async function enforceTelegramDmAccess(params) {
	const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger, upsertPairingRequest } = params;
	if (isGroup) return true;
	if (dmPolicy === "disabled") return false;
	const sender = resolveTelegramSenderIdentity(msg, chatId);
	const allowMatch = resolveSenderAllowMatch({
		allow: effectiveDmAllow,
		senderId: sender.candidateId,
		senderUsername: sender.username
	});
	const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${allowMatch.matchSource ?? "none"}`;
	const allowed = effectiveDmAllow.hasWildcard || effectiveDmAllow.hasEntries && allowMatch.allowed;
	if (dmPolicy === "open") {
		if (allowed) return true;
		logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=open, ${allowMatchMeta})`);
		return false;
	}
	if (allowed) return true;
	if (dmPolicy === "pairing") {
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
						lastName: sender.lastName,
						matchKey: allowMatch.matchKey ?? "none",
						matchSource: allowMatch.matchSource ?? "none"
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
	logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`);
	return false;
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
//#region extensions/telegram/src/bot-handlers.runtime.ts
const registerTelegramHandlers = ({ cfg, accountId, bot, opts, telegramTransport, runtime, mediaMaxBytes, telegramCfg, allowFrom, groupAllowFrom, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, processMessage, logger, telegramDeps }) => {
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
	const mediaGroupTimeoutMs = typeof opts.testTimings?.mediaGroupFlushMs === "number" && Number.isFinite(opts.testTimings.mediaGroupFlushMs) ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs)) : 500;
	const mediaGroupBuffer = /* @__PURE__ */ new Map();
	let mediaGroupProcessing = Promise.resolve();
	const textFragmentBuffer = /* @__PURE__ */ new Map();
	let textFragmentProcessing = Promise.resolve();
	const debounceMs = resolveInboundDebounceMs({
		cfg,
		channel: "telegram"
	});
	const FORWARD_BURST_DEBOUNCE_MS = 80;
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
	const inboundDebouncer = createInboundDebouncer({
		debounceMs,
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
				const replyMedia = await resolveReplyMediaForMessage(last.ctx, last.msg);
				await processMessage(last.ctx, last.allMedia, last.storeAllowFrom, {
					receivedAtMs: last.receivedAtMs,
					ingressBuffer: "inbound-debounce"
				}, replyMedia);
				return;
			}
			const combinedText = entries.map((entry) => getTelegramTextParts(entry.msg).text).filter(Boolean).join("\n");
			const combinedMedia = entries.flatMap((entry) => entry.allMedia);
			if (!combinedText.trim() && combinedMedia.length === 0) return;
			const first = entries[0];
			const baseCtx = first.ctx;
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : void 0;
			const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
			const replyMedia = await resolveReplyMediaForMessage(baseCtx, syntheticMessage);
			await processMessage(syntheticCtx, combinedMedia, first.storeAllowFrom, {
				...messageIdOverride ? { messageIdOverride } : {},
				receivedAtMs: first.receivedAtMs,
				ingressBuffer: "inbound-debounce"
			}, replyMedia);
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
		}
	});
	const resolveTelegramSessionState = (params) => {
		const runtimeCfg = telegramDeps.getRuntimeConfig();
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
		const store = loadSessionStore(telegramDeps.resolveStorePath(runtimeCfg.session?.store, { agentId: route.agentId }));
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
	const processMediaGroup = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const primaryEntry = entry.messages.find((m) => m.msg.caption || m.msg.text) ?? entry.messages[0];
			const allMedia = [];
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
					continue;
				}
				if (media) allMedia.push({
					path: media.path,
					contentType: media.contentType,
					stickerMetadata: media.stickerMetadata
				});
			}
			const storeAllowFrom = await loadStoreAllowFrom();
			const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
			await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, void 0, replyMedia);
		} catch (err) {
			runtime.error?.(danger(`media group handler failed: ${String(err)}`));
		}
	};
	const flushTextFragments = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const first = entry.messages[0];
			const last = entry.messages.at(-1);
			if (!first || !last) return;
			const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
			if (!combinedText.trim()) return;
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const storeAllowFrom = await loadStoreAllowFrom();
			const baseCtx = first.ctx;
			await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
				messageIdOverride: String(last.msg.message_id),
				receivedAtMs: first.receivedAtMs,
				ingressBuffer: "text-fragment"
			});
		} catch (err) {
			runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
		}
	};
	const queueTextFragmentFlush = async (entry) => {
		textFragmentProcessing = textFragmentProcessing.then(async () => {
			await flushTextFragments(entry);
		}).catch(() => void 0);
		await textFragmentProcessing;
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
	const resolveReplyMediaForMessage = async (ctx, msg) => {
		const replyMessage = msg.reply_to_message;
		if (!replyMessage || !hasInboundMedia(replyMessage)) return [];
		const replyFileId = resolveInboundMediaFileId(replyMessage);
		if (!replyFileId) return [];
		try {
			const media = await resolveMedia({
				ctx: {
					message: replyMessage,
					me: ctx.me,
					getFile: async () => await bot.api.getFile(replyFileId)
				},
				maxBytes: mediaMaxBytes,
				...mediaRuntimeOptions
			});
			if (!media) return [];
			return [{
				path: media.path,
				contentType: media.contentType,
				stickerMetadata: media.stickerMetadata
			}];
		} catch (err) {
			logger.warn({
				chatId: msg.chat.id,
				error: String(err)
			}, "reply media fetch failed");
			return [];
		}
	};
	const isAllowlistAuthorized = (allow, senderId, senderUsername) => allow.hasWildcard || allow.hasEntries && isSenderAllowed({
		allow,
		senderId,
		senderUsername
	});
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
			chatId: params.chatId,
			accountId,
			isGroup: params.isGroup,
			isForum: params.isForum,
			messageThreadId: params.messageThreadId,
			groupAllowFrom,
			readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
			resolveTelegramGroupConfig
		});
		return {
			dmPolicy: !params.isGroup && groupAllowContext.groupConfig && "dmPolicy" in groupAllowContext.groupConfig ? groupAllowContext.groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing" : telegramCfg.dmPolicy ?? "pairing",
			...groupAllowContext
		};
	};
	const authorizeTelegramEventSender = (params) => {
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
		})) return {
			allowed: false,
			reason: "group-policy"
		};
		if (!isGroup && enforceDirectAuthorization) {
			if (dmPolicy === "disabled") {
				logVerbose(`Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`);
				return {
					allowed: false,
					reason: "direct-disabled"
				};
			}
			const effectiveDmAllow = normalizeDmAllowFromWithStore({
				allowFrom: groupAllowOverride ?? allowFrom,
				storeAllowFrom,
				dmPolicy
			});
			if (!(dmPolicy === "open" && effectiveDmAllow.hasWildcard) && !isAllowlistAuthorized(effectiveDmAllow, senderId, senderUsername)) {
				logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
				return {
					allowed: false,
					reason: "direct-unauthorized"
				};
			}
		}
		if (isGroup && enforceGroupAllowlistAuthorization) {
			if (!isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername)) {
				logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
				return {
					allowed: false,
					reason: "group-unauthorized"
				};
			}
		}
		return { allowed: true };
	};
	const isTelegramModelCallbackAuthorized = (params) => {
		const { chatId, isGroup, senderId, senderUsername, context, cfg } = params;
		const useAccessGroups = cfg.commands?.useAccessGroups !== false;
		const dmAllowFrom = context.groupAllowOverride ?? allowFrom;
		const commandsAllowFrom = cfg.commands?.allowFrom;
		if (commandsAllowFrom != null && typeof commandsAllowFrom === "object" && (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]))) return resolveCommandAuthorization({
			ctx: {
				Provider: "telegram",
				Surface: "telegram",
				OriginatingChannel: "telegram",
				AccountId: accountId,
				ChatType: isGroup ? "group" : "direct",
				From: isGroup ? buildTelegramGroupFrom(chatId, context.resolvedThreadId) : `telegram:${chatId}`,
				SenderId: senderId || void 0,
				SenderUsername: senderUsername || void 0
			},
			cfg,
			commandAuthorized: false
		}).isAuthorizedSender;
		const dmAllow = normalizeDmAllowFromWithStore({
			allowFrom: dmAllowFrom,
			storeAllowFrom: isGroup ? [] : context.storeAllowFrom,
			dmPolicy: context.dmPolicy
		});
		const senderAllowed = isSenderAllowed({
			allow: dmAllow,
			senderId,
			senderUsername
		});
		const groupSenderAllowed = isGroup ? isSenderAllowed({
			allow: context.effectiveGroupAllow,
			senderId,
			senderUsername
		}) : false;
		return resolveCommandAuthorizedFromAuthorizers({
			useAccessGroups,
			authorizers: [{
				configured: dmAllow.hasEntries,
				allowed: senderAllowed
			}, ...isGroup ? [{
				configured: context.effectiveGroupAllow.hasEntries,
				allowed: groupSenderAllowed
			}] : []],
			modeWhenAccessGroupsOff: "configured"
		});
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
				isForum
			});
			if (!authorizeTelegramEventSender({
				chatId,
				chatTitle: reaction.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: "reaction",
				context: eventAuthContext
			}).allowed) return;
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
		const { ctx, msg, chatId, resolvedThreadId, dmThreadId, storeAllowFrom, sendOversizeWarning, oversizeLogMessage } = params;
		const text = typeof msg.text === "string" ? msg.text : void 0;
		const isCommandLike = (text ?? "").trim().startsWith("/");
		if (text && !isCommandLike) {
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
						scheduleTextFragmentFlush(existing);
						return;
					}
				}
				clearTimeout(existing.timer);
				textFragmentBuffer.delete(key);
				textFragmentProcessing = textFragmentProcessing.then(async () => {
					await flushTextFragments(existing);
				}).catch(() => void 0);
				await textFragmentProcessing;
			}
			if (text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS) {
				const entry = {
					key,
					messages: [{
						msg,
						ctx,
						receivedAtMs: nowMs
					}],
					timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS)
				};
				textFragmentBuffer.set(key, entry);
				scheduleTextFragmentFlush(entry);
				return;
			}
		}
		const mediaGroupId = msg.media_group_id;
		if (mediaGroupId) {
			const existing = mediaGroupBuffer.get(mediaGroupId);
			if (existing) {
				clearTimeout(existing.timer);
				existing.messages.push({
					msg,
					ctx
				});
				existing.timer = setTimeout(async () => {
					mediaGroupBuffer.delete(mediaGroupId);
					mediaGroupProcessing = mediaGroupProcessing.then(async () => {
						await processMediaGroup(existing);
					}).catch(() => void 0);
					await mediaGroupProcessing;
				}, mediaGroupTimeoutMs);
			} else {
				const entry = {
					messages: [{
						msg,
						ctx
					}],
					timer: setTimeout(async () => {
						mediaGroupBuffer.delete(mediaGroupId);
						mediaGroupProcessing = mediaGroupProcessing.then(async () => {
							await processMediaGroup(entry);
						}).catch(() => void 0);
						await mediaGroupProcessing;
					}, mediaGroupTimeoutMs)
				};
				mediaGroupBuffer.set(mediaGroupId, entry);
			}
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
			return;
		}
		const hasText = Boolean(getTelegramTextParts(msg).text.trim());
		if (msg.sticker && !media && !hasText) {
			logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
			return;
		}
		const allMedia = media ? [{
			path: media.path,
			contentType: media.contentType,
			stickerMetadata: media.stickerMetadata
		}] : [];
		const senderId = msg.from?.id ? String(msg.from.id) : "";
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
		await inboundDebouncer.enqueue({
			ctx,
			msg,
			allMedia,
			storeAllowFrom,
			receivedAtMs: Date.now(),
			debounceKey,
			debounceLane,
			botUsername: ctx.me?.username
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
				getChat
			});
			const eventAuthContext = await resolveTelegramEventAuthorizationContext({
				chatId,
				isGroup,
				isForum,
				messageThreadId
			});
			const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
			const requireTopic = groupConfig?.requireTopic;
			if (!isGroup && requireTopic === true && dmThreadId == null) {
				logVerbose(`Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`);
				return;
			}
			const senderId = callback.from?.id ? String(callback.from.id) : "";
			const senderUsername = callback.from?.username ?? "";
			const authorizationMode = !isGroup || !execApprovalButtonsEnabled && inlineButtonsScope === "allowlist" ? "callback-allowlist" : "callback-scope";
			if (!authorizeTelegramEventSender({
				chatId,
				chatTitle: callbackMessage.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: authorizationMode,
				context: eventAuthContext
			}).allowed) return;
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
					auth: { isAuthorizedSender: true },
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
			const runtimeCfg = telegramDeps.getRuntimeConfig();
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
				if (!isTelegramModelCallbackAuthorized({
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
								const resolved = resolveSessionStoreEntry({
									store,
									sessionKey
								});
								const entry = resolved.existing ?? {};
								store[resolved.normalizedKey] = entry;
								for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
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
						await editMessageWithButtons(`✅ Model ${isDefaultSelection ? "reset to default" : `changed to <b>${escapeHtml(selection.provider)}/${escapeHtml(selection.model)}</b>`}\n\n${isDefaultSelection ? "Session selection cleared. New replies use the agent's configured default." : "Session-only selection. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default."}`, [], { parse_mode: "HTML" });
					} catch (err) {
						if (err instanceof TelegramRetryableCallbackError) throw err;
						await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
					}
					return;
				}
				return;
			}
			const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
			await processMessage(buildSyntheticContext(ctx, buildSyntheticTextMessage({
				base: withResolvedTelegramForumFlag(callbackMessage, isForum),
				from: callback.from,
				text: nativeCallbackCommand ?? data
			})), [], storeAllowFrom, {
				...nativeCallbackCommand ? { commandSource: "native" } : {},
				forceWasMentioned: true,
				messageIdOverride: callback.id
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
			const currentConfig = telegramDeps.getRuntimeConfig();
			const migration = migrateTelegramGroupConfig({
				cfg: currentConfig,
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
				await replaceConfigFile({
					nextConfig: currentConfig,
					afterWrite: { mode: "auto" }
				});
				runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
			} else if (migration.skippedExisting) runtime.log?.(warn(`[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`));
			else runtime.log?.(warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`));
		} catch (err) {
			runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
			throw err;
		}
	});
	const handleInboundMessageLike = async (event) => {
		try {
			if (shouldSkipUpdate(event.ctxForDedupe)) return;
			const { dmPolicy, resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramEventAuthorizationContext({
				chatId: event.chatId,
				isGroup: event.isGroup,
				isForum: event.isForum,
				messageThreadId: event.messageThreadId
			});
			const effectiveDmAllow = normalizeDmAllowFromWithStore({
				allowFrom: groupAllowOverride ?? allowFrom,
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
			await processInboundMessage({
				ctx: event.ctx,
				msg: event.msg,
				chatId: event.chatId,
				resolvedThreadId,
				dmThreadId,
				storeAllowFrom,
				sendOversizeWarning: event.sendOversizeWarning,
				oversizeLogMessage: event.oversizeLogMessage
			});
		} catch (err) {
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
	bot.on("channel_post", async (ctx) => {
		const post = ctx.channelPost;
		if (!post) return;
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
		const syntheticMsg = {
			...post,
			from: post.from ?? syntheticFrom,
			chat: {
				...post.chat,
				type: "supergroup"
			}
		};
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
};
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
async function resolveStickerVisionSupport$1(params) {
	try {
		const { resolveStickerVisionSupportRuntime } = await loadStickerVisionRuntime();
		return await resolveStickerVisionSupportRuntime(params);
	} catch {
		return false;
	}
}
async function resolveTelegramInboundBody(params) {
	const { cfg, primaryCtx, msg, allMedia, isGroup, chatId, accountId, senderId, senderUsername, sessionKey, resolvedThreadId, replyThreadId, routeAgentId, effectiveGroupAllow, effectiveDmAllow, groupConfig, topicConfig, requireMention, options, groupHistories, historyLimit, logger } = params;
	const botUsername = normalizeOptionalLowercaseString(primaryCtx.me?.username);
	const mentionRegexes = buildMentionRegexes(cfg, routeAgentId);
	const messageTextParts = getTelegramTextParts(msg);
	const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
	const senderAllowedForCommands = isSenderAllowed({
		allow: allowForCommands,
		senderId,
		senderUsername
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, { botUsername });
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: allowForCommands.hasEntries,
			allowed: senderAllowedForCommands
		}],
		allowTextCommands: true,
		hasControlCommand: hasControlCommandInMessage
	});
	const commandAuthorized = commandGate.commandAuthorized;
	const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : void 0;
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
	const senderAllowedForAudioPreflight = !useAccessGroups || !allowForCommands.hasEntries || senderAllowedForCommands;
	let preflightTranscript;
	if (hasAudio && !hasUserText && (!isGroup || requireMention && mentionRegexes.length > 0 && !disableAudioPreflight && senderAllowedForAudioPreflight)) try {
		const { transcribeFirstAudio } = await loadMediaUnderstandingRuntime();
		preflightTranscript = await transcribeFirstAudio({
			ctx: {
				Provider: "telegram",
				Surface: "telegram",
				OriginatingChannel: "telegram",
				OriginatingTo: `telegram:${chatId}`,
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
	if (!bodyText && allMedia.length > 0) if (hasAudio) bodyText = preflightTranscript ? formatAudioTranscriptForAgent(preflightTranscript) : "<media:audio>";
	else bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
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
	if (isGroup && commandGate.shouldBlock) {
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
			implicitMentionKinds: isGroup && Boolean(requireMention) ? implicitMentionKinds : []
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
		recordPendingHistoryEntryIfEnabled({
			historyMap: groupHistories,
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
			to: `telegram:${chatId}`,
			content: rawBody,
			timestamp: msg.date ? msg.date * 1e3 : void 0,
			channelId: "telegram",
			accountId,
			conversationId: `telegram:${chatId}`,
			messageId: typeof msg.message_id === "number" ? String(msg.message_id) : void 0,
			senderId: senderId || void 0,
			senderName: buildSenderName(msg),
			senderUsername: senderUsername || void 0,
			provider: "telegram",
			surface: "telegram",
			threadId: resolvedThreadId,
			originatingChannel: "telegram",
			originatingTo: `telegram:${chatId}`,
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
		...audioTranscribedMediaIndex !== void 0 && audioTranscribedMediaIndex >= 0 ? { audioTranscribedMediaIndex } : {},
		stickerCacheHit,
		locationData: locationData ?? void 0
	};
}
//#endregion
//#region extensions/telegram/src/bot-message-context.session.ts
const sessionRuntimeMethods = [
	"finalizeInboundContext",
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
async function buildTelegramInboundContextPayload(params) {
	const { cfg, primaryCtx, msg, allMedia, replyMedia, isGroup, isForum, chatId, senderId, senderUsername, resolvedThreadId, dmThreadId, threadSpec, route, rawBody, bodyText, historyKey, historyLimit, groupHistories, groupConfig, topicConfig, stickerCacheHit, effectiveWasMentioned, audioTranscribedMediaIndex, commandAuthorized, locationData, options, dmAllowFrom, effectiveGroupAllow, topicName, sessionRuntime: sessionRuntimeOverride } = params;
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
	const visibleForwardOrigin = includeForwardOrigin ? forwardOrigin : null;
	const replyForwardAnnotation = visibleReplyTarget?.forwardedFrom ? `[Forwarded from ${visibleReplyTarget.forwardedFrom.from}${visibleReplyTarget.forwardedFrom.date ? ` at ${(/* @__PURE__ */ new Date(visibleReplyTarget.forwardedFrom.date * 1e3)).toISOString()}` : ""}]\n` : "";
	const buildReplySupplementalLines = (params) => {
		const lines = [];
		const forwardAnnotation = replyForwardAnnotation.trimEnd();
		if (forwardAnnotation) lines.push(forwardAnnotation);
		if (params.body) lines.push(params.body);
		return lines.length > 0 ? `\n${lines.join("\n")}` : "";
	};
	const replySuffix = visibleReplyTarget ? visibleReplyTarget.kind === "quote" ? `\n\n[Quoting ${visibleReplyTarget.sender}${visibleReplyTarget.id ? ` id:${visibleReplyTarget.id}` : ""}]${buildReplySupplementalLines({ body: visibleReplyTarget.body ? `"${visibleReplyTarget.body}"` : void 0 })}\n[/Quoting]` : `\n\n[Replying to ${visibleReplyTarget.sender}${visibleReplyTarget.id ? ` id:${visibleReplyTarget.id}` : ""}]${buildReplySupplementalLines({ body: visibleReplyTarget.body })}\n[/Replying]` : "";
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
	let combinedBody = body;
	if (isGroup && historyKey && historyLimit > 0) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: groupHistories,
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
	const inboundHistory = isGroup && historyKey && historyLimit > 0 ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const contextMedia = [...stickerCacheHit ? [] : allMedia, ...replyMedia];
	const ctxPayload = sessionRuntime.finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: bodyText,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
		To: `telegram:${chatId}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: conversationLabel,
		GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
		GroupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
		SenderName: senderName,
		SenderId: senderId || void 0,
		SenderUsername: senderUsername || void 0,
		Provider: "telegram",
		Surface: "telegram",
		BotUsername: primaryCtx.me?.username ?? void 0,
		MessageSid: options?.messageIdOverride ?? String(msg.message_id),
		ReplyToId: visibleReplyTarget?.id,
		ReplyToBody: visibleReplyTarget?.body,
		ReplyToSender: visibleReplyTarget?.sender,
		ReplyToIsQuote: visibleReplyTarget?.kind === "quote" ? true : void 0,
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
		ForwardedFrom: visibleForwardOrigin?.from,
		ForwardedFromType: visibleForwardOrigin?.fromType,
		ForwardedFromId: visibleForwardOrigin?.fromId,
		ForwardedFromUsername: visibleForwardOrigin?.fromUsername,
		ForwardedFromTitle: visibleForwardOrigin?.fromTitle,
		ForwardedFromSignature: visibleForwardOrigin?.fromSignature,
		ForwardedFromChatType: visibleForwardOrigin?.fromChatType,
		ForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
		ForwardedDate: visibleForwardOrigin?.date ? visibleForwardOrigin.date * 1e3 : void 0,
		Timestamp: msg.date ? msg.date * 1e3 : void 0,
		WasMentioned: isGroup ? effectiveWasMentioned : void 0,
		MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
		MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : void 0,
		MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
		MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
		MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
		MediaTypes: contextMedia.length > 0 ? contextMedia.map((m) => m.contentType).filter(Boolean) : void 0,
		...audioTranscribedMediaIndex !== void 0 ? { MediaTranscribedIndexes: [audioTranscribedMediaIndex] } : {},
		Sticker: allMedia[0]?.stickerMetadata,
		StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : void 0,
		...locationData ? toLocationContext(locationData) : void 0,
		CommandAuthorized: commandAuthorized,
		CommandSource: options?.commandSource,
		MessageThreadId: threadSpec.id,
		IsForum: isForum,
		TopicName: isForum && topicName ? topicName : void 0,
		OriginatingChannel: "telegram",
		OriginatingTo: `telegram:${chatId}`
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
	fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
	const tempPath = `${persistedPath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(store)), "utf-8");
	fs.renameSync(tempPath, persistedPath);
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
const buildTelegramMessageContext = async ({ primaryCtx, allMedia, replyMedia = [], storeAllowFrom, options, bot, cfg, account, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, loadFreshConfig, runtime, sessionRuntime, upsertPairingRequest, sendChatActionHandler }) => {
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
	const topicNameCachePath = resolveTopicNameCachePath(await resolveTelegramMessageContextStorePath({
		cfg,
		agentId: account.accountId,
		sessionRuntime
	}));
	let topicName;
	if (isForum && resolvedThreadId != null) {
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
	const effectiveDmPolicy = !isGroup && groupConfig && "dmPolicy" in groupConfig ? groupConfig.dmPolicy ?? dmPolicy : dmPolicy;
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
	const dmAllowFrom = groupAllowOverride ?? allowFrom;
	const effectiveDmAllow = normalizeDmAllowFromWithStore({
		allowFrom: dmAllowFrom,
		storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
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
		effectiveDmAllow,
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
	const requireMention = firstDefined(activationOverride, topicConfig?.requireMention, telegramGroupConfig?.requireMention, baseRequireMention);
	(runtime?.recordChannelActivity ?? (await loadTelegramMessageContextRuntime()).recordChannelActivity)({
		channel: "telegram",
		accountId: account.accountId,
		direction: "inbound"
	});
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
		routeAgentId: route.agentId,
		sessionKey,
		effectiveGroupAllow,
		effectiveDmAllow,
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
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "telegram",
		accountId: account.accountId
	});
	const ackReactionEmoji = ackReaction && isTelegramSupportedReactionEmoji(ackReaction) ? ackReaction : void 0;
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
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
	const statusReactionsEnabled = statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction$1();
	const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
		initialEmoji: ackReaction,
		overrides: statusReactionsConfig?.emojis
	});
	const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(resolvedStatusReactionEmojis);
	let allowedStatusReactionEmojisPromise = null;
	const createStatusReactionController = statusReactionsEnabled && msg.message_id ? runtime?.createStatusReactionController ?? (await loadTelegramMessageContextRuntime()).createStatusReactionController : null;
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
		emojis: resolvedStatusReactionEmojis,
		timing: statusReactionsConfig?.timing,
		onError: (err) => {
			logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
		}
	}) : null;
	const ackReactionPromise = statusReactionController ? shouldAckReaction$1() ? Promise.resolve(statusReactionController.setQueued()).then(() => true, () => false) : null : shouldAckReaction$1() && msg.message_id && reactionApi && ackReactionEmoji ? withTelegramApiErrorLogging({
		operation: "setMessageReaction",
		fn: () => reactionApi(chatId, msg.message_id, [{
			type: "emoji",
			emoji: ackReactionEmoji
		}])
	}).then(() => true, (err) => {
		logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
		return false;
	}) : null;
	const { ctxPayload, skillFilter, turn } = await buildTelegramInboundContextPayload({
		cfg,
		primaryCtx,
		msg,
		allMedia,
		replyMedia,
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
		...bodyResult.audioTranscribedMediaIndex !== void 0 ? { audioTranscribedMediaIndex: bodyResult.audioTranscribedMediaIndex } : {},
		locationData: bodyResult.locationData,
		options,
		dmAllowFrom,
		effectiveGroupAllow,
		commandAuthorized: bodyResult.commandAuthorized,
		topicName,
		sessionRuntime
	});
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
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_NOT_FOUND_RE = /400:\s*Bad Request:\s*message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i;
const LONG_LIVED_PREVIEW_FRESH_FINAL_AFTER_MS = 6e4;
function extractErrorText(err) {
	return typeof err === "string" ? err : err instanceof Error ? err.message : typeof err === "object" && err && "description" in err ? typeof err.description === "string" ? err.description : "" : "";
}
function isMessageNotModifiedError(err) {
	return MESSAGE_NOT_MODIFIED_RE.test(extractErrorText(err));
}
/**
* Returns true when Telegram rejects an edit because the target message can no
* longer be resolved or edited. The caller still needs preview context to
* decide whether to retain a different visible preview or fall back to send.
*/
function isMissingPreviewMessageError(err) {
	return MESSAGE_NOT_FOUND_RE.test(extractErrorText(err));
}
function isIncompleteFinalPreviewPrefix(previewText, finalText) {
	const preview = previewText.trimEnd();
	const final = finalText.trimEnd();
	return preview.length > 0 && preview.length < final.length && final.startsWith(preview);
}
function result(kind, delivery) {
	if (kind === "preview-finalized") return {
		kind,
		delivery
	};
	return { kind };
}
function shouldSkipRegressivePreviewUpdate(args) {
	const currentPreviewText = args.currentPreviewText;
	if (currentPreviewText === void 0) return false;
	return currentPreviewText.startsWith(args.text) && args.text.length < currentPreviewText.length && (args.skipRegressive === "always" || args.hadPreviewMessage);
}
function isLongLivedPreview(visibleSinceMs, nowMs) {
	return typeof visibleSinceMs === "number" && Number.isFinite(visibleSinceMs) && nowMs - visibleSinceMs >= LONG_LIVED_PREVIEW_FRESH_FINAL_AFTER_MS;
}
function resolvePreviewTarget(params) {
	const lanePreviewMessageId = params.lane.stream?.messageId();
	const previewMessageId = typeof params.previewMessageIdOverride === "number" ? params.previewMessageIdOverride : lanePreviewMessageId;
	const hadPreviewMessage = typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
	return {
		hadPreviewMessage,
		previewMessageId: typeof previewMessageId === "number" ? previewMessageId : void 0,
		stopCreatesFirstPreview: params.stopBeforeEdit && !hadPreviewMessage && params.context === "final"
	};
}
function createLaneTextDeliverer(params) {
	const getLanePreviewText = (lane) => lane.lastPartialText;
	const readNow = () => params.now?.() ?? Date.now();
	const markActivePreviewComplete = (laneName) => {
		params.activePreviewLifecycleByLane[laneName] = "complete";
		params.retainPreviewOnCleanupByLane[laneName] = true;
	};
	const isMessagePreviewLane = (lane) => lane.stream != null;
	const shouldUseFreshFinalForLane = (lane) => isMessagePreviewLane(lane) && isLongLivedPreview(lane.stream?.visibleSinceMs?.(), readNow());
	const shouldUseFreshFinalForPreview = (lane, visibleSinceMs) => isMessagePreviewLane(lane) && isLongLivedPreview(visibleSinceMs, readNow());
	const clearActivePreviewAfterFreshFinal = async (lane, laneName) => {
		try {
			await lane.stream?.clear();
		} catch (err) {
			params.log(`telegram: ${laneName} fresh final preview cleanup failed: ${String(err)}`);
		}
		lane.lastPartialText = "";
		lane.hasStreamedMessage = false;
		lane.stream?.forceNewMessage();
	};
	const tryEditPreviewMessage = async (args) => {
		try {
			await params.editPreview({
				laneName: args.laneName,
				messageId: args.messageId,
				text: args.text,
				previewButtons: args.previewButtons,
				context: args.context
			});
			if (args.updateLaneSnapshot) args.lane.lastPartialText = args.text;
			params.markDelivered();
			return "edited";
		} catch (err) {
			if (isMessageNotModifiedError(err)) {
				params.log(`telegram: ${args.laneName} preview ${args.context} edit returned "message is not modified"; treating as delivered`);
				params.markDelivered();
				return "edited";
			}
			if (args.context === "final") {
				if (args.finalTextAlreadyLanded) {
					params.log(`telegram: ${args.laneName} preview final edit failed after stop flush; keeping existing preview (${String(err)})`);
					params.markDelivered();
					return "retained";
				}
				if (isSafeToRetrySendError(err)) {
					params.log(`telegram: ${args.laneName} preview final edit failed before reaching Telegram; falling back to standard send (${String(err)})`);
					return "fallback";
				}
				if (isMissingPreviewMessageError(err)) {
					if (args.retainAlternatePreviewOnMissingTarget) {
						params.log(`telegram: ${args.laneName} preview final edit target missing; keeping alternate preview without fallback (${String(err)})`);
						params.markDelivered();
						return "retained";
					}
					params.log(`telegram: ${args.laneName} preview final edit target missing with no alternate preview; falling back to standard send (${String(err)})`);
					return "fallback";
				}
				if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
					params.log(`telegram: ${args.laneName} preview final edit may have landed despite network error; keeping existing preview (${String(err)})`);
					params.markDelivered();
					return "retained";
				}
				if (isTelegramClientRejection(err)) {
					params.log(`telegram: ${args.laneName} preview final edit rejected by Telegram (client error); falling back to standard send (${String(err)})`);
					return "fallback";
				}
				if (isIncompleteFinalPreviewPrefix(args.targetPreviewText, args.text)) {
					params.log(`telegram: ${args.laneName} preview final edit failed and existing preview is an incomplete prefix; falling back to standard send (${String(err)})`);
					return "fallback";
				}
				params.log(`telegram: ${args.laneName} preview final edit failed with ambiguous error; keeping existing preview to avoid duplicate (${String(err)})`);
				params.markDelivered();
				return "retained";
			}
			params.log(`telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`);
			return "fallback";
		}
	};
	const tryUpdatePreviewForLane = async ({ lane, laneName, text, previewButtons, stopBeforeEdit = false, updateLaneSnapshot = false, skipRegressive, context, previewMessageId: previewMessageIdOverride, previewTextSnapshot }) => {
		const editPreview = (messageId, finalTextAlreadyLanded, retainAlternatePreviewOnMissingTarget, targetPreviewText) => tryEditPreviewMessage({
			laneName,
			messageId,
			text,
			context,
			previewButtons,
			updateLaneSnapshot,
			lane,
			finalTextAlreadyLanded,
			retainAlternatePreviewOnMissingTarget,
			targetPreviewText
		});
		const finalizePreview = (previewMessageId, finalTextAlreadyLanded, hadPreviewMessage, retainAlternatePreviewOnMissingTarget = false) => {
			const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
			if (shouldSkipRegressivePreviewUpdate({
				currentPreviewText,
				text,
				skipRegressive,
				hadPreviewMessage
			})) {
				params.markDelivered();
				return "regressive-skipped";
			}
			return editPreview(previewMessageId, finalTextAlreadyLanded, retainAlternatePreviewOnMissingTarget, currentPreviewText);
		};
		if (!lane.stream) return "fallback";
		if (resolvePreviewTarget({
			lane,
			previewMessageIdOverride,
			stopBeforeEdit,
			context
		}).stopCreatesFirstPreview && lane.hasStreamedMessage) {
			lane.stream.update(text);
			await params.stopDraftLane(lane);
			const previewTargetAfterStop = resolvePreviewTarget({
				lane,
				stopBeforeEdit: false,
				context
			});
			if (typeof previewTargetAfterStop.previewMessageId !== "number") return "fallback";
			return finalizePreview(previewTargetAfterStop.previewMessageId, true, false);
		}
		if (stopBeforeEdit) await params.stopDraftLane(lane);
		const previewTargetAfterStop = resolvePreviewTarget({
			lane,
			previewMessageIdOverride,
			stopBeforeEdit: false,
			context
		});
		if (typeof previewTargetAfterStop.previewMessageId !== "number") {
			if (context === "final" && lane.hasStreamedMessage && lane.stream?.sendMayHaveLanded?.()) {
				params.log(`telegram: ${laneName} preview send may have landed despite missing message id; keeping to avoid duplicate`);
				params.markDelivered();
				return "retained";
			}
			return "fallback";
		}
		const activePreviewMessageId = lane.stream?.messageId();
		return finalizePreview(previewTargetAfterStop.previewMessageId, false, previewTargetAfterStop.hadPreviewMessage, typeof activePreviewMessageId === "number" && activePreviewMessageId !== previewTargetAfterStop.previewMessageId);
	};
	const consumeArchivedAnswerPreviewForFinal = async ({ lane, text, payload, previewButtons, canEditViaPreview }) => {
		const archivedPreview = params.archivedAnswerPreviews.shift();
		if (!archivedPreview) return;
		if (canEditViaPreview && shouldUseFreshFinalForPreview(lane, archivedPreview.visibleSinceMs)) {
			if (await params.sendPayload(params.applyTextToPayload(payload, text))) {
				try {
					await params.deletePreviewMessage(archivedPreview.messageId);
				} catch (err) {
					params.log(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
				}
				return result("sent");
			}
		}
		if (canEditViaPreview) {
			const finalized = await tryUpdatePreviewForLane({
				lane,
				laneName: "answer",
				text,
				previewButtons,
				stopBeforeEdit: false,
				skipRegressive: "existingOnly",
				context: "final",
				previewMessageId: archivedPreview.messageId,
				previewTextSnapshot: archivedPreview.textSnapshot
			});
			if (finalized === "edited") return result("preview-finalized", {
				content: text,
				messageId: archivedPreview.messageId
			});
			if (finalized === "regressive-skipped") return result("preview-finalized", {
				content: archivedPreview.textSnapshot,
				messageId: archivedPreview.messageId
			});
			if (finalized === "retained") {
				params.retainPreviewOnCleanupByLane.answer = true;
				return result("preview-retained");
			}
		}
		const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
		if (delivered || archivedPreview.deleteIfUnused !== false) try {
			await params.deletePreviewMessage(archivedPreview.messageId);
		} catch (err) {
			params.log(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
		}
		return delivered ? result("sent") : result("skipped");
	};
	return async ({ laneName, text, payload, infoKind, previewButtons, allowPreviewUpdateForNonFinal = false }) => {
		const lane = params.lanes[laneName];
		const hasMedia = resolveSendableOutboundReplyParts(payload, { text }).hasMedia;
		const canEditViaPreview = !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;
		if (infoKind === "final") {
			if (params.activePreviewLifecycleByLane[laneName] === "transient") params.retainPreviewOnCleanupByLane[laneName] = false;
			if (laneName === "answer") {
				const archivedResult = await consumeArchivedAnswerPreviewForFinal({
					lane,
					text,
					payload,
					previewButtons,
					canEditViaPreview
				});
				if (archivedResult) return archivedResult;
			}
			if (canEditViaPreview && params.activePreviewLifecycleByLane[laneName] === "transient") {
				await params.flushDraftLane(lane);
				if (laneName === "answer") {
					const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
						lane,
						text,
						payload,
						previewButtons,
						canEditViaPreview
					});
					if (archivedResultAfterFlush) return archivedResultAfterFlush;
				}
				if (shouldUseFreshFinalForLane(lane)) {
					await params.stopDraftLane(lane);
					if (await params.sendPayload(params.applyTextToPayload(payload, text))) {
						await clearActivePreviewAfterFreshFinal(lane, laneName);
						return result("sent");
					}
				}
				const previewMessageId = lane.stream?.messageId();
				const finalized = await tryUpdatePreviewForLane({
					lane,
					laneName,
					text,
					previewButtons,
					stopBeforeEdit: true,
					skipRegressive: "existingOnly",
					context: "final"
				});
				if (finalized === "edited") {
					markActivePreviewComplete(laneName);
					return result("preview-finalized", {
						content: text,
						messageId: previewMessageId ?? lane.stream?.messageId()
					});
				}
				if (finalized === "regressive-skipped") {
					markActivePreviewComplete(laneName);
					return result("preview-finalized", {
						content: lane.lastPartialText,
						messageId: previewMessageId ?? lane.stream?.messageId()
					});
				}
				if (finalized === "retained") {
					markActivePreviewComplete(laneName);
					return result("preview-retained");
				}
			} else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) params.log(`telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`);
			await params.stopDraftLane(lane);
			return await params.sendPayload(params.applyTextToPayload(payload, text)) ? result("sent") : result("skipped");
		}
		if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
			const updated = await tryUpdatePreviewForLane({
				lane,
				laneName,
				text,
				previewButtons,
				stopBeforeEdit: false,
				updateLaneSnapshot: true,
				skipRegressive: "always",
				context: "update"
			});
			if (updated === "edited" || updated === "regressive-skipped") return result("preview-updated");
		}
		return await params.sendPayload(params.applyTextToPayload(payload, text)) ? result("sent") : result("skipped");
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
const REASONING_MESSAGE_PREFIX = "Reasoning:\n";
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
function splitTelegramReasoningText(text) {
	if (typeof text !== "string") return {};
	const trimmed = text.trim();
	if (isPartialReasoningTagPrefix(trimmed)) return {};
	if (trimmed.startsWith(REASONING_MESSAGE_PREFIX) && trimmed.length > 11) return { reasoningText: trimmed };
	const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
	const strippedAnswer = stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
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
	const takeBufferedFinalAnswer = () => {
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
//#region extensions/telegram/src/bot-message-dispatch.ts
const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");
/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;
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
const telegramAbortFenceByKey = /* @__PURE__ */ new Map();
function normalizeTelegramFenceKey(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveTelegramAbortFenceKey(params) {
	return normalizeTelegramFenceKey(params.ctxPayload.CommandTargetSessionKey) ?? normalizeTelegramFenceKey(params.ctxPayload.SessionKey) ?? `telegram:${String(params.chatId)}:${params.threadSpec.scope ?? "default"}:${params.threadSpec.id ?? "root"}`;
}
function beginTelegramAbortFence(params) {
	const state = telegramAbortFenceByKey.get(params.key) ?? {
		generation: 0,
		activeDispatches: 0
	};
	if (params.supersede) state.generation += 1;
	state.activeDispatches += 1;
	telegramAbortFenceByKey.set(params.key, state);
	return state.generation;
}
function isTelegramAbortFenceSuperseded(params) {
	return (telegramAbortFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}
function endTelegramAbortFence(key) {
	const state = telegramAbortFenceByKey.get(key);
	if (!state) return;
	state.activeDispatches -= 1;
	if (state.activeDispatches <= 0) telegramAbortFenceByKey.delete(key);
}
function resolveTelegramReasoningLevel(params) {
	const { cfg, sessionKey, agentId, telegramDeps } = params;
	if (!sessionKey) return "off";
	try {
		const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
		const level = resolveSessionStoreEntry({
			store: (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, { skipCache: true }),
			sessionKey
		}).existing?.reasoningLevel;
		if (level === "on" || level === "stream") return level;
	} catch {}
	return "off";
}
const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;
function clipProgressMarkdownText(text) {
	if (text.length <= MAX_PROGRESS_MARKDOWN_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_PROGRESS_MARKDOWN_TEXT_CHARS - 1).trimEnd()}…`;
}
function formatProgressAsMarkdownCode(text) {
	return `\`${clipProgressMarkdownText(text).replaceAll("`", "'")}\``;
}
const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps: injectedTelegramDeps, opts }) => {
	const telegramDeps = injectedTelegramDeps ?? (await import("./bot-deps-Dsu6vClF.js")).defaultTelegramBotDeps;
	const { ctxPayload, msg, chatId, isGroup, groupConfig, topicConfig, threadSpec, historyKey, historyLimit, groupHistories, route, skillFilter, sendTyping, sendRecordVoice, ackReactionPromise, reactionApi, removeAckAfterReply, statusReactionController } = context;
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
	const dispatchFenceKey = resolveTelegramAbortFenceKey({
		ctxPayload,
		chatId,
		threadSpec
	});
	let abortFenceGeneration;
	let dispatchWasSuperseded = false;
	const isDispatchSuperseded = () => abortFenceGeneration !== void 0 && isTelegramAbortFenceSuperseded({
		key: dispatchFenceKey,
		generation: abortFenceGeneration
	});
	const releaseAbortFence = () => {
		if (abortFenceGeneration === void 0) return;
		endTelegramAbortFence(dispatchFenceKey);
		abortFenceGeneration = void 0;
	};
	const draftMaxChars = Math.min(textLimit, 4096);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: route.accountId
	});
	const renderDraftPreview = (text) => ({
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
	const previewStreamingEnabled = streamMode !== "off";
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
	const canStreamAnswerDraft = previewStreamingEnabled && !(replyToMode !== "off" && replyQuoteText != null) && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
	const canStreamReasoningDraft = streamReasoningDraft;
	const draftReplyToMessageId = replyToMode !== "off" && typeof msg.message_id === "number" ? replyQuoteMessageId ?? msg.message_id : void 0;
	const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const archivedAnswerPreviews = [];
	const archivedReasoningPreviewIds = [];
	const createDraftLane = (laneName, enabled) => {
		return {
			stream: enabled ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
				api: bot.api,
				chatId,
				maxChars: draftMaxChars,
				thread: threadSpec,
				replyToMessageId: draftReplyToMessageId,
				minInitialChars: draftMinInitialChars,
				renderText: renderDraftPreview,
				onSupersededPreview: laneName === "answer" || laneName === "reasoning" ? (preview) => {
					if (laneName === "reasoning") {
						if (!archivedReasoningPreviewIds.includes(preview.messageId)) archivedReasoningPreviewIds.push(preview.messageId);
						return;
					}
					archivedAnswerPreviews.push({
						messageId: preview.messageId,
						textSnapshot: preview.textSnapshot,
						visibleSinceMs: preview.visibleSinceMs,
						deleteIfUnused: true
					});
				} : void 0,
				log: logVerbose,
				warn: logVerbose
			}) : void 0,
			lastPartialText: "",
			hasStreamedMessage: false
		};
	};
	const lanes = {
		answer: createDraftLane("answer", canStreamAnswerDraft),
		reasoning: createDraftLane("reasoning", canStreamReasoningDraft)
	};
	const activePreviewLifecycleByLane = {
		answer: "transient",
		reasoning: "transient"
	};
	const retainPreviewOnCleanupByLane = {
		answer: false,
		reasoning: false
	};
	const answerLane = lanes.answer;
	const reasoningLane = lanes.reasoning;
	const previewToolProgressEnabled = Boolean(answerLane.stream) && resolveChannelStreamingPreviewToolProgress(telegramCfg);
	let previewToolProgressSuppressed = false;
	let previewToolProgressLines = [];
	const pushPreviewToolProgress = (line) => {
		if (!previewToolProgressEnabled || previewToolProgressSuppressed || !answerLane.stream) return;
		const normalized = line?.replace(/\s+/g, " ").trim();
		if (!normalized) return;
		if (previewToolProgressLines.at(-1) === normalized) return;
		previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-8);
		const previewText = ["Working…", ...previewToolProgressLines.map((entry) => `• ${formatProgressAsMarkdownCode(entry)}`)].join("\n");
		answerLane.lastPartialText = previewText;
		answerLane.stream.update(previewText);
	};
	let splitReasoningOnNextStream = false;
	let skipNextAnswerMessageStartRotation = false;
	let pendingCompactionReplayBoundary = false;
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
	const splitTextIntoLaneSegments = (text) => {
		const split = splitTelegramReasoningText(text);
		const segments = [];
		const suppressReasoning = resolvedReasoningLevel === "off";
		if (split.reasoningText && !suppressReasoning) segments.push({
			lane: "reasoning",
			text: split.reasoningText
		});
		if (split.answerText) segments.push({
			lane: "answer",
			text: split.answerText
		});
		return {
			segments,
			suppressedReasoningOnly: Boolean(split.reasoningText) && suppressReasoning && !split.answerText
		};
	};
	const resetDraftLaneState = (lane) => {
		lane.lastPartialText = "";
		lane.hasStreamedMessage = false;
	};
	const rotateAnswerLaneForNewAssistantMessage = async () => {
		let didForceNewMessage = false;
		if (answerLane.hasStreamedMessage) {
			const previewMessageId = await answerLane.stream?.materialize?.() ?? answerLane.stream?.messageId();
			if (typeof previewMessageId === "number" && activePreviewLifecycleByLane.answer === "transient") archivedAnswerPreviews.push({
				messageId: previewMessageId,
				textSnapshot: answerLane.lastPartialText,
				visibleSinceMs: answerLane.stream?.visibleSinceMs?.(),
				deleteIfUnused: false
			});
			answerLane.stream?.forceNewMessage();
			didForceNewMessage = true;
		}
		resetDraftLaneState(answerLane);
		if (didForceNewMessage) {
			activePreviewLifecycleByLane.answer = "transient";
			retainPreviewOnCleanupByLane.answer = false;
		}
		return didForceNewMessage;
	};
	const updateDraftFromPartial = (lane, text) => {
		const laneStream = lane.stream;
		if (!laneStream || !text) return;
		if (text === lane.lastPartialText) return;
		if (lane === answerLane) {
			previewToolProgressSuppressed = true;
			previewToolProgressLines = [];
		}
		lane.hasStreamedMessage = true;
		if (lane.lastPartialText && lane.lastPartialText.startsWith(text) && text.length < lane.lastPartialText.length) return;
		lane.lastPartialText = text;
		laneStream.update(text);
	};
	const ingestDraftLaneSegments = async (text) => {
		const split = splitTextIntoLaneSegments(text);
		if (split.segments.some((segment) => segment.lane === "answer") && activePreviewLifecycleByLane.answer !== "transient") skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
		for (const segment of split.segments) {
			if (segment.lane === "reasoning") {
				reasoningStepState.noteReasoningHint();
				reasoningStepState.noteReasoningDelivered();
			}
			updateDraftFromPartial(lanes[segment.lane], segment.text);
		}
	};
	const flushDraftLane = async (lane) => {
		if (!lane.stream) return;
		await lane.stream.flush();
	};
	const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
	const disableBlockStreaming = !previewStreamingEnabled ? true : forceBlockStreamingForReasoning ? false : typeof resolvedBlockStreamingEnabled === "boolean" ? !resolvedBlockStreamingEnabled : canStreamAnswerDraft ? true : void 0;
	const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
	abortFenceGeneration = beginTelegramAbortFence({
		key: dispatchFenceKey,
		supersede: ctxPayload.CommandAuthorized && isAbortRequestText(ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "")
	});
	const implicitQuoteReplyTargetId = replyQuoteMessageId != null ? String(replyQuoteMessageId) : void 0;
	const currentMessageIdForQuoteReply = implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : void 0;
	const replyQuotePosition = typeof ctxPayload.ReplyToQuotePosition === "number" ? ctxPayload.ReplyToQuotePosition : void 0;
	const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities) ? ctxPayload.ReplyToQuoteEntities : void 0;
	const deliveryState = createLaneDeliveryStateTracker();
	const clearGroupHistory = () => {
		if (isGroup && historyKey) clearHistoryEntriesIfEnabled({
			historyMap: groupHistories,
			historyKey,
			limit: historyLimit
		});
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
		replyQuoteByMessageId
	};
	const silentErrorReplies = telegramCfg.silentErrorReplies === true;
	const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
	let queuedFinal = false;
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
		const applyQuoteReplyTarget = (payload) => {
			if (!implicitQuoteReplyTargetId || !currentMessageIdForQuoteReply || payload.replyToId !== currentMessageIdForQuoteReply || payload.replyToTag || payload.replyToCurrent) return payload;
			return {
				...payload,
				replyToId: implicitQuoteReplyTargetId
			};
		};
		const sendPayload = async (payload) => {
			if (isDispatchSuperseded()) return false;
			const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
				...deliveryBaseOptions,
				replies: [applyQuoteReplyTarget(payload)],
				onVoiceRecording: sendRecordVoice,
				silent: silentErrorReplies && payload.isError === true,
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
		};
		const deliverLaneText = createLaneTextDeliverer({
			lanes,
			archivedAnswerPreviews,
			activePreviewLifecycleByLane,
			retainPreviewOnCleanupByLane,
			draftMaxChars,
			applyTextToPayload,
			sendPayload,
			flushDraftLane,
			stopDraftLane: async (lane) => {
				await lane.stream?.stop();
			},
			editPreview: async ({ messageId, text, previewButtons }) => {
				if (isDispatchSuperseded()) return;
				await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
					api: bot.api,
					cfg,
					accountId: route.accountId,
					linkPreview: telegramCfg.linkPreview,
					buttons: previewButtons
				});
			},
			deletePreviewMessage: async (messageId) => {
				if (isDispatchSuperseded()) return;
				await bot.api.deleteMessage(chatId, messageId);
			},
			log: logVerbose,
			markDelivered: () => {
				deliveryState.markDelivered();
			}
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
		if (statusReactionController) statusReactionController.setThinking();
		const { onModelSelected, ...replyPipeline } = (telegramDeps.createChannelReplyPipeline ?? createChannelReplyPipeline)({
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
						runDispatch: () => telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
							ctx: ctxPayload,
							cfg,
							dispatcherOptions: {
								...replyPipeline,
								beforeDeliver: async (payload) => payload,
								deliver: async (payload, info) => {
									if (isDispatchSuperseded()) return;
									const clearPendingCompactionReplayBoundaryOnVisibleBoundary = (didDeliver) => {
										if (didDeliver && info.kind !== "final") pendingCompactionReplayBoundary = false;
									};
									if (payload.isError === true) hadErrorReplyFailureOrSkip = true;
									if (info.kind === "final") await enqueueDraftLaneEvent(async () => {});
									if (shouldSuppressLocalTelegramExecApprovalPrompt({
										cfg,
										accountId: route.accountId,
										payload
									})) {
										queuedFinal = true;
										return;
									}
									const previewButtons = (payload.channelData?.telegram)?.buttons;
									const split = splitTextIntoLaneSegments(payload.text);
									const segments = split.segments;
									const reply = resolveSendableOutboundReplyParts(payload);
									reply.hasMedia;
									const flushBufferedFinalAnswer = async () => {
										const buffered = reasoningStepState.takeBufferedFinalAnswer();
										if (!buffered) return;
										const bufferedButtons = (buffered.payload.channelData?.telegram)?.buttons;
										await deliverLaneText({
											laneName: "answer",
											text: buffered.text,
											payload: buffered.payload,
											infoKind: "final",
											previewButtons: bufferedButtons
										});
										reasoningStepState.resetForNextStep();
									};
									for (const segment of segments) {
										if (segment.lane === "answer" && info.kind === "final" && reasoningStepState.shouldBufferFinalAnswer()) {
											reasoningStepState.bufferFinalAnswer({
												payload,
												text: segment.text
											});
											continue;
										}
										if (segment.lane === "reasoning") reasoningStepState.noteReasoningHint();
										const result = await deliverLaneText({
											laneName: segment.lane,
											text: segment.text,
											payload,
											infoKind: info.kind,
											previewButtons,
											allowPreviewUpdateForNonFinal: segment.lane === "reasoning"
										});
										if (info.kind === "final") emitPreviewFinalizedHook(result);
										if (segment.lane === "reasoning") {
											if (result.kind !== "skipped") {
												reasoningStepState.noteReasoningDelivered();
												await flushBufferedFinalAnswer();
											}
											continue;
										}
										if (info.kind === "final") {
											if (reasoningLane.hasStreamedMessage) {
												activePreviewLifecycleByLane.reasoning = "complete";
												retainPreviewOnCleanupByLane.reasoning = true;
											}
											reasoningStepState.resetForNextStep();
										}
									}
									if (segments.length > 0) {
										if (info.kind === "final") pendingCompactionReplayBoundary = false;
										return;
									}
									if (split.suppressedReasoningOnly) {
										if (reply.hasMedia) clearPendingCompactionReplayBoundaryOnVisibleBoundary(await sendPayload(typeof payload.text === "string" ? {
											...payload,
											text: ""
										} : payload));
										if (info.kind === "final") {
											await flushBufferedFinalAnswer();
											pendingCompactionReplayBoundary = false;
										}
										return;
									}
									if (info.kind === "final") {
										await answerLane.stream?.stop();
										await reasoningLane.stream?.stop();
										reasoningStepState.resetForNextStep();
									}
									if (!(reply.hasMedia || reply.text.length > 0)) {
										if (info.kind === "final") {
											await flushBufferedFinalAnswer();
											pendingCompactionReplayBoundary = false;
										}
										return;
									}
									clearPendingCompactionReplayBoundaryOnVisibleBoundary(await sendPayload(payload));
									if (info.kind === "final") {
										await flushBufferedFinalAnswer();
										pendingCompactionReplayBoundary = false;
									}
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
								onPartialReply: answerLane.stream || reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
									await ingestDraftLaneSegments(payload.text);
								}) : void 0,
								onReasoningStream: reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
									if (splitReasoningOnNextStream) {
										reasoningLane.stream?.forceNewMessage();
										resetDraftLaneState(reasoningLane);
										splitReasoningOnNextStream = false;
									}
									await ingestDraftLaneSegments(payload.text);
								}) : void 0,
								onAssistantMessageStart: answerLane.stream ? () => enqueueDraftLaneEvent(async () => {
									reasoningStepState.resetForNextStep();
									previewToolProgressSuppressed = false;
									previewToolProgressLines = [];
									if (skipNextAnswerMessageStartRotation) {
										skipNextAnswerMessageStartRotation = false;
										activePreviewLifecycleByLane.answer = "transient";
										retainPreviewOnCleanupByLane.answer = false;
										return;
									}
									if (pendingCompactionReplayBoundary) {
										pendingCompactionReplayBoundary = false;
										activePreviewLifecycleByLane.answer = "transient";
										retainPreviewOnCleanupByLane.answer = false;
										return;
									}
									await rotateAnswerLaneForNewAssistantMessage();
									activePreviewLifecycleByLane.answer = "transient";
									retainPreviewOnCleanupByLane.answer = false;
								}) : void 0,
								onReasoningEnd: reasoningLane.stream ? () => enqueueDraftLaneEvent(async () => {
									splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
									previewToolProgressSuppressed = false;
									previewToolProgressLines = [];
								}) : void 0,
								suppressDefaultToolProgressMessages: !previewStreamingEnabled || Boolean(answerLane.stream),
								onToolStart: async (payload) => {
									const toolName = payload.name?.trim();
									if (statusReactionController && toolName) await statusReactionController.setTool(toolName);
									pushPreviewToolProgress(toolName ? `tool: ${toolName}` : "tool running");
								},
								onItemEvent: async (payload) => {
									pushPreviewToolProgress(payload.progressText ?? payload.summary ?? payload.title ?? payload.name);
								},
								onPlanUpdate: async (payload) => {
									if (payload.phase !== "update") return;
									pushPreviewToolProgress(payload.explanation ?? payload.steps?.[0] ?? "planning");
								},
								onApprovalEvent: async (payload) => {
									if (payload.phase !== "requested") return;
									pushPreviewToolProgress(payload.command ? `approval: ${payload.command}` : "approval requested");
								},
								onCommandOutput: async (payload) => {
									if (payload.phase !== "end") return;
									pushPreviewToolProgress(payload.name ? `${payload.name}${payload.exitCode === 0 ? " ✓" : payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}` : payload.title);
								},
								onPatchSummary: async (payload) => {
									if (payload.phase !== "end") return;
									pushPreviewToolProgress(payload.summary ?? payload.title ?? "patch applied");
								},
								onCompactionStart: statusReactionController || answerLane.stream ? async () => {
									if (answerLane.hasStreamedMessage && activePreviewLifecycleByLane.answer === "transient") pendingCompactionReplayBoundary = true;
									if (statusReactionController) await statusReactionController.setCompacting();
								} : void 0,
								onCompactionEnd: statusReactionController ? async () => {
									statusReactionController.cancelPending();
									await statusReactionController.setThinking();
								} : void 0,
								onModelSelected
							}
						})
					})
				}
			});
			if (!turnResult.dispatched) return;
			({queuedFinal} = turnResult.dispatchResult);
		} catch (err) {
			dispatchError = err;
			runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
		} finally {
			await draftLaneEventQueue;
			if (isDispatchSuperseded()) {
				if (answerLane.hasStreamedMessage || typeof answerLane.stream?.messageId() === "number") retainPreviewOnCleanupByLane.answer = true;
				for (const archivedPreview of archivedAnswerPreviews) archivedPreview.deleteIfUnused = false;
			}
			const streamCleanupStates = /* @__PURE__ */ new Map();
			const lanesToCleanup = [{
				laneName: "answer",
				lane: answerLane
			}, {
				laneName: "reasoning",
				lane: reasoningLane
			}];
			for (const laneState of lanesToCleanup) {
				const stream = laneState.lane.stream;
				if (!stream) continue;
				const activePreviewMessageId = stream.messageId();
				const hasBoundaryFinalizedActivePreview = laneState.laneName === "answer" && typeof activePreviewMessageId === "number" && archivedAnswerPreviews.some((p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId);
				const shouldClear = !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
				const existing = streamCleanupStates.get(stream);
				if (!existing) {
					streamCleanupStates.set(stream, { shouldClear });
					continue;
				}
				existing.shouldClear = existing.shouldClear && shouldClear;
			}
			for (const [stream, cleanupState] of streamCleanupStates) {
				if (isDispatchSuperseded()) {
					await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
					continue;
				}
				await stream.stop();
				if (cleanupState.shouldClear) await stream.clear();
			}
			if (!isDispatchSuperseded()) {
				for (const archivedPreview of archivedAnswerPreviews) {
					if (archivedPreview.deleteIfUnused === false) continue;
					try {
						await bot.api.deleteMessage(chatId, archivedPreview.messageId);
					} catch (err) {
						logVerbose(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
					}
				}
				for (const messageId of archivedReasoningPreviewIds) try {
					await bot.api.deleteMessage(chatId, messageId);
				} catch (err) {
					logVerbose(`telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`);
				}
			}
		}
	} finally {
		dispatchWasSuperseded = isDispatchSuperseded();
		releaseAbortFence();
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
		clearGroupHistory();
		return;
	}
	let sentFallback = false;
	const deliverySummary = deliveryState.snapshot();
	if (dispatchError || !deliverySummary.delivered && (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0)) {
		const fallbackText = dispatchError ? "Something went wrong while processing your request. Please try again." : EMPTY_RESPONSE_FALLBACK;
		sentFallback = (await (telegramDeps.deliverReplies ?? deliverReplies)({
			replies: [{ text: fallbackText }],
			...deliveryBaseOptions,
			silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
			mediaLoader: telegramDeps.loadWebMedia
		})).delivered;
	}
	if (!queuedFinal && !sentFallback && !dispatchError && !deliverySummary.delivered) {
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
	const hasFinalResponse = hasFinalChannelTurnDispatch({ queuedFinal }, {
		fallbackDelivered: sentFallback,
		deliverySummaryDelivered: deliverySummary.delivered
	});
	if (statusReactionController && !hasFinalResponse) finalizeTelegramStatusReaction({
		outcome: "error",
		hasFinalResponse: false
	}).catch((err) => {
		logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
	});
	if (!hasFinalResponse) {
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
	clearGroupHistory();
};
//#endregion
//#region extensions/telegram/src/bot-message.ts
const createTelegramMessageProcessor = (deps) => {
	const { bot, cfg, account, telegramCfg, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, loadFreshConfig, sendChatActionHandler, runtime, replyToMode, streamMode, textLimit, telegramDeps, opts } = deps;
	return async (primaryCtx, allMedia, storeAllowFrom, options, replyMedia) => {
		const ingressReceivedAtMs = typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs) ? options.receivedAtMs : void 0;
		const ingressDebugEnabled = shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
		const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : void 0;
		const context = await buildTelegramMessageContext({
			primaryCtx,
			allMedia,
			replyMedia,
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
			upsertPairingRequest: telegramDeps.upsertChannelPairingRequest
		});
		if (!context) {
			if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) logVerbose(`telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""));
			return;
		}
		if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) logVerbose(`telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs} preDispatchMs=${Date.now() - ingressContextStartMs}` + (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""));
		context.sendTyping().catch((err) => {
			logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
		});
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
	};
};
//#endregion
//#region extensions/telegram/src/bot-update-tracker.ts
function sortedIds(ids) {
	return [...ids].toSorted((a, b) => a - b);
}
function createTelegramUpdateTracker(options = {}) {
	const initialUpdateId = typeof options.initialUpdateId === "number" ? options.initialUpdateId : null;
	const recentUpdates = createTelegramUpdateDedupe();
	const pendingUpdateKeys = /* @__PURE__ */ new Set();
	const activeHandledUpdateKeys = /* @__PURE__ */ new Map();
	const pendingUpdateIds = /* @__PURE__ */ new Set();
	const failedUpdateIds = /* @__PURE__ */ new Set();
	let highestAcceptedUpdateId = initialUpdateId;
	let highestPersistedAcceptedUpdateId = initialUpdateId;
	let highestPersistenceRequestedUpdateId = initialUpdateId;
	let highestCompletedUpdateId = initialUpdateId;
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
		requestPersistAcceptedUpdateId(updateId);
	};
	const beginUpdate = (ctx) => {
		const updateId = resolveTelegramUpdateId(ctx);
		const updateKey = buildTelegramUpdateKey(ctx);
		if (typeof updateId === "number") if (highestAcceptedUpdateId !== null && updateId <= highestAcceptedUpdateId) {
			if (!failedUpdateIds.has(updateId)) {
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
		if (typeof updateId === "number") {
			pendingUpdateIds.add(updateId);
			acceptUpdateId(updateId);
		}
		return {
			accepted: true,
			update: {
				...updateKey ? { key: updateKey } : {},
				...typeof updateId === "number" ? { updateId } : {}
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
				if (highestCompletedUpdateId === null || update.updateId > highestCompletedUpdateId) highestCompletedUpdateId = update.updateId;
			} else failedUpdateIds.add(update.updateId);
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
	const resolveSafeCompletedUpdateId = () => {
		if (highestCompletedUpdateId === null) return null;
		let safeCompletedUpdateId = highestCompletedUpdateId;
		for (const updateId of pendingUpdateIds) if (updateId <= safeCompletedUpdateId) safeCompletedUpdateId = updateId - 1;
		for (const updateId of failedUpdateIds) if (updateId <= safeCompletedUpdateId) safeCompletedUpdateId = updateId - 1;
		return safeCompletedUpdateId;
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
function createTelegramSendChatActionHandler({ sendChatActionFn, logger, maxConsecutive401 = 10 }) {
	let consecutive401Failures = 0;
	let suspended = false;
	const reset = () => {
		consecutive401Failures = 0;
		suspended = false;
	};
	const sendChatAction = async (chatId, action, threadParams) => {
		if (suspended) return;
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
		}
	};
	return {
		sendChatAction,
		isSuspended: () => suspended,
		reset
	};
}
//#endregion
//#region extensions/telegram/src/sequential-key.ts
function resolveStatusCommandControlLane(params) {
	const alias = maybeResolveTextAlias(normalizeCommandBody(params.rawText?.trim() ?? "", params.botUsername ? { botUsername: params.botUsername } : void 0));
	if (!alias) return false;
	const command = listChatCommands().find((entry) => entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias));
	return command?.category === "status" && command.key !== "export-session";
}
function getTelegramSequentialKey(ctx) {
	const reaction = ctx.update?.message_reaction;
	if (reaction?.chat?.id) return `telegram:${reaction.chat.id}`;
	const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.update?.callback_query?.message;
	const chatId = msg?.chat?.id ?? ctx.chat?.id;
	const rawText = msg?.text ?? msg?.caption;
	const botUsername = ctx.me?.username;
	if (isAbortRequestText(rawText, botUsername ? { botUsername } : void 0)) {
		if (typeof chatId === "number") return `telegram:${chatId}:control`;
		return "telegram:control";
	}
	if (resolveStatusCommandControlLane({
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
	const isForum = msg?.chat?.is_forum;
	const threadId = isGroup ? resolveTelegramForumThreadId({
		isForum,
		messageThreadId
	}) : messageThreadId;
	if (typeof chatId === "number") return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
	return "telegram:unknown";
}
//#endregion
//#region extensions/telegram/src/bot-core.ts
const DEFAULT_TELEGRAM_BOT_RUNTIME = {
	Bot: Bot$1,
	sequentialize,
	apiThrottler
};
let telegramBotRuntimeForTest;
function asTelegramClientFetch(fetchImpl) {
	return fetchImpl;
}
function asTelegramCompatFetch(fetchImpl) {
	return fetchImpl;
}
function isTelegramAbortSignalLike(value) {
	return typeof value === "object" && value !== null && "aborted" in value && typeof value.aborted === "boolean" && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}
function readRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	return null;
}
function extractTelegramApiMethod(input) {
	const url = readRequestUrl(input);
	if (!url) return null;
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		return normalizeOptionalLowercaseString(segments.length > 0 ? segments.at(-1) ?? null : null) ?? null;
	} catch {
		return null;
	}
}
const TELEGRAM_TIMEOUT_FALLBACK_METHODS = new Set([
	"deletemycommands",
	"deletewebhook",
	"getme",
	"sendchataction",
	"setmycommands",
	"setwebhook"
]);
function shouldRetryTimedOutTelegramControlRequest(method) {
	return method !== null && TELEGRAM_TIMEOUT_FALLBACK_METHODS.has(method);
}
function resolveTelegramClientTimeoutSeconds(params) {
	const { value, minimum } = params;
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const configured = Math.max(1, Math.floor(value));
	if (typeof minimum !== "number" || !Number.isFinite(minimum)) return configured;
	return Math.max(configured, Math.max(1, Math.floor(minimum)));
}
function resolveTelegramClientTimeoutMinimumSeconds(values) {
	let minimum;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		const normalized = Math.max(1, Math.ceil(value));
		minimum = minimum === void 0 ? normalized : Math.max(minimum, normalized);
	}
	return minimum;
}
function resolveTelegramOutboundClientTimeoutFloorSeconds(timeoutSeconds) {
	const timeoutMs = resolveTelegramRequestTimeoutMs("sendmessage", timeoutSeconds);
	return timeoutMs === void 0 ? void 0 : timeoutMs / 1e3;
}
function createTelegramBotCore(opts) {
	const botRuntime = telegramBotRuntimeForTest ?? DEFAULT_TELEGRAM_BOT_RUNTIME;
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
	const shouldProvideFetch = Boolean(telegramTransport.fetch);
	const fetchForClient = telegramTransport.fetch ? asTelegramCompatFetch(asTelegramClientFetch(telegramTransport.fetch)) : void 0;
	let finalFetch = shouldProvideFetch ? fetchForClient : void 0;
	if (finalFetch || opts.fetchAbortSignal) {
		const callFetch = finalFetch ?? asTelegramCompatFetch(asTelegramClientFetch(globalThis.fetch));
		finalFetch = async (input, init) => {
			const method = extractTelegramApiMethod(input);
			const requestTimeoutMs = resolveTelegramRequestTimeoutMs(method, telegramCfg?.timeoutSeconds);
			const shutdownSignal = isTelegramAbortSignalLike(opts.fetchAbortSignal) ? opts.fetchAbortSignal : void 0;
			const requestSignal = isTelegramAbortSignalLike(init?.signal) ? init.signal : void 0;
			const runFetch = async () => {
				const controller = new AbortController();
				const abortWith = (signal) => controller.abort(signal.reason);
				const onShutdown = () => {
					if (shutdownSignal) abortWith(shutdownSignal);
				};
				let requestTimeout;
				let onRequestAbort;
				let requestTimedOut = false;
				const timeoutError = requestTimeoutMs !== void 0 ? /* @__PURE__ */ new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`) : void 0;
				if (shutdownSignal?.aborted) abortWith(shutdownSignal);
				else if (shutdownSignal) shutdownSignal.addEventListener("abort", onShutdown, { once: true });
				if (requestSignal) if (requestSignal.aborted) abortWith(requestSignal);
				else {
					onRequestAbort = () => abortWith(requestSignal);
					requestSignal.addEventListener("abort", onRequestAbort);
				}
				if (requestTimeoutMs && timeoutError) {
					requestTimeout = setTimeout(() => {
						requestTimedOut = true;
						controller.abort(timeoutError);
					}, requestTimeoutMs);
					requestTimeout.unref?.();
				}
				try {
					return await callFetch(input, {
						...init,
						signal: controller.signal
					});
				} catch (err) {
					if (requestTimedOut && timeoutError) throw timeoutError;
					throw err;
				} finally {
					if (requestTimeout) clearTimeout(requestTimeout);
					shutdownSignal?.removeEventListener("abort", onShutdown);
					if (requestSignal && onRequestAbort) requestSignal.removeEventListener("abort", onRequestAbort);
				}
			};
			try {
				return await runFetch();
			} catch (err) {
				if (requestTimeoutMs && shouldRetryTimedOutTelegramControlRequest(method) && !shutdownSignal?.aborted && !requestSignal?.aborted && telegramTransport.forceFallback?.("request-timeout")) return await runFetch();
				throw err;
			}
		};
	}
	if (finalFetch) {
		const baseFetch = finalFetch;
		finalFetch = (input, init) => {
			return Promise.resolve(baseFetch(input, init)).catch((err) => {
				try {
					tagTelegramNetworkError(err, {
						method: extractTelegramApiMethod(input),
						url: readRequestUrl(input)
					});
				} catch {}
				throw err;
			});
		};
	}
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
	const bot = new botRuntime.Bot(opts.token, client ? { client } : void 0);
	bot.api.config.use(botRuntime.apiThrottler());
	bot.catch((err) => {
		runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
	});
	const initialUpdateId = typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
	const logSkippedUpdate = (key) => {
		if (shouldLogVerbose()) logVerbose(`telegram dedupe: skipped ${key}`);
	};
	const updateTracker = createTelegramUpdateTracker({
		initialUpdateId,
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
	const MAX_RAW_UPDATE_STRING = 500;
	const MAX_RAW_UPDATE_ARRAY = 20;
	const stringifyUpdate = (update) => {
		const seen = /* @__PURE__ */ new WeakSet();
		return JSON.stringify(update ?? null, (key, value) => {
			if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
			if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) return [...value.slice(0, MAX_RAW_UPDATE_ARRAY), `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`];
			if (value && typeof value === "object") {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		});
	};
	bot.use(async (ctx, next) => {
		if (shouldLogVerbose()) try {
			const raw = stringifyUpdate(ctx.update);
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
		const freshTelegramCfg = loadFreshTelegramAccountConfig();
		const groups = freshTelegramCfg.groups;
		const direct = freshTelegramCfg.direct;
		const chatIdStr = String(chatId);
		if (!chatIdStr.startsWith("-")) {
			const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
			if (directConfig) return {
				groupConfig: directConfig,
				topicConfig: messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : void 0
			};
			return {
				groupConfig: void 0,
				topicConfig: void 0
			};
		}
		if (!groups) return {
			groupConfig: void 0,
			topicConfig: void 0
		};
		const groupConfig = groups[chatIdStr] ?? groups["*"];
		return {
			groupConfig,
			topicConfig: messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : void 0
		};
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
			logger: (message) => logVerbose(`telegram: ${message}`)
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
export { createTelegramBot as t };
