import path from "node:path";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabaseOwnerInspection,
  OpenClawRegisteredAgentDatabase,
} from "../state/openclaw-agent-db-contract.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
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
} from "./agent-dir-registry.js";
import { listAgentIds } from "./agent-scope.js";

export type AgentDeleteDatabasePlan = {
  registrationPaths: string[];
  fileGroups: string[][];
  relocatedFileGroups: string[][];
};

/** Destructive planning includes every registered owner, regardless of runtime schema readiness. */
export function readAgentDeleteDatabaseRegistry(options: OpenClawStateDatabaseOptions = {}) {
  invalidateRegisteredAgentDatabasesMemo(options);
  return listOpenClawRegisteredAgentDatabases({
    ...options,
    includeIncompatibleSchemaVersions: true,
  });
}

export class AgentSharedStoreOwnerError extends Error {}

export function resolveAgentSessionStoreSurvivorTargets(
  cfg: OpenClawConfig,
  agentId: string,
  registeredDatabases: readonly OpenClawRegisteredAgentDatabase[],
  env?: NodeJS.ProcessEnv,
): Array<{ agentId: string; path: string }> {
  const configuredStore = cfg.session?.store;
  if (!configuredStore?.trim()) {
    return [];
  }
  const id = normalizeAgentId(agentId);
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  return listAgentIds(cfg)
    .filter((survivorId) => normalizeAgentId(survivorId) !== id)
    .map((survivorId) => {
      const storePath = resolveSessionStorePathCore(configuredStore, {
        agentId: survivorId,
        env,
      });
      const target = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: survivorId,
        defaultAgentId,
        env,
        registeredDatabases,
      });
      return { agentId: survivorId, path: target.path };
    });
}

/** Check before journaling: retaining the file alone would still fence its shared owner. */
export function assertAgentSessionStoreDeletionSafe(
  cfg: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  readFacts?: {
    registeredDatabases: readonly OpenClawRegisteredAgentDatabase[];
    inspectOwner: (path: string) => OpenClawAgentDatabaseOwnerInspection;
  },
): void {
  if (!cfg.session?.store?.trim()) {
    return;
  }
  const id = normalizeAgentId(agentId);
  const registeredDatabases =
    readFacts?.registeredDatabases ?? readAgentDeleteDatabaseRegistry(options);
  for (const target of resolveAgentSessionStoreSurvivorTargets(
    cfg,
    agentId,
    registeredDatabases,
    options.env,
  )) {
    const owner =
      readFacts?.inspectOwner(target.path) ?? inspectOpenClawAgentDatabaseOwner(target.path);
    if (readFacts && owner.status === "unreadable") {
      throw new AgentSharedStoreOwnerError(
        `Session database ownership for agent "${target.agentId}" could not be verified; removal is blocked.`,
      );
    }
    if (owner.status === "owned" && owner.agentId === id) {
      throw new AgentSharedStoreOwnerError(
        `Agent "${id}" owns the session database still used by agent "${target.agentId}" and cannot be deleted. Keep this owner configured until shared history can be moved with a supported migration; no such migration is currently available.`,
      );
    }
  }
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
  readFacts?: {
    registeredDatabases: readonly OpenClawRegisteredAgentDatabase[];
    assertNoLeases: () => Promise<void>;
    assertCurrent?: () => Promise<void>;
    closeDatabase?: (pathname: string, agentId: string) => Promise<void>;
  },
): Promise<AgentDeleteDatabasePlan> {
  const registeredDatabases =
    readFacts?.registeredDatabases ?? readAgentDeleteDatabaseRegistry(options);
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
    await readFacts?.assertCurrent?.();
    if (readFacts?.closeDatabase) {
      await readFacts.closeDatabase(databasePath, agentId);
    } else {
      await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
    }
  }
  // Incognito has no registry row or files, but retained statements must also be retired.
  await readFacts?.assertCurrent?.();
  const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: options.env });
  if (readFacts?.closeDatabase) {
    await readFacts.closeDatabase(incognitoPath, agentId);
  } else {
    await closeOpenClawAgentDatabaseByPathAsync(incognitoPath, agentId);
  }
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
  if (readFacts) {
    await readFacts.assertNoLeases();
  } else {
    assertNoOpenClawAgentDatabaseLeases(agentId, options);
  }
  const fileGroups = databasePaths.map(resolveSqliteDatabaseFilePaths);
  const relocatedFileGroups = fileGroups.filter((fileGroup) => {
    const relative = path.relative(agentDir, fileGroup[0] ?? agentDir);
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  return {
    registrationPaths: [...registeredDatabasePaths],
    fileGroups,
    relocatedFileGroups,
  };
}
