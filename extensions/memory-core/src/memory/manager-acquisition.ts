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
  status(): {
    custom?: {
      automaticRebuildNotice?: { sequence?: number; warning?: string };
    };
  };
  sync(params?: { reason?: string; force?: boolean }): Promise<void>;
};

type MemoryManagerAcquisitionOutcome = { warning?: string };

export type MemoryManagerGetParams<T> = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemoryIndexManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  maintenanceSource?: T;
  acquisitionOutcome?: MemoryManagerAcquisitionOutcome;
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
  writerPrepared?: boolean;
};

function resolveMemoryManagerAcquisition<T>(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: MemoryIndexManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  source?: MemoryManagerAcquisitionSource<T>;
  writerPrepared?: boolean;
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
    ...(params.writerPrepared ? { writerPrepared: true } : {}),
  };
}

export async function acquireMemoryManagerWithSearchRecovery<
  T extends AcquirableMemoryManager,
  TPreparedCreate,
>(
  params: MemoryManagerGetParams<T> & {
    registry: MemoryManagerRegistry<T>;
    source?: MemoryManagerAcquisitionSource<T>;
    prepareCreate: (acquisition: MemoryManagerAcquisition<T>) => TPreparedCreate;
    create: (acquisition: MemoryManagerAcquisition<T>, prepared: TPreparedCreate) => Promise<T>;
    reuse: (manager: T, purpose: MemoryIndexManagerPurpose) => Promise<boolean> | boolean;
  },
): Promise<T | null> {
  const acquire = async (
    purpose: MemoryIndexManagerPurpose,
    options?: { writerPrepared?: boolean },
  ): Promise<T | null> => {
    const acquisition = resolveMemoryManagerAcquisition({
      cfg: params.cfg,
      agentId: params.agentId,
      purpose,
      acquireLocalService: params.acquireLocalService,
      source: params.source,
      writerPrepared: options?.writerPrepared,
    });
    if (!acquisition) {
      return null;
    }
    return await params.registry.acquire(
      { agentId: acquisition.agentId, purpose },
      {
        prepare: () => {
          const prepared = params.prepareCreate(acquisition);
          return {
            key: acquisition.key,
            create: async () => await params.create(acquisition, prepared),
            reuse: async (manager) => await params.reuse(manager, purpose),
          };
        },
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
    const beforeNotice = writer.status().custom?.automaticRebuildNotice;
    const beforeSequence = beforeNotice?.sequence;
    const captureWriterNotice = () => {
      const afterNotice = writer.status().custom?.automaticRebuildNotice;
      if (
        afterNotice?.sequence !== beforeSequence &&
        typeof afterNotice?.warning === "string" &&
        afterNotice.warning
      ) {
        if (params.acquisitionOutcome) {
          params.acquisitionOutcome.warning = afterNotice.warning;
        }
      }
    };
    try {
      await writer.sync({ reason: "search", force: true });
    } catch (error) {
      try {
        captureWriterNotice();
      } catch {
        // Preserve the writer failure when best-effort status capture is unavailable.
      }
      throw error;
    }
    captureWriterNotice();
    return await acquire(purpose, { writerPrepared: true });
  } catch (recoveryError) {
    throw new Error(
      `Memory search reader unavailable after writer preparation: ${formatErrorMessage(recoveryError)}; initial reader error: ${formatErrorMessage(initialError)}`,
      { cause: recoveryError },
    );
  }
}
