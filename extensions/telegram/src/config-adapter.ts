import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";

type TelegramConfigAccessorAccount = {
  config: TelegramAccountConfig;
};

export function resolveTelegramConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  return { config: mergeTelegramAccountConfig(params.cfg, accountId) };
}

export const telegramConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedTelegramAccount,
  TelegramConfigAccessorAccount
>({
  sectionKey: "telegram",
  listAccountIds: listTelegramAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveTelegramAccount),
  resolveAccessorAccount: resolveTelegramConfigAccessorAccount,
  inspectAccount: adaptScopedAccountAccessor(inspectTelegramAccount),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});
