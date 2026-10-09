import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { listTelegramAccountIds } from "./accounts.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";

/**
 * Message ids are only meaningful across accounts in supergroups and
 * channels, where they come from the channel's own sequence. Private chats
 * and basic groups use account-local ids: the same numeric coordinates in a
 * sibling's cache can belong to an unrelated conversation, so fan-out there
 * would delete messages Telegram never asked us to touch. The Bot API chat
 * type is the authority for that call; a basic group can carry an id in the
 * `-100…` supergroup space, so the id prefix alone cannot decide.
 */
function chatSharesMessageIdentityAcrossAccounts(chatType: string | undefined): boolean {
  return chatType === "supergroup" || chatType === "channel";
}

/**
 * Retires one precisely identified streamed preview from the originating
 * account's message history, and from sibling accounts too when the chat
 * shares message identity across accounts. Telegram never delivers a message
 * deletion to other bots, so a sibling account's cache copy would otherwise
 * linger and keep feeding the dead preview text into later group history
 * windows.
 */
export async function retireTelegramStreamPreviewAcrossAccounts(params: {
  cfg: OpenClawConfig;
  originAccountId: string;
  chatId: string | number;
  messageId: string | number;
  chatType?: string;
}): Promise<void> {
  const accountIds = chatSharesMessageIdentityAcrossAccounts(params.chatType)
    ? [...new Set([params.originAccountId, ...listTelegramAccountIds(params.cfg)])]
    : [params.originAccountId];
  await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const cache = createTelegramMessageCache({
          scope: resolveTelegramMessageCacheScope(
            resolveStorePath(params.cfg.session?.store, {
              agentId: resolveTelegramAccountOwnerAgentId({
                cfg: params.cfg,
                accountId,
              }),
            }),
          ),
        });
        await cache.retireMessage({
          accountId,
          chatId: params.chatId,
          messageId: params.messageId,
        });
      } catch (error) {
        logVerbose(
          `telegram: failed to retire stream preview for account ${accountId}: ${String(error)}`,
        );
      }
    }),
  );
}
