export { captureMemoryRebuildNotice } from "./src/memory-rebuild-notice.js";
export type {
  MemoryCliSearchResult,
  MemoryCliSearchOutcome,
} from "./src/memory-search-operation.js";

export async function searchMemoryForCli(
  params: Parameters<typeof import("./src/memory-search-operation.js").searchMemoryForCli>[0],
) {
  const runtime = await import("./src/memory-search-operation.js");
  return runtime.searchMemoryForCli(params);
}
