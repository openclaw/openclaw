import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
// Host side of the query reader pool: two lazily created workers that own the
// whole-vault scans (search and lookup) for wiki queries. Single-page reads stay
// on the calling thread (query.ts) so they never wait behind a scan.
import {
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
  type WorkerTaskResponse,
} from "openclaw/plugin-sdk/process-runtime";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import {
  excludeWikiPagePaths,
  readWikiPagesTask,
  resolveQueryableWikiPageByLookup,
  WIKI_SCAN_YIELD,
  type WikiPageKey,
  type WikiPageReadResult,
  type WikiPageReadScope,
  type WikiPageReadTask,
} from "./query-pages.js";
import {
  sortWikiSearchResults,
  type QueryableWikiPage,
  type WikiSearchMode,
  type WikiSearchResult,
} from "./query-scoring.js";

/**
 * The watchdog on a checkpoint reply, which the pool requires: the timer maximum, so a scan
 * keeps no deadline of its own. Caller deadlines and cancellation arrive through `signal`.
 */
const WIKI_SCAN_CHECKPOINT_WATCHDOG_MS = MAX_TIMER_TIMEOUT_MS;

/**
 * Answer a scan's checkpoint. The pool aborts `yieldSignal` when another task waits for this
 * task's shared compute permit or worker (it checks as each checkpoint opens); the scan then
 * returns what it has read, its permit goes to the waiting task, and the host resubmits the
 * rest. An uncontended scan stays one task, so it never pays a task boundary per segment.
 */
async function answerScanCheckpoint(
  _value: unknown,
  { yieldSignal }: { yieldSignal: AbortSignal },
): Promise<WorkerTaskResponse> {
  return {
    input: yieldSignal.aborted ? WIKI_SCAN_YIELD : null,
    timeoutMs: WIKI_SCAN_CHECKPOINT_WATCHDOG_MS,
  };
}

/** A whole-vault scan as callers submit it; the reader runs it as yielding pool tasks. */
export type WikiPageScanTask = WikiPageReadScope &
  (
    | { select: "search"; query: string; mode: WikiSearchMode; maxResults: number }
    | { select: "lookup"; lookup: string }
  );

export type WikiPageScanResult =
  | { select: "search"; results: WikiSearchResult[] }
  | { select: "lookup"; page: QueryableWikiPage | null };

/** What the pool runs: the listing and the scan reads; one-page reads stay in-thread. */
type WikiPagePoolTask = Exclude<WikiPageReadTask, { select: "page" }>;

const memoryWikiQueryReaderEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "query-reader.worker",
  distWorkerPath: "extensions/memory-wiki/src/query-reader.worker.js",
  package: { name: "@openclaw/memory-wiki", distWorkerPath: "src/query-reader.worker.js" },
} as const;

let pool: WorkerTaskPool<WikiPagePoolTask, WikiPageReadResult> | undefined;

function resolvePool(): WorkerTaskPool<WikiPagePoolTask, WikiPageReadResult> {
  // A pool that is closing stays referenced until close settles, so a read issued
  // during stop() fails with the pool's own closed error instead of opening an orphan.
  pool ??= new WorkerTaskPool<WikiPagePoolTask, WikiPageReadResult>({
    workerUrl: resolveRuntimeWorkerUrl(memoryWikiQueryReaderEntrypoint),
    // Two workers: a lookup can overtake a long search and two scans overlap; a third
    // queues. Each worker is a V8 isolate (about 100 MB heap peak while scanning a 140 MB,
    // 10,000-page vault), which is why the pool does not grow with the core count.
    maxWorkers: 2,
    sharedCompute: true,
  });
  return pool;
}

/** Pool admission accounting: UTF-16 code units of the strings the task carries. */
function estimateWikiPageReadBytes(task: WikiPagePoolTask): number {
  let chars = task.rootDir.length;
  const paths = task.select === "list" ? (task.excludePaths ?? []) : task.relativePaths;
  for (const relativePath of paths) {
    chars += relativePath.length;
  }
  if (task.select === "search") {
    chars += task.query.length;
  }
  return chars * 2;
}

