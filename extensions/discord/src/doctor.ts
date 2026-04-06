import {
  type ChannelDoctorAdapter,
  type ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import { type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime-doctor";
import { DISCORD_LEGACY_CONFIG_RULES } from "./doctor-shared.js";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

type DiscordNumericIdHit = { path: string; entry: number; safe: boolean };

type DiscordIdListRef = {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: string;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ensureNestedRecord(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObjectRecord(owner[key]);
  if (existing) {
    return { ...existing };
  }
  return {};
}

function sanitizeForLog(value: string): string {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}

function isDiscordMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeMentionId)) {
    return false;
  }

  for (const prefix of ["discord:", "user:", "pk:"]) {
    if (!text.startsWith(prefix)) {
      continue;
    }
    return text.slice(prefix.length).trim().length === 0;
  }

  return true;
}

function normalizeDiscordDmAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let changed = false;
  let updated: Record<string, unknown> = params.entry;
  const rawDm = updated.dm;
  const dm = asObjectRecord(rawDm) ? (structuredClone(rawDm) as Record<string, unknown>) : null;
  let dmChanged = false;

  const allowFromEqual = (a: unknown, b: unknown): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    const na = a.map((v) => String(v).trim()).filter(Boolean);
    const nb = b.map((v) => String(v).trim()).filter(Boolean);
    if (na.length !== nb.length) {
      return false;
    }
    return na.every((v, i) => v === nb[i]);
  };

  const topDmPolicy = updated.dmPolicy;
  const legacyDmPolicy = dm?.policy;
  if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
    updated = { ...updated, dmPolicy: legacyDmPolicy };
    changed = true;
    if (dm) {
      delete dm.policy;
      dmChanged = true;
    }
    params.changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
  } else if (
    topDmPolicy !== undefined &&
    legacyDmPolicy !== undefined &&
    topDmPolicy === legacyDmPolicy
  ) {
    if (dm) {
      delete dm.policy;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
    }
  }

  const topAllowFrom = updated.allowFrom;
  const legacyAllowFrom = dm?.allowFrom;
  if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
    updated = { ...updated, allowFrom: legacyAllowFrom };
    changed = true;
    if (dm) {
      delete dm.allowFrom;
      dmChanged = true;
    }
    params.changes.push(
      `Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`,
    );
  } else if (
    topAllowFrom !== undefined &&
    legacyAllowFrom !== undefined &&
    allowFromEqual(topAllowFrom, legacyAllowFrom)
  ) {
    if (dm) {
      delete dm.allowFrom;
      dmChanged = true;
      params.changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
    }
  }

  if (dm && asObjectRecord(rawDm) && dmChanged) {
    const keys = Object.keys(dm);
    if (keys.length === 0) {
      if (updated.dm !== undefined) {
        const { dm: _ignored, ...rest } = updated;
        updated = rest;
        changed = true;
        params.changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
      }
    } else {
      updated = { ...updated, dm };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

function normalizeDiscordStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const beforeStreaming = params.entry.streaming;
  const hadLegacyStreamMode = params.entry.streamMode !== undefined;
  const hasLegacyFlatFields =
    params.entry.chunkMode !== undefined ||
    params.entry.blockStreaming !== undefined ||
    params.entry.draftChunk !== undefined ||
    params.entry.blockStreamingCoalesce !== undefined;
  const resolved = resolveDiscordPreviewStreamMode(params.entry);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    typeof beforeStreaming === "string" ||
    hasLegacyFlatFields;
  if (!shouldNormalize) {
    return { entry: params.entry, changed: false };
  }

  let updated = { ...params.entry };
  let changed = false;
  const streaming = ensureNestedRecord(updated, "streaming");
  const block = ensureNestedRecord(streaming, "block");
  const preview = ensureNestedRecord(streaming, "preview");

  if (
    (hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      typeof beforeStreaming === "string") &&
    streaming.mode === undefined
  ) {
    streaming.mode = resolved;
    if (hadLegacyStreamMode) {
      params.changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${resolved}).`,
      );
    } else if (typeof beforeStreaming === "boolean") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${resolved}).`,
      );
    } else if (typeof beforeStreaming === "string") {
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${resolved}).`,
      );
    }
    changed = true;
  }
  if (hadLegacyStreamMode) {
    delete updated.streamMode;
    changed = true;
  }
  if (updated.chunkMode !== undefined && streaming.chunkMode === undefined) {
    streaming.chunkMode = updated.chunkMode;
    delete updated.chunkMode;
    params.changes.push(
      `Moved ${params.pathPrefix}.chunkMode → ${params.pathPrefix}.streaming.chunkMode.`,
    );
    changed = true;
  }
  if (updated.blockStreaming !== undefined && block.enabled === undefined) {
    block.enabled = updated.blockStreaming;
    delete updated.blockStreaming;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreaming → ${params.pathPrefix}.streaming.block.enabled.`,
    );
    changed = true;
  }
  if (updated.draftChunk !== undefined && preview.chunk === undefined) {
    preview.chunk = updated.draftChunk;
    delete updated.draftChunk;
    params.changes.push(
      `Moved ${params.pathPrefix}.draftChunk → ${params.pathPrefix}.streaming.preview.chunk.`,
    );
    changed = true;
  }
  if (updated.blockStreamingCoalesce !== undefined && block.coalesce === undefined) {
    block.coalesce = updated.blockStreamingCoalesce;
    delete updated.blockStreamingCoalesce;
    params.changes.push(
      `Moved ${params.pathPrefix}.blockStreamingCoalesce → ${params.pathPrefix}.streaming.block.coalesce.`,
    );
    changed = true;
  }
  if (Object.keys(preview).length > 0) {
    streaming.preview = preview;
  }
  if (Object.keys(block).length > 0) {
    streaming.block = block;
  }
  updated.streaming = streaming;
  if (
    params.pathPrefix.startsWith("channels.discord") &&
    resolved === "off" &&
    hadLegacyStreamMode
  ) {
    params.changes.push(
      `${params.pathPrefix}.streaming remains off by default to avoid Discord preview-edit rate limits; set ${params.pathPrefix}.streaming.mode="partial" to opt in explicitly.`,
    );
  }
  return { entry: updated, changed };
}

