import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  type OpenClawConfig,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  promptLegacyChannelAllowFrom,
  resolveSetupAccountId,
  setLegacyChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { type ChannelSetupDmPolicy, type ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "./accounts.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import {
  resolveDiscordChannelAllowlist,
  type DiscordChannelResolution,
} from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  discordSetupAdapter,
  DISCORD_TOKEN_HELP_LINES,
  parseDiscordAllowFromId,
  setDiscordGuildChannelAllowlist,
} from "./setup-core.js";

const channel = "discord" as const;

async function resolveDiscordAllowFromEntries(params: { token?: string; entries: string[] }) {
  if (!params.token?.trim()) {
    return params.entries.map((input) => ({
      input,
      resolved: false,
      id: null,
    }));
  }
  const resolved = await resolveDiscordUserAllowlist({
    token: params.token,
    entries: params.entries,
  });
  return resolved.map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id ?? null,
  }));
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
  const resolved = resolveDiscordAccount({ cfg: params.cfg, accountId });
  return promptLegacyChannelAllowFrom({
    cfg: params.cfg,
    channel,
    prompter: params.prompter,
    existing: resolved.config.allowFrom ?? resolved.config.dm?.allowFrom ?? [],
    token: resolved.token,
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
    resolveEntries: ({ token, entries }) =>
      resolveDiscordUserAllowlist({
        token,
        entries,
      }),
  });
}

const discordDmPolicy: ChannelSetupDmPolicy = {
  label: "Discord",
  channel,
  policyKey: "channels.discord.dmPolicy",
  allowFromKey: "channels.discord.allowFrom",
  getCurrent: (cfg) =>
    cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
  promptAllowFrom: promptDiscordAllowFrom,
};

export const discordSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs token",
    configuredHint: "configured",
    unconfiguredHint: "needs token",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg }) =>
      listDiscordAccountIds(cfg).some(
        (accountId) => inspectDiscordAccount({ cfg, accountId }).configured,
      ),
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
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
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
    currentPolicy: ({ cfg, accountId }) =>
      resolveDiscordAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
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
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveDiscordAccount({ cfg, accountId }).config.guilds),
    setPolicy: ({ cfg, accountId, policy }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { groupPolicy: policy },
      }),
    resolveAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
      const token =
        resolveDiscordAccount({ cfg, accountId }).token ||
        (typeof credentialValues.token === "string" ? credentialValues.token : "");
      let resolved: DiscordChannelResolution[] = entries.map((input) => ({
        input,
        resolved: false,
      }));
      if (!token || entries.length === 0) {
        return resolved;
      }
      try {
        resolved = await resolveDiscordChannelAllowlist({
          token,
          entries,
        });
        const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
        const resolvedGuilds = resolved.filter(
          (entry) => entry.resolved && entry.guildId && !entry.channelId,
        );
        const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
        await noteChannelLookupSummary({
          prompter,
          label: "Discord channels",
          resolvedSections: [
            {
              title: "Resolved channels",
              values: resolvedChannels
                .map((entry) => entry.channelId)
                .filter((value): value is string => Boolean(value)),
            },
            {
              title: "Resolved guilds",
              values: resolvedGuilds
                .map((entry) => entry.guildId)
                .filter((value): value is string => Boolean(value)),
            },
          ],
          unresolved,
        });
      } catch (error) {
        await noteChannelLookupFailure({
          prompter,
          label: "Discord channels",
          error,
        });
      }
      return resolved;
    },
    applyAllowlist: ({ cfg, accountId, resolved }) => {
      const allowlistEntries: Array<{ guildKey: string; channelKey?: string }> = [];
      for (const entry of resolved as DiscordChannelResolution[]) {
        const guildKey =
          entry.guildId ??
          (entry.guildName ? normalizeDiscordSlug(entry.guildName) : undefined) ??
          "*";
        const channelKey =
          entry.channelId ??
          (entry.channelName ? normalizeDiscordSlug(entry.channelName) : undefined);
        if (!channelKey && guildKey === "*") {
          continue;
        }
        allowlistEntries.push({ guildKey, ...(channelKey ? { channelKey } : {}) });
      }
      return setDiscordGuildChannelAllowlist(cfg, accountId, allowlistEntries);
    },
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
    invalidWithoutCredentialNote: "Bot token missing; use numeric user ids (or mention form) only.",
    parseId: parseDiscordAllowFromId,
    resolveEntries: async ({ cfg, accountId, credentialValues, entries }) =>
      await resolveDiscordAllowFromEntries({
        token:
          resolveDiscordAccount({ cfg, accountId }).token ||
          (typeof credentialValues.token === "string" ? credentialValues.token : ""),
        entries,
      }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  },
  dmPolicy: discordDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
