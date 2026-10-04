import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { listTelegramAccountIds } from "./accounts.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";

/**
 * Retires one precisely identified streamed preview from every Telegram
 * account's message history. Telegram never delivers a message deletion to
 * other bots, so a sibling account's cache copy would otherwise linger and
 * keep feeding the dead preview text into later group history windows.
 */
export async function retireTelegramStreamPreviewAcrossAccounts(params: {
  cfg: OpenClawConfig;
  chatId: string | number;
  messageId: string | number;
}): Promise<void> {
  const accountIds = listTelegramAccountIds(params.cfg);
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