function normalizeDiscordCompatibilityConfig(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.discord);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const base = normalizeDiscordDmAliases({
    entry: rawEntry,
    pathPrefix: "channels.discord",
    changes,
  });
  updated = base.entry;
  changed = base.changed;

  const streaming = normalizeDiscordStreamingAliases({
    entry: updated,
    pathPrefix: "channels.discord",
    changes,
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      let accountEntry = account;
      let accountChanged = false;
      const dm = normalizeDiscordDmAliases({
        entry: account,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      accountEntry = dm.entry;
      accountChanged = dm.changed;
      const accountStreaming = normalizeDiscordStreamingAliases({
        entry: accountEntry,
        pathPrefix: `channels.discord.accounts.${accountId}`,
        changes,
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;
      if (accountChanged) {
        accounts[accountId] = accountEntry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: updated,
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}

function collectDiscordAccountScopes(
  cfg: OpenClawConfig,
): Array<{ prefix: string; account: Record<string, unknown> }> {
  const scopes: Array<{ prefix: string; account: Record<string, unknown> }> = [];
  const discord = asObjectRecord(cfg.channels?.discord);
  if (!discord) {
    return scopes;
  }

  scopes.push({ prefix: "channels.discord", account: discord });
  const accounts = asObjectRecord(discord.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (account) {
      scopes.push({ prefix: `channels.discord.accounts.${key}`, account });
    }
  }
  return scopes;
}

function collectDiscordIdLists(
  prefix: string,
  account: Record<string, unknown>,
): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [
    { pathLabel: `${prefix}.allowFrom`, holder: account, key: "allowFrom" },
  ];
  const dm = asObjectRecord(account.dm);
  if (dm) {
    refs.push({ pathLabel: `${prefix}.dm.allowFrom`, holder: dm, key: "allowFrom" });
    refs.push({ pathLabel: `${prefix}.dm.groupChannels`, holder: dm, key: "groupChannels" });
  }
  const execApprovals = asObjectRecord(account.execApprovals);
  if (execApprovals) {
    refs.push({
      pathLabel: `${prefix}.execApprovals.approvers`,
      holder: execApprovals,
      key: "approvers",
    });
  }
  const guilds = asObjectRecord(account.guilds);
  if (!guilds) {
    return refs;
  }
  for (const guildId of Object.keys(guilds)) {
    const guild = asObjectRecord(guilds[guildId]);
    if (!guild) {
      continue;
    }
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.users`, holder: guild, key: "users" });
    refs.push({ pathLabel: `${prefix}.guilds.${guildId}.roles`, holder: guild, key: "roles" });
    const channels = asObjectRecord(guild.channels);
    if (!channels) {
      continue;
    }
    for (const channelId of Object.keys(channels)) {
      const channel = asObjectRecord(channels[channelId]);
      if (!channel) {
        continue;
      }
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.users`,
        holder: channel,
        key: "users",
      });
      refs.push({
        pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.roles`,
        holder: channel,
        key: "roles",
      });
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

  for (const scope of collectDiscordAccountScopes(cfg)) {
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
  const hitsByListPath = new Map<string, DiscordNumericIdHit[]>();
  for (const hit of params.hits) {
    const listPath = hit.path.replace(/\[\d+\]$/, "");
    const existing = hitsByListPath.get(listPath);
    if (existing) {
      existing.push(hit);
    } else {
      hitsByListPath.set(listPath, [hit]);
    }
  }

  const repairableHits: DiscordNumericIdHit[] = [];
  const blockedHits: DiscordNumericIdHit[] = [];
  for (const hits of hitsByListPath.values()) {
    if (hits.some((hit) => !hit.safe)) {
      blockedHits.push(...hits);
    } else {
      repairableHits.push(...hits);
    }
  }

  const lines: string[] = [];
  if (repairableHits.length > 0) {
    const sample = repairableHits[0];
    lines.push(
      `- Discord allowlists contain ${repairableHits.length} numeric ${repairableHits.length === 1 ? "entry" : "entries"} (e.g. ${sanitizeForLog(sample.path)}=${sanitizeForLog(String(sample.entry))}).`,
      `- Discord IDs must be strings; run "${params.doctorFixCommand}" to convert numeric IDs to quoted strings.`,
    );
  }
  if (blockedHits.length > 0) {
    const sample = blockedHits[0];
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

  for (const scope of collectDiscordAccountScopes(next)) {
    for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) {
      repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  if (changes.length === 0) {
    return {
      config: cfg,
      changes: [],
      warnings: collectDiscordNumericIdWarnings({ hits, doctorFixCommand }),
    };
  }
  return {
    config: next,
    changes,
    warnings: collectDiscordNumericIdWarnings({
      hits: hits.filter((hit) => !hit.safe),
      doctorFixCommand,
    }),
  };
}

function collectDiscordMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];
  const addHits = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const text = String(entry).trim();
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
    addHits(`${scope.prefix}.allowFrom`, scope.account.allowFrom);
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addHits(`${scope.prefix}.dm.allowFrom`, dm.allowFrom);
    }
    const guilds = asObjectRecord(scope.account.guilds);
    if (!guilds) {
      continue;
    }
    for (const [guildId, guildRaw] of Object.entries(guilds)) {
      const guild = asObjectRecord(guildRaw);
      if (!guild) {
        continue;
      }
      addHits(`${scope.prefix}.guilds.${guildId}.users`, guild.users);
      const channels = asObjectRecord(guild.channels);
      if (!channels) {
        continue;
      }
      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = asObjectRecord(channelRaw);
        if (channel) {
          addHits(`${scope.prefix}.guilds.${guildId}.channels.${channelId}.users`, channel.users);
        }
      }
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
    `- Option A (break-glass): enable channels.discord.dangerousNameMatching=true for the affected scope.`,
    `- Option B (recommended): resolve names to stable Discord IDs and rewrite the allowlist entries.`,
  ];
}

export const discordDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOrNested",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: DISCORD_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: ({ cfg }) => normalizeDiscordCompatibilityConfig(cfg),
  collectPreviewWarnings: ({ cfg, doctorFixCommand }) =>
    collectDiscordNumericIdWarnings({
      hits: scanDiscordNumericIdEntries(cfg),
      doctorFixCommand,
    }),
  collectMutableAllowlistWarnings: ({ cfg }) => collectDiscordMutableAllowlistWarnings(cfg),
  repairConfig: ({ cfg, doctorFixCommand }) => maybeRepairDiscordNumericIds(cfg, doctorFixCommand),
};
