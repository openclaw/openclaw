import {
  resolveEntriesWithOptionalToken,
  type OpenClawConfig,
  promptLegacyChannelAllowFromForAccount,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { type ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultDiscordAccountId, resolveDiscordAccount } from "./accounts.js";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  createDiscordSetupWizardBase,
  DISCORD_TOKEN_HELP_LINES,
  parseDiscordAllowFromId,
  setDiscordGuildChannelAllowlist,
} from "./setup-core.js";

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
    channel,
    prompter: params.prompter,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
    resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
    resolveExisting: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom ?? [],
    resolveToken: (account) => account.token,
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
      resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId }).token ||
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
        resolveDiscordAccount({ cfg, accountId }).token ||
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
