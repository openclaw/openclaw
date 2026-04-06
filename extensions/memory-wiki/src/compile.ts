import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  formatWikiLink,
  parseWikiMarkdown,
  renderWikiMarkdown,
  toWikiPageSummary,
  type WikiPageKind,
  type WikiPageSummary,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const COMPILE_PAGE_GROUPS: Array<{ kind: WikiPageKind; dir: string; heading: string }> = [
  { kind: "source", dir: "sources", heading: "Sources" },
  { kind: "entity", dir: "entities", heading: "Entities" },
  { kind: "concept", dir: "concepts", heading: "Concepts" },
  { kind: "synthesis", dir: "syntheses", heading: "Syntheses" },
  { kind: "report", dir: "reports", heading: "Reports" },
];
const DASHBOARD_STALE_PAGE_DAYS = 30;

type DashboardPageDefinition = {
  id: string;
  title: string;
  relativePath: string;
  buildBody: (params: {
    config: ResolvedMemoryWikiConfig;
    pages: WikiPageSummary[];
    now: Date;
  }) => string;
};

const DASHBOARD_PAGES: DashboardPageDefinition[] = [
  {
    id: "report.open-questions",
    title: "Open Questions",
    relativePath: "reports/open-questions.md",
    buildBody: ({ config, pages }) => {
      const matches = pages.filter((page) => page.questions.length > 0);
      if (matches.length === 0) {
        return "- No open questions right now.";
      }
      return [
        `- Pages with open questions: ${matches.length}`,
        "",
        ...matches.map(
          (page) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: ${page.questions.join(" | ")}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.contradictions",
    title: "Contradictions",
    relativePath: "reports/contradictions.md",
    buildBody: ({ config, pages }) => {
      const matches = pages.filter((page) => page.contradictions.length > 0);
      if (matches.length === 0) {
        return "- No contradictions flagged right now.";
      }
      return [
        `- Pages with contradictions: ${matches.length}`,
        "",
        ...matches.map(
          (page) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: ${page.contradictions.join(" | ")}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.low-confidence",
    title: "Low Confidence",
    relativePath: "reports/low-confidence.md",
    buildBody: ({ config, pages }) => {
      const matches = pages
        .filter((page) => typeof page.confidence === "number" && page.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      if (matches.length === 0) {
        return "- No low-confidence pages right now.";
      }
      return [
        `- Low-confidence pages: ${matches.length}`,
        "",
        ...matches.map(
          (page) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: confidence ${(page.confidence ?? 0).toFixed(2)}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.stale-pages",
    title: "Stale Pages",
    relativePath: "reports/stale-pages.md",
    buildBody: ({ config, pages, now }) => {
      const staleBeforeMs = now.getTime() - DASHBOARD_STALE_PAGE_DAYS * 24 * 60 * 60 * 1000;
      const matches = pages
        .filter((page) => page.kind !== "report")
        .flatMap((page) => {
          if (!page.updatedAt) {
            return [{ page, reason: "missing updatedAt" }];
          }
          const updatedAtMs = Date.parse(page.updatedAt);
          if (!Number.isFinite(updatedAtMs) || updatedAtMs > staleBeforeMs) {
            return [];
          }
          return [{ page, reason: `updated ${page.updatedAt}` }];
        })
        .toSorted((left, right) => left.page.title.localeCompare(right.page.title));
      if (matches.length === 0) {
        return `- No stale pages older than ${DASHBOARD_STALE_PAGE_DAYS} days.`;
      }
      return [
        `- Stale pages: ${matches.length}`,
        "",
        ...matches.map(
          ({ page, reason }) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: ${reason}`,
        ),
      ].join("\n");
    },
  },
];

export type CompileMemoryWikiResult = {
  vaultRoot: string;
  pageCounts: Record<WikiPageKind, number>;
  pages: WikiPageSummary[];
  updatedFiles: string[];
};

export type RefreshMemoryWikiIndexesResult = {
  refreshed: boolean;
  reason: "auto-compile-disabled" | "no-import-changes" | "missing-indexes" | "import-changed";
  compile?: CompileMemoryWikiResult;
};

async function collectMarkdownFiles(rootDir: string, relativeDir: string): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(relativeDir, entry.name))
    .filter((relativePath) => path.basename(relativePath) !== "index.md")
    .toSorted((left, right) => left.localeCompare(right));
}

async function readPageSummaries(rootDir: string): Promise<WikiPageSummary[]> {
  const filePaths = (
    await Promise.all(COMPILE_PAGE_GROUPS.map((group) => collectMarkdownFiles(rootDir, group.dir)))
  ).flat();

  const pages = await Promise.all(
    filePaths.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      return toWikiPageSummary({ absolutePath, relativePath, raw });
    }),
  );

  return pages
    .flatMap((page) => (page ? [page] : []))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

function buildPageCounts(pages: WikiPageSummary[]): Record<WikiPageKind, number> {
  return {
    entity: pages.filter((page) => page.kind === "entity").length,
    concept: pages.filter((page) => page.kind === "concept").length,
    source: pages.filter((page) => page.kind === "source").length,
    synthesis: pages.filter((page) => page.kind === "synthesis").length,
    report: pages.filter((page) => page.kind === "report").length,
  };
}

function normalizeComparableTarget(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function uniquePages(pages: WikiPageSummary[]): WikiPageSummary[] {
  const seen = new Set<string>();
  const unique: WikiPageSummary[] = [];
  for (const page of pages) {
    const key = page.id ?? page.relativePath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(page);
  }
  return unique;
}

function buildPageLookupKeys(page: WikiPageSummary): Set<string> {
  const keys = new Set<string>();
  keys.add(normalizeComparableTarget(page.relativePath));
  keys.add(normalizeComparableTarget(page.relativePath.replace(/\.md$/i, "")));
  keys.add(normalizeComparableTarget(page.title));
  if (page.id) {
    keys.add(normalizeComparableTarget(page.id));
  }
  return keys;
}

function renderWikiPageLinks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): string {
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

function buildRelatedBlockBody(params: {
  config: ResolvedMemoryWikiConfig;
  page: WikiPageSummary;
  allPages: WikiPageSummary[];
}): string {
  const candidatePages = params.allPages.filter((candidate) => candidate.kind !== "report");
  const pagesById = new Map(
    candidatePages.flatMap((candidate) =>
      candidate.id ? [[candidate.id, candidate] as const] : [],
    ),
  );
  const sourcePages = uniquePages(
    params.page.sourceIds.flatMap((sourceId) => {
      const page = pagesById.get(sourceId);
      return page ? [page] : [];
    }),
  );
  const backlinkKeys = buildPageLookupKeys(params.page);
  const backlinks = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (candidate.sourceIds.includes(params.page.id ?? "")) {
        return true;
      }
      return candidate.linkTargets.some((target) =>
        backlinkKeys.has(normalizeComparableTarget(target)),
      );
    }),
  );
  const relatedPages = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (sourcePages.some((sourcePage) => sourcePage.relativePath === candidate.relativePath)) {
        return false;
      }
      if (backlinks.some((backlink) => backlink.relativePath === candidate.relativePath)) {
        return false;
      }
      if (params.page.sourceIds.length === 0 || candidate.sourceIds.length === 0) {
        return false;
      }
      return params.page.sourceIds.some((sourceId) => candidate.sourceIds.includes(sourceId));
    }),
  );

  const sections: string[] = [];
  if (sourcePages.length > 0) {
    sections.push(
      "### Sources",
      renderWikiPageLinks({ config: params.config, pages: sourcePages }),
    );
  }
  if (backlinks.length > 0) {
    sections.push(
      "### Referenced By",
      renderWikiPageLinks({ config: params.config, pages: backlinks }),
    );
  }
  if (relatedPages.length > 0) {
    sections.push(
      "### Related Pages",
      renderWikiPageLinks({ config: params.config, pages: relatedPages }),
    );
  }
  if (sections.length === 0) {
    return "- No related pages yet.";
  }
  return sections.join("\n\n");
}

async function refreshPageRelatedBlocks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createBacklinks) {
    return [];
  }
  const updatedFiles: string[] = [];
  for (const page of params.pages) {
    if (page.kind === "report") {
      continue;
    }
    const original = await fs.readFile(page.absolutePath, "utf8");
    const updated = withTrailingNewline(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Related",
        startMarker: WIKI_RELATED_START_MARKER,
        endMarker: WIKI_RELATED_END_MARKER,
        body: buildRelatedBlockBody({
          config: params.config,
          page,
          allPages: params.pages,
        }),
      }),
    );
    if (updated === original) {
      continue;
    }
    await fs.writeFile(page.absolutePath, updated, "utf8");
    updatedFiles.push(page.absolutePath);
  }
  return updatedFiles;
}

function renderSectionList(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  emptyText: string;
}): string {
  if (params.pages.length === 0) {
    return `- ${params.emptyText}`;
  }
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

async function writeManagedMarkdownFile(params: {
  filePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): Promise<boolean> {
  const original = await fs.readFile(params.filePath, "utf8").catch(() => `# ${params.title}\n`);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: params.startMarker,
    endMarker: params.endMarker,
    body: params.body,
  });
  const rendered = withTrailingNewline(updated);
  if (rendered === original) {
    return false;
  }
  await fs.writeFile(params.filePath, rendered, "utf8");
  return true;
}

async function writeDashboardPage(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  definition: DashboardPageDefinition;
  pages: WikiPageSummary[];
  now: Date;
}): Promise<boolean> {
  const filePath = path.join(params.rootDir, params.definition.relativePath);
  const original = await fs.readFile(filePath, "utf8").catch(() =>
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status: "active",
      },
      body: `# ${params.definition.title}\n`,
    }),
  );
  const parsed = parseWikiMarkdown(original);
  const originalBody =
    parsed.body.trim().length > 0 ? parsed.body : `# ${params.definition.title}\n`;
  const updatedBody = replaceManagedMarkdownBlock({
    original: originalBody,
    heading: "## Generated",
    startMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:start -->`,
    endMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:end -->`,
    body: params.definition.buildBody({
      config: params.config,
      pages: params.pages,
      now: params.now,
    }),
  });
  const preservedUpdatedAt =
    typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim()
      ? parsed.frontmatter.updatedAt
      : params.now.toISOString();
  const stableRendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: preservedUpdatedAt,
      },
      body: updatedBody,
    }),
  );
  if (stableRendered === original) {
    return false;
  }
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: params.now.toISOString(),
      },
      body: updatedBody,
    }),
  );
  await fs.writeFile(filePath, rendered, "utf8");
  return true;
}

