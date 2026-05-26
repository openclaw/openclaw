import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { _ as GroupPolicy } from "./types.base-DS--yneR.js";
import { _ as TelegramAccountConfig$1 } from "./types.channels-C67UBRPK.js";
import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { s as ExecApprovalRequest } from "./exec-approvals-DZ3KhICc.js";
import { y as ChannelMessageActionAdapter } from "./types.core-BkmTlRzr.js";
import { n as MonitorTelegramOpts } from "./runtime-DLkvdXf0.js";
import { AgentToolResult } from "@earendil-works/pi-agent-core";

//#region extensions/telegram/src/bot-access.d.ts
type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
  invalidEntries: string[];
};
//#endregion
//#region extensions/telegram/src/group-access.d.ts
declare const resolveTelegramRuntimeGroupPolicy: (params: {
  providerConfigPresent: boolean;
  groupPolicy?: TelegramAccountConfig$1["groupPolicy"];
  defaultGroupPolicy?: TelegramAccountConfig$1["groupPolicy"];
}) => {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};
//#endregion
//#region extensions/telegram/src/exec-approval-forwarding.d.ts
declare function shouldSuppressTelegramExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: {
    channel: string;
    accountId?: string | null;
  };
  request: ExecApprovalRequest;
}): boolean;
declare function buildTelegramExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}): ReplyPayload;
//#endregion
//#region extensions/telegram/src/sticker-cache-store.d.ts
interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}
/**
 * Get a cached sticker by its unique ID.
 */
declare function getCachedSticker(fileUniqueId: string): CachedSticker | null;
/**
 * Add or update a sticker in the cache.
 */
declare function cacheSticker(sticker: CachedSticker): void;
/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
declare function searchStickers(query: string, limit?: number): CachedSticker[];
/**
 * Get all cached stickers (for debugging/listing).
 */
declare function getAllCachedStickers(): CachedSticker[];
/**
 * Get cache statistics.
 */
declare function getCacheStats(): {
  count: number;
  oldestAt?: string;
  newestAt?: string;
};
//#endregion
//#region extensions/telegram/src/sticker-cache.d.ts
interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
}
/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
declare function describeStickerImage(params: DescribeStickerParams): Promise<string | null>;
//#endregion
//#region extensions/telegram/src/channel-actions.d.ts
declare const telegramMessageActions: ChannelMessageActionAdapter;
//#endregion
//#region extensions/telegram/src/monitor.d.ts
declare function monitorTelegramProvider(opts?: MonitorTelegramOpts): Promise<void>;
//#endregion
//#region extensions/telegram/src/topic-conversation.d.ts
type ParsedTelegramTopicConversation = {
  chatId: string;
  topicId: string;
  canonicalConversationId: string;
};
declare function parseTelegramTopicConversation(params: {
  conversationId: string;
  parentConversationId?: string;
}): ParsedTelegramTopicConversation | null;
//#endregion
//#region extensions/telegram/src/poll-visibility.d.ts
declare function resolveTelegramPollVisibility(params: {
  pollAnonymous?: boolean;
  pollPublic?: boolean;
}): boolean | undefined;
//#endregion
//#region extensions/telegram/runtime-api.d.ts
type TelegramAccountConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
type TelegramActionConfig = NonNullable<TelegramAccountConfig["actions"]>;
type TelegramNetworkConfig = NonNullable<TelegramAccountConfig["network"]>;
//#endregion
export { buildTelegramExecApprovalPendingPayload as _, ParsedTelegramTopicConversation as a, NormalizedAllowFrom as b, telegramMessageActions as c, CachedSticker as d, cacheSticker as f, searchStickers as g, getCachedSticker as h, resolveTelegramPollVisibility as i, DescribeStickerParams as l, getCacheStats as m, TelegramActionConfig as n, parseTelegramTopicConversation as o, getAllCachedStickers as p, TelegramNetworkConfig as r, monitorTelegramProvider as s, TelegramAccountConfig as t, describeStickerImage as u, shouldSuppressTelegramExecApprovalForwardingFallback as v, resolveTelegramRuntimeGroupPolicy as y };