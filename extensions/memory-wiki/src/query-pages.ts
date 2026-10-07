// Page reads for wiki queries. This module runs inside the query reader worker,
// so it carries no host-only state (pools, stores, config).
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import { scanWikiPageSummary, WIKI_PAGE_GROUPS } from "./markdown.js";
import {
  type QueryableWikiPage,
  sortWikiSearchResults,
  toWikiSearchResult,
  type WikiSearchMode,
  type WikiSearchResult,
} from "./query-scoring.js";

const QUERY_PAGE_READ_CONCURRENCY = 16;

/**
 * Pages a scan reads between two checkpoints. At each checkpoint the worker asks the host
 * whether to go on; it stops when another task is waiting for its shared compute permit
 * or its worker, so that task waits for one segment rather than the whole scan.
 */
const WIKI_SCAN_CHECKPOINT_PAGES = 64;

/** The host's checkpoint reply that ends a scan task early; the host resubmits the rest. */
export const WIKI_SCAN_YIELD = "yield";

/** Serializable sandbox scope for bridge pages; `null` admits every page. */
export type WikiPageVisibility = { scopedAgentId: string };

/** A scan's scope as callers pass it to the reader pool. */
export type WikiPageReadScope = {
  rootDir: string;
  /** Explicit page paths; the whole vault when absent. */
  relativePaths?: string[];
  /** Whole-vault reads skip pages an earlier candidate read already covered. */
  excludePaths?: string[];
  visibility: WikiPageVisibility | null;
};

/** What a lookup resolves on: the page's path and id. */
export type WikiPageKey = Pick<QueryableWikiPage, "relativePath" | "id">;

/** One read: list the vault, or read, parse and project an explicit list of pages. */
export type WikiPageReadTask =
  | { select: "list"; rootDir: string; excludePaths?: string[] }
  | ({ rootDir: string; relativePaths: string[]; visibility: WikiPageVisibility | null } & (
      | { select: "search"; query: string; mode: WikiSearchMode; maxResults: number }
      | { select: "keys" }
      | { select: "page" }
    ));

/** `readPages` counts the leading pages read before a checkpoint stopped the task. */
export type WikiPageReadResult =
  | { select: "list"; relativePaths: string[] }
  | { select: "search"; results: WikiSearchResult[]; readPages: number }
  | { select: "keys"; keys: WikiPageKey[]; readPages: number }
  | { select: "page"; page: QueryableWikiPage | null }
  | { select: "refused"; code: FsSafeError["code"]; message: string };

/** Cancellation checkpoint: an `AbortSignal`, or the pool task control in the worker. */
type WikiPageReadCancellation = Pick<AbortSignal, "throwIfAborted">;

/** Called between scan segments; resolves true when the scan should stop and return. */
type WikiPageReadYield = () => Promise<boolean>;

export function normalizeLookupKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.endsWith(".md") ? normalized : normalized.replace(/\/+$/, "");
}

async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const files = await Promise.all(
    WIKI_PAGE_GROUPS.map(({ dir }) => listMemoryWikiPagePaths(rootDir, dir)),
  );
  return files.flat().toSorted((left, right) => left.localeCompare(right));
}

export function excludeWikiPagePaths(relativePaths: string[], excludePaths?: string[]): string[] {
  if (!excludePaths?.length) {
    return relativePaths;
  }
  const excluded = new Set(excludePaths);
  return relativePaths.filter((relativePath) => !excluded.has(relativePath));
}

/** Read and parse pages in listing order, keeping only each page's projection. */
async function readQueryableWikiPagesByPaths<T>(
  rootDir: string,
  files: string[],
  project: (page: QueryableWikiPage) => T | null,
  signal?: WikiPageReadCancellation,
): Promise<T[]> {
  signal?.throwIfAborted();
  if (files.length === 0) {
    return [];
  }
  // Wiki pages retain their existing size and hardlink support as user artifacts.
  // Verify the opened file's vault boundary without imposing secret-file defaults.
  const vault = await fsRoot(rootDir, { hardlinks: "allow", maxBytes: Infinity });
  const { results } = await runTasksWithConcurrency({
    tasks: files.map((relativePath) => async () => {
      signal?.throwIfAborted();
      const absolutePath = path.join(rootDir, relativePath);
      try {
        const raw = await vault.readText(relativePath);
        signal?.throwIfAborted();
        const scan = scanWikiPageSummary({ absolutePath, relativePath, raw, includeLinks: false });
        return scan.status === "valid" ? project({ ...scan.page, raw, parsed: scan.parsed }) : null;
      } catch (error) {
        // Compiled candidates and directory listings can outlive a page. Only absence
        // may fall through to discovery; boundary refusals must remain terminal.
        if (
          error instanceof FsSafeError &&
          (error.code === "not-found" || error.code === "not-file")
        ) {
          return null;
        }
        throw error;
      }
    }),
    limit: QUERY_PAGE_READ_CONCURRENCY,
    errorMode: "stop",
    throwOnError: true,
  });
  return results.filter((result): result is T => result !== null);
}

