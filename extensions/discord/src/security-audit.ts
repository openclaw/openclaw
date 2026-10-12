import { coerceNativeSetting, normalizeAllowFromList } from "openclaw/plugin-sdk/channel-policy";
import type {
  DiscordGuildChannelConfig,
  DiscordGuildEntry,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";

function isWildcardEntry(value: unknown): boolean {
  return String(value).trim() === "*";
}

function hasNarrowMemberRestriction(
  guild: DiscordGuildEntry,
  channel?: DiscordGuildChannelConfig,
): boolean {
  const users = channel?.users ?? guild.users ?? [];
  const roles = channel?.roles ?? guild.roles ?? [];
  return ![...users, ...roles].some(isWildcardEntry) && (users.length > 0 || roles.length > 0);
}

function listBroadMemberTargetPaths(params: {
  discordCfg: ResolvedDiscordAccount["config"];
  pathPrefix: string;
}): string[] {
  const paths: string[] = [];
  for (const [guildKey, guild] of Object.entries(params.discordCfg.guilds ?? {})) {
    const guildPath = `${params.pathPrefix}.guilds.${guildKey}`;
    const channels = Object.entries(guild.channels ?? {});
    if (channels.length === 0) {
      if (!hasNarrowMemberRestriction(guild)) {
        paths.push(guildPath);
      }
      continue;
    }
    for (const [channelKey, channel] of channels) {
      if (channel.enabled === false || hasNarrowMemberRestriction(guild, channel)) {
        continue;
      }
      paths.push(`${guildPath}.channels.${channelKey}`);
    }
  }
  return paths.toSorted();
}

export async function collectDiscordSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedDiscordAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}) {
  const findings: Array<{
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
  }> = [];
  const discordCfg = params.account.config ?? {};
  const accountId =
    normalizeOptionalString(params.accountId) ?? params.account.accountId ?? "default";
  const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(discordCfg);
  const storeAllowFrom = await readChannelAllowFromStore("discord", process.env, accountId).catch(
    () => [],
  );
  const discordNameBasedAllowEntries = new Map<string, number>();
  const addNameBasedEntries = (values: unknown, source: string) => {
    if (!Array.isArray(values)) {
      return;
    }
    const entries = new Set(
      values.map((value) => String(value).trim()).filter(isDiscordMutableAllowEntry),
    );
    if (entries.size > 0) {
      discordNameBasedAllowEntries.set(source, entries.size);
    }
  };
  const discordPathPrefix =
    params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
      ? `channels.discord.accounts.${accountId}`
      : "channels.discord";

  const effectiveGroupPolicy =
    discordCfg.groupPolicy ?? params.cfg.channels?.defaults?.groupPolicy ?? "allowlist";
  if (effectiveGroupPolicy === "allowlist") {
    const broadMemberPaths = listBroadMemberTargetPaths({
      discordCfg,
      pathPrefix: discordPathPrefix,
    });
    if (broadMemberPaths.length > 0) {
      findings.push({
        checkId: "channels.discord.allowlisted_groups.broad_members",
        severity: "warn",
        title: "Discord allowlisted groups have broad member access",
        detail:
          `These allowlisted Discord targets have no effective users or roles restriction:\n${broadMemberPaths.map((path) => `- ${path}`).join("\n")}\n` +
          'groupPolicy="allowlist" limits guilds/channels, but all members of a listed target can still trigger the agent.',
        remediation:
          "Add users or roles restrictions at each listed guild/channel when only specific members should trigger the agent.",
      });
    }
  }

  addNameBasedEntries(discordCfg.allowFrom, `${discordPathPrefix}.allowFrom`);
  const dmAllowFromRaw = (discordCfg.dm as { allowFrom?: unknown } | undefined)?.allowFrom;
  addNameBasedEntries(dmAllowFromRaw, `${discordPathPrefix}.dm.allowFrom`);
  addNameBasedEntries(storeAllowFrom, "Discord pairing store");

  const guildEntries = (discordCfg.guilds as Record<string, unknown> | undefined) ?? {};
  let hasAnyUserAllowlist = false;
  const addUserEntries = (values: unknown, source: string) => {
    hasAnyUserAllowlist ||= Array.isArray(values) && values.length > 0;
    addNameBasedEntries(values, source);
  };
  for (const [guildKey, guildValue] of Object.entries(guildEntries)) {
    if (!guildValue || typeof guildValue !== "object") {
      continue;
    }
    const guild = guildValue as Record<string, unknown>;
    addUserEntries(guild.users, `${discordPathPrefix}.guilds.${guildKey}.users`);
    const channels = guild.channels;
    if (!channels || typeof channels !== "object") {
      continue;
    }
    for (const [channelKey, channelValue] of Object.entries(channels as Record<string, unknown>)) {
      if (!channelValue || typeof channelValue !== "object") {
        continue;
      }
      const channel = channelValue as Record<string, unknown>;
      addUserEntries(
        channel.users,
        `${discordPathPrefix}.guilds.${guildKey}.channels.${channelKey}.users`,
      );
    }
  }

  if (discordNameBasedAllowEntries.size > 0) {
    const counts = Array.from(discordNameBasedAllowEntries);
    const entryCount = counts.reduce((total, [, count]) => total + count, 0);
    const sources = counts.slice(0, 5).map(([source, count]) => `${source} (${count})`);
    const more =
      counts.length > sources.length ? ` (+${counts.length - sources.length} more sources)` : "";
    const summary = `Found ${entryCount} name/tag entries: ${sources.join(", ")}${more}.`;
    findings.push({
      checkId: "channels.discord.allowFrom.name_based_entries",
      severity: dangerousNameMatchingEnabled ? "info" : "warn",
      title: dangerousNameMatchingEnabled
        ? "Discord allowlist uses break-glass name/tag matching"
        : "Discord allowlist contains name or tag entries",
      detail: dangerousNameMatchingEnabled
        ? "Discord name/tag allowlist matching is explicitly enabled via dangerouslyAllowNameMatching. This mutable-identity mode is operator-selected break-glass behavior and out-of-scope for vulnerability reports by itself. " +
          summary
        : "Discord name/tag allowlist matching uses normalized slugs and can collide across users. " +
          summary,
      remediation: dangerousNameMatchingEnabled
        ? "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>), then disable dangerouslyAllowNameMatching."
        : "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>) in channels.discord.allowFrom and channels.discord.guilds.*.users, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept the risk.",
    });
  }

  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "discord",
    providerSetting: coerceNativeSetting(discordCfg.commands?.native),
    globalSetting: params.cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "discord",
    providerSetting: coerceNativeSetting(discordCfg.commands?.nativeSkills),
    globalSetting: params.cfg.commands?.nativeSkills,
  });
  if (!nativeEnabled && !nativeSkillsEnabled) {
    return findings;
  }

  const guildsConfigured = Object.keys(guildEntries).length > 0;
  const dmAllowFrom = Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [];
  const ownerAllowFromConfigured =
    normalizeAllowFromList([...(discordCfg.allowFrom ?? dmAllowFrom), ...storeAllowFrom]).length >
    0;
  if (
    effectiveGroupPolicy !== "disabled" &&
    guildsConfigured &&
    !ownerAllowFromConfigured &&
    !hasAnyUserAllowlist
  ) {
    findings.push({
      checkId: "channels.discord.commands.native.no_allowlists",
      severity: "warn",
      title: "Discord slash commands have no allowlists",
      detail:
        "Discord slash commands are enabled, but neither an owner allowFrom list nor any per-guild/channel users allowlist is configured; /… commands will be rejected for everyone.",
      remediation:
        "Add your user id to channels.discord.allowFrom (or approve yourself via pairing), or configure channels.discord.guilds.<id>.users.",
    });
  }

  return findings;
}
