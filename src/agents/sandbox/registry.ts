/**
 * Persistent sandbox registry storage.
 *
 * Tracks runtime and browser containers in the shared state DB plus migration support for legacy registries.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Insertable, Selectable, Updateable } from "kysely";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import type { SandboxBackendCleanupMetadata } from "./backend-handle.types.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "./constants.js";
import { hashTextSha256 } from "./hash.js";
import type { SandboxScope } from "./types.js";

export type SandboxRegistryCleanupLocation = {
  workspaceRoot?: string;
  sshTarget?: string;
  sshWorkspaceRoot?: string;
  cleanupMetadata?: SandboxBackendCleanupMetadata;
};

export type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
  scope?: SandboxScope;
  workspaceRoot?: string;
  lifecycleCleanupOnSessionEnd?: boolean;
  lifecycleOwnerSessionId?: string;
  sshTarget?: string;
  sshWorkspaceRoot?: string;
  cleanupMetadata?: SandboxBackendCleanupMetadata;
  supersededCleanupLocations?: SandboxRegistryCleanupLocation[];
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  scope?: SandboxScope;
  workspaceRoot?: string;
  lifecycleCleanupOnSessionEnd?: boolean;
  lifecycleOwnerSessionId?: string;
  supersededCleanupLocations?: SandboxRegistryCleanupLocation[];
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

export type SandboxWorkspaceRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  scope?: SandboxScope;
  workspaceRoot: string;
  supersededWorkspaceRoots?: string[];
  lifecycleCleanupOnSessionEnd?: boolean;
  lifecycleOwnerSessionId?: string;
};

type SandboxWorkspaceRegistry = {
  entries: SandboxWorkspaceRegistryEntry[];
};

type RegistryEntry = {
  containerName: string;
};

type RegistryEntryPayload = RegistryEntry & Record<string, unknown>;

type RegistryFile = {
  entries: RegistryEntryPayload[];
};

type ShardedRegistryRead<T extends RegistryEntry> = {
  entries: T[];
  validFiles: string[];
  invalidFiles: string[];
};

type LegacyRegistryKind = "containers" | "browsers";
type SandboxRegistryKind = "container" | "browser" | "workspace";
type SandboxRegistryTable = OpenClawStateKyselyDatabase["sandbox_registry_entries"];
type SandboxRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">;
type SandboxRegistryRow = Selectable<SandboxRegistryTable>;
type SandboxRegistryInsert = Insertable<SandboxRegistryTable>;
type SandboxRegistryUpdate = Updateable<SandboxRegistryTable>;

type LegacyRegistryTarget = {
  kind: LegacyRegistryKind;
  registryPath: string;
  shardedDir: string;
};

export type LegacySandboxRegistryInspection = LegacyRegistryTarget & {
  exists: boolean;
  valid: boolean;
  entries: number;
  source: "monolithic" | "sharded";
};

export type LegacySandboxRegistryMigrationResult = LegacyRegistryTarget & {
  status: "missing" | "migrated" | "removed-empty" | "quarantined-invalid";
  entries: number;
  source?: "monolithic" | "sharded";
  quarantinePath?: string;
};

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

export function resolveWorkspaceRegistryName(sessionKey: string): string {
  return `workspace:${hashTextSha256(sessionKey.trim() || "main")}`;
}

function getSandboxRegistryKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SandboxRegistryDatabase>(db);
}

function parseRegistryEntryJson(row: SandboxRegistryRow): RegistryEntryPayload | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RegistryEntryPayload)
      : null;
  } catch {
    return null;
  }
}

function optionalPayloadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCleanupLocationValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanupLocationFromEntry(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): SandboxRegistryCleanupLocation {
  if ("cdpPort" in entry) {
    return {
      workspaceRoot: normalizeCleanupLocationValue(entry.workspaceRoot),
    };
  }
  const sshTarget =
    normalizeCleanupLocationValue(entry.sshTarget) ??
    (entry.backendId === "ssh" ? normalizeCleanupLocationValue(entry.image) : undefined);
  return {
    workspaceRoot: normalizeCleanupLocationValue(entry.workspaceRoot),
    sshTarget,
    sshWorkspaceRoot: normalizeCleanupLocationValue(entry.sshWorkspaceRoot),
    cleanupMetadata: entry.cleanupMetadata,
  };
}

function cleanupLocationKey(location: SandboxRegistryCleanupLocation): string {
  return JSON.stringify([
    location.workspaceRoot ?? "",
    location.sshTarget ?? "",
    location.sshWorkspaceRoot ?? "",
    location.cleanupMetadata ?? null,
  ]);
}

function hasCleanupLocation(location: SandboxRegistryCleanupLocation): boolean {
  return cleanupLocationKey(location) !== JSON.stringify(["", "", "", null]);
}

function mergeCleanupLocations(
  ...locations: ReadonlyArray<SandboxRegistryCleanupLocation | undefined>
): SandboxRegistryCleanupLocation[] | undefined {
  const merged = new Map<string, SandboxRegistryCleanupLocation>();
  for (const location of locations) {
    if (!location || !hasCleanupLocation(location)) {
      continue;
    }
    merged.set(cleanupLocationKey(location), location);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function cleanupLocationChanged(
  before: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
  after: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): boolean {
  return (
    cleanupLocationKey(cleanupLocationFromEntry(before)) !==
    cleanupLocationKey(cleanupLocationFromEntry(after))
  );
}

function mergeSupersededCleanupLocations<
  T extends SandboxRegistryEntry | SandboxBrowserRegistryEntry,
>(
  entry: T,
  existing?: T | null,
  lifecycleCleanupOnSessionEnd?: boolean,
): SandboxRegistryCleanupLocation[] | undefined {
  return mergeCleanupLocations(
    ...(existing?.supersededCleanupLocations ?? []),
    ...(entry.supersededCleanupLocations ?? []),
    existing && lifecycleCleanupOnSessionEnd === true && cleanupLocationChanged(existing, entry)
      ? cleanupLocationFromEntry(existing)
      : undefined,
  );
}

function mergeSupersededWorkspaceRoots(
  currentWorkspaceRoot: string,
  ...roots: ReadonlyArray<string | undefined | readonly string[]>
): string[] | undefined {
  const normalizedCurrent = normalizeCleanupLocationValue(currentWorkspaceRoot);
  const merged = new Set<string>();
  for (const value of roots) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const normalized = normalizeCleanupLocationValue(candidate);
      if (normalized && normalized !== normalizedCurrent) {
        merged.add(normalized);
      }
    }
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

export function getSandboxRegistryCleanupLocations(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): SandboxRegistryCleanupLocation[] {
  return (
    mergeCleanupLocations(
      cleanupLocationFromEntry(entry),
      ...(entry.supersededCleanupLocations ?? []),
    ) ?? [cleanupLocationFromEntry(entry)]
  );
}

export function applySandboxRegistryCleanupLocation(
  entry: SandboxRegistryEntry,
  location: SandboxRegistryCleanupLocation,
): SandboxRegistryEntry {
  return {
    ...entry,
    workspaceRoot: location.workspaceRoot ?? entry.workspaceRoot,
    sshTarget: location.sshTarget ?? entry.sshTarget,
    sshWorkspaceRoot: location.sshWorkspaceRoot ?? entry.sshWorkspaceRoot,
    cleanupMetadata:
      "cleanupMetadata" in location ? location.cleanupMetadata : entry.cleanupMetadata,
  };
}

export function getSandboxWorkspaceRegistryRoots(entry: SandboxWorkspaceRegistryEntry): string[] {
  const roots = new Set<string>();
  for (const root of [entry.workspaceRoot, ...(entry.supersededWorkspaceRoots ?? [])]) {
    const normalized = normalizeCleanupLocationValue(root);
    if (normalized) {
      roots.add(normalized);
    }
  }
  return [...roots];
}

function rowToContainerEntry(row: SandboxRegistryRow): SandboxRegistryEntry | null {
  if (row.registry_kind !== "container") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return normalizeSandboxRegistryEntry({
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    ...(row.backend_id != null ? { backendId: row.backend_id } : {}),
    ...(row.runtime_label != null ? { runtimeLabel: row.runtime_label } : {}),
    ...(row.config_label_kind != null ? { configLabelKind: row.config_label_kind } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  } as SandboxRegistryEntry);
}

function rowToBrowserEntry(row: SandboxRegistryRow): SandboxBrowserRegistryEntry | null {
  if (row.registry_kind !== "browser") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return {
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    cdpPort: row.cdp_port ?? Number(payload.cdpPort ?? 0),
    ...(row.no_vnc_port != null ? { noVncPort: row.no_vnc_port } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  } as SandboxBrowserRegistryEntry;
}

function rowToWorkspaceEntry(row: SandboxRegistryRow): SandboxWorkspaceRegistryEntry | null {
  if (row.registry_kind !== "workspace") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  const workspaceRoot = optionalPayloadString(payload.workspaceRoot).trim();
  if (!workspaceRoot) {
    return null;
  }
  return {
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    workspaceRoot,
  } as SandboxWorkspaceRegistryEntry;
}

function containerEntryToRow(entry: SandboxRegistryEntry, existing?: SandboxRegistryEntry | null) {
  const lifecycleCleanupOnSessionEnd =
    entry.lifecycleCleanupOnSessionEnd === true || existing?.lifecycleCleanupOnSessionEnd === true
      ? true
      : (entry.lifecycleCleanupOnSessionEnd ?? existing?.lifecycleCleanupOnSessionEnd);
  const next: SandboxRegistryEntry = {
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
    scope: entry.scope ?? existing?.scope,
    workspaceRoot: entry.workspaceRoot ?? existing?.workspaceRoot,
    lifecycleCleanupOnSessionEnd,
    lifecycleOwnerSessionId: entry.lifecycleOwnerSessionId ?? existing?.lifecycleOwnerSessionId,
    sshTarget: entry.sshTarget ?? existing?.sshTarget,
    sshWorkspaceRoot: entry.sshWorkspaceRoot ?? existing?.sshWorkspaceRoot,
    cleanupMetadata: "cleanupMetadata" in entry ? entry.cleanupMetadata : existing?.cleanupMetadata,
    supersededCleanupLocations: mergeSupersededCleanupLocations(
      entry,
      existing,
      lifecycleCleanupOnSessionEnd,
    ),
  };
  return {
    registry_kind: "container",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: next.backendId ?? null,
    runtime_label: next.runtimeLabel ?? null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: next.configLabelKind ?? null,
    config_hash: next.configHash ?? null,
    cdp_port: null,
    no_vnc_port: null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

function workspaceEntryToRow(
  entry: SandboxWorkspaceRegistryEntry,
  existing?: SandboxWorkspaceRegistryEntry | null,
) {
  const lifecycleCleanupOnSessionEnd =
    entry.lifecycleCleanupOnSessionEnd === true || existing?.lifecycleCleanupOnSessionEnd === true
      ? true
      : (entry.lifecycleCleanupOnSessionEnd ?? existing?.lifecycleCleanupOnSessionEnd);
  const workspaceRoot = entry.workspaceRoot || existing?.workspaceRoot || entry.workspaceRoot;
  const supersededWorkspaceRoots = mergeSupersededWorkspaceRoots(
    workspaceRoot,
    existing?.supersededWorkspaceRoots,
    entry.supersededWorkspaceRoots,
    existing &&
      lifecycleCleanupOnSessionEnd === true &&
      normalizeCleanupLocationValue(existing.workspaceRoot) !==
        normalizeCleanupLocationValue(workspaceRoot)
      ? existing.workspaceRoot
      : undefined,
  );
  const next: SandboxWorkspaceRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    scope: entry.scope ?? existing?.scope,
    workspaceRoot,
    supersededWorkspaceRoots,
    lifecycleCleanupOnSessionEnd,
    lifecycleOwnerSessionId: entry.lifecycleOwnerSessionId ?? existing?.lifecycleOwnerSessionId,
  };
  return {
    registry_kind: "workspace",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: null,
    runtime_label: null,
    image: null,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: null,
    config_hash: null,
    cdp_port: null,
    no_vnc_port: null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

function browserEntryToRow(
  entry: SandboxBrowserRegistryEntry,
  existing?: SandboxBrowserRegistryEntry | null,
) {
  const lifecycleCleanupOnSessionEnd =
    entry.lifecycleCleanupOnSessionEnd === true || existing?.lifecycleCleanupOnSessionEnd === true
      ? true
      : (entry.lifecycleCleanupOnSessionEnd ?? existing?.lifecycleCleanupOnSessionEnd);
  const next: SandboxBrowserRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
    scope: entry.scope ?? existing?.scope,
    workspaceRoot: entry.workspaceRoot ?? existing?.workspaceRoot,
    lifecycleCleanupOnSessionEnd,
    lifecycleOwnerSessionId: entry.lifecycleOwnerSessionId ?? existing?.lifecycleOwnerSessionId,
    supersededCleanupLocations: mergeSupersededCleanupLocations(
      entry,
      existing,
      lifecycleCleanupOnSessionEnd,
    ),
  };
  return {
    registry_kind: "browser",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: null,
    runtime_label: null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: null,
    config_hash: next.configHash ?? null,
    cdp_port: next.cdpPort,
    no_vnc_port: next.noVncPort ?? null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

function sandboxRegistryEntryMatchesSnapshot(
  current: SandboxRegistryEntry,
  expected: SandboxRegistryEntry,
): boolean {
  return (
    current.containerName === expected.containerName &&
    current.sessionKey === expected.sessionKey &&
    current.createdAtMs === expected.createdAtMs &&
    current.lastUsedAtMs === expected.lastUsedAtMs &&
    current.image === expected.image &&
    current.configHash === expected.configHash &&
    current.lifecycleCleanupOnSessionEnd === expected.lifecycleCleanupOnSessionEnd &&
    current.lifecycleOwnerSessionId === expected.lifecycleOwnerSessionId &&
    current.sshTarget === expected.sshTarget &&
    current.sshWorkspaceRoot === expected.sshWorkspaceRoot &&
    JSON.stringify(current.cleanupMetadata ?? null) ===
      JSON.stringify(expected.cleanupMetadata ?? null) &&
    JSON.stringify(current.supersededCleanupLocations ?? []) ===
      JSON.stringify(expected.supersededCleanupLocations ?? [])
  );
}

function sandboxBrowserRegistryEntryMatchesSnapshot(
  current: SandboxBrowserRegistryEntry,
  expected: SandboxBrowserRegistryEntry,
): boolean {
  return (
    current.containerName === expected.containerName &&
    current.sessionKey === expected.sessionKey &&
    current.createdAtMs === expected.createdAtMs &&
    current.lastUsedAtMs === expected.lastUsedAtMs &&
    current.image === expected.image &&
    current.configHash === expected.configHash &&
    current.lifecycleCleanupOnSessionEnd === expected.lifecycleCleanupOnSessionEnd &&
    current.lifecycleOwnerSessionId === expected.lifecycleOwnerSessionId &&
    JSON.stringify(current.supersededCleanupLocations ?? []) ===
      JSON.stringify(expected.supersededCleanupLocations ?? []) &&
    current.cdpPort === expected.cdpPort &&
    current.noVncPort === expected.noVncPort
  );
}

function sandboxWorkspaceRegistryEntryMatchesSnapshot(
  current: SandboxWorkspaceRegistryEntry,
  expected: SandboxWorkspaceRegistryEntry,
): boolean {
  return (
    current.containerName === expected.containerName &&
    current.sessionKey === expected.sessionKey &&
    current.createdAtMs === expected.createdAtMs &&
    current.lastUsedAtMs === expected.lastUsedAtMs &&
    current.scope === expected.scope &&
    current.workspaceRoot === expected.workspaceRoot &&
    JSON.stringify(current.supersededWorkspaceRoots ?? []) ===
      JSON.stringify(expected.supersededWorkspaceRoots ?? []) &&
    current.lifecycleCleanupOnSessionEnd === expected.lifecycleCleanupOnSessionEnd &&
    current.lifecycleOwnerSessionId === expected.lifecycleOwnerSessionId
  );
}

function rowToUpdate(row: SandboxRegistryInsert): SandboxRegistryUpdate {
  const { registry_kind: _registryKind, container_name: _containerName, ...update } = row;
  return update;
}

function readRegistryRows(kind: SandboxRegistryKind): SandboxRegistryRow[] {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getSandboxRegistryKysely(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("sandbox_registry_entries")
      .selectAll()
      .where("registry_kind", "=", kind)
      .orderBy("container_name", "asc"),
  ).rows;
}

function readRegistryRowsBySessionKeyFromDb(
  db: import("node:sqlite").DatabaseSync,
  kind: SandboxRegistryKind,
  sessionKey: string,
): SandboxRegistryRow[] {
  const stateDb = getSandboxRegistryKysely(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("sandbox_registry_entries")
      .selectAll()
      .where("registry_kind", "=", kind)
      .where("session_key", "=", sessionKey)
      .orderBy("container_name", "asc"),
  ).rows;
}

function readRegistryRow(
  kind: SandboxRegistryKind,
  containerName: string,
): SandboxRegistryRow | null {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getSandboxRegistryKysely(db);
  return (
    executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName)
        .limit(1),
    ).rows[0] ?? null
  );
}

function insertRegistryRowIfMissing(row: SandboxRegistryInsert): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("sandbox_registry_entries")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["registry_kind", "container_name"]).doNothing(),
        ),
    );
  });
}

function insertRegistryRow(
  db: import("node:sqlite").DatabaseSync,
  row: SandboxRegistryInsert,
): void {
  const stateDb = getSandboxRegistryKysely(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("sandbox_registry_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["registry_kind", "container_name"]).doUpdateSet(rowToUpdate(row)),
      ),
  );
}

function touchContainerRegistryRowsForSessionKey(
  db: import("node:sqlite").DatabaseSync,
  sessionKey: string,
  lastUsedAtMs: number,
): void {
  for (const row of readRegistryRowsBySessionKeyFromDb(db, "container", sessionKey)) {
    const entry = rowToContainerEntry(row);
    if (!entry) {
      continue;
    }
    insertRegistryRow(
      db,
      containerEntryToRow(
        {
          ...entry,
          lastUsedAtMs: Math.max(entry.lastUsedAtMs, lastUsedAtMs),
        },
        entry,
      ),
    );
  }
}

function touchBrowserRegistryRowsForSessionKey(
  db: import("node:sqlite").DatabaseSync,
  sessionKey: string,
  lastUsedAtMs: number,
): void {
  for (const row of readRegistryRowsBySessionKeyFromDb(db, "browser", sessionKey)) {
    const entry = rowToBrowserEntry(row);
    if (!entry) {
      continue;
    }
    insertRegistryRow(
      db,
      browserEntryToRow(
        {
          ...entry,
          lastUsedAtMs: Math.max(entry.lastUsedAtMs, lastUsedAtMs),
        },
        entry,
      ),
    );
  }
}

function touchWorkspaceRegistryRowsForSessionKey(
  db: import("node:sqlite").DatabaseSync,
  sessionKey: string,
  lastUsedAtMs: number,
): void {
  for (const row of readRegistryRowsBySessionKeyFromDb(db, "workspace", sessionKey)) {
    const entry = rowToWorkspaceEntry(row);
    if (!entry) {
      continue;
    }
    insertRegistryRow(
      db,
      workspaceEntryToRow(
        {
          ...entry,
          lastUsedAtMs: Math.max(entry.lastUsedAtMs, lastUsedAtMs),
        },
        entry,
      ),
    );
  }
}

function readRegistryRowFromDb(
  db: import("node:sqlite").DatabaseSync,
  kind: SandboxRegistryKind,
  containerName: string,
): SandboxRegistryRow | null {
  const stateDb = getSandboxRegistryKysely(db);
  return (
    executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName)
        .limit(1),
    ).rows[0] ?? null
  );
}

function removeRegistryRow(kind: SandboxRegistryKind, containerName: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName),
    );
  });
}

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: registryPath,
    allowReentrant: false,
    timeoutMs: 60_000,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function readLegacyRegistryFile(registryPath: string): Promise<RegistryFile | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw) as RegistryFile | null;
    return parsed;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
}

/** Reads all registered sandbox runtime containers from SQLite. */
export async function readRegistry(): Promise<SandboxRegistry> {
  const entries = readRegistryRows("container")
    .map((row) => rowToContainerEntry(row))
    .filter((entry): entry is SandboxRegistryEntry => entry != null);
  return {
    entries: entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
  };
}

