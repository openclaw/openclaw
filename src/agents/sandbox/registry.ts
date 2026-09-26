/**
 * Persistent sandbox registry storage.
 *
 * Tracks runtime and browser containers in the shared state DB.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "../../infra/file-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  assertSandboxRegistryReservationCurrent,
  browserEntryToRow,
  containerEntryToRow,
  insertSandboxRegistryRowInDatabase,
  type SandboxRegistryWrite,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryRowInDatabase,
  rowToBrowserEntry,
  rowToContainerEntry,
} from "./registry.kernel.js";
import type {
  SandboxBrowserRegistry,
  SandboxBrowserRegistryEntry,
  SandboxRegistry,
  SandboxRegistryEntry,
} from "./registry.types.js";

export type { SandboxRegistryEntry, SandboxBrowserRegistryEntry } from "./registry.types.js";

type SandboxRegistryKind = "container" | "browser";
type SandboxRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">;

function getSandboxRegistryKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SandboxRegistryDatabase>(db);
}

async function writeRegistry(write: SandboxRegistryWrite): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const input = structuredClone(write);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  const { runOpenClawStateWorkerOperation } =
    await import("../../state/openclaw-state-worker-store.js");
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "sandboxRegistry.write", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
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

/** Reads all registered sandbox runtime containers from SQLite. */
export async function readRegistry(): Promise<SandboxRegistry> {
  const reply = await executeExistingOpenClawStateRead({}, { type: "sandboxRegistry.list" });
  if (!reply) {
    return { entries: [] };
  }
  if (!reply.ok || reply.type !== "sandboxRegistry.list") {
    throw new Error("Unexpected sandbox registry list result");
  }
  return { entries: reply.entries };
}

/** Reads one registered sandbox runtime container by container name. */
export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "sandboxRegistry.get", containerName },
  );
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== "sandboxRegistry.get") {
    throw new Error("Unexpected sandbox registry lookup result");
  }
  return reply.entry;
}

/** Reads registered runtime IDs for one backend-owned sandbox scope, newest first. */
export async function readRegisteredSandboxRuntimeIds(params: {
  backendId: string;
  scopeKey: string;
}): Promise<string[]> {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "sandboxRegistry.runtimeIds", ...params },
  );
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "sandboxRegistry.runtimeIds") {
    throw new Error("Unexpected sandbox runtime ID result");
  }
  return reply.runtimeIds;
}

/** Creates or updates one sandbox runtime registry entry, preserving immutable creation fields. */
export async function updateRegistry(entry: SandboxRegistryEntry) {
  await writeRegistry({ operation: "update", entry });
}

/** Removes one sandbox runtime registry entry by container name. */
export async function removeRegistryEntry(
  containerName: string,
  options: { preserveRemovalIntent?: boolean } = {},
) {
  await writeRegistry({
    operation: "remove",
    containerName,
    preserveRemovalIntent: options.preserveRemovalIntent,
  });
}

/** Atomically select one generation for a backend/scope before provider allocation. */
export function reserveSandboxRegistryEntry(candidate: SandboxRegistryEntry): SandboxRegistryEntry {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getSandboxRegistryKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", "container")
        .where("backend_id", "=", candidate.backendId ?? "docker")
        .where("session_key", "=", candidate.sessionKey)
        .orderBy("last_used_at_ms", "desc")
        .orderBy("container_name", "asc"),
    ).rows;
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
  });
}

/** Validate the exact generation; retained handles cannot outlive removal intent. */
export function assertSandboxRegistryEntryCurrent(entry: SandboxRegistryEntry): void {
  const current =
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      readSandboxRegistryEntryInDatabase(db, entry.containerName),
    ) ?? null;
  assertSandboxRegistryReservationCurrent(current, entry);
  if (
    current.createdAtMs !== entry.createdAtMs ||
    current.workspaceDir !== entry.workspaceDir ||
    current.configHash !== entry.configHash ||
    !isDeepStrictEqual(current.backendTarget, entry.backendTarget)
  ) {
    throw new Error("Sandbox runtime generation changed");
  }
}

/** Publish only a still-current reservation, or forget a provider-confirmed terminal generation. */
export async function completeSandboxRegistryReservation(
  entry: SandboxRegistryEntry,
  retired = false,
): Promise<void> {
  await writeRegistry({ operation: "complete", entry, retired });
}

