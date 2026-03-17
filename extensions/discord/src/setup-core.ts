import type { DiscordGuildEntry } from "openclaw/plugin-sdk/config-runtime";
import {
  applyAccountNameToChannelSection,
  createPatchedAccountSetupAdapter,
  DEFAULT_ACCOUNT_ID,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setLegacyChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "../../../src/terminal/links.js";
import {
  createAllowlistSetupWizardProxy,
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { inspectDiscordAccount } from "./account-inspect.js";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";

const channel = "discord" as const;

export const DISCORD_TOKEN_HELP_LINES = [
  "1) Discord Developer Portal -> Applications -> New Application",
  "2) Bot -> Add Bot -> Reset Token -> copy token",
  "3) OAuth2 -> URL Generator -> scope 'bot' -> invite to your server",
  "Tip: enable Message Content Intent if you need message text. (Bot -> Privileged Gateway Intents -> Message Content Intent)",
  `Docs: ${formatDocsLink("/discord", "discord")}`,
];

export function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: Array<{
    guildKey: string;
    channelKey?: string;
  }>,
): OpenClawConfig {
  const baseGuilds =
    accountId === DEFAULT_ACCOUNT_ID
      ? (cfg.channels?.discord?.guilds ?? {})
      : (cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {});
  const guilds: Record<string, DiscordGuildEntry> = { ...baseGuilds };
  for (const entry of entries) {
    const guildKey = entry.guildKey || "*";
    const existing = guilds[guildKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = { allow: true };
      guilds[guildKey] = { ...existing, channels };
    } else {
      guilds[guildKey] = existing;
    }
  }
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: { guilds },
  });
}

export function parseDiscordAllowFromId(value: string): string | null {
  return parseMentionOrPrefixedId({
    value,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixPattern: /^(user:|discord:)/i,
    idPattern: /^\d+$/,
  });
}

export const discordSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "DISCORD_BOT_TOKEN can only be used for the default account.";
    }
    if (!input.useEnv && !input.token) {
      return "Discord requires token (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          discord: {
            ...next.channels?.discord,
            enabled: true,
            ...(input.useEnv ? {} : input.token ? { token: input.token } : {}),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        discord: {
          ...next.channels?.discord,
          enabled: true,
          accounts: {
            ...next.channels?.discord?.accounts,
            [accountId]: {
              ...next.channels?.discord?.accounts?.[accountId],
              enabled: true,
              ...(input.token ? { token: input.token } : {}),
            },
          },
        },
      },
    };
  },
};

export function createDiscordSetupWizardBase(handlers: {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
  resolveAllowFromEntries: NonNullable<
    NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
  >;
  resolveGroupAllowlist: NonNullable<
    NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
  >;
}) {
  const discordDmPolicy: ChannelSetupDmPolicy = {
    label: "Discord",
    channel,
    policyKey: "channels.discord.dmPolicy",
    allowFromKey: "channels.discord.allowFrom",
    getCurrent: (cfg: OpenClawConfig) =>
      cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
    setPolicy: (cfg: OpenClawConfig, policy) =>
      setLegacyChannelDmPolicyWithAllowFrom({
        cfg,
        channel,
        dmPolicy: policy,
      }),
    promptAllowFrom: handlers.promptAllowFrom,
  };

  return {
    channel,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      configuredHint: "configured",
      unconfiguredHint: "needs token",
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg }) =>
        listDiscordAccountIds(cfg).some((accountId) => {
          const account = inspectDiscordAccount({ cfg, accountId });
          return account.configured;
        }),
    },
    credentials: [
      {
        inputKey: "token",
        providerHint: channel,
        credentialLabel: "Discord bot token",
        preferredEnvVar: "DISCORD_BOT_TOKEN",
        helpTitle: "Discord bot token",
        helpLines: DISCORD_TOKEN_HELP_LINES,
        envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
        keepPrompt: "Discord token already configured. Keep it?",
        inputPrompt: "Enter Discord bot token",
        allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
        inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
          const account = inspectDiscordAccount({ cfg, accountId });
          return {
            accountConfigured: account.configured,
            hasConfiguredValue: account.tokenStatus !== "missing",
            resolvedValue: account.token?.trim() || undefined,
            envValue:
              accountId === DEFAULT_ACCOUNT_ID
                ? process.env.DISCORD_BOT_TOKEN?.trim() || undefined
                : undefined,
          };
        },
      },
    ],
    groupAccess: {
      label: "Discord channels",
      placeholder: "My Server/#general, guildId/channelId, #support",
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveDiscordAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(resolveDiscordAccount({ cfg, accountId }).config.guilds ?? {}).flatMap(
          ([guildKey, value]) => {
            const channels = value?.channels ?? {};
            const channelKeys = Object.keys(channels);
            if (channelKeys.length === 0) {
              const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
              return [input];
            }
            return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
          },
        ),
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveDiscordAccount({ cfg, accountId }).config.guilds),
      setPolicy: ({
        cfg,
        accountId,
        policy,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        policy: "open" | "allowlist" | "disabled";
      }) =>
        patchChannelConfigForAccount({
          cfg,
          channel,
          accountId,
          patch: { groupPolicy: policy },
        }),
      resolveAllowlist: async ({
        cfg,
        accountId,
        credentialValues,
        entries,
        prompter,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        credentialValues: { token?: string };
        entries: string[];
        prompter: { note: (message: string, title?: string) => Promise<void> };
      }) => {
        try {
          return await handlers.resolveGroupAllowlist({
            cfg,
            accountId,
            credentialValues,
            entries,
            prompter,
          });
        } catch (error) {
          await noteChannelLookupFailure({
            prompter,
            label: "Discord channels",
            error,
          });
          await noteChannelLookupSummary({
            prompter,
            label: "Discord channels",
            resolvedSections: [],
            unresolved: entries,
          });
          return entries.map((input) => ({ input, resolved: false }));
        }
      },
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setDiscordGuildChannelAllowlist(cfg, accountId, resolved as never),
    },
    allowFrom: {
      credentialInputKey: "token",
      helpTitle: "Discord allowlist",
      helpLines: [
        "Allowlist Discord DMs by username (we resolve to user ids).",
        "Examples:",
        "- 123456789012345678",
        "- @alice",
        "- alice#1234",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/discord", "discord")}`,
      ],
      message: "Discord allowFrom (usernames or ids)",
      placeholder: "@alice, 123456789012345678",
      invalidWithoutCredentialNote:
        "Bot token missing; use numeric user ids (or mention form) only.",
      parseId: parseDiscordAllowFromId,
      resolveEntries: async ({
        cfg,
        accountId,
        credentialValues,
        entries,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        credentialValues: { token?: string };
        entries: string[];
      }) => await handlers.resolveAllowFromEntries({ cfg, accountId, credentialValues, entries }),
      apply: async ({
        cfg,
        accountId,
        allowFrom,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        allowFrom: string[];
      }) =>
        patchChannelConfigForAccount({
          cfg,
          channel,
          accountId,
          patch: { dmPolicy: "allowlist", allowFrom },
        }),
    },
    dmPolicy: discordDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}
export function createDiscordSetupWizardProxy(
  loadWizard: () => Promise<{ discordSetupWizard: ChannelSetupWizard }>,
) {
  return createAllowlistSetupWizardProxy({
    loadWizard: async () => (await loadWizard()).discordSetupWizard,
    createBase: createDiscordSetupWizardBase,
    fallbackResolvedGroupAllowlist: (entries) =>
      entries.map((input) => ({ input, resolved: false })),
  });
}
