import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-normalization-runtime";
import { resolveMatrixTargets } from "../../resolve-targets.js";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { isMatrixQualifiedUserId, isMatrixRoomId } from "../target-ids.js";
import { normalizeMatrixUserId } from "./allowlist.js";

type MatrixRoomsConfig = Record<string, MatrixRoomConfig>;
type ResolveMatrixTargetsFn = typeof resolveMatrixTargets;

export type MatrixResolvedAllowlistEntry = {
  input: string;
  id: string;
};

type MatrixResolvedUserAllowlist = {
  entries: string[];
  resolvedEntries: MatrixResolvedAllowlistEntry[];
};

function normalizeMatrixUserLookupEntry(raw: string): string {
  return raw
    .replace(/^matrix:/i, "")
    .replace(/^user:/i, "")
    .trim();
}

function normalizeMatrixRoomLookupEntry(raw: string): string {
  return raw
    .replace(/^matrix:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function filterResolvedMatrixAllowlistEntries(entries: string[]): string[] {
  return entries.filter((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === "*") {
      return true;
    }
    return isMatrixQualifiedUserId(normalizeMatrixUserLookupEntry(trimmed));
  });
}

function filterFailClosedMatrixAllowlistEntries(entries: string[]): string[] {
  return entries.filter((entry) => entry.trim().length > 0);
}

function listResolvedMatrixAllowlistEntries(params: {
  entries: Array<string | number>;
  resolvedMap: Map<string, { resolved: boolean; id?: string }>;
}): MatrixResolvedAllowlistEntry[] {
  const resolvedEntries: MatrixResolvedAllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const entry of params.entries) {
    const input = String(entry).trim();
    if (!input || seen.has(input)) {
      continue;
    }
    seen.add(input);
    const resolved = params.resolvedMap.get(input);
    if (!resolved?.resolved || !resolved.id) {
      continue;
    }
    const id = normalizeMatrixUserId(resolved.id);
    if (isMatrixQualifiedUserId(id)) {
      resolvedEntries.push({ input, id });
    }
  }
  return resolvedEntries;
}

function isMatrixDangerousNameMatchingEnabled(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): boolean {
  return isDangerousNameMatchingEnabled(
    resolveMatrixAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    }),
  );
}

function addUniqueMatrixAllowlistEntry(params: {
  entries: string[];
  seen: Set<string>;
  entry: string;
}): void {
  const trimmed = params.entry.trim();
  if (!trimmed) {
    return;
  }
  const key = normalizeMatrixUserId(trimmed);
  if (params.seen.has(key)) {
    return;
  }
  params.seen.add(key);
  params.entries.push(trimmed);
}

function logMatrixAllowlistResolution(params: {
  label: string;
  resolution: ReturnType<typeof buildAllowlistResolutionSummary>;
  allowNameMatching: boolean;
  runtime: RuntimeEnv;
}): void {
  const { label, resolution, allowNameMatching, runtime } = params;
  summarizeMapping(
    label,
    allowNameMatching ? resolution.mapping : [],
    resolution.unresolved,
    runtime,
  );
  if (resolution.unresolved.length > 0) {
    const nameMatchingHint = allowNameMatching
      ? ""
      : " To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.";
    runtime.log?.(
      `${label} entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender.${nameMatchingHint}`,
    );
  }
}

async function resolveMatrixMonitorUserEntries(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  entries: Array<string | number>;
  runtime: RuntimeEnv;
  resolveTargets: ResolveMatrixTargetsFn;
  allowNameMatching: boolean;
}) {
  const directMatches: Array<{ input: string; resolved: boolean; id?: string }> = [];
  const pending: Array<{ input: string; query: string }> = [];

  for (const entry of params.entries) {
    const input = String(entry).trim();
    if (!input) {
      continue;
    }
    const query = normalizeMatrixUserLookupEntry(input);
    if (!query || query === "*") {
      continue;
    }
    if (isMatrixQualifiedUserId(query)) {
      directMatches.push({
        input,
        resolved: true,
        id: normalizeMatrixUserId(query),
      });
      continue;
    }
    if (params.allowNameMatching) {
      pending.push({ input, query });
    } else {
      directMatches.push({ input, resolved: false });
    }
  }

  const pendingResolved =
    pending.length === 0
      ? []
      : await params.resolveTargets({
          cfg: params.cfg,
          accountId: params.accountId,
          inputs: pending.map((entry) => entry.query),
          kind: "user",
          runtime: params.runtime,
        });

  pendingResolved.forEach((entry, index) => {
    const source = pending[index];
    if (!source) {
      return;
    }
    directMatches.push({
      input: source.input,
      resolved: entry.resolved,
      id: entry.id ? normalizeMatrixUserId(entry.id) : undefined,
    });
  });

  return buildAllowlistResolutionSummary(directMatches);
}

