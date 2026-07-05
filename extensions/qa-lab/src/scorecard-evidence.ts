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
<<<<<<< HEAD
=======
import { readQaScorecardFeatureCoverageByCategory } from "./scorecard-taxonomy.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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

<<<<<<< HEAD
function statusForCategory(params: { coverageIdCount: number; fulfilledCoverageIdCount: number }) {
  if (params.fulfilledCoverageIdCount === 0) {
    return "missing" as const;
  }
  if (params.fulfilledCoverageIdCount === params.coverageIdCount) {
=======
function statusForCategory(params: { featureCount: number; fulfilledFeatureCount: number }) {
  if (params.fulfilledFeatureCount === 0) {
    return "missing" as const;
  }
  if (params.fulfilledFeatureCount === params.featureCount) {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return "fulfilled" as const;
  }
  return "partial" as const;
}

<<<<<<< HEAD
function featureCounts(
  features: readonly { coverageIds: readonly string[] }[],
  primaryCoverageIds: ReadonlySet<string>,
) {
  let fulfilled = 0;
  let partial = 0;
  let missing = 0;
  for (const feature of features) {
    const coverageIds = uniqueSortedStrings(feature.coverageIds);
    const fulfilledCoverageIds = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    if (coverageIds.length > 0 && fulfilledCoverageIds === coverageIds.length) {
      fulfilled += 1;
    } else if (fulfilledCoverageIds > 0) {
      partial += 1;
    } else {
      missing += 1;
    }
  }
  return {
    total: features.length,
    fulfilled,
    partial,
    missing,
    fulfillmentPercent: percent(fulfilled, features.length),
  };
=======
function categoryFeatureCoverageIds(params: {
  category: QaScorecardCategoryCoverageReport;
  featureCoverageByCategoryId?: ReadonlyMap<string, readonly (readonly string[])[]>;
}) {
  const features = params.featureCoverageByCategoryId?.get(params.category.id);
  return features && features.length > 0
    ? features
    : params.category.coverageIds.map((coverageId) => [coverageId]);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

export function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
<<<<<<< HEAD
}): QaEvidenceScorecardJson {
  const primaryCoverageIds = coverageIdsForRole(params.evidence.entries, "primary");
  const secondaryCoverageIds = coverageIdsForRole(params.evidence.entries, "secondary");
  const categoryInputs = params.categories.map((category) => ({
    category,
    features: category.features,
    coverageIds: uniqueSortedStrings(category.coverageIds),
  }));
  const categoryReports = categoryInputs.map(({ category, features, coverageIds }) => {
    const fulfilledCoverageIdCount = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    const secondaryOnlyCoverageIdCount = coverageIds.filter(
      (coverageId) => !primaryCoverageIds.has(coverageId) && secondaryCoverageIds.has(coverageId),
    ).length;
    const missingCoverageIds = uniqueSortedStrings(
      coverageIds.filter((coverageId) => !primaryCoverageIds.has(coverageId)),
    );
    const missingCoverageIdCount = coverageIds.length - fulfilledCoverageIdCount;
=======
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
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return {
      id: category.id,
      surfaceId: category.taxonomySurfaceId,
      name: category.taxonomyCategoryName,
      status: statusForCategory({
<<<<<<< HEAD
        coverageIdCount: coverageIds.length,
        fulfilledCoverageIdCount,
      }),
      features: featureCounts(features, primaryCoverageIds),
      coverageIds: {
        total: coverageIds.length,
        fulfilled: fulfilledCoverageIdCount,
        secondaryOnly: secondaryOnlyCoverageIdCount,
        missing: missingCoverageIdCount,
        fulfillmentPercent: percent(fulfilledCoverageIdCount, coverageIds.length),
=======
        featureCount: featureCoverageIds.length,
        fulfilledFeatureCount,
      }),
      features: {
        total: featureCoverageIds.length,
        fulfilled: fulfilledFeatureCount,
        secondaryOnly: secondaryOnlyFeatureCount,
        missing: missingFeatureCount,
        fulfillmentPercent: percent(fulfilledFeatureCount, featureCoverageIds.length),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      },
      missingCoverageIds,
    };
  });
<<<<<<< HEAD
  const profileCoverageIds = uniqueSortedStrings(
    categoryInputs.flatMap((input) => input.coverageIds),
  );
  const coverageIdCount = profileCoverageIds.length;
  const fulfilledCoverageIdCount = profileCoverageIds.filter((coverageId) =>
    primaryCoverageIds.has(coverageId),
  ).length;
  const missingCoverageIdCount = coverageIdCount - fulfilledCoverageIdCount;
=======
  const featureCount = categoryReports.reduce((sum, category) => sum + category.features.total, 0);
  const fulfilledFeatureCount = categoryReports.reduce(
    (sum, category) => sum + category.features.fulfilled,
    0,
  );
  const missingFeatureCount = categoryReports.reduce(
    (sum, category) => sum + category.features.missing,
    0,
  );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const fulfilledCategoryCount = categoryReports.filter(
    (category) => category.status === "fulfilled",
  ).length;
  const partialCategoryCount = categoryReports.filter(
    (category) => category.status === "partial",
  ).length;
  const missingCategoryCount = categoryReports.filter(
    (category) => category.status === "missing",
  ).length;
<<<<<<< HEAD
  const profileFeatures = categoryInputs.flatMap((input) => input.features);
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    features: featureCounts(profileFeatures, primaryCoverageIds),
    coverageIds: {
      total: coverageIdCount,
      fulfilled: fulfilledCoverageIdCount,
      missing: missingCoverageIdCount,
      fulfillmentPercent: percent(fulfilledCoverageIdCount, coverageIdCount),
=======
    features: {
      total: featureCount,
      fulfilled: fulfilledFeatureCount,
      missing: missingFeatureCount,
      fulfillmentPercent: percent(fulfilledFeatureCount, featureCount),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
=======
    featureCoverageByCategoryId: readQaScorecardFeatureCoverageByCategory(),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
