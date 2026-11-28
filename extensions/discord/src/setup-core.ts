import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveBasicAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ChannelSetupWizard,
  createAccountScopedAllowFromSection,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  defineTokenCredential,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  promptResolvedAllowFrom,
  resolveSetupAccountId,
  splitSetupEntries,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultDiscordAccountId, resolveDiscordAccountAllowFrom } from "./accounts.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import { configureDiscordGuildAccess } from "./setup-guild-access.js";
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
  finalize: configureDiscordGuildAccess,
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
