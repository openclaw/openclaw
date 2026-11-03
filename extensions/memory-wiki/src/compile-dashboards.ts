import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessPageFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  collectWikiClaimHealth,
  isClaimContestedStatus,
  WIKI_AGING_DAYS,
  type WikiClaimContradictionCluster,
  type WikiClaimHealth,
  type WikiFreshness,
  type WikiPageContradictionCluster,
} from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  formatWikiLink,
  isUnmanagedRawSourceSummary,
  type WikiClaim,
  type WikiClaimEvidence,
  type WikiPageSummary,
  type WikiRelationship,
} from "./markdown.js";
import { isPersonLikePage } from "./person-page.js";

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

export const DASHBOARD_PAGES: Record<string, DashboardPageDefinition> = {
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

export function formatPageLink(
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

export function countBy(values: readonly string[]): Map<string, number> {
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
