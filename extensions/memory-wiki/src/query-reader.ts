// Host side of the query reader worker: one lazily created pool with one worker
// that owns whole-vault page reads, parsing and scoring for wiki queries.
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import type { WikiPageReadResult, WikiPageReadTask } from "./query-pages.js";

const memoryWikiQueryReaderEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "query-reader.worker",
  distWorkerPath: "extensions/memory-wiki/src/query-reader.worker.js",
  package: { name: "@openclaw/memory-wiki", distWorkerPath: "src/query-reader.worker.js" },
} as const;

let pool: WorkerTaskPool<WikiPageReadTask, WikiPageReadResult> | undefined;

function resolvePool(): WorkerTaskPool<WikiPageReadTask, WikiPageReadResult> {
  // A pool that is closing stays referenced until close settles, so a read issued
  // during stop() fails with the pool's own closed error instead of opening an orphan.
  pool ??= new WorkerTaskPool<WikiPageReadTask, WikiPageReadResult>({
    workerUrl: resolveRuntimeWorkerUrl(memoryWikiQueryReaderEntrypoint),
    maxWorkers: 1,
    sharedCompute: true,
  });
  return pool;
}

/** Pool admission accounting: UTF-16 code units of the strings the task carries. */
function estimateWikiPageReadBytes(task: WikiPageReadTask): number {
  let chars = task.rootDir.length;
  for (const relativePath of task.relativePaths ?? []) {
    chars += relativePath.length;
  }
  for (const relativePath of task.excludePaths ?? []) {
    chars += relativePath.length;
  }
  chars +=
    task.select === "search"
      ? task.query.length
      : task.select === "lookup"
        ? task.lookup.length
        : 0;
  return chars * 2;
}

/** Run one page read task in the reader worker and return its typed selection. */
export async function readMemoryWikiPages<Task extends WikiPageReadTask>(
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

/** Plugin stop releases the worker; a read after the close settles recreates the pool. */
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
