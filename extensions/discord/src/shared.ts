import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import {
  createScopedChannelConfigAdapter,
  buildChannelConfigSchema,
  DiscordConfigSchema,
  getChatChannelMeta,
  type ChannelPlugin,
} from "./runtime-api.js";
import { createDiscordSetupWizardProxy } from "./setup-core.js";

export const DISCORD_CHANNEL = "discord" as const;

async function loadDiscordChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const discordSetupWizard = createDiscordSetupWizardProxy(
  async () => (await loadDiscordChannelRuntime()).discordSetupWizard,
);

export const discordConfigAdapter = createScopedChannelConfigAdapter<ResolvedDiscordAccount>({
  sectionKey: DISCORD_CHANNEL,
  listAccountIds: listDiscordAccountIds,
  resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectDiscordAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
  resolveAllowFrom: (account: ResolvedDiscordAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedDiscordAccount) => account.config.defaultTo,
});

export function createDiscordPluginBase(params: {
  setup: NonNullable<ChannelPlugin<ResolvedDiscordAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedDiscordAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
> {
  return createChannelPluginBase({
    id: DISCORD_CHANNEL,
    setupWizard: discordSetupWizard,
    meta: { ...getChatChannelMeta(DISCORD_CHANNEL) },
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
      ...discordConfigAdapter,
      isConfigured: (account) => Boolean(account.token?.trim()),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token?.trim()),
        tokenSource: account.tokenSource,
      }),
    },
    setup: params.setup,
  }) as Pick<
    ChannelPlugin<ResolvedDiscordAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
  >;
}
