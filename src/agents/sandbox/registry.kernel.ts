import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Insertable, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { SandboxBrowserRegistryEntry, SandboxRegistryEntry } from "./registry.types.js";

export type SandboxRegistryInsert = Insertable<DB["sandbox_registry_entries"]>;
export type SandboxRegistryPrune = { now: number; idleHours: number; maxAgeDays: number };
export type SandboxRegistryCleanupOperations = {
  "sandboxRegistry.finishRemoval": { input: SandboxRegistryEntry; output: void };
};
export type SandboxRegistryOperations = {
  "sandboxRegistry.write": { input: SandboxRegistryWrite; output: void };
  "sandboxRegistry.reserve": { input: SandboxRegistryEntry; output: SandboxRegistryEntry };
  "sandboxRegistry.beginRemoval": {
    input: {
      entry: SandboxRegistryEntry;
      reserveRuntime?: boolean;
      prune?: SandboxRegistryPrune;
    };
    output: SandboxRegistryEntry | null;
  };
};
export type SandboxRegistryWrite =
  | { operation: "update"; entry: SandboxRegistryEntry }
  | { operation: "updateBrowser"; entry: SandboxBrowserRegistryEntry }
  | { operation: "removeBrowser"; containerName: string }
  | {
      operation: "removeGeneration";
      kind: "container" | "browser";
      entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry;
    }
  | { operation: "complete"; entry: SandboxRegistryEntry; retired: boolean }
  | { operation: "remove"; containerName: string; preserveRemovalIntent?: boolean };

type SandboxRegistryRow = Selectable<DB["sandbox_registry_entries"]>;
type SandboxRegistryDatabase = Pick<DB, "sandbox_registry_entries">;

function rowToUpdate(row: SandboxRegistryInsert): Updateable<DB["sandbox_registry_entries"]> {
  const { registry_kind: _registryKind, container_name: _containerName, ...update } = row;
  return update;
}

export function reserveSandboxRegistryInDatabase(
  db: DatabaseSync,
  candidate: SandboxRegistryEntry,
): SandboxRegistryEntry {
  const rows = readRegistryRows(db, "container", {
    backendId: candidate.backendId ?? "docker",
    scopeKey: candidate.sessionKey,
  });
  const existing = rows.map(rowToContainerEntry).find((entry) => entry !== null);
  if (existing) {
    assertSandboxRegistryReservationCurrent(existing, candidate);
    if (!existing.runtimeState || !existing.workspaceDir) {
      existing.runtimeState ??= "pending";
      existing.workspaceDir ??= candidate.workspaceDir;
      insertSandboxRegistryRowInDatabase(db, containerEntryToRow(existing));
    }
    return existing;
  }
  if (readSandboxRegistryRowInDatabase(db, "container", candidate.containerName)) {
    throw new Error(`Sandbox runtime ID "${candidate.containerName}" is already registered.`);
  }
  const entry = { ...candidate, runtimeState: "pending" as const };
  insertSandboxRegistryRowInDatabase(db, containerEntryToRow(entry));
  return entry;
}

