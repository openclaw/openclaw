import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { MemoryIndexManager } from "./manager.js";

type SearchConfig = NonNullable<NonNullable<OpenClawConfig["memory"]>["search"]>;

export async function openObservedManager(
  workspace: string,
  search: SearchConfig,
  agentId = "main",
) {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace }, entries: { [agentId]: {} } },
    memory: {
      search: {
        provider: "none",
        sources: ["memory"],
        store: { vector: { enabled: false } },
        ...search,
      },
    },
  };
  const manager = await MemoryIndexManager.get({
    runInBackgroundContext: runInMemoryTestBackgroundContext,
    cfg,
    agentId,
  });
  assert(manager, "Expected a persistent memory manager");
  return { manager, cfg };
}