/** Serialize provider operations across Gateway/CLI; only dead owners permit lock recovery. */
export async function withSandboxRegistryEntryLock<T>(
  entry: SandboxRegistryEntry,
  operation: () => Promise<T>,
): Promise<T> {
  const key = createHash("sha256").update(entry.containerName).digest("hex");
  return await withFileLock(
    `${resolveOpenClawStateSqlitePath()}.sandbox-${key}`,
    {
      // Cover provider warmup (10 minutes), inspection, and cleanup contention.
      retries: { retries: 9000, factor: 1, minTimeout: 100, maxTimeout: 100 },
      stale: 0,
      staleRecovery: "remove-if-definitely-stale",
    },
    operation,
  );
}

/** Persist removal intent before waiting for provisioning, and retain failed cleanup for retry. */
export async function removeSandboxRegistryRuntime(
  entry: SandboxRegistryEntry,
  removeRuntime: (entry: SandboxRegistryEntry) => Promise<void>,
  options: {
    reserveRuntime?: boolean;
    shouldRemove?: (current: SandboxRegistryEntry) => boolean;
  } = {},
): Promise<void> {
  const selected = runOpenClawStateWriteTransaction(({ db }) => {
    const row = readSandboxRegistryRowInDatabase(db, "container", entry.containerName);
    const current = row ? rowToContainerEntry(row) : null;
    if (
      !current ||
      current.backendId !== entry.backendId ||
      current.sessionKey !== entry.sessionKey ||
      (options.shouldRemove && !options.shouldRemove(current))
    ) {
      return null;
    }
    if (!current.runtimeState && !options.reserveRuntime) {
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
  });
  if (!selected) {
    return;
  }
  if (!selected.runtimeState) {
    await removeRuntime(selected);
    await removeRegistryEntry(selected.containerName);
    return;
  }
  const removing = selected;
  await withSandboxRegistryEntryLock(removing, async () => {
    const current = await readRegistryEntry(removing.containerName);
    if (
      !current ||
      (current.runtimeState !== "removing" && current.runtimeState !== "removing-pending") ||
      current.backendId !== removing.backendId ||
      current.sessionKey !== removing.sessionKey ||
      (options.shouldRemove && !options.shouldRemove(current))
    ) {
      return;
    }
    await removeRuntime(current);
    await removeRegistryEntry(current.containerName);
  });
}

/** Reads all registered browser sandbox containers from SQLite. */
export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  const reply = await executeExistingOpenClawStateRead({}, { type: "sandboxRegistry.browsers" });
  if (!reply) {
    return { entries: [] };
  }
  if (!reply.ok || reply.type !== "sandboxRegistry.browsers") {
    throw new Error("Unexpected sandbox browser registry result");
  }
  return { entries: reply.entries };
}

/** Validate the exact browser workspace owner before local reconciliation effects. */
export function assertSandboxBrowserRegistryEntryCurrent(entry: SandboxBrowserRegistryEntry): void {
  const current = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "sandbox_registry_entries")) {
      return null;
    }
    const row = readSandboxRegistryRowInDatabase(db, "browser", entry.containerName);
    return row ? rowToBrowserEntry(row) : null;
  });
  if (
    !current ||
    current.sessionKey !== entry.sessionKey ||
    current.createdAtMs !== entry.createdAtMs ||
    current.workspaceDir !== entry.workspaceDir ||
    current.configHash !== entry.configHash
  ) {
    throw new Error("Sandbox browser workspace owner changed");
  }
}

/** Creates or updates one browser sandbox registry entry, preserving immutable creation fields. */
export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readSandboxRegistryRowInDatabase(db, "browser", entry.containerName);
    const existing = existingRow ? rowToBrowserEntry(existingRow) : null;
    insertSandboxRegistryRowInDatabase(db, browserEntryToRow(entry, existing));
  });
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

/** Forget only the inspected allocation, under the caller's still-live settlement lease. */
export function removeSandboxRegistryGeneration(
  kind: SandboxRegistryKind,
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
  assertCurrent: () => void,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    assertCurrent();
    const row = readSandboxRegistryRowInDatabase(db, kind, entry.containerName);
    const current = row && (kind === "browser" ? rowToBrowserEntry(row) : rowToContainerEntry(row));
    if (!current || !sameSandboxRegistryGeneration(current, entry)) {
      throw new Error("Sandbox runtime generation changed during retirement");
    }
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", kind)
        .where("container_name", "=", entry.containerName),
    );
  });
}

/** Removes one browser sandbox registry entry by container name. */
export async function removeBrowserRegistryEntry(containerName: string) {
  removeRegistryRow("browser", containerName);
}
