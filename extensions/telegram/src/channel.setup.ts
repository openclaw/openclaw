import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  normalizeAccountId,
  TelegramConfigSchema,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/telegram";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import type { TelegramProbe } from "./probe.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";

function findTelegramTokenOwnerAccountId(params: {
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

function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

const telegramConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account: ResolvedTelegramAccount) => account.config.defaultTo,
});

const telegramConfigBase = createScopedChannelConfigBase<ResolvedTelegramAccount>({
  sectionKey: "telegram",
  listAccountIds: listTelegramAccountIds,
  resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
});

export const telegramSetupPlugin: ChannelPlugin<ResolvedTelegramAccount, TelegramProbe> = {
  id: "telegram",
  meta: {
    ...getChatChannelMeta("telegram"),
    quickstartAllowFrom: true,
  },
  setupWizard: telegramSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    polls: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.telegram"] },
  configSchema: buildChannelConfigSchema(TelegramConfigSchema),
  config: {
    ...telegramConfigBase,
    isConfigured: (account, cfg) => {
      if (!account.token?.trim()) {
        return false;
      }
      return !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
    },
    unconfiguredReason: (account, cfg) => {
      if (!account.token?.trim()) {
        return "not configured";
      }
      const ownerAccountId = findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
      if (!ownerAccountId) {
        return "not configured";
      }
      return formatDuplicateTelegramTokenReason({
        accountId: account.accountId,
        ownerAccountId,
      });
    },
    describeAccount: (account, cfg) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured:
        Boolean(account.token?.trim()) &&
        !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId }),
      tokenSource: account.tokenSource,
    }),
    ...telegramConfigAccessors,
  },
  setup: telegramSetupAdapter,
};
