import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { S as MarkdownTableMode } from "../../types.base-DS--yneR.js";
import { o as GroupToolPolicyConfig } from "../../types.tools-BpgZArJS.js";
import { D as TelegramGroupConfig, O as TelegramInlineButtonsScope, P as TelegramTopicConfig, S as TelegramDirectConfig, T as TelegramExecApprovalConfig, k as TelegramNetworkConfig, m as ResolvedReactionLevel$1, p as ReactionLevel } from "../../types.channels-C67UBRPK.js";
import { s as ExecApprovalRequest } from "../../exec-approvals-DZ3KhICc.js";
import { n as ChannelOutboundAdapter } from "../../outbound.types-D7agCOHK.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot } from "../../types.core-BkmTlRzr.js";
import { r as ReplyPayload } from "../../reply-payload-BlNiejVc.js";
import { o as PluginApprovalRequest } from "../../plugin-approvals-BKi4KQTi.js";
import { n as NormalizedLocation } from "../../location-D6ia4w3e.js";
import { o as readChannelAllowFromStore } from "../../pairing-store-caRw7Va0.js";
import { n as TelegramCredentialStatus, r as inspectTelegramAccount, t as InspectedTelegramAccount } from "../../account-inspect-D7hwGJRD.js";
import { g as TelegramInlineButtons, h as TelegramButtonStyle, u as sendMessageTelegram } from "../../send-DtZGLA2D.js";
import { a as normalizeTelegramCommandName, i as normalizeTelegramCommandDescription, n as TelegramCustomCommandInput, o as resolveTelegramCustomCommands, r as TelegramCustomCommandIssue, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../../command-config-B5uSKuEF.js";
import { _ as buildTelegramExecApprovalPendingPayload, a as ParsedTelegramTopicConversation, b as NormalizedAllowFrom, d as CachedSticker, f as cacheSticker, g as searchStickers, h as getCachedSticker, l as DescribeStickerParams, m as getCacheStats, o as parseTelegramTopicConversation, p as getAllCachedStickers, u as describeStickerImage, v as shouldSuppressTelegramExecApprovalForwardingFallback } from "../../runtime-api-DQZanni9.js";
import { i as resetTelegramProbeFetcherCacheForTests, n as TelegramProbeOptions, r as probeTelegram, t as TelegramProbe } from "../../probe-BP11RQbF.js";
import { t as TelegramTokenResolution } from "../../token-Cclcktlo.js";
import { n as isNumericTelegramUserId, r as normalizeTelegramAllowFromEntry, t as isNumericTelegramSenderUserId } from "../../allow-from-CUKXV9ZT.js";
import { a as listEnabledTelegramAccounts, c as resolveDefaultTelegramAccountId, d as resolveTelegramPollActionGateState, f as mergeTelegramAccountConfig, i as createTelegramActionGate, l as resolveTelegramAccount, n as TelegramMediaRuntimeOptions, o as listTelegramAccountIds, p as resolveTelegramAccountConfig, r as TelegramPollActionGateState, s as resetMissingDefaultWarnFlag, t as ResolvedTelegramAccount, u as resolveTelegramMediaRuntimeOptions } from "../../accounts-D4kQK2Wz.js";
import { t as telegramPlugin } from "../../channel-DLPe2rdg.js";
import { t as telegramSetupPlugin } from "../../channel.setup-DjU1Y1Tv.js";
import { _ as resolveModelSelection, a as ButtonRow, c as ProviderInfo, d as buildModelSelectionCallbackData, f as buildModelsKeyboard, g as parseModelCallbackData, h as getModelsPageSize, i as buildTelegramModelsProviderChannelData, l as ResolveModelSelectionResult, m as calculateTotalPages, n as TelegramInteractiveHandlerRegistration, o as ModelsKeyboardParams, p as buildProviderKeyboard, r as buildCommandsPaginationKeyboard, s as ParsedModelCallback, t as TelegramInteractiveHandlerContext, u as buildBrowseProvidersButton } from "../../interactive-dispatch-Bk81ioRA.js";
import { n as listTelegramDirectoryPeersFromConfig, t as listTelegramDirectoryGroupsFromConfig } from "../../directory-config-CxQNGBS0.js";
import { t as collectTelegramSecurityAuditFindings } from "../../security-audit-BWfrfQvx.js";
import { n as readTelegramUpdateOffset, r as writeTelegramUpdateOffset, t as deleteTelegramUpdateOffset } from "../../update-offset-store-C0iicdOm.js";
import { Chat, ChatFullInfo, Message } from "grammy/types";

//#region extensions/telegram/src/action-threading.d.ts
declare function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: {
    currentThreadTs?: string;
    currentChannelId?: string;
  };
}): string | undefined;
//#endregion
//#region extensions/telegram/src/api-fetch.d.ts
declare function resolveTelegramChatLookupFetch(params?: {
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): typeof fetch;
declare function lookupTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): Promise<string | null>;
declare function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null>;
//#endregion
//#region extensions/telegram/src/bot/body-helpers.d.ts
type TelegramMediaMessage = Pick<Message, "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker">;
declare function buildSenderName(msg: Message): string | undefined;
declare function resolveTelegramMediaPlaceholder(msg: TelegramMediaMessage | undefined | null): string | undefined;
declare function buildSenderLabel(msg: Message, senderId?: number | string): string;
type TelegramTextEntity = NonNullable<Message["entities"]>[number];
declare function isBinaryContent(text: string): boolean;
declare function getTelegramTextParts(msg: Pick<Message, "text" | "caption" | "entities" | "caption_entities">): {
  text: string;
  entities: TelegramTextEntity[];
};
declare function hasBotMention(msg: Message, botUsername: string): boolean;
type TelegramTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};
declare function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string;
type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
  fromChatType?: Chat["type"];
  fromMessageId?: number;
};
declare function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null;
declare function extractTelegramLocation(msg: Message): NormalizedLocation | null;
//#endregion
//#region extensions/telegram/src/bot/types.d.ts
/** App-specific stream mode for Telegram stream previews. */
type TelegramStreamMode = "off" | "partial" | "block" | "progress";
type TelegramChatDetails = {
  id?: number | string;
  available_reactions?: ChatFullInfo["available_reactions"] | null;
  is_forum?: boolean;
};
type TelegramGetChat = (chatId: number | string) => Promise<TelegramChatDetails>;
/** Telegram sticker metadata for context enrichment and caching. */
interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
//#endregion
//#region extensions/telegram/src/bot/helpers.d.ts
declare function resetTelegramForumFlagCacheForTest(): void;
type TelegramThreadSpec = {
  id?: number;
  scope: "dm" | "forum" | "none";
};
declare function extractTelegramForumFlag(value: unknown): boolean | undefined;
declare function resolveTelegramForumFlag(params: {
  chatId: string | number;
  chatType?: Chat["type"];
  isGroup: boolean;
  isForum?: boolean;
  isTopicMessage?: boolean;
  getChat?: TelegramGetChat;
}): Promise<boolean>;
declare function withResolvedTelegramForumFlag<T extends {
  chat: object;
}>(message: T, isForum: boolean): T;
declare function resolveTelegramGroupAllowFromContext(params: {
  cfg?: OpenClawConfig;
  chatId: string | number;
  accountId?: string;
  senderId?: string;
  isGroup?: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
  groupAllowFrom?: Array<string | number>;
  readChannelAllowFromStore?: typeof readChannelAllowFromStore;
  resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
    groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
    topicConfig?: TelegramTopicConfig;
  };
}): Promise<{
  resolvedThreadId?: number;
  dmThreadId?: number;
  storeAllowFrom: string[];
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  groupAllowOverride?: Array<string | number>;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
}>;
/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
declare function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}): number | undefined;
declare function resolveTelegramThreadSpec(params: {
  isGroup: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
}): TelegramThreadSpec;
/**
 * Build thread params for Telegram API calls (messages, media).
 *
 * IMPORTANT: Thread IDs behave differently based on chat type:
 * - DMs (private chats): Include message_thread_id when present (DM topics)
 * - Forum topics: Skip thread_id=1 (General topic), include others
 * - Regular groups: Thread IDs are ignored by Telegram
 *
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 *
 * @param thread - Thread specification with ID and scope
 * @returns API params object or undefined if thread_id should be omitted
 */