/** Reads workspace ownership rows for sandbox scopes without runtime containers yet. */
export async function readWorkspaceRegistry(): Promise<SandboxWorkspaceRegistry> {
  return {
    entries: readRegistryRows("workspace")
      .map((row) => rowToWorkspaceEntry(row))
      .filter((entry): entry is SandboxWorkspaceRegistryEntry => entry != null),
  };
}

async function readShardedEntriesDetailed<T extends RegistryEntry>(
  dir: string,
): Promise<ShardedRegistryRead<T>> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [], validFiles: [], invalidFiles: [] };
    }
    throw error;
  }

  const invalidFiles: string[] = [];
  const validFiles: string[] = [];
  const entries = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          const entry = safeParseJsonWithSchema(RegistryEntrySchema, raw) as T | null;
          if (!entry) {
            invalidFiles.push(filePath);
          } else {
            validFiles.push(filePath);
          }
          return entry;
        } catch {
          invalidFiles.push(filePath);
          return null;
        }
      }),
  );
  const validEntries: T[] = [];
  for (const entry of entries) {
    if (entry) {
      validEntries.push(entry);
    }
  }
  return {
    entries: validEntries.toSorted((left, right) =>
      left.containerName.localeCompare(right.containerName),
    ),
    validFiles: validFiles.toSorted(),
    invalidFiles: invalidFiles.toSorted(),
  };
}

