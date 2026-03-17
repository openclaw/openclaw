import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeAccountId, type OpenClawConfig } from "openclaw/plugin-sdk/telegram";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ cfg: params.cfg, accountId: id });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

export const telegramConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveTelegramAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account: ResolvedTelegramAccount) => account.config.defaultTo,
});

export const telegramConfigBase = createScopedChannelConfigBase<ResolvedTelegramAccount>({
  sectionKey: "telegram",
  listAccountIds: listTelegramAccountIds,
  resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
});