export function shouldPruneSandboxRegistryEntry(
  entry: Pick<SandboxRegistryEntry, "lastUsedAtMs" | "createdAtMs">,
  prune: SandboxRegistryPrune,
): boolean {
  const now = asDateTimestampMs(prune.now) ?? 0;
  const lastUsed = asDateTimestampMs(entry.lastUsedAtMs) ?? 0;
  const created = asDateTimestampMs(entry.createdAtMs) ?? 0;
  return (
    (prune.idleHours > 0 && now - lastUsed > prune.idleHours * 60 * 60 * 1000) ||
    (prune.maxAgeDays > 0 && now - created > prune.maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

export function beginSandboxRegistryRemovalInDatabase(
  db: DatabaseSync,
  {
    entry,
    reserveRuntime,
    prune,
  }: SandboxRegistryOperations["sandboxRegistry.beginRemoval"]["input"],
): SandboxRegistryEntry | null {
  const current = readSandboxRegistryEntryInDatabase(db, entry.containerName);
  if (
    !current ||
    current.backendId !== entry.backendId ||
    current.sessionKey !== entry.sessionKey ||
    current.createdAtMs !== entry.createdAtMs ||
    (prune && !shouldPruneSandboxRegistryEntry(current, prune))
  ) {
    return null;
  }
  if (!current.runtimeState && !reserveRuntime) {
    return current;
  }
  const next: SandboxRegistryEntry = {
    ...current,
    runtimeState:
      current.runtimeState === "pending" || current.runtimeState === "removing-pending"
        ? "removing-pending"
        : "removing",
  };
  insertSandboxRegistryRowInDatabase(db, containerEntryToRow(next, current));
  return next;
}

function insertSandboxRegistryRowInDatabase(db: DatabaseSync, row: SandboxRegistryInsert): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SandboxRegistryDatabase>(db)
      .insertInto("sandbox_registry_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["registry_kind", "container_name"]).doUpdateSet(rowToUpdate(row)),
      ),
  );
}

function assertSandboxRegistryReservationCurrent(
  current: SandboxRegistryEntry | null,
  expected: Pick<SandboxRegistryEntry, "backendId" | "sessionKey">,
): asserts current is SandboxRegistryEntry {
  if (
    !current ||
    current.runtimeState === "removing" ||
    current.runtimeState === "removing-pending" ||
    current.backendId !== expected.backendId ||
    current.sessionKey !== expected.sessionKey
  ) {
    throw new Error(
      "Sandbox runtime was removed or is being removed; retry after sandbox recreate completes.",
    );
  }
}

export function assertSandboxRegistryGenerationCurrent(
  current: SandboxRegistryEntry | null,
  expected: SandboxRegistryEntry,
): asserts current is SandboxRegistryEntry {
  assertSandboxRegistryReservationCurrent(current, expected);
  if (
    current.createdAtMs !== expected.createdAtMs ||
    current.workspaceDir !== expected.workspaceDir ||
    current.configHash !== expected.configHash ||
    !isDeepStrictEqual(current.backendTarget, expected.backendTarget)
  ) {
    throw new Error("Sandbox runtime generation changed");
  }
}

function removeRegistryRowInDatabase(
  db: DatabaseSync,
  kind: "container" | "browser",
  containerName: string,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SandboxRegistryDatabase>(db)
      .deleteFrom("sandbox_registry_entries")
      .where("registry_kind", "=", kind)
      .where("container_name", "=", containerName),
  );
}

export function writeSandboxRegistryInDatabase(
  db: DatabaseSync,
  write: SandboxRegistryWrite,
): void {
  if (write.operation === "removeGeneration") {
    const { kind, entry } = write;
    const row = readSandboxRegistryRowInDatabase(db, kind, entry.containerName);
    const current = row && (kind === "browser" ? rowToBrowserEntry(row) : rowToContainerEntry(row));
    if (!current || !sameSandboxRegistryGeneration(current, entry)) {
      throw new Error("Sandbox runtime generation changed during retirement");
    }
    removeRegistryRowInDatabase(db, kind, entry.containerName);
    return;
  }
  if (write.operation === "updateBrowser") {
    const { entry } = write;
    const row = readSandboxRegistryRowInDatabase(db, "browser", entry.containerName);
    insertSandboxRegistryRowInDatabase(
      db,
      browserEntryToRow(entry, row ? rowToBrowserEntry(row) : null),
    );
    return;
  }
  if (write.operation === "removeBrowser") {
    removeRegistryRowInDatabase(db, "browser", write.containerName);
    return;
  }
  if (write.operation === "remove") {
    if (write.preserveRemovalIntent) {
      const row = readSandboxRegistryRowInDatabase(db, "container", write.containerName);
      const current = row ? rowToContainerEntry(row) : null;
      if (current?.runtimeState === "removing" || current?.runtimeState === "removing-pending") {
        return;
      }
    }
    removeRegistryRowInDatabase(db, "container", write.containerName);
    return;
  }
  const { entry } = write;
  const row = readSandboxRegistryRowInDatabase(db, "container", entry.containerName);
  const existing = row ? rowToContainerEntry(row) : null;
  if (write.operation === "update") {
    if (entry.runtimeState === "pending" && existing?.runtimeState !== undefined) {
      assertSandboxRegistryReservationCurrent(existing, entry);
    }
    insertSandboxRegistryRowInDatabase(db, containerEntryToRow(entry, existing));
    return;
  }
  assertSandboxRegistryGenerationCurrent(existing, entry);
  if (write.retired) {
    removeRegistryRowInDatabase(db, "container", entry.containerName);
  } else {
    insertSandboxRegistryRowInDatabase(
      db,
      containerEntryToRow(
        { ...entry, runtimeState: "ready" },
        {
          ...existing,
          image: existing.runtimeState === "pending" ? entry.image : existing.image,
        },
      ),
    );
  }
}

// Activity stamps can advance without changing custody; all allocation facts must match.
function sameSandboxRegistryGeneration(
  current: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
  expected: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): boolean {
  const { lastUsedAtMs: _currentUse, ...currentGeneration } = current;
  const { lastUsedAtMs: _expectedUse, ...expectedGeneration } = expected;
  return isDeepStrictEqual(currentGeneration, expectedGeneration);
}

