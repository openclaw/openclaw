// Memory Core owns Gateway indexes for both local and host-provided files.
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { AcquireConfiguredProviderLocalService } from "openclaw/plugin-sdk/embedding-providers";
import { extractErrorCode, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { loadMemoryManagerRuntime } from "./manager-runtime-loader.js";
import type { MemoryCoreRuntimeHost } from "./runtime-host.js";

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: AcquireConfiguredProviderLocalService;
  runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
};

type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
  code?: string;
  debug: {
    backend: "builtin";
    purpose: MemorySearchManagerPurpose;
    managerMs: number;
  };
};

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const startedAt = Date.now();
  let result: Omit<MemorySearchManagerResult, "debug">;
  try {
    const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
    const access = settings?.sources.includes("memory")
      ? getAgentWorkspaceAccess(resolveAgentWorkspaceDir(params.cfg, params.agentId), "memoryFiles")
      : undefined;
    const { MemoryIndexManager } = await loadMemoryManagerRuntime();
    result = {
      manager: await MemoryIndexManager.get({ ...params, memoryFiles: access?.memoryFiles }),
    };
  } catch (err) {
    result = { manager: null, error: formatErrorMessage(err), code: extractErrorCode(err) };
  }
  return {
    ...result,
    debug: {
      backend: "builtin",
      purpose: params.purpose ?? "default",
      managerMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  if (!loadMemoryManagerRuntime.peek()) {
    return;
  }
  const { closeMemoryIndexManagersForAgent } = await loadMemoryManagerRuntime();
  await closeMemoryIndexManagersForAgent({
    agentId: normalizeAgentId(params.agentId),
  });
}