async function quarantineLegacyRegistry(registryPath: string): Promise<string> {
  const quarantinePath = `${registryPath}.invalid-${Date.now()}`;
  await fs.rename(registryPath, quarantinePath).catch(async (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      await fs.rm(registryPath, { force: true });
    }
  });
  return quarantinePath;
}

async function quarantineInvalidShards(
  dir: string,
  invalidFiles: readonly string[],
): Promise<string> {
  const quarantineDir = `${dir}.invalid-${Date.now()}`;
  await fs.mkdir(quarantineDir, { recursive: true });
  for (const invalidFile of invalidFiles) {
    await fs
      .rename(invalidFile, path.join(quarantineDir, path.basename(invalidFile)))
      .catch(async (error: unknown) => {
        const code = (error as { code?: string } | null)?.code;
        if (code !== "ENOENT") {
          throw error;
        }
      });
  }
  return quarantineDir;
}

async function removeFiles(files: readonly string[]): Promise<void> {
  await Promise.all(files.map((file) => fs.rm(file, { force: true })));
}

async function migrateMonolithicIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  const { registryPath } = target;
  try {
    await fs.access(registryPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { ...target, source: "monolithic", status: "missing", entries: 0 };
    }
    throw error;
  }

  return await withRegistryLock(registryPath, async () => {
    const registry = await readLegacyRegistryFile(registryPath);
    if (!registry) {
      const quarantinePath = await quarantineLegacyRegistry(registryPath);
      return {
        ...target,
        source: "monolithic",
        status: "quarantined-invalid",
        entries: 0,
        quarantinePath,
      };
    }
    if (registry.entries.length === 0) {
      await fs.rm(registryPath, { force: true });
      return { ...target, source: "monolithic", status: "removed-empty", entries: 0 };
    }
    for (const entry of registry.entries) {
      writeLegacyEntryIfMissing(target.kind, entry);
    }
    await fs.rm(registryPath, { force: true });
    return {
      ...target,
      source: "monolithic",
      status: "migrated",
      entries: registry.entries.length,
    };
  });
}

