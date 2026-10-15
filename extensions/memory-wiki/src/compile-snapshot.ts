import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessClaimFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  compareWikiClaimSummaries,
  normalizeClaimStatus,
} from "./claim-health.js";
import type {
  MemoryWikiCompiledCacheSnapshot,
  MemoryWikiImportInsightItem,
  MemoryWikiOverviewItem,
} from "./compiled-cache.js";
import { buildMemoryWikiImportInsights } from "./import-insights.js";
import type { WikiPageSummary } from "./markdown.js";
import { buildMemoryWikiOverview } from "./wiki-overview.js";

export function buildCompiledCacheSnapshot(scan: {
  pages: WikiPageSummary[];
  importInsights: MemoryWikiImportInsightItem[];
  overviewItems: MemoryWikiOverviewItem[];
}): MemoryWikiCompiledCacheSnapshot {
  const pagesInput = scan.pages;
  const claims: MemoryWikiCompiledCacheSnapshot["claims"] = [];
  const pages = pagesInput
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((page) => {
      const pageClaims = page.claims
        .map((claim) => {
          const freshness = assessClaimFreshness({ page, claim });
          const summary = Object.assign(
            claim.id ? { id: claim.id } : {},
            { text: claim.text, status: normalizeClaimStatus(claim.status) },
            typeof claim.confidence === "number" ? { confidence: claim.confidence } : {},
            { freshnessLevel: freshness.level },
          );
          return { claim, freshness, summary };
        })
        .toSorted((left, right) => compareWikiClaimSummaries(left.summary, right.summary));
      for (const { claim, freshness, summary } of pageClaims) {
        claims.push(
          Object.assign(claim.id ? { id: claim.id } : {}, {
            pageId: page.id,
            pageTitle: page.title,
            pageKind: page.kind,
            pagePath: page.relativePath,
            pageType: page.pageType,
            entityType: page.entityType,
            canonicalId: page.canonicalId,
            aliases: page.aliases,
            text: summary.text,
            status: summary.status,
            confidence: claim.confidence,
            sourceIds: page.sourceIds,
            evidenceKinds: uniqueStrings(claim.evidence.flatMap((entry) => entry.kind ?? [])),
            privacyTiers: uniqueStrings(
              [
                page.privacyTier,
                page.personCard?.privacyTier,
                ...claim.evidence.map((entry) => entry.privacyTier),
              ].flatMap((entry) => entry ?? []),
            ),
            freshnessLevel: freshness.level,
            lastTouchedAt: freshness.lastTouchedAt,
          }),
        );
      }
      return Object.assign(page.id ? { id: page.id } : {}, {
        title: page.title,
        kind: page.kind,
        path: page.relativePath,
        aliases: page.aliases,
        sourceIds: page.sourceIds,
        questions: page.questions,
        contradictions: page.contradictions,
        bestUsedFor: page.bestUsedFor,
        notEnoughFor: page.notEnoughFor,
        relationshipCount: page.relationships.length,
        topRelationships: page.relationships.slice(0, 5),
        ...(page.pageType ? { pageType: page.pageType } : {}),
        ...(page.entityType ? { entityType: page.entityType } : {}),
        ...(page.canonicalId ? { canonicalId: page.canonicalId } : {}),
        ...(page.privacyTier ? { privacyTier: page.privacyTier } : {}),
        ...(page.personCard ? { personCard: page.personCard } : {}),
        claimCount: page.claims.length,
        topClaims: pageClaims.slice(0, 5).map(({ summary }) => summary),
      });
    });
  return {
    digest: {
      claimCount: claims.length,
      contradictionCount:
        buildPageContradictionClusters(pagesInput).length +
        buildClaimContradictionClusters({ pages: pagesInput }).length,
      pages,
    },
    claims: claims.toSorted(
      (left, right) =>
        left.pagePath.localeCompare(right.pagePath) || left.text.localeCompare(right.text),
    ),
    dashboards: {
      importInsights: buildMemoryWikiImportInsights(scan.importInsights),
      overview: buildMemoryWikiOverview(scan.pages, scan.overviewItems),
    },
  };
}
