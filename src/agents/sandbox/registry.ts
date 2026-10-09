/**
 * Persistent sandbox registry storage.
 *
 * Tracks runtime and browser containers in the shared state DB.
 */
import { createHash } from "node:crypto";
import { withFileLock } from "../../infra/file-lock.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import {
  finishSandboxRegistryRemoval,
  withSandboxRegistrySettlement,
} from "./registry-lifecycle.js";
import {
  assertSandboxRegistryGenerationCurrent,
  shouldPruneSandboxRegistryEntry,
  type SandboxRegistryOperations,
  type SandboxRegistryPrune,
  type SandboxRegistryWrite,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryRowInDatabase,
  rowToBrowserEntry,
} from "./registry.kernel.js";
import type {
  SandboxBrowserRegistry,
  SandboxBrowserRegistryEntry,
  SandboxRegistry,
  SandboxRegistryEntry,
} from "./registry.types.js";

export type { SandboxRegistryEntry, SandboxBrowserRegistryEntry } from "./registry.types.js";

type SandboxRegistryKind = "container" | "browser";
async function executeRegistry<Key extends keyof SandboxRegistryOperations>(
  command: { type: Key; input: SandboxRegistryOperations[Key]["input"] },
  guard?: WorkspaceStateGuard,
  assertCallerCurrent?: () => void,
  context = captureOpenClawStateWorkerContext(),
): Promise<SandboxRegistryOperations[Key]["output"]> {
  guard?.assertHost?.();
  guard?.beforeLegacyApply?.();
  const input = structuredClone(command.input);
  const assertCurrent = () => {
    guard?.assertHost?.();
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    assertCallerCurrent?.();
  };
  const { runOpenClawStateWorkerOperation } =
    await import("../../state/openclaw-state-worker-store.js");
  // Reservation checks stay outside grants; the worker checks its authoritative rows.
  guard?.beforeLegacyApply?.();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: command.type, input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

function writeRegistry(
  write: SandboxRegistryWrite,
  guard?: WorkspaceStateGuard,
  assertCallerCurrent?: () => void,
  context?: OpenClawStateWorkerContext,
): Promise<void> {
  return executeRegistry(
    { type: "sandboxRegistry.write", input: write },
    guard,
    assertCallerCurrent,
    context,
  );
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
export async function updateRegistry(entry: SandboxRegistryEntry, guard?: WorkspaceStateGuard) {
  await writeRegistry({ operation: "update", entry }, guard);
}

/** Removes one sandbox runtime registry entry by container name. */
export async function removeRegistryEntry(
  containerName: string,
  options: { preserveRemovalIntent?: boolean; guard?: WorkspaceStateGuard } = {},
) {
  await writeRegistry(
    {
      operation: "remove",
      containerName,
      preserveRemovalIntent: options.preserveRemovalIntent,
    },
    options.guard,
  );
}

/** Atomically select one generation for a backend/scope before provider allocation. */
export async function reserveSandboxRegistryEntry(
  candidate: SandboxRegistryEntry,
  guard?: WorkspaceStateGuard,
): Promise<SandboxRegistryEntry> {
  return executeRegistry({ type: "sandboxRegistry.reserve", input: candidate }, guard);
}

/** Validate the exact generation; retained handles cannot outlive removal intent. */
// Released synchronous sandbox callbacks span provider waits and deferred process launch.
// They need live generation authority observing foreign removals; revisit with async
// companions at the next SDK major (docs/reference/database-schemas/worker-access.md).
export function assertSandboxRegistryEntryCurrent(entry: SandboxRegistryEntry): void {
  const current =
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      readSandboxRegistryEntryInDatabase(db, entry.containerName),
    ) ?? null;
  assertSandboxRegistryGenerationCurrent(current, entry);
}

/** Publish only a still-current reservation, or forget a provider-confirmed terminal generation. */
export async function completeSandboxRegistryReservation(
  entry: SandboxRegistryEntry,
  retired = false,
  guard?: WorkspaceStateGuard,
): Promise<void> {
  await writeRegistry({ operation: "complete", entry, retired }, guard);
}

/** Serialize provider operations across Gateway/CLI; only dead owners permit lock recovery. */
export async function withSandboxRegistryEntryLock<T>(
  entry: SandboxRegistryEntry,
  operation: () => Promise<T>,
  databasePath = resolveOpenClawStateSqlitePath(),
): Promise<T> {
  const key = createHash("sha256").update(entry.containerName).digest("hex");
  return await withFileLock(
    `${databasePath}.sandbox-${key}`,
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
    prune?: SandboxRegistryPrune;
    guard?: WorkspaceStateGuard;
  } = {},
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.guard?.assertHost?.();
    options.guard?.beforeLegacyApply?.();
  };
  assertCurrent();
  const input = structuredClone({
    entry,
    reserveRuntime: options.reserveRuntime,
    prune: options.prune,
  });
  return withSandboxRegistrySettlement(context, async () => {
    const selected = await executeRegistry(
      { type: "sandboxRegistry.beginRemoval", input },
      options.guard,
      undefined,
      context,
    );
    assertCurrent();
    if (!selected) {
      return;
    }
    const remove = async (current: SandboxRegistryEntry) => {
      assertCurrent();
      const identity = { ...context.admission.identity };
      const generation = structuredClone(current);
      await removeRuntime(current);
      await finishSandboxRegistryRemoval(context, identity, generation, options.guard);
    };
    if (!selected.runtimeState) {
      await remove(selected);
      return;
    }
    await withSandboxRegistryEntryLock(
      selected,
      async () => {
        assertCurrent();
        const reply = await executeExistingOpenClawStateRead(
          { path: context.admission.databasePath, env: context.environment },
          { type: "sandboxRegistry.get", containerName: selected.containerName },
          { context, current: true },
        );
        assertCurrent();
        if (reply && (!reply.ok || reply.type !== "sandboxRegistry.get")) {
          throw new Error("Unexpected sandbox registry removal lookup result");
        }
        const current = reply?.entry;
        if (
          !current ||
          (current.runtimeState !== "removing" && current.runtimeState !== "removing-pending") ||
          current.backendId !== selected.backendId ||
          current.sessionKey !== selected.sessionKey ||
          current.createdAtMs !== selected.createdAtMs ||
          (input.prune && !shouldPruneSandboxRegistryEntry(current, input.prune))
        ) {
          return;
        }
        await remove(current);
      },
      context.admission.databasePath,
    );
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
export async function updateBrowserRegistry(
  entry: SandboxBrowserRegistryEntry,
  assertCurrent?: () => void,
) {
  await writeRegistry({ operation: "updateBrowser", entry }, undefined, assertCurrent);
}

/** Forget only the inspected allocation, under the caller's still-live settlement lease. */
export async function removeSandboxRegistryGeneration(
  kind: SandboxRegistryKind,
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
  assertCurrent?: () => void,
): Promise<void> {
  await writeRegistry({ operation: "removeGeneration", kind, entry }, undefined, assertCurrent);
}

/** Removes one browser sandbox registry entry by container name. */
export async function removeBrowserRegistryEntry(containerName: string) {
  await writeRegistry({ operation: "removeBrowser", containerName });
}
