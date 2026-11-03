import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { retryTransientMemoryRead } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import {
  assessClaimFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  normalizeClaimStatus,
  type WikiFreshnessLevel,
} from "./claim-health.js";
import { DASHBOARD_PAGES, countBy, formatPageLink } from "./compile-dashboards.js";
import {
  readMemoryWikiDashboardState,
  resolveMemoryWikiCompiledCacheGeneration,
  setMemoryWikiDashboardState,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  buildMemoryWikiImportInsights,
  projectMemoryWikiImportInsight,
} from "./import-insights.js";
import {
  appendMemoryWikiLog,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
  resolveMemoryWikiVaultSourceGeneration,
} from "./log.js";
import {
  decodeWikiPageUtf8,
  parseWikiMarkdown,
  renderWikiMarkdown,
  scanWikiPageSummary,
  type WikiClaim,
  type WikiPageKind,
  type WikiPageSummary,
  WIKI_PAGE_GROUPS,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { readExistingWikiPageUtf8 } from "./vault-page-write.js";
import { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./vault.js";
import { buildMemoryWikiOverview, projectMemoryWikiOverviewItem } from "./wiki-overview.js";

const READ_PAGE_SUMMARIES_CONCURRENCY = 16;
const MAX_RELATED_PAGES_PER_SECTION = 12;
const MAX_SHARED_SOURCE_FANOUT = 24;

export type CompileMemoryWikiResult = Awaited<ReturnType<typeof compileMemoryWikiVaultUnlocked>>;

export type RefreshMemoryWikiIndexesResult = {
  refreshed: boolean;
  reason:
    | "auto-compile-disabled"
    | "no-import-changes"
    | "missing-indexes"
    | "missing-compiled-cache"
    | "import-changed";
  compile?: CompileMemoryWikiResult;
};

type CompileMemoryWikiOptions = {
  sourcePageWrites?: "update" | "preserve";
  signal?: AbortSignal;
};

async function readPageSummaries(rootDir: string, signal?: AbortSignal) {
  const filePaths = (
    await Promise.all(
      WIKI_PAGE_GROUPS.map(async (group) =>
        (await listMemoryWikiPagePaths(rootDir, group.dir)).toSorted((left, right) =>
          left.localeCompare(right),
        ),
      ),
    )
  ).flat();
  signal?.throwIfAborted();

  const readResult = await runTasksWithConcurrency({
    tasks: filePaths.map((relativePath) => async () => {
      signal?.throwIfAborted();
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await retryTransientMemoryRead(
        () => fs.readFile(absolutePath, "utf8"),
        `read wiki page ${absolutePath}`,
      );
      signal?.throwIfAborted();
      // Large imported pages are parsed off the request path, but the compiler
      // still yields between pages so background recovery cannot starve Gateway ticks.
      await yieldToEventLoop();
      signal?.throwIfAborted();
      const scan = scanWikiPageSummary({ absolutePath, relativePath, raw });
      if (scan.status !== "valid") {
        return { scan, importInsight: null, overviewItem: null };
      }
      const { parsed, ...summaryScan } = scan;
      return {
        scan: summaryScan,
        importInsight: projectMemoryWikiImportInsight(scan.page, parsed),
        overviewItem: projectMemoryWikiOverviewItem(scan.page, parsed.body),
      };
    }),
    limit: READ_PAGE_SUMMARIES_CONCURRENCY,
    errorMode: "stop",
  });
  if (readResult.hasError) {
    throw readResult.firstError;
  }
  signal?.throwIfAborted();

  return {
    pages: readResult.results
      .flatMap(({ scan }) => (scan.status === "valid" ? [scan.page] : []))
      .toSorted((left, right) => left.title.localeCompare(right.title)),
    frontmatterErrors: readResult.results.flatMap(({ scan }) =>
      scan.status === "invalid-frontmatter" ? [scan.error] : [],
    ),
    importInsights: readResult.results.flatMap(({ importInsight }) =>
      importInsight ? [importInsight] : [],
    ),
    overviewItems: readResult.results.flatMap(({ overviewItem }) =>
      overviewItem ? [overviewItem] : [],
    ),
  };
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, ""),
  );
}

