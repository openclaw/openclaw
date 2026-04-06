import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-host-files";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig, WikiSearchBackend, WikiSearchCorpus } from "./config.js";
import { parseWikiMarkdown, toWikiPageSummary, type WikiPageSummary } from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const QUERY_DIRS = ["entities", "concepts", "sources", "syntheses", "reports"] as const;

export type WikiSearchResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageSummary["kind"] | "memory";
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  memorySource?: MemorySearchResult["source"];
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export type WikiGetResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageSummary["kind"] | "memory";
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
};

type QuerySearchOverrides = {
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
};

async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const files = (
    await Promise.all(
      QUERY_DIRS.map(async (relativeDir) => {
        const dirPath = path.join(rootDir, relativeDir);
        const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
        return entries
          .filter(
            (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md",
          )
          .map((entry) => path.join(relativeDir, entry.name));
      }),
    )
  ).flat();
  return files.toSorted((left, right) => left.localeCompare(right));
}

export async function readQueryableWikiPages(rootDir: string): Promise<QueryableWikiPage[]> {
  const files = await listWikiMarkdownFiles(rootDir);
  const pages = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      const summary = toWikiPageSummary({ absolutePath, relativePath, raw });
      return summary ? { ...summary, raw } : null;
    }),
  );
  return pages.flatMap((page) => (page ? [page] : []));
}

function buildSnippet(raw: string, query: string): string {
  const queryLower = query.toLowerCase();
  const matchingLine = raw
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes(queryLower) && line.trim().length > 0);
  return (
    matchingLine?.trim() ||
    raw
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ||
    ""
  );
}

function scorePage(page: QueryableWikiPage, query: string): number {
  const queryLower = query.toLowerCase();
  const titleLower = page.title.toLowerCase();
  const pathLower = page.relativePath.toLowerCase();
  const idLower = page.id?.toLowerCase() ?? "";
  const rawLower = page.raw.toLowerCase();
  if (
    !(
      titleLower.includes(queryLower) ||
      pathLower.includes(queryLower) ||
      idLower.includes(queryLower) ||
      rawLower.includes(queryLower)
    )
  ) {
    return 0;
  }

  let score = 1;
  if (titleLower === queryLower) {
    score += 50;
  } else if (titleLower.includes(queryLower)) {
    score += 20;
  }
  if (pathLower.includes(queryLower)) {
    score += 10;
  }
  if (idLower.includes(queryLower)) {
    score += 10;
  }
  const bodyOccurrences = rawLower.split(queryLower).length - 1;
  score += Math.min(20, bodyOccurrences);
  return score;
}

function normalizeLookupKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.endsWith(".md") ? normalized : normalized.replace(/\/+$/, "");
}

function buildLookupCandidates(lookup: string): string[] {
  const normalized = normalizeLookupKey(lookup);
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  return [...new Set([normalized, withExtension])];
}

function shouldSearchWiki(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.corpus === "wiki" || config.search.corpus === "all";
}

function shouldSearchSharedMemory(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): boolean {
  return (
    config.search.backend === "shared" &&
    appConfig !== undefined &&
    (config.search.corpus === "memory" || config.search.corpus === "all")
  );
}

async function resolveActiveMemoryManager(appConfig?: OpenClawConfig) {
  if (!appConfig) {
    return null;
  }
  try {
    const { manager } = await getActiveMemorySearchManager({
      cfg: appConfig,
      agentId: resolveDefaultAgentId(appConfig),
    });
    return manager;
  } catch {
    return null;
  }
}

function buildMemorySearchTitle(resultPath: string): string {
  const basename = path.basename(resultPath, path.extname(resultPath));
  return basename.length > 0 ? basename : resultPath;
}

function applySearchOverrides(
  config: ResolvedMemoryWikiConfig,
  overrides?: QuerySearchOverrides,
): ResolvedMemoryWikiConfig {
  if (!overrides?.searchBackend && !overrides?.searchCorpus) {
    return config;
  }
  return {
    ...config,
    search: {
      backend: overrides.searchBackend ?? config.search.backend,
      corpus: overrides.searchCorpus ?? config.search.corpus,
    },
  };
}