function isBridgeCompiledPage(page: QueryableWikiPage): boolean {
  return (
    page.sourceType === "memory-bridge" ||
    page.sourceType === "memory-bridge-events" ||
    page.bridgeAgentIds.length > 0
  );
}

function isWikiPageVisible(page: QueryableWikiPage, visibility: WikiPageVisibility | null) {
  if (!visibility) {
    return true;
  }
  return (
    !isBridgeCompiledPage(page) ||
    (visibility.scopedAgentId.length > 0 &&
      page.bridgeAgentIds.some(
        (agentId) => normalizeLowercaseStringOrEmpty(agentId) === visibility.scopedAgentId,
      ))
  );
}

export function resolveQueryableWikiPageByLookup<Page extends WikiPageKey>(
  pages: Page[],
  lookup: string,
): Page | null {
  const key = normalizeLookupKey(lookup);
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  return (
    pages.find((page) => page.relativePath === key) ??
    pages.find((page) => page.relativePath === withExtension) ??
    pages.find((page) => page.relativePath.replace(/\.md$/i, "") === key) ??
    pages.find((page) => path.basename(page.relativePath, ".md") === key) ??
    pages.find((page) => page.id === key) ??
    null
  );
}

type WikiPageReadSelection<Task extends WikiPageReadTask> = Extract<
  WikiPageReadResult,
  { select: Task["select"] }
>;

/**
 * List the vault, or read, parse and score pages for one query task. Each page is
 * projected as it is read (a scoring result, a lookup key, or the one requested page),
 * so a read retains no page text or parse; boundary refusals propagate as
 * `FsSafeError`, and the cancellation checkpoint stops the read between pages. A search
 * or key read asks `shouldYield` between segments and returns early when it says so.
 */
export function readWikiPagesTask<Task extends WikiPageReadTask>(
  task: Task,
  signal?: WikiPageReadCancellation,
  shouldYield?: WikiPageReadYield,
): Promise<WikiPageReadSelection<Task>> {
  // SAFETY: Every branch below returns the variant named by the task's `select`.
  return runWikiPageReadTask(task, signal, shouldYield) as Promise<WikiPageReadSelection<Task>>;
}

async function runWikiPageReadTask(
  task: WikiPageReadTask,
  signal?: WikiPageReadCancellation,
  shouldYield?: WikiPageReadYield,
): Promise<Exclude<WikiPageReadResult, { select: "refused" }>> {
  signal?.throwIfAborted();
  if (task.select === "list") {
    const files = await listWikiMarkdownFiles(task.rootDir);
    return { select: "list", relativePaths: excludeWikiPagePaths(files, task.excludePaths) };
  }
  const { relativePaths } = task;
  const visible = (page: QueryableWikiPage) =>
    isWikiPageVisible(page, task.visibility) ? page : null;
  if (task.select === "search" || task.select === "keys") {
    let results: WikiSearchResult[] = [];
    const keys: WikiPageKey[] = [];
    let readPages = 0;
    while (readPages < relativePaths.length) {
      if (readPages > 0 && shouldYield && (await shouldYield())) {
        break;
      }
      const segment = relativePaths.slice(readPages, readPages + WIKI_SCAN_CHECKPOINT_PAGES);
      if (task.select === "search") {
        const found = await readQueryableWikiPagesByPaths(
          task.rootDir,
          segment,
          (page) => {
            if (!visible(page)) {
              return null;
            }
            const result = toWikiSearchResult(page, task.query, task.mode);
            return result.score > 0 ? result : null;
          },
          signal,
        );
        // A stable sort of the running top followed by the segment keeps ties in listing
        // order, as one whole-list sort does, and a page cut here already trails
        // maxResults better pages.
        results = sortWikiSearchResults([...results, ...found]).slice(0, task.maxResults);
      } else {
        const found = await readQueryableWikiPagesByPaths(
          task.rootDir,
          segment,
          (page) => (visible(page) ? { relativePath: page.relativePath, id: page.id } : null),
          signal,
        );
        keys.push(...found);
      }
      readPages += segment.length;
    }
    return task.select === "search"
      ? { select: "search", results, readPages }
      : { select: "keys", keys, readPages };
  }
  const pages = await readQueryableWikiPagesByPaths(
    task.rootDir,
    relativePaths.slice(0, 1),
    visible,
    signal,
  );
  return { select: "page", page: pages[0] ?? null };
}
