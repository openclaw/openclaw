import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { DiscordChannelConfigSchema } from "./config-schema.js";
import { discordDoctor } from "./doctor.js";
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
  resolveAccount: adaptScopedAccountAccessor(resolveDiscordAccount),
  inspectAccount: adaptScopedAccountAccessor(inspectDiscordAccount),
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
  | "commands"
  | "doctor"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
> {
  return {
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
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
      resolveNativeCommandName: ({ commandKey, defaultName }) =>
        commandKey === "tts" ? "voice" : defaultName,
    },
    doctor: discordDoctor,
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.discord"] },
    configSchema: DiscordChannelConfigSchema,
    config: {
      ...discordConfigAdapter,
      isConfigured: (account) => Boolean(account.token?.trim()),
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.token?.trim()),
          extra: {
            tokenSource: account.tokenSource,
          },
        }),
    },
    setup: params.setup,
  } as Pick<
    ChannelPlugin<ResolvedDiscordAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "commands"
    | "doctor"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
  >;
}