function writeLegacyEntryIfMissing(kind: LegacyRegistryKind, entry: RegistryEntryPayload): boolean {
  if (kind === "containers") {
    insertRegistryRowIfMissing(
      containerEntryToRow({
        ...entry,
        containerName: entry.containerName,
        sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : "",
        createdAtMs: typeof entry.createdAtMs === "number" ? entry.createdAtMs : 0,
        lastUsedAtMs: typeof entry.lastUsedAtMs === "number" ? entry.lastUsedAtMs : 0,
        image: typeof entry.image === "string" ? entry.image : "",
      }),
    );
    return true;
  }
  insertRegistryRowIfMissing(
    browserEntryToRow({
      ...entry,
      containerName: entry.containerName,
      sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : "",
      createdAtMs: typeof entry.createdAtMs === "number" ? entry.createdAtMs : 0,
      lastUsedAtMs: typeof entry.lastUsedAtMs === "number" ? entry.lastUsedAtMs : 0,
      image: typeof entry.image === "string" ? entry.image : "",
      cdpPort: typeof entry.cdpPort === "number" ? entry.cdpPort : 0,
    }),
  );
  return true;
}

async function migrateShardedIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  let dirExists = false;
  try {
    const stat = await fs.stat(target.shardedDir);
    dirExists = stat.isDirectory();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  if (!dirExists) {
    return { ...target, source: "sharded", status: "missing", entries: 0 };
  }
  const { entries, validFiles, invalidFiles } =
    await readShardedEntriesDetailed<RegistryEntryPayload>(target.shardedDir);
  if (invalidFiles.length > 0) {
    for (const entry of entries) {
      writeLegacyEntryIfMissing(target.kind, entry);
    }
    await removeFiles(validFiles);
    const quarantinePath = await quarantineInvalidShards(target.shardedDir, invalidFiles);
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return {
      ...target,
      source: "sharded",
      status: "quarantined-invalid",
      entries: entries.length,
      quarantinePath,
    };
  }
  if (entries.length === 0) {
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return { ...target, source: "sharded", status: "removed-empty", entries: 0 };
  }
  for (const entry of entries) {
    writeLegacyEntryIfMissing(target.kind, entry);
  }
  await fs.rm(target.shardedDir, { recursive: true, force: true });
  return { ...target, source: "sharded", status: "migrated", entries: entries.length };
}

