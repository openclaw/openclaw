import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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

export function openPublishedIndex(manager: MemoryIndexManager) {
  const dbPath = manager.status().dbPath;
  assert(dbPath, "Expected a persistent memory index");
  return new DatabaseSync(dbPath, { readOnly: true });
}
