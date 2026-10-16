import { runWithLocalStateOwner } from "openclaw/plugin-sdk/cli-state-owner";
import type { MemoryCliSearchOutcome } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { renderMemorySearch } from "./cli-search-output.js";
import type { MemorySearchCommandOptions } from "./cli.types.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";

export async function runMemorySearchWithOwner(
  query: string,
  opts: MemorySearchCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
): Promise<void> {
  const result = await runWithLocalStateOwner<MemoryCliSearchOutcome | undefined>({
    method: "memory.search.owner",
    params: {
      query,
      ...(opts.agent !== undefined ? { agentId: opts.agent } : {}),
      ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    },
    target: "memory search",
    runLocal: async () => {
      const { runMemorySearch } = await import("./cli.runtime.js");
      await runMemorySearch(query, opts, hostOptions);
      return undefined;
    },
  });
  if (result) {
    renderMemorySearch(result, opts.json);
  }
}
