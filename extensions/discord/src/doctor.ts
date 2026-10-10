import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  asObjectRecord,
  collectChannelAccountScopes,
  collectProviderDangerousNameMatchingScopes,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectDiscordAccount } from "./account-inspect.js";
import { resolveDefaultDiscordAccountId } from "./accounts.js";
import { normalizeCompatibilityConfig as normalizeDiscordCompatibilityConfig } from "./doctor-contract.js";
import { DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared.js";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";
import { discordVoiceTranscriptsSourceProvider } from "./voice/transcripts-source.js";

type DiscordNumericIdHit = { path: string; entry: number; safe: boolean };

type DiscordIdListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: string;
};

function sanitizeForLog(value: string): string {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}

function collectDiscordIdLists(
  prefix: string,
  account: Record<string, unknown>,
  userAllowlistsOnly = false,
): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [];
  const addLists = (holder: Record<string, unknown>, path: string, keys: string[]) => {
    for (const key of keys) {
      refs.push({ pathLabel: `${path}.${key}`, holder, key });
    }
  };
  addLists(account, prefix, ["allowFrom"]);
  const dm = asObjectRecord(account.dm);
  if (dm) {
    addLists(
      dm,
      `${prefix}.dm`,
      userAllowlistsOnly ? ["allowFrom"] : ["allowFrom", "groupChannels"],
    );
  }
  const execApprovals = asObjectRecord(account.execApprovals);
  if (execApprovals && !userAllowlistsOnly) {
    addLists(execApprovals, `${prefix}.execApprovals`, ["approvers"]);
  }
  const memberKeys = userAllowlistsOnly ? ["users"] : ["users", "roles"];
  for (const [guildId, guildValue] of Object.entries(asObjectRecord(account.guilds) ?? {})) {
    const guild = asObjectRecord(guildValue);
    if (!guild) {
      continue;
    }
    const guildPath = `${prefix}.guilds.${guildId}`;
    addLists(guild, guildPath, memberKeys);
    for (const [channelId, channelValue] of Object.entries(asObjectRecord(guild.channels) ?? {})) {
      const channel = asObjectRecord(channelValue);
      if (channel) {
        addLists(channel, `${guildPath}.channels.${channelId}`, memberKeys);
      }
    }
  }
  return refs;
}

export function scanDiscordNumericIdEntries(cfg: OpenClawConfig): DiscordNumericIdHit[] {
  const hits: DiscordNumericIdHit[] = [];
  const scanList = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== "number") {
        continue;
      }
      hits.push({
        path: `${pathLabel}[${index}]`,
        entry,
        safe: Number.isSafeInteger(entry) && entry >= 0,
      });
    }
  };

  for (const scope of collectChannelAccountScopes({ cfg, channelId: "discord" })) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }
  return hits;
}

export function collectDiscordNumericIdWarnings(params: {
  hits: DiscordNumericIdHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const listPath = (hit: DiscordNumericIdHit) => hit.path.replace(/\[\d+\]$/, "");
  const blockedPaths = new Set(params.hits.filter((hit) => !hit.safe).map(listPath));
  const repairableHits = params.hits.filter((hit) => !blockedPaths.has(listPath(hit)));
  const blockedHits = params.hits.filter((hit) => blockedPaths.has(listPath(hit)));

  const lines: string[] = [];
  if (repairableHits.length > 0) {
    const sample = expectDefined(repairableHits.at(0), "non-empty repairable Discord ID hits");
    lines.push(
      `- Discord allowlists contain ${repairableHits.length} numeric ${repairableHits.length === 1 ? "entry" : "entries"} (e.g. ${sanitizeForLog(sample.path)}=${sanitizeForLog(String(sample.entry))}).`,
      `- Discord IDs must be strings; run "${params.doctorFixCommand}" to convert numeric IDs to quoted strings.`,
    );
  }
  if (blockedHits.length > 0) {
    const sample = expectDefined(blockedHits.at(0), "non-empty blocked Discord ID hits");
    lines.push(
      `- Discord allowlists contain ${blockedHits.length} numeric ${blockedHits.length === 1 ? "entry" : "entries"} in lists that cannot be auto-repaired (e.g. ${sanitizeForLog(sample.path)}).`,
      `- These lists include invalid or precision-losing numeric IDs; manually quote the original values in your config file, then rerun "${params.doctorFixCommand}".`,
    );
  }
  return lines;
}

export function maybeRepairDiscordNumericIds(
  cfg: OpenClawConfig,
  doctorFixCommand: string,
): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  const hits = scanDiscordNumericIdEntries(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const repairList = (pathLabel: string, holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!Array.isArray(raw)) {
      return;
    }
    const hasUnsafe = raw.some(
      (entry) => typeof entry === "number" && (!Number.isSafeInteger(entry) || entry < 0),
    );
    if (hasUnsafe) {
      return;
    }
    let converted = 0;
    holder[key] = raw.map((entry) => {
      if (typeof entry === "number") {
        converted += 1;
        return String(entry);
      }
      return entry;
    });
    if (converted > 0) {
      changes.push(
        `- ${sanitizeForLog(pathLabel)}: converted ${converted} numeric ${converted === 1 ? "ID" : "IDs"} to strings`,
      );
    }
  };

  for (const scope of collectChannelAccountScopes({ cfg: next, channelId: "discord" })) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  const repaired = changes.length > 0;
  return {
    config: repaired ? next : cfg,
    changes,
    warnings: collectDiscordNumericIdWarnings({
      hits: repaired ? hits.filter((hit) => !hit.safe) : hits,
      doctorFixCommand,
    }),
  };
}

export function collectDiscordMissingEnvTokenWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (resolveDefaultDiscordAccountId(params.cfg) !== "default") {
    return [];
  }
  const account = inspectDiscordAccount({
    cfg: params.cfg,
    accountId: "default",
    envToken: params.env?.DISCORD_BOT_TOKEN ?? "",
  });
  if (!account.enabled || account.tokenStatus !== "missing" || account.tokenSource !== "none") {
    return [];
  }
  return [
    "- channels.discord: default account has no available bot token, and DISCORD_BOT_TOKEN is absent in this doctor environment. After migration, verify DISCORD_BOT_TOKEN is present in the state-dir .env or configure channels.discord.token / channels.discord.accounts.default.token as a SecretRef.",
  ];
}

function collectDiscordTranscriptsAutoStartWarnings(cfg: OpenClawConfig): string[] {
  if (cfg.transcripts?.enabled === false || !Array.isArray(cfg.transcripts?.autoStart)) {
    return [];
  }
  const ownership = discordVoiceTranscriptsSourceProvider.accessControl;
  if (!ownership) {
    return [];
  }

  return cfg.transcripts.autoStart.flatMap((entry, index) => {
    const providerId = normalizeOptionalString(entry.providerId)?.toLowerCase();
    if (
      (providerId !== discordVoiceTranscriptsSourceProvider.id &&
        !discordVoiceTranscriptsSourceProvider.aliases?.includes(providerId ?? "")) ||
      normalizeOptionalString(entry.accountId)
    ) {
      return [];
    }
    const resolution = ownership.resolveAccountId({
      cfg,
      source: { providerId: entry.providerId, accountId: entry.accountId },
    });
    if (resolution.ok) {
      return [];
    }
    const path = `transcripts.autoStart[${index}]`;
    return [
      `- ${path} cannot select a Discord voice account: ${resolution.error} Set ${path}.accountId to the intended enabled voice account, or set channels.discord.defaultAccount when one account should be the global default.`,
    ];
  });
}

function collectDiscordMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];
  const addHits = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const text = normalizeOptionalString(String(entry)) ?? "";
      if (!text || text === "*" || !isDiscordMutableAllowEntry(text)) {
        continue;
      }
      hits.push({ path: pathLabel, entry: text });
    }
  };

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "discord")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account, true)) {
      addHits(ref.pathLabel, ref.holder[ref.key]);
    }
  }

  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across discord while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    `- Option A (break-glass): enable channels.discord.dangerouslyAllowNameMatching=true for the affected scope.`,
    `- Option B (recommended): resolve names to stable Discord IDs and rewrite the allowlist entries.`,
  ];
}

export const discordDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: DISCORD_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeDiscordCompatibilityConfig,
  collectPreviewWarnings: ({ cfg, doctorFixCommand, env }) => [
    ...collectDiscordMissingEnvTokenWarnings({ cfg, env }),
    ...collectDiscordNumericIdWarnings({
      hits: scanDiscordNumericIdEntries(cfg),
      doctorFixCommand,
    }),
    ...collectDiscordTranscriptsAutoStartWarnings(cfg),
  ],
  collectMutableAllowlistWarnings: ({ cfg }) => collectDiscordMutableAllowlistWarnings(cfg),
  repairConfig: ({ cfg, doctorFixCommand }) => maybeRepairDiscordNumericIds(cfg, doctorFixCommand),
};