async function runPoolTask<Task extends WikiPagePoolTask>(
  task: Task,
  signal: AbortSignal | undefined,
): Promise<Extract<WikiPageReadResult, { select: Task["select"] }>> {
  const result = await resolvePool().run(task, {
    inputBytes: estimateWikiPageReadBytes(task),
    ...(signal ? { signal } : {}),
    ...(task.select === "list" ? {} : { onRequest: answerScanCheckpoint }),
  });
  if (result.select === "refused") {
    throw new FsSafeError(result.code, result.message);
  }
  // A scan task reads at least one segment before it can yield, so each one makes progress.
  const stalled =
    "readPages" in result &&
    task.select !== "list" &&
    task.relativePaths.length > 0 &&
    result.readPages <= 0;
  if (result.select !== task.select || stalled) {
    throw new Error("Invalid memory wiki page read worker result");
  }
  // SAFETY: The discriminant check above pairs the reply with the submitted task.
  return result as Extract<WikiPageReadResult, { select: Task["select"] }>;
}

/**
 * Run one whole-vault scan in the reader pool and return its typed selection. The vault
 * is listed once, then read by one task that yields at a checkpoint when another task
 * waits; the host resubmits the unread rest until every page is read. Deadlines stay
 * with the caller, as on main: the wiki_search tool's 30 s deadline and turn
 * cancellation arrive through `signal`; a caller that passes none waits for the scan.
 */
export async function readMemoryWikiPages<Task extends WikiPageScanTask>(
  task: Task,
  options: { signal?: AbortSignal } = {},
): Promise<Extract<WikiPageScanResult, { select: Task["select"] }>> {
  const { rootDir, visibility } = task;
  const { signal } = options;
  const relativePaths = task.relativePaths
    ? excludeWikiPagePaths(task.relativePaths, task.excludePaths)
    : (
        await runPoolTask(
          {
            select: "list",
            rootDir,
            ...(task.excludePaths ? { excludePaths: task.excludePaths } : {}),
          },
          signal,
        )
      ).relativePaths;
  type Selection = Extract<WikiPageScanResult, { select: Task["select"] }>;
  const rest = (offset: number) => (offset === 0 ? relativePaths : relativePaths.slice(offset));
  if (task.select === "search") {
    const { query, mode, maxResults } = task;
    let results: WikiSearchResult[] = [];
    let offset = 0;
    do {
      const read = await runPoolTask(
        {
          select: "search",
          rootDir,
          visibility,
          relativePaths: rest(offset),
          query,
          mode,
          maxResults,
        },
        signal,
      );
      // Each task returns its top maxResults in order; merging it after the earlier tasks'
      // with a stable sort keeps listing order among ties, as the worker's own merge does.
      results = sortWikiSearchResults([...results, ...read.results]).slice(0, maxResults);
      offset += read.readPages;
    } while (offset < relativePaths.length);
    // SAFETY: This branch handles the search task, so the reply is its variant.
    return { select: "search", results } as Selection;
  }
  const keys: WikiPageKey[] = [];
  let offset = 0;
  do {
    const read = await runPoolTask(
      { select: "keys", rootDir, visibility, relativePaths: rest(offset) },
      signal,
    );
    keys.push(...read.keys);
    offset += read.readPages;
  } while (offset < relativePaths.length);
  // Resolve over the whole listing, then read the matched page on the calling thread
  // like any other single-page read. The page is read twice, so it must still match: a
  // page whose id changed in between resolves to nothing, like one that disappeared.
  const match = resolveQueryableWikiPageByLookup(keys, task.lookup);
  const { page } = match
    ? await readWikiPagesTask(
        { select: "page", rootDir, visibility, relativePaths: [match.relativePath] },
        signal,
      )
    : { page: null };
  const current = page && resolveQueryableWikiPageByLookup([page], task.lookup);
  // SAFETY: The only other scan task is a lookup, so the reply is its variant.
  return { select: "lookup", page: current ?? null } as Selection;
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
