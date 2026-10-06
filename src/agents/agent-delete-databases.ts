import path from "node:path";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
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
  databasePlan: AgentDeleteDatabasePlan | undefined;
  agentDir: string;
  deleteFiles: boolean;
  complete: boolean;
}): Promise<void> {
  const { deletion, databasePlan, agentDir, deleteFiles, complete } = params;
  await deletion.assertCurrentAsync();
  if (!complete) {
    return;
  }
  const agentId = deletion.entry.agentId;
  unregisterResolvedAgentDir({ agentId, agentDir });
  if (deleteFiles) {
    for (const databasePath of databasePlan?.registrationPaths ?? []) {
      unregisterOpenClawAgentDatabase({ agentId, path: databasePath });
    }
  }
  deletion.finish();
}

/** Destructive planning includes every registered owner, regardless of runtime schema readiness. */
export function readAgentDeleteDatabaseRegistry(options: OpenClawStateDatabaseOptions = {}) {
  invalidateRegisteredAgentDatabasesMemo(options);
  return listOpenClawRegisteredAgentDatabases({
    ...options,
    includeIncompatibleSchemaVersions: true,
  });
}

export class AgentSharedStoreOwnerError extends Error {}

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
export function assertAgentSessionStoreDeletionSafe(
  cfg: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (!cfg.session?.store?.trim()) {
    return;
  }
  const id = normalizeAgentId(agentId);
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const registeredDatabases = readAgentDeleteDatabaseRegistry(options);
  for (const survivorId of listAgentIds(cfg)) {
    if (normalizeAgentId(survivorId) === id) {
      continue;
    }
    const storePath = resolveSessionStorePathCore(cfg.session.store, {
      agentId: survivorId,
      env: options.env,
    });
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: survivorId,
      defaultAgentId,
      env: options.env,
      registeredDatabases,
    });
    const owner = inspectOpenClawAgentDatabaseOwner(target.path);
    if (owner.status === "owned" && owner.agentId === id) {
      throw new AgentSharedStoreOwnerError(
        `Agent "${id}" owns the session database still used by agent "${survivorId}" and cannot be deleted. Keep this owner configured until shared history can be moved with a supported migration; no such migration is currently available.`,
      );
    }
  }
}

export function resolveSurvivingDatabaseFilePaths(
  registeredDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases>,
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
): Promise<AgentDeleteDatabasePlan> {
  const registeredDatabases = readAgentDeleteDatabaseRegistry(options);
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
    await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
  }
  // Incognito has no registry row or files, but retained statements must also be retired.
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
  for (const databasePath of databasePaths) {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
  assertNoOpenClawAgentDatabaseLeases(agentId, options);
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