function buildWikiProvenanceLabel(
  page: Pick<
    WikiPageSummary,
    | "sourceType"
    | "provenanceMode"
    | "bridgeRelativePath"
    | "unsafeLocalRelativePath"
    | "relativePath"
  >,
): string | undefined {
  if (page.sourceType === "memory-bridge-events") {
    return `bridge events: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.sourceType === "memory-bridge") {
    return `bridge: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") {
    return `unsafe-local: ${page.unsafeLocalRelativePath ?? page.relativePath}`;
  }
  return undefined;
}

function toWikiSearchResult(page: QueryableWikiPage, query: string): WikiSearchResult {
  return {
    corpus: "wiki",
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    score: scorePage(page, query),
    snippet: buildSnippet(page.raw, query),
    ...(page.id ? { id: page.id } : {}),
    ...(page.sourceType ? { sourceType: page.sourceType } : {}),
    ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
    ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
    ...(buildWikiProvenanceLabel(page) ? { provenanceLabel: buildWikiProvenanceLabel(page) } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
  };
}

function toMemoryWikiSearchResult(result: MemorySearchResult): WikiSearchResult {
  return {
    corpus: "memory",
    path: result.path,
    title: buildMemorySearchTitle(result.path),
    kind: "memory",
    score: result.score,
    snippet: result.snippet,
    startLine: result.startLine,
    endLine: result.endLine,
    memorySource: result.source,
    ...(result.citation ? { citation: result.citation } : {}),
  };
}

export function resolveQueryableWikiPageByLookup(
  pages: QueryableWikiPage[],
  lookup: string,
): QueryableWikiPage | null {
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

export async function searchMemoryWiki(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  query: string;
  maxResults?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiSearchResult[]> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  await initializeMemoryWikiVault(effectiveConfig);
  const maxResults = Math.max(1, params.maxResults ?? 10);

  const wikiResults = shouldSearchWiki(effectiveConfig)
    ? (await readQueryableWikiPages(effectiveConfig.vault.path))
        .map((page) => toWikiSearchResult(page, params.query))
        .filter((page) => page.score > 0)
    : [];

  const sharedMemoryManager = shouldSearchSharedMemory(effectiveConfig, params.appConfig)
    ? await resolveActiveMemoryManager(params.appConfig)
    : null;
  const memoryResults = sharedMemoryManager
    ? (await sharedMemoryManager.search(params.query, { maxResults })).map((result) =>
        toMemoryWikiSearchResult(result),
      )
    : [];

  return [...wikiResults, ...memoryResults]
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, maxResults);
}

export async function getMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiGetResult | null> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  await initializeMemoryWikiVault(effectiveConfig);
  const fromLine = Math.max(1, params.fromLine ?? 1);
  const lineCount = Math.max(1, params.lineCount ?? 200);

  if (shouldSearchWiki(effectiveConfig)) {
    const pages = await readQueryableWikiPages(effectiveConfig.vault.path);
    const page = resolveQueryableWikiPageByLookup(pages, params.lookup);
    if (page) {
      const parsed = parseWikiMarkdown(page.raw);
      const lines = parsed.body.split(/\r?\n/);
      const slice = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");

      return {
        corpus: "wiki",
        path: page.relativePath,
        title: page.title,
        kind: page.kind,
        content: slice,
        fromLine,
        lineCount,
        ...(page.id ? { id: page.id } : {}),
        ...(page.sourceType ? { sourceType: page.sourceType } : {}),
        ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
        ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
        ...(buildWikiProvenanceLabel(page)
          ? { provenanceLabel: buildWikiProvenanceLabel(page) }
          : {}),
        ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
      };
    }
  }

  if (!shouldSearchSharedMemory(effectiveConfig, params.appConfig)) {
    return null;
  }

  const manager = await resolveActiveMemoryManager(params.appConfig);
  if (!manager) {
    return null;
  }

  for (const relPath of buildLookupCandidates(params.lookup)) {
    try {
      const result = await manager.readFile({
        relPath,
        from: fromLine,
        lines: lineCount,
      });
      return {
        corpus: "memory",
        path: result.path,
        title: buildMemorySearchTitle(result.path),
        kind: "memory",
        content: result.text,
        fromLine,
        lineCount,
      };
    } catch {
      continue;
    }
  }

  return null;
}
