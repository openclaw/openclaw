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
  assessPageFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  collectWikiClaimHealth,
  isClaimContestedStatus,
  normalizeClaimStatus,
  WIKI_AGING_DAYS,
  type WikiClaimContradictionCluster,
  type WikiClaimHealth,
  type WikiFreshness,
  type WikiFreshnessLevel,
  type WikiPageContradictionCluster,
} from "./claim-health.js";
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
  formatWikiLink,
  isUnmanagedRawSourceSummary,
  parseWikiMarkdown,
  renderWikiMarkdown,
  scanWikiPageSummary,
  type WikiClaim,
  type WikiClaimEvidence,
  type WikiPageKind,
  type WikiPageSummary,
  type WikiRelationship,
  WIKI_PAGE_GROUPS,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { isPersonLikePage } from "./person-page.js";
import {
  buildRelatedPageIndex,
  selectRelatedPages,
  type RelatedPageIndex,
} from "./related-pages.js";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./vault.js";
import { buildMemoryWikiOverview, projectMemoryWikiOverviewItem } from "./wiki-overview.js";

const READ_PAGE_SUMMARIES_CONCURRENCY = 16;

type DashboardPageDefinition = {
  title: string;
  buildBody: (params: {
    config: ResolvedMemoryWikiConfig;
    pages: WikiPageSummary[];
    managedImportedSourcePagePaths: Set<string>;
    now: Date;
    sourceRelativeTo: string;
  }) => string;
};

function renderCountedList(
  label: string,
  lines: string[],
  emptyText: string,
  separator = "\n\n",
): string {
  return lines.length === 0
    ? `- ${emptyText}`
    : [`- ${label}: ${lines.length}`, lines.join("\n")].join(separator);
}

function renderReportSection(heading: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", `### ${heading}`, ...lines] : [];
}

function renderCountedSections(
  emptyText: string,
  sections: Array<[label: string, heading: string, lines: string[]]>,
): string {
  return sections.every((section) => section[2].length === 0)
    ? `- ${emptyText}`
    : [
        ...sections.map(([label, , lines]) => `- ${label}: ${lines.length}`),
        ...sections.flatMap(([, heading, lines]) => renderReportSection(heading, lines)),
      ].join("\n");
}

