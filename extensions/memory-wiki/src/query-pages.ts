// Page reads for wiki queries. This module runs inside the query reader worker,
// so it carries no host-only state (pools, stores, config).
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import {
  type ParsedWikiMarkdown,
  scanWikiPageSummary,
  type WikiPageSummary,
  WIKI_PAGE_GROUPS,
} from "./markdown.js";
import {
  sortWikiSearchResults,
  toWikiSearchResult,
  type WikiSearchMode,
  type WikiSearchResult,
} from "./query-scoring.js";

const QUERY_PAGE_READ_CONCURRENCY = 16;

export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
  parsed: ParsedWikiMarkdown;
};

/** Serializable sandbox scope for bridge pages; `null` admits every page. */
export type WikiPageVisibility = { scopedAgentId: string };

type WikiPageReadScope = {
  rootDir: string;
  /** Explicit page paths; the whole vault when absent. */
  relativePaths?: string[];
  /** Whole-vault reads skip pages an earlier candidate read already covered. */
  excludePaths?: string[];
  visibility: WikiPageVisibility | null;
};

export type WikiPageReadTask = WikiPageReadScope &
  (
    | { select: "search"; query: string; mode: WikiSearchMode; maxResults: number }
    | { select: "lookup"; lookup: string }
    | { select: "page" }
  );

export type WikiPageReadResult =
  | { select: "search"; results: WikiSearchResult[] }
  | { select: "lookup"; page: QueryableWikiPage | null }
  | { select: "page"; page: QueryableWikiPage | null }
  | { select: "refused"; code: FsSafeError["code"]; message: string };

/** Cancellation checkpoint: an `AbortSignal`, or the pool task control in the worker. */
type WikiPageReadCancellation = Pick<AbortSignal, "throwIfAborted">;

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

function resolveQueryableWikiPageByLookup<
  Page extends Pick<QueryableWikiPage, "relativePath" | "id">,
>(pages: Page[], lookup: string): Page | null {
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
 * Read, parse and score pages for one query task. Each page is projected as it is
 * read (a scoring result, a lookup key, or the one requested page), so a whole-vault
 * read retains no page text or parse; boundary refusals propagate as `FsSafeError`,
 * and the cancellation checkpoint stops the scan between pages.
 */
export function readWikiPagesTask<Task extends WikiPageReadTask>(
  task: Task,
  signal?: WikiPageReadCancellation,
): Promise<WikiPageReadSelection<Task>> {
  // SAFETY: Every branch below returns the variant named by the task's `select`.
  return runWikiPageReadTask(task, signal) as Promise<WikiPageReadSelection<Task>>;
}

async function runWikiPageReadTask(
  task: WikiPageReadTask,
  signal?: WikiPageReadCancellation,
): Promise<Exclude<WikiPageReadResult, { select: "refused" }>> {
  signal?.throwIfAborted();
  let relativePaths = task.relativePaths ?? (await listWikiMarkdownFiles(task.rootDir));
  if (task.excludePaths?.length) {
    const excluded = new Set(task.excludePaths);
    relativePaths = relativePaths.filter((relativePath) => !excluded.has(relativePath));
  }
  const visible = (page: QueryableWikiPage) =>
    isWikiPageVisible(page, task.visibility) ? page : null;
  const readPage = async (relativePath: string) =>
    (await readQueryableWikiPagesByPaths(task.rootDir, [relativePath], visible, signal))[0] ?? null;
  if (task.select === "search") {
    const results = await readQueryableWikiPagesByPaths(
      task.rootDir,
      relativePaths,
      (page) => {
        if (!visible(page)) {
          return null;
        }
        const result = toWikiSearchResult(page, task.query, task.mode);
        return result.score > 0 ? result : null;
      },
      signal,
    );
    return { select: "search", results: sortWikiSearchResults(results).slice(0, task.maxResults) };
  }
  if (task.select === "lookup") {
    // Resolve on keys first; the matched page is read again so only it is retained.
    const keys = await readQueryableWikiPagesByPaths(
      task.rootDir,
      relativePaths,
      (page) => (visible(page) ? { relativePath: page.relativePath, id: page.id } : null),
      signal,
    );
    const match = resolveQueryableWikiPageByLookup(keys, task.lookup);
    return { select: "lookup", page: match ? await readPage(match.relativePath) : null };
  }
  const [relativePath] = relativePaths;
  return { select: "page", page: relativePath ? await readPage(relativePath) : null };
}
