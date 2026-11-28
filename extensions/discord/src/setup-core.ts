import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveBasicAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ChannelSetupWizard,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  defineTokenCredential,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  promptResolvedAllowFrom,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  splitSetupEntries,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultDiscordAccountId, resolveDiscordAccountAllowFrom } from "./accounts.js";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import { resolveDiscordToken } from "./token.js";

const t = createSetupTranslator();

const channel = "discord" as const;

const DISCORD_TOKEN_HELP_LINES = [
  t("wizard.discord.tokenHelpCreateApplication"),
  t("wizard.discord.tokenHelpCopyToken"),
  t("wizard.discord.tokenHelpInviteBot"),
  t("wizard.discord.tokenHelpMessageContentIntent"),
  t("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") }),
];

function getDiscordAllowFromHelpLines(): string[] {
  return [
    t("wizard.discord.allowlistIntro"),
    t("wizard.discord.examples"),
    "- 123456789012345678",
    "- @alice",
    "- alice#1234",
    t("wizard.discord.multipleEntries"),
    t("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") }),
  ];
}

type DiscordGuildChannelAllowlistEntry = {
  guildKey: string;
  channelKey?: string;
};

type DiscordSetupAllowlistResolution = {
  resolved?: boolean;
  guildId?: string;
  channelId?: string;
  guildKey?: string;
  channelKey?: string;
};

function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  resolved: unknown,
): OpenClawConfig {
  const entries = Array.isArray(resolved)
    ? resolved.flatMap((entry): DiscordGuildChannelAllowlistEntry[] => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const row = entry as DiscordSetupAllowlistResolution;
        if (row.resolved === false) {
          return [];
        }
        const guildKey = normalizeOptionalString(row.guildId ?? row.guildKey);
        if (!guildKey) {
          return [];
        }
        const channelKey = normalizeOptionalString(row.channelId ?? row.channelKey);
        return channelKey ? [{ guildKey, channelKey }] : [{ guildKey }];
      })
    : [];
  const baseGuilds =
    accountId === DEFAULT_ACCOUNT_ID
      ? (cfg.channels?.discord?.guilds ?? {})
      : (cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {});
  const guilds: Record<string, DiscordGuildEntry> = { ...baseGuilds };
  for (const entry of entries) {
    const guildKey = entry.guildKey;
    const existing = guilds[guildKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = { enabled: true };
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

function parseDiscordAllowFromId(value: string): string | null {
  return parseMentionOrPrefixedId({
    value,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixPattern: /^(user:|discord:)/i,
    idPattern: /^\d+$/,
  });
}

async function promptDiscordAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
  });
  const account = resolveDiscordSetupAccountConfig({ cfg: params.cfg, accountId });
  const noteTitle = t("wizard.discord.allowlistTitle");
  await params.prompter.note(getDiscordAllowFromHelpLines().join("\n"), noteTitle);
  const allowFrom = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId }) ?? [],
    token: resolveDiscordToken(params.cfg, { accountId }).token,
    message: t("wizard.discord.allowFromPrompt"),
    placeholder: "@alice, 123456789012345678",
    label: noteTitle,
    parseInputs: splitSetupEntries,
    parseId: parseDiscordAllowFromId,
    invalidWithoutTokenNote: t("wizard.discord.allowFromInvalidWithoutToken"),
    resolveEntries: async ({ token, entries }) =>
      await resolveBasicAllowFromEntries({
        token,
        entries,
        resolveEntries: resolveDiscordUserAllowlist,
      }),
  });
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId: account.accountId,
    patch: {
      allowFrom,
      dm: {
        ...account.config.dm,
        enabled: typeof account.config.dm?.enabled === "boolean" ? account.config.dm.enabled : true,
      },
    },
  });
}

const discordDmPolicy = createChannelDmPolicy({
  label: "Discord",
  channel,
  resolveAccount: (cfg, accountId) => resolveDiscordSetupAccountConfig({ cfg, accountId }),
  buildPatch: ({ account, policy, allowFrom }) => ({
    dmPolicy: policy,
    ...(allowFrom === undefined ? {} : { allowFrom }),
    dm: {
      ...account.config.dm,
      enabled: typeof account.config.dm?.enabled === "boolean" ? account.config.dm.enabled : true,
    },
  }),
  promptAllowFrom: promptDiscordAllowFrom,
});

export const discordSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Discord",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsToken"),
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      inspectDiscordSetupAccount({ cfg, accountId }).configured,
  }),
  credentials: [
    defineTokenCredential({
      inputKey: "token",
      configKey: "token",
      providerHint: channel,
      credentialLabel: t("wizard.discord.botToken"),
      preferredEnvVar: "DISCORD_BOT_TOKEN",
      helpTitle: t("wizard.discord.botToken"),
      helpLines: DISCORD_TOKEN_HELP_LINES,
      envPrompt: t("wizard.discord.tokenEnvPrompt"),
      keepPrompt: t("wizard.discord.tokenKeepPrompt"),
      inputPrompt: t("wizard.discord.tokenInputPrompt"),
      allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
      resolveAccount: inspectDiscordSetupAccount,
      accountConfigured: (account) => account.configured,
      hasConfiguredValue: (account) => account.tokenStatus !== "missing",
      resolvedValue: (account) => normalizeOptionalString(account.token),
      envValue: ({ accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID
          ? normalizeOptionalString(process.env.DISCORD_BOT_TOKEN)
          : undefined,
    }),
  ],
  groupAccess: createAccountScopedGroupAccessSection({
    channel,
    label: t("wizard.discord.channelsLabel"),
    placeholder: "My Server/#general, guildId/channelId, #support",
    currentPolicy: ({ cfg, accountId }) =>
      resolveDiscordSetupAccountConfig({ cfg, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.entries(
        resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds ?? {},
      ).flatMap(([guildKey, value]) => {
        const channelKeys = Object.keys(value?.channels ?? {});
        if (channelKeys.length === 0) {
          return [/^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey];
        }
        return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
      }),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds),
    resolveAllowlist: async (params) =>
      await resolveEntriesWithOptionalToken({
        token:
          resolveDiscordToken(params.cfg, { accountId: params.accountId }).token ||
          (typeof params.credentialValues.token === "string" ? params.credentialValues.token : ""),
        entries: params.entries,
        buildWithoutToken: (input) => ({ input, resolved: false }),
        resolveEntries: resolveDiscordChannelAllowlist,
      }),
    fallbackResolved: (entries) => entries.map((input) => ({ input, resolved: false })),
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setDiscordGuildChannelAllowlist(cfg, accountId, resolved),
  }),
  allowFrom: createAccountScopedAllowFromSection({
    channel,
    credentialInputKey: "token",
    helpTitle: "Discord allowlist",
    helpLines: getDiscordAllowFromHelpLines(),
    message: t("wizard.discord.allowFromPrompt"),
    placeholder: "@alice, 123456789012345678",
    invalidWithoutCredentialNote: t("wizard.discord.allowFromInvalidWithoutToken"),
    parseId: parseDiscordAllowFromId,
    resolveEntries: async ({ cfg, accountId, credentialValues, entries }) =>
      await resolveBasicAllowFromEntries({
        token:
          resolveDiscordToken(cfg, { accountId }).token ||
          (typeof credentialValues.token === "string" ? credentialValues.token : ""),
        entries,
        resolveEntries: resolveDiscordUserAllowlist,
      }),
  }),
  dmPolicy: discordDmPolicy,
  disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
};