async function resolveMatrixMonitorUserAllowlist(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  label: string;
  list?: Array<string | number>;
  failClosedOnUnresolved?: boolean;
  runtime: RuntimeEnv;
  resolveTargets: ResolveMatrixTargetsFn;
}): Promise<MatrixResolvedUserAllowlist> {
  const allowList = (params.list ?? []).map(String);
  if (allowList.length === 0) {
    return { entries: allowList, resolvedEntries: [] };
  }
  const allowNameMatching = isMatrixDangerousNameMatchingEnabled(params);

  const resolution = await resolveMatrixMonitorUserEntries({
    cfg: params.cfg,
    accountId: params.accountId,
    entries: allowList,
    runtime: params.runtime,
    resolveTargets: params.resolveTargets,
    allowNameMatching,
  });
  const canonicalized = canonicalizeAllowlistWithResolvedIds({
    existing: allowList,
    resolvedMap: resolution.resolvedMap,
    entryKey: normalizeMatrixUserId,
  });

  logMatrixAllowlistResolution({
    label: params.label,
    resolution,
    allowNameMatching,
    runtime: params.runtime,
  });

  return {
    entries: params.failClosedOnUnresolved
      ? filterFailClosedMatrixAllowlistEntries(canonicalized)
      : filterResolvedMatrixAllowlistEntries(canonicalized),
    resolvedEntries: listResolvedMatrixAllowlistEntries({
      entries: allowList,
      resolvedMap: resolution.resolvedMap,
    }),
  };
}

