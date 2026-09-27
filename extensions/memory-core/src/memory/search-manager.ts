// Memory Core owns Gateway indexes for both local and host-provided files.
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

const loadManagerRuntime = createLazyRuntimeModule(() => import("../../manager-runtime.js"));

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
  debug?: {
    backend: "builtin";
    purpose: MemorySearchManagerPurpose;
    managerMs: number;
  };
};

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const startedAt = Date.now();
  const result = await getBuiltinMemorySearchManager(params);
  return {
    ...result,
    debug: {
      backend: "builtin",
      purpose: params.purpose ?? "default",
      managerMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

async function getBuiltinMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<Omit<MemorySearchManagerResult, "debug">> {
  try {
    const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
    const access = settings?.sources.includes("memory")
      ? getAgentWorkspaceAccess(resolveAgentWorkspaceDir(params.cfg, params.agentId), "memoryFiles")
      : undefined;
    const { MemoryIndexManager } = await loadManagerRuntime();
    return {
      manager: await MemoryIndexManager.get({ ...params, memoryFiles: access?.memoryFiles }),
    };
  } catch (err) {
    return { manager: null, error: formatErrorMessage(err) };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  if (!loadManagerRuntime.peek()) {
    return;
  }
  const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
  await closeAllMemoryIndexManagers();
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  if (!loadManagerRuntime.peek()) {
    return;
  }
  const { closeMemoryIndexManagersForAgent } = await loadManagerRuntime();
  await closeMemoryIndexManagersForAgent({
    agentId: normalizeAgentId(params.agentId),
  });
}
