import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  resolveMemorySearchSyncConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

export async function prewarmMemorySearchWorker(cfg: OpenClawConfig): Promise<void> {
  // Capability registration also serves non-search memory features. Only warm a
  // retrieval worker when at least one configured agent can actually use it.
  if (!listAgentIds(cfg).some((id) => resolveMemorySearchSyncConfig(cfg, id))) {
    return;
  }
  const runtime = await import("./src/memory/manager-cpu-worker-runtime.js");
  await runtime.prewarmMemorySearchWorker();
}