function combineMigrationResults(
  target: LegacyRegistryTarget,
  monolithic: LegacySandboxRegistryMigrationResult,
  sharded: LegacySandboxRegistryMigrationResult,
): LegacySandboxRegistryMigrationResult {
  if (monolithic.status === "quarantined-invalid") {
    return monolithic;
  }
  if (sharded.status === "quarantined-invalid") {
    return sharded;
  }
  const entries = monolithic.entries + sharded.entries;
  if (entries > 0) {
    return { ...target, status: "migrated", entries };
  }
  if (monolithic.status === "removed-empty" || sharded.status === "removed-empty") {
    return { ...target, status: "removed-empty", entries: 0 };
  }
  return { ...target, status: "missing", entries: 0 };
}

function legacyRegistryTargets(): LegacyRegistryTarget[] {
  return [
    {
      kind: "containers",
      registryPath: SANDBOX_REGISTRY_PATH,
      shardedDir: SANDBOX_CONTAINERS_DIR,
    },
    {
      kind: "browsers",
      registryPath: SANDBOX_BROWSER_REGISTRY_PATH,
      shardedDir: SANDBOX_BROWSERS_DIR,
    },
  ];
}

/** Inspects old registry files without mutating them. */
export async function inspectLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryInspection[]
> {
  const inspections: LegacySandboxRegistryInspection[] = [];
  for (const target of legacyRegistryTargets()) {
    try {
      await fs.access(target.registryPath);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        inspections.push({
          ...target,
          source: "monolithic",
          exists: false,
          valid: true,
          entries: 0,
        });
      } else {
        throw error;
      }
    }

    if (!inspections.some((entry) => entry.kind === target.kind && entry.source === "monolithic")) {
      const registry = await readLegacyRegistryFile(target.registryPath);
      inspections.push({
        ...target,
        source: "monolithic",
        exists: true,
        valid: Boolean(registry),
        entries: registry?.entries.length ?? 0,
      });
    }

    const sharded = await readShardedEntriesDetailed<RegistryEntryPayload>(target.shardedDir);
    let shardedExists = false;
    try {
      shardedExists = (await fs.stat(target.shardedDir)).isDirectory();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    inspections.push({
      ...target,
      source: "sharded",
      exists: shardedExists,
      valid: sharded.invalidFiles.length === 0,
      entries: sharded.entries.length,
    });
  }
  return inspections;
}