const DASHBOARD_PAGES: Record<string, DashboardPageDefinition> = {
  "open-questions": {
    title: "Open Questions",
    buildBody: ({ config, pages, sourceRelativeTo }) => {
      const matches = pages.filter((page) => page.questions.length > 0);
      return renderCountedList(
        "Pages with open questions",
        matches.map(
          (page) =>
            `- ${formatPageLink(config, page, sourceRelativeTo)}: ${page.questions.join(" | ")}`,
        ),
        "No open questions right now.",
      );
    },
  },
  contradictions: {
    title: "Contradictions",
    buildBody: ({ config, pages, now, sourceRelativeTo }) => {
      return renderCountedSections("No contradictions flagged right now.", [
        [
          "Contradiction note clusters",
          "Page Notes",
          buildPageContradictionClusters(pages).map((cluster) =>
            formatPageContradictionClusterLine(config, cluster, sourceRelativeTo),
          ),
        ],
        [
          "Competing claim clusters",
          "Claim Clusters",
          buildClaimContradictionClusters({ pages, now }).map((cluster) =>
            formatClaimContradictionClusterLine(config, cluster, sourceRelativeTo),
          ),
        ],
      ]);
    },
  },
  "low-confidence": {
    title: "Low Confidence",
    buildBody: ({ config, pages, now, sourceRelativeTo }) => {
      const pageMatches = pages
        .filter((page) => typeof page.confidence === "number" && page.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      const claimMatches = collectWikiClaimHealth(pages, now)
        .filter((claim) => typeof claim.confidence === "number" && claim.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      return renderCountedSections("No low-confidence pages or claims right now.", [
        [
          "Low-confidence pages",
          "Pages",
          pageMatches.map(
            (page) =>
              `- ${formatPageLink(config, page, sourceRelativeTo)}: confidence ${(page.confidence ?? 0).toFixed(2)}`,
          ),
        ],
        [
          "Low-confidence claims",
          "Claims",
          claimMatches.map(
            (claim) => `- ${formatClaimHealthLine(config, claim, sourceRelativeTo)}`,
          ),
        ],
      ]);
    },
  },
  "claim-health": {
    title: "Claim Health",
    buildBody: ({ config, pages, now, sourceRelativeTo }) => {
      const claimHealth = collectWikiClaimHealth(pages, now);
      const missingEvidence = claimHealth.filter((claim) => claim.missingEvidence);
      const contestedClaims = claimHealth.filter((claim) => isClaimContestedStatus(claim.status));
      const staleClaims = claimHealth.filter(
        (claim) => claim.freshness.level === "stale" || claim.freshness.level === "unknown",
      );
      const claimLines = (claims: WikiClaimHealth[]) =>
        claims.map((claim) => `- ${formatClaimHealthLine(config, claim, sourceRelativeTo)}`);
      return renderCountedSections("No claim health issues right now.", [
        ["Claims missing evidence", "Missing Evidence", claimLines(missingEvidence)],
        ["Contested claims", "Contested Claims", claimLines(contestedClaims)],
        ["Stale or unknown claims", "Stale Claims", claimLines(staleClaims)],
      ]);
    },
  },
  "stale-pages": {
    title: "Stale Pages",
    buildBody: ({ config, managedImportedSourcePagePaths, pages, now, sourceRelativeTo }) => {
      const matches = pages
        .filter(
          (page) =>
            page.kind !== "report" &&
            // concept/synthesis are intentionally durable references
            page.kind !== "concept" &&
            page.kind !== "synthesis" &&
            !(
              isUnmanagedRawSourceSummary(page) &&
              !managedImportedSourcePagePaths.has(page.relativePath)
            ),
        )
        .flatMap((page) => {
          const freshness = assessPageFreshness(page, now);
          if (freshness.level === "fresh") {
            return [];
          }
          return [{ page, freshness }];
        })
        .toSorted((left, right) => left.page.title.localeCompare(right.page.title));
      return renderCountedList(
        "Stale pages",
        matches.map(
          ({ page, freshness }) =>
            `- ${formatPageLink(config, page, sourceRelativeTo)}: ${formatFreshnessLabel(freshness)}`,
        ),
        `No aging or stale pages older than ${WIKI_AGING_DAYS} days.`,
      );
    },
  },
  "person-agent-directory": {
    title: "Person Agent Directory",
    buildBody: ({ config, pages, now, sourceRelativeTo }) => {
      const matches = pages
        .filter((page) => page.kind !== "report" && isPersonLikePage(page))
        .toSorted((left, right) => left.title.localeCompare(right.title));
      return renderCountedList(
        "People with routing metadata",
        matches.map(
          (page) =>
            `- ${formatPersonDirectoryLine(config, page, assessPageFreshness(page, now), sourceRelativeTo)}`,
        ),
        "No person-like entity pages with agent cards yet.",
        "\n",
      );
    },
  },
  "relationship-graph": {
    title: "Relationship Graph",
    buildBody: ({ config, pages, sourceRelativeTo }) => {
      const relationships = pages
        .flatMap((page) => page.relationships.map((relationship) => ({ page, relationship })))
        .toSorted((left, right) => {
          const leftTitle = left.relationship.targetTitle ?? left.relationship.targetId ?? "";
          const rightTitle = right.relationship.targetTitle ?? right.relationship.targetId ?? "";
          return `${left.page.title} ${leftTitle}`.localeCompare(
            `${right.page.title} ${rightTitle}`,
          );
        });
      return renderCountedList(
        "Structured relationships",
        relationships.map(
          ({ page, relationship }) =>
            `- ${formatRelationshipLine(config, page, relationship, sourceRelativeTo)}`,
        ),
        "No structured relationships yet.",
      );
    },
  },
  "provenance-coverage": {
    title: "Provenance Coverage",
    buildBody: ({ config, pages, sourceRelativeTo }) => {
      const evidenceEntries = pages.flatMap((page) =>
        page.claims.flatMap((claim) =>
          claim.evidence.map((evidence) => ({ page, claim, evidence })),
        ),
      );
      const missingEvidence = pages.flatMap((page) =>
        page.claims
          .filter((claim) => claim.evidence.length === 0)
          .map((claim) => ({ page, claim })),
      );
      if (evidenceEntries.length === 0 && missingEvidence.length === 0) {
        return "- No structured claims with provenance coverage yet.";
      }
      const kindCounts = countBy(
        evidenceEntries.map(({ evidence }) => evidence.kind ?? "unspecified"),
      );
      const sourceCounts = countBy(
        evidenceEntries.map(({ evidence }) => evidence.sourceId ?? evidence.path ?? "inline"),
      );
      return [
        `- Evidence entries: ${evidenceEntries.length}`,
        `- Claims missing evidence: ${missingEvidence.length}`,
        ...renderReportSection("Evidence Classes", formatCountLines(kindCounts)),
        ...renderReportSection("Top Evidence Sources", formatCountLines(sourceCounts).slice(0, 20)),
        ...renderReportSection(
          "Missing Evidence",
          missingEvidence.map(
            ({ page, claim }) =>
              `- ${formatPageLink(config, page, sourceRelativeTo)}: ${formatClaimIdentityForPage(claim)}`,
          ),
        ),
      ].join("\n");
    },
  },
  "privacy-review": {
    title: "Privacy Review",
    buildBody: ({ config, pages, sourceRelativeTo }) => {
      const entries = collectPrivacyReviewEntries(config, pages, sourceRelativeTo);
      return renderCountedList(
        "Privacy review entries",
        entries,
        "No non-public privacy tiers flagged right now.",
      );
    },
  },
};

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

function formatPageLink(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  sourceRelativeTo?: string,
): string {
  return formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: page.relativePath,
    sourceRelativeTo,
    title: page.title,
  });
}

