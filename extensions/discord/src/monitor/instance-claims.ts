import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

const DISCORD_CLAIMS_SCHEMA_VERSION = 2;
const DISCORD_CLAIMS_TTL_MS = 90_000;

export const DISCORD_CLAIMS_PATH = join(homedir(), ".discord-claims.json");

export type DiscordClaimOwnership = {
  status: "owned" | "not-owned" | "claimed-by-other" | "no-entry";
  instanceKey: string;
  botId?: string;
  matchedChannelId?: string;
  ownerInstanceKey?: string;
};

type DiscordClaimChannelEntry = {
  updatedAt: number;
  source: string;
};

type DiscordClaimBotEntry = {
  updatedAt: number;
  channels: Record<string, DiscordClaimChannelEntry>;
  guilds: Record<string, DiscordClaimChannelEntry>;
};

type DiscordClaimInstanceEntry = {
  updatedAt: number;
  bots: Record<string, DiscordClaimBotEntry>;
};

type DiscordClaimsFile = {
  version: number;
  instances: Record<string, DiscordClaimInstanceEntry>;
};

type MinimalGuildEntry = {
  id?: string;
  guildId?: string;
  channels?: Record<string, unknown>;
};

function sanitizeInstanceKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveConfiguredInstanceId(cfg?: OpenClawConfig): string {
  const value = (cfg as OpenClawConfig & { gateway?: { instanceId?: string } })?.gateway?.instanceId;
  return sanitizeInstanceKey(value);
}

