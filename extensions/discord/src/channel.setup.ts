import { createScopedChannelConfigBase } from "openclaw/plugin-sdk/compat";
import {
  createScopedAccountConfigAccessors,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/compat";
import {
  buildChannelConfigSchema,
  DiscordConfigSchema,
  getChatChannelMeta,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/discord";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { createDiscordSetupWizardProxy, discordSetupAdapter } from "./setup-core.js";

async function loadDiscordChannelRuntime() {
  return await import("./channel.runtime.js");
}

const discordConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveDiscordAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedDiscordAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedDiscordAccount) => account.config.defaultTo,
});

const discordConfigBase = createScopedChannelConfigBase({
  sectionKey: "discord",
  listAccountIds: listDiscordAccountIds,
  resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectDiscordAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
});

const discordSetupWizard = createDiscordSetupWizardProxy(async () => ({
  discordSetupWizard: (await loadDiscordChannelRuntime()).discordSetupWizard,
}));

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  id: "discord",
  meta: {
    ...getChatChannelMeta("discord"),
  },
  setupWizard: discordSetupWizard,
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.discord"] },
  configSchema: buildChannelConfigSchema(DiscordConfigSchema),
  config: {
    ...discordConfigBase,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    ...discordConfigAccessors,
  },
  setup: discordSetupAdapter,
};