export async function resolveMatrixMonitorLiveUserAllowlist(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  entries?: ReadonlyArray<string | number>;
  failClosedOnUnresolved?: boolean;
  startupResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  runtime: RuntimeEnv;
  resolveTargets?: ResolveMatrixTargetsFn;
}): Promise<string[]> {
  const liveEntries = normalizeStringEntries(params.entries);
  if (liveEntries.length === 0) {
    return [];
  }

  const allowNameMatching = isMatrixDangerousNameMatchingEnabled({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const effective: string[] = [];
  const seen = new Set<string>();
  const startupByInput = new Map(
    (params.startupResolvedEntries ?? []).map((entry) => [entry.input, entry.id] as const),
  );
  const pending: string[] = [];

  for (const entry of liveEntries) {
    const query = normalizeMatrixUserLookupEntry(entry);
    if (entry === "*") {
      addUniqueMatrixAllowlistEntry({ entries: effective, seen, entry });
      continue;
    }
    if (isMatrixQualifiedUserId(query)) {
      addUniqueMatrixAllowlistEntry({
        entries: effective,
        seen,
        entry: normalizeMatrixUserId(query),
      });
      continue;
    }
    const startupId = startupByInput.get(entry);
    if (allowNameMatching && startupId) {
      addUniqueMatrixAllowlistEntry({ entries: effective, seen, entry: startupId });
      continue;
    }
    if (allowNameMatching) {
      pending.push(entry);
      continue;
    }
    if (params.failClosedOnUnresolved) {
      addUniqueMatrixAllowlistEntry({ entries: effective, seen, entry });
    }
  }

  if (pending.length === 0) {
    return effective;
  }

  const resolution = await resolveMatrixMonitorUserEntries({
    cfg: params.cfg,
    accountId: params.accountId,
    entries: pending,
    runtime: params.runtime,
    resolveTargets: params.resolveTargets ?? resolveMatrixTargets,
    allowNameMatching,
  });
  const canonicalized = canonicalizeAllowlistWithResolvedIds({
    existing: pending,
    resolvedMap: resolution.resolvedMap,
    entryKey: normalizeMatrixUserId,
  });
  const resolvedEntries = params.failClosedOnUnresolved
    ? filterFailClosedMatrixAllowlistEntries(canonicalized)
    : filterResolvedMatrixAllowlistEntries(canonicalized);
  for (const entry of resolvedEntries) {
    addUniqueMatrixAllowlistEntry({ entries: effective, seen, entry });
  }

  return effective;
}

async function resolveMatrixMonitorRoomsConfig(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  roomsConfig?: MatrixRoomsConfig;
  runtime: RuntimeEnv;
  resolveTargets: ResolveMatrixTargetsFn;
}): Promise<MatrixRoomsConfig | undefined> {
  const roomsConfig = params.roomsConfig;
  if (!roomsConfig || Object.keys(roomsConfig).length === 0) {
    return roomsConfig;
  }

  const mapping: string[] = [];
  const unresolved: string[] = [];
  const nextRooms: MatrixRoomsConfig = {};
  const allowNameMatching = isMatrixDangerousNameMatchingEnabled({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (roomsConfig["*"]) {
    nextRooms["*"] = roomsConfig["*"];
  }

  const pending: Array<{ input: string; query: string; config: MatrixRoomConfig }> = [];
  for (const [entry, roomConfig] of Object.entries(roomsConfig)) {
    if (entry === "*") {
      continue;
    }
    const input = entry.trim();
    if (!input) {
      continue;
    }
    const cleaned = normalizeMatrixRoomLookupEntry(input);
    if (!cleaned) {
      unresolved.push(entry);
      continue;
    }
    if (isMatrixRoomId(cleaned)) {
      if (!nextRooms[cleaned]) {
        nextRooms[cleaned] = roomConfig;
      }
      if (cleaned !== input) {
        mapping.push(`${input}→${cleaned}`);
      }
      continue;
    }
    if (!cleaned.startsWith("#") && !allowNameMatching) {
      unresolved.push(input);
      continue;
    }
    pending.push({ input, query: cleaned, config: roomConfig });
  }

  if (pending.length > 0) {
    const resolved = await params.resolveTargets({
      cfg: params.cfg,
      accountId: params.accountId,
      inputs: pending.map((entry) => entry.query),
      kind: "group",
      runtime: params.runtime,
    });
    resolved.forEach((entry, index) => {
      const source = pending[index];
      if (!source) {
        return;
      }
      if (entry.resolved && entry.id) {
        const roomKey = normalizeMatrixRoomLookupEntry(entry.id);
        if (!nextRooms[roomKey]) {
          nextRooms[roomKey] = source.config;
        }
        mapping.push(`${source.input}→${roomKey}`);
      } else {
        unresolved.push(source.input);
      }
    });
  }

  summarizeMapping("matrix rooms", mapping, unresolved, params.runtime);
  if (unresolved.length > 0) {
    params.runtime.log?.(
      "matrix rooms must be room IDs or aliases (example: !room:server, the suffixless !room form on room version 12+, or #alias:server). Unresolved entries are ignored.",
    );
  }

  const roomUsers = new Set<string>();
  for (const roomConfig of Object.values(nextRooms)) {
    addAllowlistUserEntriesFromConfigEntry(roomUsers, roomConfig);
  }
  if (roomUsers.size === 0) {
    return nextRooms;
  }
  const resolution = await resolveMatrixMonitorUserEntries({
    cfg: params.cfg,
    accountId: params.accountId,
    entries: Array.from(roomUsers),
    runtime: params.runtime,
    resolveTargets: params.resolveTargets,
    allowNameMatching,
  });
  logMatrixAllowlistResolution({
    label: "matrix room users",
    resolution,
    allowNameMatching,
    runtime: params.runtime,
  });

  return patchAllowlistUsersInConfigEntries({
    entries: nextRooms,
    resolvedMap: resolution.resolvedMap,
    strategy: "canonicalize",
    entryKey: normalizeMatrixUserId,
  });
}

export async function resolveMatrixMonitorConfig(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  roomsConfig?: MatrixRoomsConfig;
  runtime: RuntimeEnv;
  resolveTargets?: ResolveMatrixTargetsFn;
}): Promise<{
  allowFrom: string[];
  allowFromResolvedEntries: MatrixResolvedAllowlistEntry[];
  groupAllowFrom: string[];
  groupAllowFromResolvedEntries: MatrixResolvedAllowlistEntry[];
  roomsConfig?: MatrixRoomsConfig;
}> {
  const resolveTargets = params.resolveTargets ?? resolveMatrixTargets;

  const [allowFrom, groupAllowFrom, roomsConfig] = await Promise.all([
    resolveMatrixMonitorUserAllowlist({
      cfg: params.cfg,
      accountId: params.accountId,
      label: "matrix dm allowlist",
      list: params.allowFrom,
      runtime: params.runtime,
      resolveTargets,
    }),
    resolveMatrixMonitorUserAllowlist({
      cfg: params.cfg,
      accountId: params.accountId,
      label: "matrix group allowlist",
      list: params.groupAllowFrom,
      failClosedOnUnresolved: true,
      runtime: params.runtime,
      resolveTargets,
    }),
    resolveMatrixMonitorRoomsConfig({
      cfg: params.cfg,
      accountId: params.accountId,
      roomsConfig: params.roomsConfig,
      runtime: params.runtime,
      resolveTargets,
    }),
  ]);

  return {
    allowFrom: allowFrom.entries,
    allowFromResolvedEntries: allowFrom.resolvedEntries,
    groupAllowFrom: groupAllowFrom.entries,
    groupAllowFromResolvedEntries: groupAllowFrom.resolvedEntries,
    roomsConfig,
  };
}
