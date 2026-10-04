import path from "node:path";
import { normalizeLookupKey } from "./query-shared-memory.js";

type LookupPage = { relativePath: string; id?: string | undefined };

/** Resolves a wiki_get lookup over pages already read: four path tiers, then the page ID. */
export function resolveQueryableWikiPageByLookup<Page extends LookupPage>(
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

/**
 * Resolves only the path-shaped tiers of resolveQueryableWikiPageByLookup from the file
 * listing, reading candidates one at a time in tier then path order until one is valid and
 * visible. A hit is exactly the page the full-vault read would return because both walk the
 * same sorted listing and the full read keeps listing order. Pages matched only by ID, and
 * every miss, return null so the caller keeps the full read; the compiled digest cannot
 * prove which pages carry an ID since the last compile.
 */
async function findQueryableWikiPageByPathLookup<Page extends LookupPage>(params: {
  files: string[];
  lookup: string;
  readPage: (relativePath: string) => Promise<Page | null>;
  canReadPage: (page: Page) => boolean;
}): Promise<Page | null> {
  const key = normalizeLookupKey(params.lookup);
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  const tiers = [
    (file: string) => file === key,
    (file: string) => file === withExtension,
    (file: string) => file.replace(/\.md$/i, "") === key,
    (file: string) => path.basename(file, ".md") === key,
  ];
  const candidatePaths = new Set(tiers.flatMap((matches) => params.files.filter(matches)));
  for (const candidatePath of candidatePaths) {
    const page = await params.readPage(candidatePath);
    if (page && params.canReadPage(page)) {
      return page;
    }
  }
  return null;
}

/**
 * Resolves a wiki_get lookup to the page a read of the whole vault would pick, reading as
 * few pages as possible: the exact path, then the path tiers from the listing, then every
 * page. One listing serves both the path tiers and the full read.
 */
export async function resolveQueryableWikiPageForLookup<Page extends LookupPage>(params: {
  lookup: string;
  readExactPage: () => Promise<Page | null>;
  listFiles: () => Promise<string[]>;
  readPages: (relativePaths: string[]) => Promise<Page[]>;
  canReadPage: (page: Page) => boolean;
}): Promise<Page | null> {
  const exactPage = await params.readExactPage();
  if (exactPage && params.canReadPage(exactPage)) {
    return resolveQueryableWikiPageByLookup([exactPage], params.lookup);
  }
  const files = await params.listFiles();
  const pathPage = await findQueryableWikiPageByPathLookup({
    files,
    lookup: params.lookup,
    readPage: async (relativePath) => (await params.readPages([relativePath]))[0] ?? null,
    canReadPage: params.canReadPage,
  });
  return (
    pathPage ??
    resolveQueryableWikiPageByLookup(
      (await params.readPages(files)).filter(params.canReadPage),
      params.lookup,
    )
  );
}