/** Migrates old registry files into SQLite when present. */
export async function migrateLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryMigrationResult[]
> {
  const results: LegacySandboxRegistryMigrationResult[] = [];
  for (const target of legacyRegistryTargets()) {
    const sharded = await migrateShardedIfNeeded(target);
    const monolithic = await migrateMonolithicIfNeeded(target);
    results.push(combineMigrationResults(target, monolithic, sharded));
  }
  return results;
}

/** Reads one registered sandbox runtime container by container name. */
export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  const row = readRegistryRow("container", containerName);
  const entry = row ? rowToContainerEntry(row) : null;
  return entry ? normalizeSandboxRegistryEntry(entry) : null;
}

/** Creates or updates one sandbox runtime registry entry, preserving immutable creation fields. */
export async function updateRegistry(entry: SandboxRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readRegistryRowFromDb(db, "container", entry.containerName);
    const existing = existingRow ? rowToContainerEntry(existingRow) : null;
    insertRegistryRow(db, containerEntryToRow(entry, existing));
  });
}

/** Creates or updates one sandbox workspace ownership row before runtime creation. */
export async function updateWorkspaceRegistry(entry: SandboxWorkspaceRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readRegistryRowFromDb(db, "workspace", entry.containerName);
    const existing = existingRow ? rowToWorkspaceEntry(existingRow) : null;
    insertRegistryRow(db, workspaceEntryToRow(entry, existing));
  });
}