function uniquePages(pages: WikiPageSummary[]): WikiPageSummary[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    const key = page.id ?? page.relativePath;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function renderWikiPageLinks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  emptyText?: string;
  sourceRelativeTo?: string;
}): string {
  if (params.pages.length === 0 && params.emptyText) {
    return `- ${params.emptyText}`;
  }
  return params.pages
    .map((page) => `- ${formatPageLink(params.config, page, params.sourceRelativeTo)}`)
    .join("\n");
}

function buildRelatedBlockBody(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  candidates: WikiPageSummary[],
  pagesById: Map<string, WikiPageSummary>,
): string {
  const otherPages = candidates.filter((candidate) => candidate.relativePath !== page.relativePath);
  const sourceIds = new Set(page.sourceIds);
  const sourceFanout = countBy(
    otherPages.flatMap((candidate) => candidate.sourceIds.filter((id) => sourceIds.has(id))),
  );
  const sourcePages = uniquePages(page.sourceIds.flatMap((id) => pagesById.get(id) ?? []));
  const backlinkKeys = new Set(
    [page.relativePath, page.title, ...(page.id ? [page.id] : [])].map(normalizeComparableTarget),
  );
  const backlinks = uniquePages(
    otherPages.filter(
      (candidate) =>
        candidate.sourceIds.includes(page.id ?? "") ||
        candidate.linkTargets.some((target) => backlinkKeys.has(normalizeComparableTarget(target))),
    ),
  );
  const backlinkPages =
    backlinks.length <= MAX_SHARED_SOURCE_FANOUT
      ? backlinks.slice(0, MAX_RELATED_PAGES_PER_SECTION)
      : [];
  const excluded = new Set([...sourcePages, ...backlinkPages].map((entry) => entry.relativePath));
  const relatedPages = uniquePages(
    otherPages.filter(
      (candidate) =>
        !excluded.has(candidate.relativePath) &&
        page.sourceIds.some(
          (id) =>
            candidate.sourceIds.includes(id) &&
            (sourceFanout.get(id) ?? 0) <= MAX_SHARED_SOURCE_FANOUT,
        ),
    ),
  ).slice(0, MAX_RELATED_PAGES_PER_SECTION);
  const groups: Array<[string, WikiPageSummary[]]> = [
    ["Sources", sourcePages],
    ["Referenced By", backlinkPages],
    ["Related Pages", relatedPages],
  ];
  return (
    groups
      .filter(([, pages]) => pages.length > 0)
      .map(
        ([heading, pages]) =>
          `### ${heading}\n\n${renderWikiPageLinks({ config, pages, sourceRelativeTo: page.relativePath })}`,
      )
      .join("\n\n") || "- No related pages yet."
  );
}

async function refreshPageRelatedBlocks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!params.config.render.createBacklinks) {
    return [];
  }
  const root = await fsRoot(params.config.vault.path);
  const updatedFiles: string[] = [];
  const candidates = params.pages.filter((page) => page.kind !== "report");
  const pagesById = new Map(
    candidates.flatMap((page) => (page.id ? [[page.id, page] as const] : [])),
  );
  for (const page of params.pages) {
    params.signal?.throwIfAborted();
    if (page.kind === "report") {
      continue;
    }
    // Strict admission: the Related-block refresh re-emits the whole page, so
    // replacement-decodable bytes would be persisted over human content.
    const original = decodeWikiPageUtf8(await root.readBytes(page.relativePath), page.relativePath);
    params.signal?.throwIfAborted();
    if (original.trim().length === 0) {
      continue;
    }
    const updated = withTrailingNewline(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Related",
        startMarker: WIKI_RELATED_START_MARKER,
        endMarker: WIKI_RELATED_END_MARKER,
        body: buildRelatedBlockBody(params.config, page, candidates, pagesById),
      }),
    );
    if (updated === original) {
      continue;
    }
    await root.write(page.relativePath, updated);
    params.signal?.throwIfAborted();
    updatedFiles.push(page.absolutePath);
  }
  return updatedFiles;
}

