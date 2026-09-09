import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";
import {
  resolveMemoryEmbeddingProviderRequirement,
  type MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";
import {
  type MemoryIndexManagerPurpose,
  MemoryManagerRegistry,
  normalizeMemoryIndexManagerPurpose,
  resolveMemoryIndexManagerCacheKey,
} from "./manager-registry.js";

type AcquirableMemoryManager = {
  close(): Promise<void>;
  sync(params?: { reason?: string; force?: boolean }): Promise<void>;
};

export type MemoryManagerGetParams<T> = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemoryIndexManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  maintenanceSource?: T;
};

export type MemoryManagerAcquisitionSource<T> = {
  manager: T;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  providerRequirement: MemoryEmbeddingProviderRequirement;
};

export type MemoryManagerAcquisition<T> = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: MemoryIndexManagerPurpose;
  workspaceDir: string;
  settings: ResolvedMemorySearchConfig;
  providerRequirement: MemoryEmbeddingProviderRequirement;
  key: string;
  maintenanceSource?: T;
};

function resolveMemoryManagerAcquisition<T>(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: MemoryIndexManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  source?: MemoryManagerAcquisitionSource<T>;
}): MemoryManagerAcquisition<T> | null {
  const cfg = params.source?.cfg ?? params.cfg;
  const agentId = params.source?.agentId ?? normalizeAgentId(params.agentId);
  const settings = params.source?.settings ?? resolveMemorySearchConfig(cfg, agentId);
  if (!settings) {
    return null;
  }
  const workspaceDir = params.source?.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
  const providerRequirement =
    params.source?.providerRequirement ??
    resolveMemoryEmbeddingProviderRequirement({ cfg, agentId, settings });
  const key = resolveMemoryIndexManagerCacheKey({
    agentId,
    workspaceDir,
    settings,
    providerRequirement,
    purpose: params.purpose,
    acquireLocalService: params.acquireLocalService,
  });
  return {
    cfg,
    agentId,
    purpose: params.purpose,
    workspaceDir,
    settings,
    providerRequirement,
    key,
    ...(params.source ? { maintenanceSource: params.source.manager } : {}),
  };
}

export async function acquireMemoryManagerWithSearchRecovery<T extends AcquirableMemoryManager>(
  params: MemoryManagerGetParams<T> & {
    registry: MemoryManagerRegistry<T>;
    source?: MemoryManagerAcquisitionSource<T>;
    create: (acquisition: MemoryManagerAcquisition<T>) => Promise<T>;
    reuse: (manager: T, purpose: MemoryIndexManagerPurpose) => Promise<boolean> | boolean;
  },
): Promise<T | null> {
  const acquire = async (purpose: MemoryIndexManagerPurpose): Promise<T | null> => {
    const acquisition = resolveMemoryManagerAcquisition({
      cfg: params.cfg,
      agentId: params.agentId,
      purpose,
      acquireLocalService: params.acquireLocalService,
      source: params.source,
    });
    if (!acquisition) {
      return null;
    }
    return await params.registry.acquire(
      { agentId: acquisition.agentId, purpose },
      {
        prepare: () => ({
          key: acquisition.key,
          create: async () => await params.create(acquisition),
          reuse: async (manager) => await params.reuse(manager, purpose),
        }),
      },
    );
  };

  const purpose = normalizeMemoryIndexManagerPurpose(params.purpose);
  if (purpose !== "search") {
    return await acquire(purpose);
  }

  let initialError: unknown;
  try {
    return await acquire(purpose);
  } catch (err) {
    initialError = err;
  }

  try {
    const writer = await acquire("default");
    if (!writer) {
      throw new Error("memory indexing is disabled");
    }
    await writer.sync({ reason: "search", force: true });
    return await acquire(purpose);
  } catch (recoveryError) {
    throw new Error(
      `Memory search reader unavailable after writer preparation: ${formatErrorMessage(recoveryError)}; initial reader error: ${formatErrorMessage(initialError)}`,
      { cause: recoveryError },
    );
  }
}