async function refreshDashboardPages(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createDashboards) {
    return [];
  }
  const now = new Date();
  const updatedFiles: string[] = [];
  for (const definition of DASHBOARD_PAGES) {
    if (
      await writeDashboardPage({
        config: params.config,
        rootDir: params.rootDir,
        definition,
        pages: params.pages,
        now,
      })
    ) {
      updatedFiles.push(path.join(params.rootDir, definition.relativePath));
    }
  }
  return updatedFiles;
}

function buildRootIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  counts: Record<WikiPageKind, number>;
}): string {
  const lines = [
    `- Render mode: \`${params.config.vault.renderMode}\``,
    `- Total pages: ${params.pages.length}`,
    `- Sources: ${params.counts.source}`,
    `- Entities: ${params.counts.entity}`,
    `- Concepts: ${params.counts.concept}`,
    `- Syntheses: ${params.counts.synthesis}`,
    `- Reports: ${params.counts.report}`,
  ];

  for (const group of COMPILE_PAGE_GROUPS) {
    lines.push("", `### ${group.heading}`);
    lines.push(
      renderSectionList({
        config: params.config,
        pages: params.pages.filter((page) => page.kind === group.kind),
        emptyText: `No ${group.heading.toLowerCase()} yet.`,
      }),
    );
  }

  return lines.join("\n");
}

function buildDirectoryIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  group: { kind: WikiPageKind; dir: string; heading: string };
}): string {
  return renderSectionList({
    config: params.config,
    pages: params.pages.filter((page) => page.kind === params.group.kind),
    emptyText: `No ${params.group.heading.toLowerCase()} yet.`,
  });
}

export async function compileMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<CompileMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  const rootDir = config.vault.path;
  let pages = await readPageSummaries(rootDir);
  const updatedFiles = await refreshPageRelatedBlocks({ config, pages });
  if (updatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir);
  }
  const dashboardUpdatedFiles = await refreshDashboardPages({ config, rootDir, pages });
  updatedFiles.push(...dashboardUpdatedFiles);
  if (dashboardUpdatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir);
  }
  const counts = buildPageCounts(pages);

  const rootIndexPath = path.join(rootDir, "index.md");
  if (
    await writeManagedMarkdownFile({
      filePath: rootIndexPath,
      title: "Wiki Index",
      startMarker: "<!-- openclaw:wiki:index:start -->",
      endMarker: "<!-- openclaw:wiki:index:end -->",
      body: buildRootIndexBody({ config, pages, counts }),
    })
  ) {
    updatedFiles.push(rootIndexPath);
  }

  for (const group of COMPILE_PAGE_GROUPS) {
    const filePath = path.join(rootDir, group.dir, "index.md");
    if (
      await writeManagedMarkdownFile({
        filePath,
        title: group.heading,
        startMarker: `<!-- openclaw:wiki:${group.dir}:index:start -->`,
        endMarker: `<!-- openclaw:wiki:${group.dir}:index:end -->`,
        body: buildDirectoryIndexBody({ config, pages, group }),
      })
    ) {
      updatedFiles.push(filePath);
    }
  }

  if (updatedFiles.length > 0) {
    await appendMemoryWikiLog(rootDir, {
      type: "compile",
      timestamp: new Date().toISOString(),
      details: {
        pageCounts: counts,
        updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath)),
      },
    });
  }

  return {
    vaultRoot: rootDir,
    pageCounts: counts,
    pages,
    updatedFiles,
  };
}