async function writeManagedMarkdownFile(params: {
  rootDir: string;
  relativePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const root = await fsRoot(params.rootDir);
  const original = await readExistingWikiPageUtf8(
    root,
    params.relativePath,
    () => `# ${params.title}\n`,
  );
  params.signal?.throwIfAborted();
  // Generated indexes bypass page discovery. Parse existing content here so
  // managed-block updates cannot rewrite malformed frontmatter.
  parseWikiMarkdown(original);
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
  await root.write(params.relativePath, rendered);
  params.signal?.throwIfAborted();
  return true;
}

async function refreshDashboardPages(params: {
  config: ResolvedMemoryWikiConfig;
  managedImportedSourcePagePaths: Set<string>;
  pages: WikiPageSummary[];
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!params.config.render.createDashboards) {
    return [];
  }
  const now = new Date();
  const updatedFiles: string[] = [];
  for (const [name, definition] of Object.entries(DASHBOARD_PAGES)) {
    params.signal?.throwIfAborted();
    const relativePath = `reports/${name}.md`;
    const root = await fsRoot(params.config.vault.path);
    const original = await readExistingWikiPageUtf8(root, relativePath, () =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "report",
          id: `report.${name}`,
          title: definition.title,
          status: "active",
        },
        body: `# ${definition.title}\n`,
      }),
    );
    const parsed = parseWikiMarkdown(original);
    const originalBody = parsed.body.trim().length > 0 ? parsed.body : `# ${definition.title}\n`;
    const updatedBody = replaceManagedMarkdownBlock({
      original: originalBody,
      heading: "## Generated",
      startMarker: `<!-- openclaw:wiki:${name}:start -->`,
      endMarker: `<!-- openclaw:wiki:${name}:end -->`,
      body: definition.buildBody({
        config: params.config,
        managedImportedSourcePagePaths: params.managedImportedSourcePagePaths,
        pages: params.pages,
        now,
        sourceRelativeTo: relativePath,
      }),
    });
    const preservedUpdatedAt =
      typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim()
        ? parsed.frontmatter.updatedAt
        : now.toISOString();
    const renderWithUpdatedAt = (updatedAt: string) =>
      withTrailingNewline(
        renderWikiMarkdown({
          frontmatter: {
            ...parsed.frontmatter,
            pageType: "report",
            id: `report.${name}`,
            title: definition.title,
            status:
              typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
                ? parsed.frontmatter.status
                : "active",
            updatedAt,
          },
          body: updatedBody,
        }),
      );
    if (renderWithUpdatedAt(preservedUpdatedAt) !== original) {
      await root.write(relativePath, renderWithUpdatedAt(now.toISOString()));
      updatedFiles.push(path.join(params.config.vault.path, relativePath));
    }
    params.signal?.throwIfAborted();
  }
  return updatedFiles;
}

function buildRootIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  counts: Record<WikiPageKind, number>;
}): string {
  const claimCount = params.pages.reduce((total, page) => total + page.claims.length, 0);
  const lines = [
    `- Render mode: \`${params.config.vault.renderMode}\``,
    `- Total pages: ${params.pages.length}`,
    `- Claims: ${claimCount}`,
    `- Sources: ${params.counts.source}`,
    `- Entities: ${params.counts.entity}`,
    `- Concepts: ${params.counts.concept}`,
    `- Syntheses: ${params.counts.synthesis}`,
    `- Reports: ${params.counts.report}`,
  ];

  for (const group of WIKI_PAGE_GROUPS) {
    lines.push("", `### ${group.heading}`);
    lines.push(
      renderWikiPageLinks({
        config: params.config,
        pages: params.pages.filter((page) => page.kind === group.kind),
        emptyText: `No ${normalizeLowercaseStringOrEmpty(group.heading)} yet.`,
      }),
    );
  }

  return lines.join("\n");
}

const FRESHNESS_RANK: Record<WikiFreshnessLevel, number> = {
  fresh: 3,
  aging: 2,
  stale: 1,
  unknown: 0,
};

function sortClaims(page: WikiPageSummary): WikiClaim[] {
  return page.claims.toSorted((left, right) => {
    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftFreshness = FRESHNESS_RANK[assessClaimFreshness({ page, claim: left }).level];
    const rightFreshness = FRESHNESS_RANK[assessClaimFreshness({ page, claim: right }).level];
    if (leftFreshness !== rightFreshness) {
      return rightFreshness - leftFreshness;
    }
    return left.text.localeCompare(right.text);
  });
}

