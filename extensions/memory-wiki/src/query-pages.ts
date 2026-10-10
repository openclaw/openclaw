import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import {
  type ParsedWikiMarkdown,
  scanWikiPageSummary,
  type WikiPageSummary,
  WIKI_PAGE_GROUPS,
} from "./markdown.js";

export const QUERY_PAGE_READ_CONCURRENCY = 16;

export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
  parsed: ParsedWikiMarkdown;
};

export async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const files = await Promise.all(
    WIKI_PAGE_GROUPS.map(({ dir }) => listMemoryWikiPagePaths(rootDir, dir)),
  );
  return files.flat().toSorted((left, right) => left.localeCompare(right));
}

export async function readQueryableWikiPages(
  rootDir: string,
  signal?: AbortSignal,
): Promise<QueryableWikiPage[]> {
  signal?.throwIfAborted();
  const files = await listWikiMarkdownFiles(rootDir);
  return readQueryableWikiPagesByPaths(rootDir, files, signal);
}

export async function readQueryableWikiPagesByPaths(
  rootDir: string,
  files: string[],
  signal?: AbortSignal,
): Promise<QueryableWikiPage[]> {
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
        return scan.status === "valid" ? { ...scan.page, raw, parsed: scan.parsed } : null;
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
  return results.filter((page): page is QueryableWikiPage => page !== null);
}