declare function buildTelegramThreadParams(thread?: TelegramThreadSpec | null): {
  message_thread_id: number;
} | undefined;
/**
 * Build a Telegram routing target that keeps real topic/thread ids in-band.
 *
 * This is used by generic reply plumbing that may not always carry a separate
 * `threadId` field through every hop. General forum topic stays chat-scoped
 * because Telegram rejects `message_thread_id=1` for message sends.
 */
declare function buildTelegramRoutingTarget(chatId: number | string, thread?: TelegramThreadSpec | null): string;
/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
declare function buildTypingThreadParams(messageThreadId?: number): {
  message_thread_id: number;
} | undefined;
declare function resolveTelegramStreamMode(telegramCfg?: {
  streaming?: unknown;
  streamMode?: unknown;
}): TelegramStreamMode;
declare function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number): string;
/**
 * Resolve the direct-message peer identifier for Telegram routing/session keys.
 *
 * In some Telegram DM deliveries (for example certain business/chat bridge flows),
 * `chat.id` can differ from the actual sender user id. Prefer sender id when present
 * so per-peer DM scopes isolate users correctly.
 */
declare function resolveTelegramDirectPeerId(params: {
  chatId: number | string;
  senderId?: number | string | null;
}): string;
declare function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number): string;
/**
 * Build parentPeer for forum topic binding inheritance.
 * When a message comes from a forum topic, the peer ID includes the topic suffix
 * (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
 * group ID to match, we provide the parent group as `parentPeer` so the routing
 * layer can fall back to it when the exact peer doesn't match.
 */