async function hasMissingWikiIndexes(rootDir: string): Promise<boolean> {
  const required = [
    path.join(rootDir, "index.md"),
    ...COMPILE_PAGE_GROUPS.map((group) => path.join(rootDir, group.dir, "index.md")),
  ];
  for (const filePath of required) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return true;
    }
  }
  return false;
}

export async function refreshMemoryWikiIndexesAfterImport(params: {
  config: ResolvedMemoryWikiConfig;
  syncResult: { importedCount: number; updatedCount: number; removedCount: number };
}): Promise<RefreshMemoryWikiIndexesResult> {
  await initializeMemoryWikiVault(params.config);
  if (!params.config.ingest.autoCompile) {
    return {
      refreshed: false,
      reason: "auto-compile-disabled",
    };
  }
  const importChanged =
    params.syncResult.importedCount > 0 ||
    params.syncResult.updatedCount > 0 ||
    params.syncResult.removedCount > 0;
  const missingIndexes = await hasMissingWikiIndexes(params.config.vault.path);
  if (!importChanged && !missingIndexes) {
    return {
      refreshed: false,
      reason: "no-import-changes",
    };
  }
  const compile = await compileMemoryWikiVault(params.config);
  return {
    refreshed: true,
    reason: missingIndexes && !importChanged ? "missing-indexes" : "import-changed",
    compile,
  };
}
