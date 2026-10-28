import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { resolveTelegramTopicNameCacheScope } from "./topic-name-cache.js";

export function resolveActionTopicNameCacheScope(
  cfg: OpenClawConfig,
  accountId: string | undefined,
  chatId: string,
): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return resolveTelegramTopicNameCacheScope(
    resolveStorePath(cfg.session?.store, {
      agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
    }),
    resolvedAccountId,
    chatId,
  );
}
