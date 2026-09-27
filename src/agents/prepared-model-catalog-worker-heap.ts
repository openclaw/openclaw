import { WorkerTaskError } from "../infra/worker-task-pool.js";

const MEBIBYTE = 1024 * 1024;
export const CATALOG_WORKER_HEAP_LIMIT_MB = 512;

function processOverridesWorkerOldGenerationLimit(): boolean {
  const argv = [...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" ");
  return /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/u.test(argv);
}

/** Node's process-wide V8 flag overrides Worker resourceLimits; reject retained overflow. */
export function assertCatalogWorkerHeapLimit(heapUsedBytes: number): void {
  if (
    processOverridesWorkerOldGenerationLimit() &&
    heapUsedBytes > CATALOG_WORKER_HEAP_LIMIT_MB * MEBIBYTE
  ) {
    throw new WorkerTaskError("catalog worker exceeded its retained heap limit", "unavailable");
  }
}