function containerEntryToRow(entry: SandboxRegistryEntry, existing?: SandboxRegistryEntry | null) {
  const next: SandboxRegistryEntry = {
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    backendTarget: entry.backendTarget ?? existing?.backendTarget,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
    runtimeState: entry.runtimeState ?? existing?.runtimeState,
    workspaceDir: existing?.workspaceDir ?? entry.workspaceDir,
  };
  return registryEntryToRow({ kind: "container", next });
}

function browserEntryToRow(
  entry: SandboxBrowserRegistryEntry,
  existing?: SandboxBrowserRegistryEntry | null,
) {
  const next: SandboxBrowserRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
    workspaceDir: entry.workspaceDir ?? existing?.workspaceDir,
  };
  return registryEntryToRow({ kind: "browser", next });
}

function registryEntryToRow({
  kind,
  next,
}:
  | { kind: "container"; next: SandboxRegistryEntry }
  | { kind: "browser"; next: SandboxBrowserRegistryEntry }) {
  return {
    registry_kind: kind,
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: kind === "container" ? (next.backendId ?? null) : null,
    runtime_label: kind === "container" ? (next.runtimeLabel ?? null) : null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: kind === "container" ? (next.configLabelKind ?? null) : null,
    config_hash: next.configHash ?? null,
    cdp_port: kind === "browser" ? next.cdpPort : null,
    no_vnc_port: kind === "browser" ? (next.noVncPort ?? null) : null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

export function insertSandboxRegistryRowIfMissingInDatabase(
  db: DatabaseSync,
  row: SandboxRegistryInsert,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SandboxRegistryDatabase>(db)
      .insertInto("sandbox_registry_entries")
      .values(row)
      .onConflict((conflict) => conflict.columns(["registry_kind", "container_name"]).doNothing()),
  );
}

function parseRegistryEntryJson(row: SandboxRegistryRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function optionalPayloadString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
  });
}

export function rowToBrowserEntry(row: SandboxRegistryRow): SandboxBrowserRegistryEntry | null {
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
  };
}

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

function readRegistryRows(
  db: DatabaseSync,
  kind: "container" | "browser",
  filter?: { backendId: string; scopeKey: string },
): SandboxRegistryRow[] {
  if (!tableExists(db, "sandbox_registry_entries")) {
    return [];
  }
  let query = getNodeSqliteKysely<SandboxRegistryDatabase>(db)
    .selectFrom("sandbox_registry_entries")
    .selectAll()
    .where("registry_kind", "=", kind);
  if (filter) {
    query = query
      .where("session_key", "=", filter.scopeKey)
      .where("backend_id", "=", filter.backendId);
  }
  return executeSqliteQuerySync(
    db,
    filter
      ? query.orderBy("last_used_at_ms", "desc").orderBy("container_name", "asc")
      : query.orderBy("container_name", "asc"),
  ).rows;
}

export function readSandboxRegistryEntryInDatabase(
  db: DatabaseSync,
  containerName: string,
): SandboxRegistryEntry | null {
  if (!tableExists(db, "sandbox_registry_entries")) {
    return null;
  }
  const row = readSandboxRegistryRowInDatabase(db, "container", containerName);
  return row ? rowToContainerEntry(row) : null;
}

export function readSandboxRegistryRowInDatabase(
  db: DatabaseSync,
  kind: "container" | "browser",
  containerName: string,
): SandboxRegistryRow | null {
  return (
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SandboxRegistryDatabase>(db)
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName)
        .limit(1),
    ).rows[0] ?? null
  );
}

export function readSandboxRegistryInDatabase(db: DatabaseSync): SandboxRegistryEntry[] {
  return readRegistryRows(db, "container")
    .map(rowToContainerEntry)
    .filter((entry): entry is SandboxRegistryEntry => entry !== null);
}

export function readSandboxRuntimeIdsInDatabase(
  db: DatabaseSync,
  filter: { backendId: string; scopeKey: string },
): string[] {
  return readRegistryRows(db, "container", filter)
    .map(rowToContainerEntry)
    .filter((entry): entry is SandboxRegistryEntry => entry !== null)
    .map((entry) => entry.containerName);
}

export function readSandboxBrowserRegistryInDatabase(
  db: DatabaseSync,
): SandboxBrowserRegistryEntry[] {
  return readRegistryRows(db, "browser")
    .map(rowToBrowserEntry)
    .filter((entry): entry is SandboxBrowserRegistryEntry => entry !== null);
}