function formatFreshnessLabel(freshness: WikiFreshness): string {
  return freshness.level === "unknown"
    ? freshness.reason
    : `${freshness.level} (${freshness.lastTouchedAt ?? (freshness.level === "fresh" ? "recent" : "unknown")})`;
}

function formatListPreview(values: readonly string[], maxItems = 3): string | null {
  if (values.length === 0) {
    return null;
  }
  const shown = values.slice(0, maxItems).join(", ");
  return values.length > maxItems ? `${shown}, +${values.length - maxItems}` : shown;
}

function formatMaybeDetail(label: string, value: string | null | undefined): string | null {
  return value ? `${label} ${value}` : null;
}

function formatPersonDirectoryLine(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  freshness: WikiFreshness,
  sourceRelativeTo?: string,
): string {
  const card = page.personCard;
  const details = [
    formatMaybeDetail("id", page.canonicalId ?? card?.canonicalId ?? page.id),
    formatMaybeDetail("aliases", formatListPreview(page.aliases)),
    formatMaybeDetail("handles", formatListPreview(card?.handles ?? [])),
    formatMaybeDetail("lane", card?.lane),
    formatMaybeDetail("ask", formatListPreview(card?.askFor ?? [])),
    formatMaybeDetail(
      "best",
      formatListPreview([...page.bestUsedFor, ...(card?.bestUsedFor ?? [])]),
    ),
    formatMaybeDetail("privacy", page.privacyTier ?? card?.privacyTier),
    formatMaybeDetail("refreshed", page.lastRefreshedAt ?? card?.lastRefreshedAt),
    formatMaybeDetail("freshness", formatFreshnessLabel(freshness)),
  ].filter(Boolean);
  return `${formatPageLink(config, page, sourceRelativeTo)}${
    details.length > 0 ? `: ${details.join("; ")}` : ""
  }`;
}

function formatRelationshipTarget(
  config: ResolvedMemoryWikiConfig,
  relationship: WikiRelationship,
  sourceRelativeTo?: string,
) {
  if (relationship.targetPath && relationship.targetTitle) {
    return formatWikiLink({
      renderMode: config.vault.renderMode,
      relativePath: relationship.targetPath,
      sourceRelativeTo,
      title: relationship.targetTitle,
    });
  }
  return relationship.targetTitle ?? relationship.targetId ?? relationship.targetPath ?? "unknown";
}

function formatRelationshipLine(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  relationship: WikiRelationship,
  sourceRelativeTo?: string,
): string {
  const details = [
    relationship.kind ?? "related",
    typeof relationship.weight === "number" ? `weight ${relationship.weight.toFixed(2)}` : null,
    typeof relationship.confidence === "number"
      ? `confidence ${relationship.confidence.toFixed(2)}`
      : null,
    relationship.evidenceKind ? `evidence ${relationship.evidenceKind}` : null,
    relationship.privacyTier ? `privacy ${relationship.privacyTier}` : null,
    relationship.note,
  ].filter(Boolean);
  return `${formatPageLink(config, page, sourceRelativeTo)} -> ${formatRelationshipTarget(
    config,
    relationship,
    sourceRelativeTo,
  )}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCountLines(counts: Map<string, number>): string[] {
  const lines = [...counts]
    .toSorted((left, right) => {
      return right[1] - left[1] || left[0].localeCompare(right[0]);
    })
    .map(([label, count]) => `- ${label}: ${count}`);
  return lines.length > 0 ? lines : ["- None"];
}

function formatClaimIdentityForPage(claim: Pick<WikiClaim, "id" | "text">): string {
  return claim.id ? `\`${claim.id}\`: ${claim.text}` : claim.text;
}

