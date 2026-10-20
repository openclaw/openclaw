import path from "node:path";
import {
  listWikiMarkdownFiles,
  readQueryableWikiPagesByPaths,
  type QueryableWikiPage,
} from "./query-pages.js";
import { normalizeLookupKey } from "./query-shared-memory.js";
import { WIKI_PAGE_GROUPS } from "./wiki-page-kinds.js";

type LookupPage = { relativePath: string; id?: string | undefined };

// Keep path priority identical for loaded pages and filename-only discovery.
function createPathLookupMatchers(key: string): Array<(relativePath: string) => boolean> {
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  return [
    (file) => file === key,
    (file) => file === withExtension,
    (file) => file.replace(/\.md$/i, "") === key,
    (file) => path.basename(file, ".md") === key,
  ];
}

/** Resolves a wiki_get lookup over pages already read: four path tiers, then the page ID. */
export function resolveQueryableWikiPageByLookup<Page extends LookupPage>(
  pages: Page[],
  lookup: string,
): Page | null {
  const key = normalizeLookupKey(lookup);
  for (const matches of createPathLookupMatchers(key)) {
    const page = pages.find((candidate) => matches(candidate.relativePath));
    if (page) {
      return page;
    }
  }
  return pages.find((page) => page.id === key) ?? null;
}

function isExactWikiPagePath(lookup: string): boolean {
  const [directory, ...pageSegments] = lookup.split("/");
  return (
    WIKI_PAGE_GROUPS.some(({ dir }) => dir === directory) &&
    pageSegments.length > 0 &&
    pageSegments.every((segment) => segment && segment !== "." && segment !== "..") &&
    lookup.endsWith(".md") &&
    path.posix.basename(lookup) !== "index.md"
  );
}

export async function resolveQueryableWikiPageForLookup(params: {
  rootDir: string;
  lookup: string;
  canReadPage: (page: QueryableWikiPage) => boolean;
}): Promise<QueryableWikiPage | null> {
  const key = normalizeLookupKey(params.lookup);
  if (isExactWikiPagePath(key)) {
    const [page] = await readQueryableWikiPagesByPaths(params.rootDir, [key]);
    if (page && params.canReadPage(page)) {
      return page;
    }
  }
  const files = await listWikiMarkdownFiles(params.rootDir);
  // Read path tiers in listing order before falling back to IDs. The digest cannot
  // prove which pages carry an ID after the last compile, so ID lookup reads all pages.
  const candidatePaths = new Set(
    createPathLookupMatchers(key).flatMap((matches) => files.filter(matches)),
  );
  for (const candidatePath of candidatePaths) {
    const [page] = await readQueryableWikiPagesByPaths(params.rootDir, [candidatePath]);
    if (page && params.canReadPage(page)) {
      return page;
    }
  }
  return resolveQueryableWikiPageByLookup(
    (await readQueryableWikiPagesByPaths(params.rootDir, files)).filter(params.canReadPage),
    key,
  );
}
