// Host side of the query reader pool: two lazily created workers that own the
// whole-vault scans (search and lookup) for wiki queries. Single-page reads stay
// on the calling thread (query.ts) so they never wait behind a scan.
import {
  resolveRuntimeWorkerUrl,
  WorkerTaskError,
  WorkerTaskPool,
} from "openclaw/plugin-sdk/process-runtime";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import type { WikiPageReadResult, WikiPageReadTask } from "./query-pages.js";

/** Whole-vault scans; the one-page variant is read on the calling thread. */
export type WikiPageScanTask = Exclude<WikiPageReadTask, { select: "page" }>;

/**
 * One bound for a wiki page scan: the wiki_search tool's own deadline (#166329)
 * and the pool's per-task timeout. The memory_search supplement, the CLI, the
 * wiki.search RPC, wiki_get basename and id lookups and wiki_apply update_metadata
 * call without a signal, so the pool enforces this bound on every scan task.
 */
export const WIKI_SEARCH_TIMEOUT_MS = 30_000;

/** The deadline error wiki_search raises; a scan task that hits the bound raises the same shape. */
export function createWikiDeadlineError(
  operation: string,
  timeoutMs: number = WIKI_SEARCH_TIMEOUT_MS,
): Error {
  return new Error(`${operation} timed out after ${timeoutMs / 1000}s`);
}

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
    // queues. A worker retained about 460 MB of heap on a 10,000-page scan, which is
    // why the pool does not grow with the host's core count.
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

/** Run one whole-vault scan in the reader pool and return its typed selection. */
export async function readMemoryWikiPages<Task extends WikiPageScanTask>(
  task: Task,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Extract<WikiPageReadResult, { select: Task["select"] }>> {
  const timeoutMs = options.timeoutMs ?? WIKI_SEARCH_TIMEOUT_MS;
  let result: WikiPageReadResult;
  try {
    result = await resolvePool().run(task, {
      inputBytes: estimateWikiPageReadBytes(task),
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof WorkerTaskError && error.code === "timeout") {
      throw createWikiDeadlineError(
        task.select === "search" ? "wiki_search" : "wiki page lookup",
        timeoutMs,
      );
    }
    throw error;
  }
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
