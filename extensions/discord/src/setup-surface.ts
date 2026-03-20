import {
  type OpenClawConfig,
  type WizardPrompter,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  resolveDefaultDiscordSetupAccountId,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import {
  createDiscordSetupWizardBase,
  DISCORD_TOKEN_HELP_LINES,
  parseDiscordAllowFromId,
  setDiscordGuildChannelAllowlist,
} from "./setup-core.js";
import {
  promptLegacyChannelAllowFromForAccount,
  resolveEntriesWithOptionalToken,
} from "./setup-runtime-helpers.js";
import { resolveDiscordToken } from "./token.js";

const channel = "discord" as const;

async function resolveDiscordAllowFromEntries(params: { token?: string; entries: string[] }) {
  return await resolveEntriesWithOptionalToken({
    token: params.token,
    entries: params.entries,
    buildWithoutToken: (input) => ({
      input,
      resolved: false,
      id: null,
    }),
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveDiscordUserAllowlist({
          token,
          entries,
        })
      ).map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id ?? null,
      })),
  });
}

async function promptDiscordAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return await promptLegacyChannelAllowFromForAccount({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId: params.accountId,
    noteTitle: "Discord allowlist",
    noteLines: [
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
    parseId: parseDiscordAllowFromId,
    invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
    resolveExisting: (accountId, cfg) => {
      const account = resolveDiscordSetupAccountConfig({ cfg, accountId }).config;
      return account.allowFrom ?? account.dm?.allowFrom ?? [];
    },
    resolveToken: (accountId) => resolveDiscordToken(params.cfg, { accountId }).token,
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveDiscordUserAllowlist({
          token,
          entries,
        })
      ).map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id ?? null,
      })),
  });
}

async function resolveDiscordGroupAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: { token?: string };
  entries: string[];
}) {
  return await resolveEntriesWithOptionalToken({
    token:
      resolveDiscordToken(params.cfg, { accountId: params.accountId }).token ||
      (typeof params.credentialValues.token === "string" ? params.credentialValues.token : ""),
    entries: params.entries,
    buildWithoutToken: (input) => ({
      input,
      resolved: false,
    }),
    resolveEntries: async ({ token, entries }) =>
      await resolveDiscordChannelAllowlist({
        token,
        entries,
      }),
  });
}

export const discordSetupWizard: ChannelSetupWizard = createDiscordSetupWizardBase({
  promptAllowFrom: promptDiscordAllowFrom,
  resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveDiscordAllowFromEntries({
      token:
        resolveDiscordToken(cfg, { accountId }).token ||
        (typeof credentialValues.token === "string" ? credentialValues.token : ""),
      entries,
    }),
  resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveDiscordGroupAllowlist({
      cfg,
      accountId,
      credentialValues,
      entries,
    }),
});
