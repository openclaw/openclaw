import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  TelegramConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/telegram";
import { type ResolvedTelegramAccount } from "./accounts.js";
import {
  findTelegramTokenOwnerAccountId,
  formatDuplicateTelegramTokenReason,
  telegramConfigAccessors,
  telegramConfigBase,
} from "./plugin-shared.js";
import type { TelegramProbe } from "./probe.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";

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
