import type {
  MemoryCliSearchParams,
  MemoryCliSearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
export type {
  MemoryCliSearchResult,
  MemoryCliSearchOutcome,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
export { captureMemoryRebuildNotice } from "./src/memory-rebuild-notice.js";

export async function searchMemoryForCli(
  params: MemoryCliSearchParams,
): Promise<MemoryCliSearchResult> {
  const runtime = await import("./src/memory-search-operation.js");
  return runtime.searchMemoryForCli(params);
}