declare function buildTelegramParentPeer(params: {
  isGroup: boolean;
  resolvedThreadId?: number;
  chatId: number | string;
}): {
  kind: "group";
  id: string;
} | undefined;
declare function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number): string;
declare function resolveTelegramReplyId(raw?: string): number | undefined;
type TelegramReplyTarget = {
  id?: string;
  sender: string;
  senderId?: string;
  senderUsername?: string;
  body?: string;
  kind: "reply" | "quote";
  source: "reply_to_message" | "external_reply";
  quoteText?: string;
  quotePosition?: number;
  quoteEntities?: TelegramTextEntity[]; /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
  quoteSourceText?: string;
  quoteSourceEntities?: TelegramTextEntity[];
};
declare function describeReplyTarget(msg: Message): TelegramReplyTarget | null;
//#endregion
//#region extensions/telegram/src/exec-approvals.d.ts
declare function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined;
declare function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[];
declare function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean;
declare const isTelegramExecApprovalClientEnabled: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => boolean;
declare const isTelegramExecApprovalApprover: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  senderId?: string | null;
}) => boolean;
declare const isTelegramExecApprovalAuthorizedSender: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  senderId?: string | null;
}) => boolean;
declare const resolveTelegramExecApprovalTarget: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => "channel" | "both" | "dm";
declare const shouldHandleTelegramExecApprovalRequest: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  request: ExecApprovalRequest | PluginApprovalRequest;
}) => boolean;
declare function shouldInjectTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean;
declare function shouldEnableTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean;
declare function shouldSuppressLocalTelegramExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean;
declare function isTelegramExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean;
//#endregion
//#region extensions/telegram/src/group-policy.d.ts
declare function resolveTelegramGroupRequireMention(params: ChannelGroupContext): boolean | undefined;
declare function resolveTelegramGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/telegram/src/targets.d.ts
type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
};
declare function stripTelegramInternalPrefixes(to: string): string;
declare function normalizeTelegramChatId(raw: string): string | undefined;
declare function isNumericTelegramChatId(raw: string): boolean;
declare function normalizeTelegramLookupTarget(raw: string): string | undefined;
declare function parseTelegramTarget(to: string): TelegramTarget;
declare function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown";
//#endregion
//#region extensions/telegram/src/inline-buttons.d.ts
declare function resolveTelegramInlineButtonsConfigScope(capabilities: unknown): TelegramInlineButtonsScope | undefined;
declare function resolveTelegramInlineButtonsScopeFromCapabilities(capabilities: unknown): TelegramInlineButtonsScope;
declare function resolveTelegramInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope;
declare function isTelegramInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean;
//#endregion
//#region extensions/telegram/src/normalize.d.ts
declare function normalizeTelegramMessagingTarget(raw: string): string | undefined;
declare function looksLikeTelegramTargetId(raw: string): boolean;
//#endregion
//#region extensions/telegram/src/outbound-adapter.d.ts
declare const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
type TelegramSendFn = typeof sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
declare function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>>;
declare const telegramOutbound: ChannelOutboundAdapter;
//#endregion
//#region extensions/telegram/src/outbound-params.d.ts
declare function normalizeTelegramReplyToMessageId(value: unknown): number | undefined;
declare function parseTelegramReplyToMessageId(replyToId?: string | null): number | undefined;
declare function parseTelegramThreadId(threadId?: string | number | null): number | undefined;
//#endregion
//#region extensions/telegram/src/reaction-level.d.ts
type TelegramReactionLevel = ReactionLevel;
type ResolvedReactionLevel = ResolvedReactionLevel$1;
/**
 * Resolve the effective reaction level and its implications.
 */
