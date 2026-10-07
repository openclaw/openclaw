// Host side of the query reader pool: two lazily created workers that own the
// whole-vault scans (search and lookup) for wiki queries. Single-page reads stay
// on the calling thread (query.ts) so they never wait behind a scan.
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import type { WikiPageReadResult, WikiPageReadTask } from "./query-pages.js";

/** Whole-vault scans; the one-page variant is read on the calling thread. */
export type WikiPageScanTask = Exclude<WikiPageReadTask, { select: "page" }>;

const memoryWikiQueryReaderEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "query-reader.worker",
  distWorkerPath: "extensions/memory-wiki/src/query-reader.worker.js",
  package: { name: "@openclaw/memory-wiki", distWorkerPath: "src/query-reader.worker.js" },
} as const;

let pool: WorkerTaskPool<WikiPageScanTask, WikiPageReadResult> | undefined;

function resolvePool(): WorkerTaskPool<WikiPageScanTask, WikiPageReadResult> {
  // A pool that is closing stays referenced until close settles, so a read issued
  // during stop() fails with the pool's own closed error instead of opening an orphan.
  pool ??= new WorkerTaskPool<WikiPageScanTask, WikiPageReadResult>({
    workerUrl: resolveRuntimeWorkerUrl(memoryWikiQueryReaderEntrypoint),
    // Two workers: a lookup can overtake a long search and two scans overlap; a third
    // queues. A scan worker's heap grows with the vault (about 270 MB on a 140 MB,
    // 10,000-page vault), which is why the pool does not grow with the core count.
    maxWorkers: 2,
    sharedCompute: true,
  });
  return pool;
}

/** Pool admission accounting: UTF-16 code units of the strings the task carries. */
function estimateWikiPageReadBytes(task: WikiPageScanTask): number {
  let chars = task.rootDir.length;
  for (const relativePath of task.relativePaths ?? []) {
    chars += relativePath.length;
  }
  for (const relativePath of task.excludePaths ?? []) {
    chars += relativePath.length;
  }
  chars += task.select === "search" ? task.query.length : task.lookup.length;
  return chars * 2;
}

/**
 * Run one whole-vault scan in the reader pool and return its typed selection.
 * Deadlines stay with the caller, as on main: the wiki_search tool's 30 s deadline and
 * turn cancellation arrive through `signal`; a caller that passes none waits for the scan.
 */
export async function readMemoryWikiPages<Task extends WikiPageScanTask>(
  task: Task,
  options: { signal?: AbortSignal } = {},
): Promise<Extract<WikiPageReadResult, { select: Task["select"] }>> {
  const result = await resolvePool().run(task, {
    inputBytes: estimateWikiPageReadBytes(task),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.select === "refused") {
    throw new FsSafeError(result.code, result.message);
  }
  if (result.select !== task.select) {
    throw new Error("Invalid memory wiki page read worker result");
  }
  // SAFETY: The discriminant check above pairs the reply with the submitted task.
  return result as Extract<WikiPageReadResult, { select: Task["select"] }>;
}

/** Plugin stop releases the workers; a read after the close settles recreates the pool. */
export async function closeMemoryWikiQueryReader(): Promise<void> {
  const current = pool;
  if (!current) {
    return;
  }
  try {
    await current.close();
  } finally {
    if (pool === current) {
      pool = undefined;
    }
  }
}