function isReviewablePrivacyTier(value: string | undefined): boolean {
  const tier = normalizeLowercaseStringOrEmpty(value);
  return tier !== "" && tier !== "public";
}

function formatEvidencePrivacyDetails(evidence: WikiClaimEvidence): string {
  return [
    evidence.kind ? `kind ${evidence.kind}` : null,
    evidence.sourceId ? `source ${evidence.sourceId}` : null,
    evidence.path ? `path ${evidence.path}` : null,
    evidence.lines ? `lines ${evidence.lines}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function collectPrivacyReviewEntries(
  config: ResolvedMemoryWikiConfig,
  pages: WikiPageSummary[],
  sourceRelativeTo?: string,
): string[] {
  const entries: string[] = [];
  for (const page of pages) {
    if (isReviewablePrivacyTier(page.privacyTier)) {
      entries.push(
        `- ${formatPageLink(config, page, sourceRelativeTo)}: page privacy ${page.privacyTier}`,
      );
    }
    if (isReviewablePrivacyTier(page.personCard?.privacyTier)) {
      entries.push(
        `- ${formatPageLink(config, page, sourceRelativeTo)}: person card privacy ${page.personCard?.privacyTier}`,
      );
    }
    for (const relationship of page.relationships) {
      if (isReviewablePrivacyTier(relationship.privacyTier)) {
        entries.push(
          `- ${formatPageLink(config, page, sourceRelativeTo)}: relationship privacy ${
            relationship.privacyTier
          } -> ${formatRelationshipTarget(config, relationship, sourceRelativeTo)}`,
        );
      }
    }
    for (const claim of page.claims) {
      for (const evidence of claim.evidence) {
        if (!isReviewablePrivacyTier(evidence.privacyTier)) {
          continue;
        }
        const detail = formatEvidencePrivacyDetails(evidence);
        entries.push(
          `- ${formatPageLink(config, page, sourceRelativeTo)}: evidence privacy ${evidence.privacyTier} on ${formatClaimIdentityForPage(claim)}${detail ? ` (${detail})` : ""}`,
        );
      }
    }
  }
  return entries;
}

function formatClaimIdentity(claim: WikiClaimHealth): string {
  return claim.claimId ? `\`${claim.claimId}\`: ${claim.text}` : claim.text;
}

function formatClaimHealthLine(
  config: ResolvedMemoryWikiConfig,
  claim: WikiClaimHealth,
  sourceRelativeTo?: string,
): string {
  const details = [
    `status ${claim.status}`,
    typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
    claim.missingEvidence ? "missing evidence" : `${claim.evidenceCount} evidence`,
    formatFreshnessLabel(claim.freshness),
  ].filter(Boolean);
  return `${formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: claim.pagePath,
    sourceRelativeTo,
    title: claim.pageTitle,
  })}: ${formatClaimIdentity(claim)} (${details.join(", ")})`;
}

function formatPageContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiPageContradictionCluster,
  sourceRelativeTo?: string,
): string {
  const pageRefs = cluster.entries.map((entry) =>
    formatWikiLink({
      renderMode: config.vault.renderMode,
      relativePath: entry.pagePath,
      sourceRelativeTo,
      title: entry.pageTitle,
    }),
  );
  return `- ${cluster.label}: ${pageRefs.join(" | ")}`;
}

function formatClaimContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiClaimContradictionCluster,
  sourceRelativeTo?: string,
): string {
  const entries = cluster.entries.map(
    (entry) =>
      `${formatWikiLink({
        renderMode: config.vault.renderMode,
        relativePath: entry.pagePath,
        sourceRelativeTo,
        title: entry.pageTitle,
      })} -> ${formatClaimIdentity(entry)} (${entry.status}, ${formatFreshnessLabel(entry.freshness)})`,
  );
  return `- \`${cluster.label}\`: ${entries.join(" | ")}`;
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
  index: RelatedPageIndex,
): string {
  const { sourcePages, backlinkPages, relatedPages } = selectRelatedPages(page, index);
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
  const index = buildRelatedPageIndex(params.pages);
  for (const page of params.pages) {
    params.signal?.throwIfAborted();
    if (page.kind === "report") {
      continue;
    }
    const original = await root.readText(page.relativePath);
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
        body: buildRelatedBlockBody(params.config, page, index),
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
  const original = await root.readText(params.relativePath).catch(() => `# ${params.title}\n`);
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
    const original = await root.readText(relativePath).catch(() =>
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
