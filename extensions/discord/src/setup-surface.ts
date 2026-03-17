import {
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  type OpenClawConfig,
  promptLegacyChannelAllowFrom,
  resolveSetupAccountId,
  type WizardPrompter,
} from "../../../src/plugin-sdk-internal/setup.js";
import { type ChannelSetupWizard } from "../../../src/plugin-sdk-internal/setup.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { resolveDefaultDiscordAccountId, resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import {
  resolveDiscordChannelAllowlist,
  type DiscordChannelResolution,
} from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  createDiscordSetupWizardBase,
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

export const discordSetupWizard: ChannelSetupWizard = createDiscordSetupWizardBase({
  promptAllowFrom: promptDiscordAllowFrom,
  resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveDiscordAllowFromEntries({
      token:
        resolveDiscordAccount({ cfg, accountId }).token ||
        (typeof credentialValues.token === "string" ? credentialValues.token : ""),
      entries,
    }),
  resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
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
});
