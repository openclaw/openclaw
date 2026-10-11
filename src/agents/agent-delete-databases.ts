import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  runSqliteReadOnlyOperation,
  withSqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertNoAgentDatabaseLeasesAsync } from "../state/agent-deletion-journal.js";
import type { OpenClawRegisteredAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import { assertAgentSessionStoreDeletionBlocker } from "./agent-delete-session-store-safety.js";
import {
  assertAgentSessionStoreDeletionTargetsCurrent,
  prepareAgentSessionStoreDeletionSafety,
} from "./agent-delete-session-store-safety.targets.js";
import {
  isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath,
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";
import type { AgentDeletionOperation } from "./agent-lifecycle-registry.js";
import { listAgentIds, resolveAgentDir } from "./agent-scope.js";
import { closeAuthProfileReadPool } from "./auth-profiles/sqlite-read-pool.js";

export { AgentSharedStoreOwnerError } from "./agent-delete-session-store-safety.js";

export type AgentDeleteDatabasePlan = {
  agentDirs: string[];
  registrationPaths: string[];
  // Stale registrations can name a survivor's database; path-only readers must exclude it.
  readerPaths: string[];
  fileGroups: string[][];
  relocatedFileGroups: string[][];
};

export async function retireAgentDeleteRuntime(
  cfg: OpenClawConfig,
  deletion: AgentDeletionOperation,
  agentDirs: readonly string[],
): Promise<void> {
  const agentId = deletion.entry.agentId;
  const { retirePreparedModelRuntimeAgent } = await import("./prepared-model-runtime.js");
  await deletion.assertCurrentAsync();
  await retirePreparedModelRuntimeAgent({ agentId, agentDirs });
  const { closeActiveMemorySearchManagerCore } = await import("../plugins/memory-runtime.js");
  await deletion.assertCurrentAsync();
  await closeActiveMemorySearchManagerCore({ cfg, agentId });
  await deletion.assertCurrentAsync();
}

export async function finishAgentDeleteDatabases(params: {
  deletion: AgentDeletionOperation;
  agentDir: string;
  deleteFiles: boolean;
  complete: boolean;
}): Promise<void> {
  const { deletion, agentDir, deleteFiles, complete } = params;
  await deletion.assertCurrentAsync();
  if (!complete) {
    return;
  }
  const agentId = deletion.entry.agentId;
  unregisterResolvedAgentDir({ agentId, agentDir });
  await deletion.finish({ unregisterDatabases: deleteFiles });
}

/** Destructive planning includes every registered owner, regardless of runtime schema readiness. */
export async function readAgentDeleteDatabaseRegistry(options: OpenClawStateDatabaseOptions = {}) {
  const read = await prepareOpenClawAgentDatabaseRegistrySnapshotRead({
    ...options,
    includeIncompatibleSchemaVersions: true,
    fresh: true,
  }).read();
  read.assertCurrent();
  if (read.result.status !== "available") {
    throw new Error("OpenClaw agent database registry is unavailable during deletion.");
  }
  return read.result.entries;
}

export function prepareJournaledAgentDirOwnership(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
): void {
  for (const configuredAgentId of listAgentIds(cfg)) {
    resolveAgentDir(cfg, configuredAgentId);
  }
  const registeredOwner = resolveRegisteredAgentIdForDir(agentDir);
  if (registeredOwner !== undefined) {
    return;
  }
  // The durable journal retains ownership across restarts after the roster entry is gone.
  registerResolvedAgentDir({ agentId, agentDir });
}

/** Check before journaling: retaining the file alone would still fence its shared owner. */
export async function assertAgentSessionStoreDeletionSafe(
  cfg: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  if (!cfg.session?.store?.trim()) {
    return;
  }
  const input = prepareAgentSessionStoreDeletionSafety(cfg, agentId, options.env ?? process.env);
  const context = captureOpenClawStateReadWorkerContext({
    path: options.database?.path ?? options.path,
    env: input.env,
  });
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    {
      type: "agentDeletion.sessionStoreBlocker",
      input: {
        ...input,
        databasePath: context.admission.databasePath,
        env: context.environment,
      },
    },
    { context, current: true },
  );
  context.admission.assertCurrent();
  assertAgentSessionStoreDeletionTargetsCurrent(input.targets);
  if (reply && (!reply.ok || reply.type !== "agentDeletion.sessionStoreBlocker")) {
    throw new Error("Unexpected agent session-store deletion safety result");
  }
  let blocker = reply?.blocker;
  if (!reply) {
    const anchor = input.targets.candidates.find(({ identity }) =>
      identity.key.startsWith("file:"),
    );
    if (anchor) {
      const result = await withSqliteReadOnlyWorkerScope(() =>
        runSqliteReadOnlyOperation(
          anchor.identity.canonicalPath,
          { type: "agentRetirement.sessionStoreBlocker", input },
          { source: "canonical", expectedIdentity: anchor.identity.key, env: input.env },
        ),
      );
      context.admission.assertCurrent();
      assertAgentSessionStoreDeletionTargetsCurrent(input.targets);
      blocker = result.blocker;
    }
  }
  assertAgentSessionStoreDeletionBlocker(input.agentId, blocker);
}

export function resolveSurvivingDatabaseFilePaths(
  registeredDatabases: readonly OpenClawRegisteredAgentDatabase[],
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  return [
    ...new Set(
      registeredDatabases
        .filter((entry) => normalizeAgentId(entry.agentId) !== agentId)
        .flatMap((entry) => resolveSqliteDatabaseFilePaths(entry.path))
        .map((pathname) => normalizeAgentDirRegistryPath(pathname, env)),
    ),
  ];
}

export function isPathOwnedBySurvivingAgent(
  cfg: OpenClawConfig,
  agentId: string,
  pathname: string,
  survivingDatabaseFilePaths: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): boolean {
  const canonicalPath = normalizeAgentDirRegistryPath(pathname, env);
  return (
    isPathOwnedByAnotherRegisteredAgent({ agentId, pathname, env }) ||
    findOverlappingWorkspaceAgentIds(cfg, agentId, pathname, env).length > 0 ||
    survivingDatabaseFilePaths.some(
      (databasePath) =>
        databasePath === canonicalPath ||
        isPathInside(databasePath, canonicalPath) ||
        isPathInside(canonicalPath, databasePath),
    )
  );
}

export async function prepareAgentDeleteDatabases(
  cfg: OpenClawConfig,
  agentId: string,
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
  deletion?: AgentDeletionOperation,
): Promise<AgentDeleteDatabasePlan> {
  const registeredDatabases = await readAgentDeleteDatabaseRegistry(options);
  const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
    registeredDatabases,
    agentId,
    options.env,
  );
  const registeredDatabasePaths = new Set([
    resolveOpenClawAgentSqlitePath({
      agentId,
      env: options.env,
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    }),
    ...registeredDatabases
      .filter((entry) => normalizeAgentId(entry.agentId) === agentId)
      .map((entry) => entry.path),
  ]);
  // A surviving directory retains files, not the deleted agent's connection. Check the
  // actual cached owner so stale registration cannot close a surviving agent's handle.
  for (const databasePath of registeredDatabasePaths) {
    if (deletion) {
      await deletion.assertCurrentAsync();
    }
    await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
  }
  // Incognito has no registry row or files, but retained statements must also be retired.
  if (deletion) {
    await deletion.assertCurrentAsync();
  }
  await closeOpenClawAgentDatabaseByPathAsync(
    resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: options.env }),
    agentId,
  );
  const databasePaths = [...registeredDatabasePaths].filter((pathname) =>
    resolveSqliteDatabaseFilePaths(pathname).every(
      (filePath) =>
        !isPathOwnedBySurvivingAgent(
          cfg,
          agentId,
          filePath,
          survivingDatabaseFilePaths,
          options.env,
        ),
    ),
  );
  if (deletion) {
    await deletion.assertCurrentAsync();
  }
  for (const databasePath of databasePaths) {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
  if (deletion) {
    await deletion.runWithWorker((scope, guard) =>
      scope.execute({ type: "agentDeletion.assertNoDatabaseLeases", input: { guard } }),
    );
  } else {
    await assertNoAgentDatabaseLeasesAsync(agentId, options);
  }
  const fileGroups = databasePaths.map(resolveSqliteDatabaseFilePaths);
  const relocatedFileGroups = fileGroups.filter((fileGroup) => {
    const relative = path.relative(agentDir, fileGroup[0] ?? agentDir);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  return {
    agentDirs: [
      agentDir,
      ...Array.from(registeredDatabasePaths, (databasePath) => path.dirname(databasePath)),
    ],
    registrationPaths: [...registeredDatabasePaths],
    readerPaths: databasePaths,
    fileGroups,
    relocatedFileGroups,
  };
}
