// Qa Lab plugin module embeds profile scorecard context into QA evidence.
import fs from "node:fs/promises";
import {
  attachQaEvidenceScorecard,
  validateQaEvidenceSummaryJson,
  type QaEvidenceScorecardJson,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type {
  QaScorecardCategoryCoverageReport,
  QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";
import { readQaScorecardFeatureCoverageByCategory } from "./scorecard-taxonomy.js";

type QaProfileScorecardFilters = {
  surface?: string;
  category?: string;
};

type EvidenceCoverageRole = QaEvidenceSummaryEntry["coverage"][number]["role"];

function uniqueSortedStrings(values: Iterable<string | undefined>) {
  return [
    ...new Set([...values].map((value) => value?.trim()).filter(Boolean) as string[]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function percent(part: number, total: number) {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

function nullableFilter(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function coverageIdsForRole(
  entries: readonly QaEvidenceSummaryEntry[],
  role: EvidenceCoverageRole,
) {
  return new Set(
    entries.flatMap((entry) =>
      entry.coverage.filter((coverage) => coverage.role === role).map((coverage) => coverage.id),
    ),
  );
}

function statusForCategory(params: { featureCount: number; fulfilledFeatureCount: number }) {
  if (params.fulfilledFeatureCount === 0) {
    return "missing" as const;
  }
  if (params.fulfilledFeatureCount === params.featureCount) {
    return "fulfilled" as const;
  }
  return "partial" as const;
}

function categoryFeatureCoverageIds(params: {
  category: QaScorecardCategoryCoverageReport;
  featureCoverageByCategoryId?: ReadonlyMap<string, readonly (readonly string[])[]>;
}) {
  const features = params.featureCoverageByCategoryId?.get(params.category.id);
  return features && features.length > 0
    ? features
    : params.category.coverageIds.map((coverageId) => [coverageId]);
}

export function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
  featureCoverageByCategoryId?: ReadonlyMap<string, readonly (readonly string[])[]>;
}): QaEvidenceScorecardJson {
  const primaryCoverageIds = coverageIdsForRole(params.evidence.entries, "primary");
  const secondaryCoverageIds = coverageIdsForRole(params.evidence.entries, "secondary");
  const categoryReports = params.categories.map((category) => {
    const featureCoverageIds = categoryFeatureCoverageIds({
      category,
      featureCoverageByCategoryId: params.featureCoverageByCategoryId,
    });
    const fulfilledFeatureCount = featureCoverageIds.filter(
      (coverageIds) =>
        coverageIds.length > 0 &&
        coverageIds.every((coverageId) => primaryCoverageIds.has(coverageId)),
    ).length;
    const secondaryOnlyFeatureCount = featureCoverageIds.filter(
      (coverageIds) =>
        coverageIds.some((coverageId) => !primaryCoverageIds.has(coverageId)) &&
        coverageIds.some(
          (coverageId) =>
            !primaryCoverageIds.has(coverageId) && secondaryCoverageIds.has(coverageId),
        ),
    ).length;
    const missingCoverageIds = uniqueSortedStrings(
      featureCoverageIds.flatMap((coverageIds) =>
        coverageIds.filter((coverageId) => !primaryCoverageIds.has(coverageId)),
      ),
    );
    const missingFeatureCount = featureCoverageIds.length - fulfilledFeatureCount;
    return {
      id: category.id,
      surfaceId: category.taxonomySurfaceId,
      name: category.taxonomyCategoryName,
      status: statusForCategory({
        featureCount: featureCoverageIds.length,
        fulfilledFeatureCount,
      }),
      features: {
        total: featureCoverageIds.length,
        fulfilled: fulfilledFeatureCount,
        secondaryOnly: secondaryOnlyFeatureCount,
        missing: missingFeatureCount,
        fulfillmentPercent: percent(fulfilledFeatureCount, featureCoverageIds.length),
      },
      missingCoverageIds,
    };
  });
  const featureCount = categoryReports.reduce((sum, category) => sum + category.features.total, 0);
  const fulfilledFeatureCount = categoryReports.reduce(
    (sum, category) => sum + category.features.fulfilled,
    0,
  );
  const missingFeatureCount = categoryReports.reduce(
    (sum, category) => sum + category.features.missing,
    0,
  );
  const fulfilledCategoryCount = categoryReports.filter(
    (category) => category.status === "fulfilled",
  ).length;
  const partialCategoryCount = categoryReports.filter(
    (category) => category.status === "partial",
  ).length;
  const missingCategoryCount = categoryReports.filter(
    (category) => category.status === "missing",
  ).length;
  return {
    filters: {
      surface: nullableFilter(params.filters.surface),
      category: nullableFilter(params.filters.category),
    },
    run: {
      evidenceEntryCount: params.evidence.entries.length,
    },
    categories: {
      total: categoryReports.length,
      fulfilled: fulfilledCategoryCount,
      partial: partialCategoryCount,
      missing: missingCategoryCount,
      fulfillmentPercent: percent(fulfilledCategoryCount, categoryReports.length),
    },
    features: {
      total: featureCount,
      fulfilled: fulfilledFeatureCount,
      missing: missingFeatureCount,
      fulfillmentPercent: percent(fulfilledFeatureCount, featureCount),
    },
    categoryReports,
  };
}

export async function attachQaProfileScorecardEvidenceToFile(params: {
  evidencePath: string;
  evidenceMode?: QaScorecardEvidenceMode;
  profile: string;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(params.evidencePath, "utf8")),
  );
  const scorecard = buildQaProfileScorecardEvidence({
    evidence,
    filters: params.filters,
    categories: params.categories,
    featureCoverageByCategoryId: readQaScorecardFeatureCoverageByCategory(),
  });
  const nextEvidence = attachQaEvidenceScorecard({
    summary: evidence,
    evidenceMode: params.evidenceMode,
    profile: params.profile,
    scorecard,
  });
  await fs.writeFile(params.evidencePath, `${JSON.stringify(nextEvidence, null, 2)}\n`, "utf8");
  return scorecard;
}