/** Refreshes ordinary and browser runtime rows for a scope before workspace reuse. */
export async function touchRegistryEntriesForSessionKey(
  sessionKey: string,
  lastUsedAtMs = Date.now(),
): Promise<void> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    touchWorkspaceRegistryRowsForSessionKey(db, normalizedSessionKey, lastUsedAtMs);
    touchContainerRegistryRowsForSessionKey(db, normalizedSessionKey, lastUsedAtMs);
    touchBrowserRegistryRowsForSessionKey(db, normalizedSessionKey, lastUsedAtMs);
  });
}

/** Removes one sandbox runtime registry entry by container name. */
export async function removeRegistryEntry(containerName: string) {
  removeRegistryRow("container", containerName);
}

/** Removes one sandbox runtime registry entry only if it still matches the stale snapshot. */
export async function removeRegistryEntryIfUnchanged(
  expected: SandboxRegistryEntry,
): Promise<boolean> {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const row = readRegistryRowFromDb(db, "container", expected.containerName);
    const current = row ? rowToContainerEntry(row) : null;
    if (!current || !sandboxRegistryEntryMatchesSnapshot(current, expected)) {
      return;
    }
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", "container")
        .where("container_name", "=", expected.containerName),
    );
    removed = true;
  });
  return removed;
}