function buildCompiledCacheSnapshot(
  scan: Awaited<ReturnType<typeof readPageSummaries>>,
): MemoryWikiCompiledCacheSnapshot {
  const pagesInput = scan.pages;
  const pages = pagesInput
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((page) => {
      const digestPage: Omit<
        MemoryWikiCompiledCacheSnapshot["digest"]["pages"][number],
        "claimCount" | "topClaims"
      > = Object.assign(page.id ? { id: page.id } : {}, {
        title: page.title,
        kind: page.kind,
        path: page.relativePath,
        aliases: [...page.aliases],
        sourceIds: [...page.sourceIds],
        questions: [...page.questions],
        contradictions: [...page.contradictions],
        bestUsedFor: [...page.bestUsedFor],
        notEnoughFor: [...page.notEnoughFor],
        relationshipCount: page.relationships.length,
        topRelationships: page.relationships.slice(0, 5),
      });
      if (page.pageType) {
        digestPage.pageType = page.pageType;
      }
      if (page.entityType) {
        digestPage.entityType = page.entityType;
      }
      if (page.canonicalId) {
        digestPage.canonicalId = page.canonicalId;
      }
      if (page.privacyTier) {
        digestPage.privacyTier = page.privacyTier;
      }
      if (page.personCard) {
        digestPage.personCard = page.personCard;
      }
      return Object.assign(digestPage, {
        claimCount: page.claims.length,
        topClaims: sortClaims(page)
          .slice(0, 5)
          .map((claim) =>
            Object.assign(
              claim.id ? { id: claim.id } : {},
              { text: claim.text, status: normalizeClaimStatus(claim.status) },
              typeof claim.confidence === "number" ? { confidence: claim.confidence } : {},
              { freshnessLevel: assessClaimFreshness({ page, claim }).level },
            ),
          ),
      });
    });
  const claims = pagesInput
    .flatMap((page) =>
      sortClaims(page).map((claim) => {
        const freshness = assessClaimFreshness({ page, claim });
        return Object.assign(claim.id ? { id: claim.id } : {}, {
          pageId: page.id,
          pageTitle: page.title,
          pageKind: page.kind,
          pagePath: page.relativePath,
          pageType: page.pageType,
          entityType: page.entityType,
          canonicalId: page.canonicalId,
          aliases: page.aliases,
          text: claim.text,
          status: normalizeClaimStatus(claim.status),
          confidence: claim.confidence,
          sourceIds: page.sourceIds,
          evidenceKinds: uniqueStrings(claim.evidence.flatMap((entry) => entry.kind ?? [])),
          privacyTiers: [
            ...new Set(
              [
                page.privacyTier,
                page.personCard?.privacyTier,
                ...claim.evidence.map((entry) => entry.privacyTier),
              ].flatMap((entry) => entry ?? []),
            ),
          ],
          freshnessLevel: freshness.level,
          lastTouchedAt: freshness.lastTouchedAt,
        });
      }),
    )
    .toSorted(
      (left, right) =>
        left.pagePath.localeCompare(right.pagePath) || left.text.localeCompare(right.text),
    );
  return {
    digest: {
      claimCount: claims.length,
      contradictionCount:
        buildPageContradictionClusters(pagesInput).length +
        buildClaimContradictionClusters({ pages: pagesInput }).length,
      pages,
    },
    claims,
    dashboards: {
      importInsights: buildMemoryWikiImportInsights(scan.importInsights),
      overview: buildMemoryWikiOverview(scan.pages, scan.overviewItems),
    },
  };
}

