// Resolve the immutable settings and database target used to acquire one memory manager.
import {
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  captureMemoryIndexDatabaseWriteOptions,
  resolveMemoryIndexDatabaseTarget,
  type MemoryIndexDatabaseTarget,
} from "./manager-database-target.js";
import {
  resolveMemoryEmbeddingProviderRequirement,
  type MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";
import {
  resolveMemoryIndexManagerCacheKey,
  type MemoryIndexManagerPurpose,
} from "./manager-registry.js";

export type MemoryIndexManagerPreparation = {
  agentId: string;
  cfg: OpenClawConfig;
  databaseTarget: MemoryIndexDatabaseTarget;
  key: string;
  providerRequirement: MemoryEmbeddingProviderRequirement;
  purpose: MemoryIndexManagerPurpose;
  settings: ResolvedMemorySearchConfig;
  workspaceDir: string;
};

export function resolveMemoryIndexManagerPreparation(params: {
  agentId: string;
  cfg: OpenClawConfig;
  purpose: MemoryIndexManagerPurpose;
  settings?: ResolvedMemorySearchConfig;
  workspaceDir?: string;
  providerRequirement?: MemoryEmbeddingProviderRequirement;
  databaseTarget?: MemoryIndexDatabaseTarget;
  publishedDatabase?: MemoryIndexDatabase;
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): MemoryIndexManagerPreparation | null {
  const settings = params.settings ?? resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!settings) {
    return null;
  }
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const databaseTarget = resolveMemoryIndexDatabaseTarget({
    cfg: params.cfg,
    agentId: params.agentId,
    settings,
    workspaceDir,
    agentDatabaseOptions: captureMemoryIndexDatabaseWriteOptions(
      params.agentId,
      settings.store.databasePath,
      params.publishedDatabase,
    ),
    maintenanceSourceTarget: params.databaseTarget,
  });
  const effectiveSettings: ResolvedMemorySearchConfig = {
    ...settings,
    store: { ...settings.store, databasePath: databaseTarget.path },
  };
  const providerRequirement =
    params.providerRequirement ??
    resolveMemoryEmbeddingProviderRequirement({
      cfg: params.cfg,
      agentId: params.agentId,
      settings: effectiveSettings,
    });
  return {
    agentId: params.agentId,
    cfg: params.cfg,
    databaseTarget,
    key: resolveMemoryIndexManagerCacheKey({
      agentId: params.agentId,
      workspaceDir,
      settings: effectiveSettings,
      providerRequirement,
      purpose: params.purpose,
      acquireLocalService: params.acquireLocalService,
    }),
    providerRequirement,
    purpose: params.purpose,
    settings: effectiveSettings,
    workspaceDir,
  };
}