/** Reads all registered browser sandbox containers from SQLite. */
export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return {
    entries: readRegistryRows("browser")
      .map((row) => rowToBrowserEntry(row))
      .filter((entry): entry is SandboxBrowserRegistryEntry => entry != null),
  };
}

/** Creates or updates one browser sandbox registry entry, preserving immutable creation fields. */
export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readRegistryRowFromDb(db, "browser", entry.containerName);
    const existing = existingRow ? rowToBrowserEntry(existingRow) : null;
    insertRegistryRow(db, browserEntryToRow(entry, existing));
  });
}

/** Removes one browser sandbox registry entry by container name. */
export async function removeBrowserRegistryEntry(containerName: string) {
  removeRegistryRow("browser", containerName);
}

/** Removes one browser runtime registry entry only if it still matches the stale snapshot. */
export async function removeBrowserRegistryEntryIfUnchanged(
  expected: SandboxBrowserRegistryEntry,
): Promise<boolean> {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const row = readRegistryRowFromDb(db, "browser", expected.containerName);
    const current = row ? rowToBrowserEntry(row) : null;
    if (!current || !sandboxBrowserRegistryEntryMatchesSnapshot(current, expected)) {
      return;
    }
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", "browser")
        .where("container_name", "=", expected.containerName),
    );
    removed = true;
  });
  return removed;
}

/** Removes one workspace ownership row only if it still matches the stale snapshot. */
export async function removeWorkspaceRegistryEntryIfUnchanged(
  expected: SandboxWorkspaceRegistryEntry,
): Promise<boolean> {
  let removed = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const row = readRegistryRowFromDb(db, "workspace", expected.containerName);
    const current = row ? rowToWorkspaceEntry(row) : null;
    if (!current || !sandboxWorkspaceRegistryEntryMatchesSnapshot(current, expected)) {
      return;
    }
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", "workspace")
        .where("container_name", "=", expected.containerName),
    );
    removed = true;
  });
  return removed;
}