async function compileMemoryWikiVaultUnlocked(
  config: ResolvedMemoryWikiConfig,
  options?: CompileMemoryWikiOptions,
) {
  if (options?.sourcePageWrites === "preserve") {
    await activateExistingMemoryWikiVault(config, options.signal);
  } else {
    await initializeMemoryWikiVault(
      config,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }
  options?.signal?.throwIfAborted();
  const rootDir = config.vault.path;
  const compiledInputIdentity = await loadMemoryWikiVaultIdentity(rootDir);
  if (!compiledInputIdentity.vaultGeneration) {
    throw new Error(`Memory Wiki vault generation is missing: ${rootDir}`);
  }
  const compiledCacheReservationId = randomUUID();
  await appendMemoryWikiLog(rootDir, {
    type: "compile",
    timestamp: new Date().toISOString(),
    details: {
      compiledCacheReservationId,
      compiledCacheParentPublicationId: compiledInputIdentity.compiledCachePublicationId,
    },
  });
  const assertCompilationCurrent = (identity: typeof compiledInputIdentity, message: string) => {
    if (
      identity.vaultGeneration !== compiledInputIdentity.vaultGeneration ||
      identity.compiledCacheReservationId !== compiledCacheReservationId ||
      identity.compiledCachePublicationId !== compiledInputIdentity.compiledCachePublicationId
    ) {
      throw new Error(message);
    }
  };
  assertCompilationCurrent(
    await loadMemoryWikiVaultIdentity(rootDir),
    "Memory Wiki vault changed before its compiled cache scan began.",
  );
  const sourceSyncState = await readMemoryWikiSourceSyncState(rootDir);
  const managedImportedSourcePagePaths = new Set(
    Object.values(sourceSyncState.entries).map((entry) => entry.pagePath.split(path.sep).join("/")),
  );
  let scan = await readPageSummaries(rootDir, options?.signal);
  let pages = scan.pages;
  const updatedFiles =
    options?.sourcePageWrites === "preserve"
      ? []
      : await refreshPageRelatedBlocks({
          config,
          pages,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
  if (updatedFiles.length > 0) {
    scan = await readPageSummaries(rootDir, options?.signal);
    pages = scan.pages;
  }
  const dashboardUpdatedFiles = await refreshDashboardPages({
    config,
    managedImportedSourcePagePaths,
    pages,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  updatedFiles.push(...dashboardUpdatedFiles);
  if (dashboardUpdatedFiles.length > 0) {
    scan = await readPageSummaries(rootDir, options?.signal);
    pages = scan.pages;
  }
  const compiledSnapshot = buildCompiledCacheSnapshot(scan);
  const counts = compiledSnapshot.dashboards.overview.pageCounts;
  const compiledCacheGeneration = resolveMemoryWikiCompiledCacheGeneration(compiledSnapshot);
  const compiledCachePublicationId = randomUUID();
  let compiledCacheSourceGeneration: string | undefined;

  for (const group of [undefined, ...WIKI_PAGE_GROUPS]) {
    const relativePath = group ? path.join(group.dir, "index.md").replace(/\\/g, "/") : "index.md";
    const marker = group ? `${group.dir}:index` : "index";
    const body = group
      ? renderWikiPageLinks({
          config,
          pages: pages.filter((page) => page.kind === group.kind),
          emptyText: `No ${normalizeLowercaseStringOrEmpty(group.heading)} yet.`,
          sourceRelativeTo: `${group.dir}/index.md`,
        })
      : buildRootIndexBody({ config, pages, counts });
    if (
      await writeManagedMarkdownFile({
        rootDir,
        relativePath,
        title: group?.heading ?? "Wiki Index",
        startMarker: `<!-- openclaw:wiki:${marker}:start -->`,
        endMarker: `<!-- openclaw:wiki:${marker}:end -->`,
        body,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
    ) {
      updatedFiles.push(path.join(rootDir, relativePath));
    }
  }

  // Persist an immutable candidate, then commit its causal publication. A stale
  // compiler cannot overwrite the accepted row or activate before validation.
  options?.signal?.throwIfAborted();
  await writeMemoryWikiCompiledCache(
    config,
    compiledSnapshot,
    compiledCacheGeneration,
    compiledCachePublicationId,
    compiledInputIdentity.compiledCachePublicationId,
    async () => {
      options?.signal?.throwIfAborted();
      assertCompilationCurrent(
        await loadMemoryWikiVaultIdentity(rootDir),
        "Memory Wiki vault changed while its compiled cache was being built.",
      );
      const sourceGenerationBeforeScan = await resolveMemoryWikiVaultSourceGeneration(rootDir);
      const verifiedScan = await readPageSummaries(rootDir, options?.signal);
      const verifiedGeneration = resolveMemoryWikiCompiledCacheGeneration(
        buildCompiledCacheSnapshot(verifiedScan),
      );
      const sourceGenerationAfterScan = await resolveMemoryWikiVaultSourceGeneration(rootDir);
      if (
        verifiedGeneration !== compiledCacheGeneration ||
        sourceGenerationAfterScan !== sourceGenerationBeforeScan
      ) {
        throw new Error("Memory Wiki vault changed while its compiled cache was being published.");
      }
      compiledCacheSourceGeneration = sourceGenerationAfterScan;
      assertCompilationCurrent(
        await loadMemoryWikiVaultIdentity(rootDir),
        "Memory Wiki vault changed while its compiled cache was being verified.",
      );
      options?.signal?.throwIfAborted();
    },
    async () => {
      options?.signal?.throwIfAborted();
      if (!compiledCacheSourceGeneration) {
        throw new Error("Memory Wiki compiled cache source generation is missing.");
      }
      await appendMemoryWikiLog(rootDir, {
        type: "compile",
        timestamp: new Date().toISOString(),
        details: {
          compiledCachePublicationId,
          compiledCacheParentPublicationId: compiledInputIdentity.compiledCachePublicationId,
          compiledCacheReservationId,
          compiledCacheSourceGeneration,
        },
      });
      options?.signal?.throwIfAborted();
    },
    () => loadMemoryWikiValidatedVaultIdentity(rootDir),
  );
  await appendMemoryWikiLog(rootDir, {
    type: "compile",
    timestamp: new Date().toISOString(),
    details: {
      pageCounts: counts,
      updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath)),
    },
  });

  return {
    vaultRoot: rootDir,
    pageCounts: counts,
    pages,
    frontmatterErrors: scan.frontmatterErrors,
    claimCount: pages.reduce((total, page) => total + page.claims.length, 0),
    updatedFiles,
  };
}

export async function compileMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
  options?: CompileMemoryWikiOptions,
): Promise<CompileMemoryWikiResult> {
  try {
    options?.signal?.throwIfAborted();
    return await withMemoryWikiVaultMutation(config.vault.path, () => {
      options?.signal?.throwIfAborted();
      setMemoryWikiDashboardState(config, { state: "rebuilding" });
      return compileMemoryWikiVaultUnlocked(config, options);
    });
  } catch (error) {
    if (!options?.signal?.aborted) {
      setMemoryWikiDashboardState(config, { state: "failed" });
    }
    throw error;
  }
}

async function hasMissingWikiIndexes(rootDir: string): Promise<boolean> {
  const required = [
    path.join(rootDir, "index.md"),
    ...WIKI_PAGE_GROUPS.map((group) => path.join(rootDir, group.dir, "index.md")),
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
  signal?: AbortSignal;
}): Promise<RefreshMemoryWikiIndexesResult> {
  params.signal?.throwIfAborted();
  const importChanged =
    params.syncResult.importedCount > 0 ||
    params.syncResult.updatedCount > 0 ||
    params.syncResult.removedCount > 0;
  const dashboardState = await readMemoryWikiDashboardState(params.config);
  params.signal?.throwIfAborted();
  let dashboardNeedsCompile = dashboardState.state !== "ready";
  if (!params.config.ingest.autoCompile) {
    if (importChanged || dashboardNeedsCompile) {
      setMemoryWikiDashboardState(params.config, { state: "compile-required" });
    }
    return { refreshed: false, reason: "auto-compile-disabled" };
  }

  const missingIndexes = await hasMissingWikiIndexes(params.config.vault.path);
  if (!importChanged && !missingIndexes && dashboardNeedsCompile) {
    // Another compiler can replace our publication without changing sources.
    // Validate and adopt its durable cache before deciding to rebuild it.
    await initializeMemoryWikiVault(params.config, { signal: params.signal });
    await activateExistingMemoryWikiVault(params.config, params.signal);
    dashboardNeedsCompile = (await readMemoryWikiDashboardState(params.config)).state !== "ready";
  }
  params.signal?.throwIfAborted();
  if (!importChanged && !missingIndexes && !dashboardNeedsCompile) {
    return { refreshed: false, reason: "no-import-changes" };
  }

  const compile = await compileMemoryWikiVault(
    params.config,
    params.signal ? { signal: params.signal } : undefined,
  );
  return {
    refreshed: true,
    reason: importChanged
      ? "import-changed"
      : missingIndexes
        ? "missing-indexes"
        : "missing-compiled-cache",
    compile,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