function deriveInstanceKeyFromConfigPath(configPath?: string): string {
  const normalized = String(configPath ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  const parent = parts.at(-2) ?? "";
  if (!parent) return "";
  if (parent === ".openclaw") return "openclaw-main";
  if (parent.startsWith(".openclaw-")) return sanitizeInstanceKey(`openclaw-${parent.slice(10)}`);
  return sanitizeInstanceKey(parent.startsWith(".") ? parent.slice(1) : parent);
}

export function resolveDiscordInstanceKey(params: {
  cfg?: OpenClawConfig;
  instanceId?: string;
  accountId?: string;
  configPath?: string;
}): string {
  const explicit =
    sanitizeInstanceKey(params.instanceId) ||
    resolveConfiguredInstanceId(params.cfg) ||
    sanitizeInstanceKey(process.env.OPENCLAW_INSTANCE_ID);
  if (explicit) return explicit;
  const fromPath =
    deriveInstanceKeyFromConfigPath(params.configPath) ||
    deriveInstanceKeyFromConfigPath(process.env.OPENCLAW_CONFIG_PATH);
  if (fromPath) return fromPath;
  return `openclaw-${sanitizeInstanceKey(params.accountId ?? "default") || "default"}`;
}

function normalizeGuildEntries(
  guildEntries?: Record<string, MinimalGuildEntry> | MinimalGuildEntry[],
): Record<string, MinimalGuildEntry> {
  if (!guildEntries) return {};
  if (!Array.isArray(guildEntries)) return guildEntries;
  return Object.fromEntries(
    guildEntries
      .map((guild) => [String(guild?.id ?? guild?.guildId ?? "").trim(), guild] as const)
      .filter(([guildId]) => Boolean(guildId)),
  );
}

function pruneClaimChannels(
  channels: Record<string, DiscordClaimChannelEntry> | undefined,
  now: number,
): Record<string, DiscordClaimChannelEntry> {
  const next: Record<string, DiscordClaimChannelEntry> = {};
  for (const [channelId, claim] of Object.entries(channels ?? {})) {
    const key = String(channelId).trim();
    if (!/^\d+$/.test(key)) continue;
    if (!claim || now - Number(claim.updatedAt ?? 0) > DISCORD_CLAIMS_TTL_MS) continue;
    next[key] = claim;
  }
  return next;
}

function pruneClaimsFile(data: DiscordClaimsFile, now: number): DiscordClaimsFile {
  const next: DiscordClaimsFile = {
    version: DISCORD_CLAIMS_SCHEMA_VERSION,
    instances: {},
  };
  for (const [instanceKey, instanceEntry] of Object.entries(data.instances ?? {})) {
    const bots: Record<string, DiscordClaimBotEntry> = {};
    for (const [botId, botEntry] of Object.entries(instanceEntry?.bots ?? {})) {
      const channels = pruneClaimChannels(botEntry?.channels, now);
      const guilds = pruneClaimChannels(botEntry?.guilds, now);
      if (
        Object.keys(channels).length === 0 &&
        Object.keys(guilds).length === 0 &&
        now - Number(botEntry?.updatedAt ?? 0) > DISCORD_CLAIMS_TTL_MS
      ) {
        continue;
      }
      bots[botId] = {
        updatedAt: Number(botEntry?.updatedAt ?? now),
        channels,
        guilds,
      };
    }
    if (Object.keys(bots).length === 0 && now - Number(instanceEntry?.updatedAt ?? 0) > DISCORD_CLAIMS_TTL_MS) {
      continue;
    }
    next.instances[instanceKey] = {
      updatedAt: Number(instanceEntry?.updatedAt ?? now),
      bots,
    };
  }
  return next;
}

export async function loadDiscordClaimsFile(): Promise<DiscordClaimsFile> {
  try {
    const raw = await readFile(DISCORD_CLAIMS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordClaimsFile>;
    if (parsed && typeof parsed === "object" && parsed.instances && typeof parsed.instances === "object") {
      return {
        version: typeof parsed.version === "number" ? parsed.version : DISCORD_CLAIMS_SCHEMA_VERSION,
        instances: parsed.instances as Record<string, DiscordClaimInstanceEntry>,
      };
    }
  } catch {}
  return { version: DISCORD_CLAIMS_SCHEMA_VERSION, instances: {} };
}

async function saveDiscordClaimsFileAtomic(data: DiscordClaimsFile): Promise<void> {
  await mkdir(dirname(DISCORD_CLAIMS_PATH), { recursive: true });
  const tmpPath = `${DISCORD_CLAIMS_PATH}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, DISCORD_CLAIMS_PATH);
}

function buildClaimEntries(
  guildEntries?: Record<string, MinimalGuildEntry> | MinimalGuildEntry[],
  now = Date.now(),
): {
  channels: Record<string, DiscordClaimChannelEntry>;
  guilds: Record<string, DiscordClaimChannelEntry>;
} {
  const channels: Record<string, DiscordClaimChannelEntry> = {};
  const guilds: Record<string, DiscordClaimChannelEntry> = {};
  for (const [guildKey, guild] of Object.entries(normalizeGuildEntries(guildEntries))) {
    const guildId = String(guild?.id ?? guild?.guildId ?? guildKey ?? "").trim();
    const channelEntries = guild?.channels ?? {};
    const channelKeys = Object.keys(channelEntries);
    const wildcardEntry = channelEntries["*"] as { allow?: boolean } | undefined;
    const claimsEntireGuild =
      channelKeys.length === 0 ||
      (channelKeys.length === 1 && channelKeys[0] === "*" && wildcardEntry?.allow !== false);
    if (/^\d+$/.test(guildId) && claimsEntireGuild) {
      guilds[guildId] = {
        updatedAt: now,
        source: `guild:${guildId}`,
      };
    }
    for (const channelId of channelKeys) {
      const key = String(channelId).trim();
      if (!/^\d+$/.test(key)) continue;
      channels[key] = {
        updatedAt: now,
        source: `guild:${guildId}`,
      };
    }
  }
  return { channels, guilds };
}

export async function refreshDiscordClaims(params: {
  cfg?: OpenClawConfig;
  instanceId?: string;
  accountId?: string;
  configPath?: string;
  botId: string;
  guildEntries?: Record<string, MinimalGuildEntry> | MinimalGuildEntry[];
}): Promise<{ instanceKey: string; botId: string; channelCount: number }> {
  const instanceKey = resolveDiscordInstanceKey(params);
  const botId = String(params.botId).trim();
  const now = Date.now();
  const data = pruneClaimsFile(await loadDiscordClaimsFile(), now);
  const { channels, guilds } = buildClaimEntries(params.guildEntries, now);
  data.instances[instanceKey] = data.instances[instanceKey] ?? { updatedAt: now, bots: {} };
  data.instances[instanceKey].updatedAt = now;
  data.instances[instanceKey].bots[botId] = {
    updatedAt: now,
    channels,
    guilds,
  };
  await saveDiscordClaimsFileAtomic(data);
  return { instanceKey, botId, channelCount: Object.keys(channels).length };
}

export async function resolveDiscordClaimOwnership(params: {
  cfg?: OpenClawConfig;
  instanceId?: string;
  accountId?: string;
  configPath?: string;
  botId?: string;
  guildId?: string;
  channelId?: string;
  parentId?: string;
}): Promise<DiscordClaimOwnership> {
  const instanceKey = resolveDiscordInstanceKey(params);
  const lookupIds = [params.channelId, params.parentId]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (lookupIds.length === 0 && !String(params.guildId ?? "").trim()) {
    return { status: "no-entry", instanceKey, botId: params.botId };
  }
  const data = pruneClaimsFile(await loadDiscordClaimsFile(), Date.now());
  const requestedBotId = String(params.botId ?? "").trim();
  const requestedGuildId = String(params.guildId ?? "").trim();
  const collectBotKeys = (bots: Record<string, DiscordClaimBotEntry>) =>
    requestedBotId ? [requestedBotId] : Object.keys(bots);
  const instanceEntry = data.instances[instanceKey];
  if (instanceEntry) {
    let sawClaims = false;
    for (const botKey of collectBotKeys(instanceEntry.bots)) {
      const botEntry = instanceEntry.bots[botKey];
      if (!botEntry) continue;
      const channels = pruneClaimChannels(botEntry.channels, Date.now());
      const guilds = pruneClaimChannels(botEntry.guilds, Date.now());
      if (Object.keys(channels).length === 0 && Object.keys(guilds).length === 0) continue;
      sawClaims = true;
      for (const lookupId of lookupIds) {
        if (channels[lookupId]) {
          return {
            status: "owned",
            instanceKey,
            botId: botKey,
            matchedChannelId: lookupId,
          };
        }
      }
      if (requestedGuildId && guilds[requestedGuildId]) {
        return {
          status: "owned",
          instanceKey,
          botId: botKey,
          matchedChannelId: requestedGuildId,
        };
      }
    }
    if (sawClaims) {
      return {
        status: "not-owned",
        instanceKey,
        botId: requestedBotId || undefined,
      };
    }
  }
  for (const [otherInstanceKey, otherInstanceEntry] of Object.entries(data.instances)) {
    if (otherInstanceKey === instanceKey) continue;
    for (const botKey of collectBotKeys(otherInstanceEntry.bots)) {
      const botEntry = otherInstanceEntry.bots[botKey];
      if (!botEntry) continue;
      const channels = pruneClaimChannels(botEntry.channels, Date.now());
      const guilds = pruneClaimChannels(botEntry.guilds, Date.now());
      for (const lookupId of lookupIds) {
        if (channels[lookupId]) {
          return {
            status: "claimed-by-other",
            instanceKey,
            ownerInstanceKey: otherInstanceKey,
            botId: botKey,
            matchedChannelId: lookupId,
          };
        }
      }
      if (requestedGuildId && guilds[requestedGuildId]) {
        return {
          status: "claimed-by-other",
          instanceKey,
          ownerInstanceKey: otherInstanceKey,
          botId: botKey,
          matchedChannelId: requestedGuildId,
        };
      }
    }
  }
  return {
    status: "no-entry",
    instanceKey,
    botId: requestedBotId || undefined,
  };
}