declare function resolveTelegramReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedReactionLevel;
//#endregion
//#region extensions/telegram/src/status-issues.d.ts
declare function collectTelegramStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[];
//#endregion
//#region extensions/telegram/src/format.d.ts
type TelegramFormattedChunk = {
  html: string;
  text: string;
};
declare function escapeTelegramHtml(text: string): string;
declare function markdownToTelegramHtml(markdown: string, options?: {
  tableMode?: MarkdownTableMode;
  wrapFileRefs?: boolean;
}): string;
declare function splitTelegramHtmlChunks(html: string, limit: number): string[];
declare function markdownToTelegramChunks(markdown: string, limit: number, options?: {
  tableMode?: MarkdownTableMode;
}): TelegramFormattedChunk[];
declare function markdownToTelegramHtmlChunks(markdown: string, limit: number, options?: {
  tableMode?: MarkdownTableMode;
}): string[];
//#endregion
export { type ButtonRow, type CachedSticker, type DescribeStickerParams, type InspectedTelegramAccount, type ModelsKeyboardParams, type ParsedModelCallback, type ParsedTelegramTopicConversation, type ProviderInfo, type ResolveModelSelectionResult, type ResolvedReactionLevel, type ResolvedTelegramAccount, type StickerMetadata, TELEGRAM_COMMAND_NAME_PATTERN, TELEGRAM_TEXT_CHUNK_LIMIT, type TelegramButtonStyle, type TelegramCredentialStatus, type TelegramCustomCommandInput, type TelegramCustomCommandIssue, type TelegramFormattedChunk, type TelegramForwardedContext, type TelegramInlineButtons, type TelegramInteractiveHandlerContext, type TelegramInteractiveHandlerRegistration, type TelegramMediaRuntimeOptions, type TelegramPollActionGateState, type TelegramProbe, type TelegramProbeOptions, type TelegramReactionLevel, type TelegramReplyTarget, type TelegramTarget, type TelegramTextEntity, type TelegramThreadSpec, type TelegramTokenResolution, buildBrowseProvidersButton, buildCommandsPaginationKeyboard, buildGroupLabel, buildModelSelectionCallbackData, buildModelsKeyboard, buildProviderKeyboard, buildSenderLabel, buildSenderName, buildTelegramExecApprovalPendingPayload, buildTelegramGroupFrom, buildTelegramGroupPeerId, buildTelegramModelsProviderChannelData, buildTelegramParentPeer, buildTelegramRoutingTarget, buildTelegramThreadParams, buildTypingThreadParams, cacheSticker, calculateTotalPages, collectTelegramSecurityAuditFindings, collectTelegramStatusIssues, createTelegramActionGate, deleteTelegramUpdateOffset, describeReplyTarget, describeStickerImage, escapeTelegramHtml, expandTextLinks, extractTelegramForumFlag, extractTelegramLocation, fetchTelegramChatId, getAllCachedStickers, getCacheStats, getCachedSticker, getModelsPageSize, getTelegramExecApprovalApprovers, getTelegramTextParts, hasBotMention, inspectTelegramAccount, isBinaryContent, isNumericTelegramChatId, isNumericTelegramSenderUserId, isNumericTelegramUserId, isTelegramExecApprovalApprover, isTelegramExecApprovalAuthorizedSender, isTelegramExecApprovalClientEnabled, isTelegramExecApprovalHandlerConfigured, isTelegramExecApprovalTargetRecipient, isTelegramInlineButtonsEnabled, listEnabledTelegramAccounts, listTelegramAccountIds, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, looksLikeTelegramTargetId, lookupTelegramChatId, markdownToTelegramChunks, markdownToTelegramHtml, markdownToTelegramHtmlChunks, mergeTelegramAccountConfig, normalizeForwardedContext, normalizeTelegramAllowFromEntry, normalizeTelegramChatId, normalizeTelegramCommandDescription, normalizeTelegramCommandName, normalizeTelegramLookupTarget, normalizeTelegramMessagingTarget, normalizeTelegramReplyToMessageId, parseModelCallbackData, parseTelegramReplyToMessageId, parseTelegramTarget, parseTelegramThreadId, parseTelegramTopicConversation, probeTelegram, readTelegramUpdateOffset, resetMissingDefaultWarnFlag, resetTelegramForumFlagCacheForTest, resetTelegramProbeFetcherCacheForTests, resolveDefaultTelegramAccountId, resolveModelSelection, resolveTelegramAccount, resolveTelegramAccountConfig, resolveTelegramAutoThreadId, resolveTelegramChatLookupFetch, resolveTelegramCustomCommands, resolveTelegramDirectPeerId, resolveTelegramExecApprovalConfig, resolveTelegramExecApprovalTarget, resolveTelegramForumFlag, resolveTelegramForumThreadId, resolveTelegramGroupAllowFromContext, resolveTelegramGroupRequireMention, resolveTelegramGroupToolPolicy, resolveTelegramInlineButtonsConfigScope, resolveTelegramInlineButtonsScope, resolveTelegramInlineButtonsScopeFromCapabilities, resolveTelegramMediaPlaceholder, resolveTelegramMediaRuntimeOptions, resolveTelegramPollActionGateState, resolveTelegramReactionLevel, resolveTelegramReplyId, resolveTelegramStreamMode, resolveTelegramTargetChatType, resolveTelegramThreadSpec, searchStickers, sendTelegramPayloadMessages, shouldEnableTelegramExecApprovalButtons, shouldHandleTelegramExecApprovalRequest, shouldInjectTelegramExecApprovalButtons, shouldSuppressLocalTelegramExecApprovalPrompt, shouldSuppressTelegramExecApprovalForwardingFallback, splitTelegramHtmlChunks, stripTelegramInternalPrefixes, telegramOutbound, telegramPlugin, telegramSetupPlugin, withResolvedTelegramForumFlag, writeTelegramUpdateOffset };