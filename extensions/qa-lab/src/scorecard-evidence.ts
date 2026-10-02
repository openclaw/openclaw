import fs from "node:fs/promises";
import { normalizeSortedUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  attachQaEvidenceScorecard,
  getEffectiveQaEvidenceEntries,
  validateQaEvidenceSummaryJson,
  type QaEvidenceScorecardJson,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan, type QaProfileEvidencePlan } from "./profile-evidence-plan.js";
import type {
  QaScorecardCategoryCoverageReport,
  QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

type QaProfileScorecardFilters = {
  surface?: string;
  category?: string;
};

type EvidenceCoverageRole = QaEvidenceSummaryEntry["coverage"][number]["role"];

function fulfillmentCounts(total: number, fulfilled: number, partial?: number) {
  return {
    total,
    fulfilled,
    ...(partial === undefined ? {} : { partial }),
    missing: total - fulfilled - (partial ?? 0),
    fulfillmentPercent: total === 0 ? 0 : Number(((fulfilled / total) * 100).toFixed(1)),
  };
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

function statusForCategory(params: { coverageIdCount: number; fulfilledCoverageIdCount: number }) {
  if (params.fulfilledCoverageIdCount === 0) {
    return "missing" as const;
  }
  if (params.fulfilledCoverageIdCount === params.coverageIdCount) {
    return "fulfilled" as const;
  }
  return "partial" as const;
}

function featureCounts(
  features: readonly { coverageIds: readonly string[] }[],
  primaryCoverageIds: ReadonlySet<string>,
) {
  let fulfilled = 0;
  let partial = 0;
  for (const feature of features) {
    const coverageIds = normalizeSortedUniqueTrimmedStringList(feature.coverageIds);
    const fulfilledCoverageIds = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    if (coverageIds.length > 0 && fulfilledCoverageIds === coverageIds.length) {
      fulfilled += 1;
    } else if (fulfilledCoverageIds > 0) {
      partial += 1;
    }
  }
  return fulfillmentCounts(features.length, fulfilled, partial);
}

function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  profilePlan: QaProfileEvidencePlan;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
}): QaEvidenceScorecardJson {
  const containment =
    params.evidence.schemaVersion === 3
      ? resolveQaEvidenceContainment(params.evidence.occurrences, params.evidence.entries)
      : undefined;
  // Coverage is a qualifying projection; raw rows keep their captured roles and
  // object identity for history, binding validation and gallery selection.
  const entries = getEffectiveQaEvidenceEntries(params.evidence).map((entry) =>
    containment && "binding" in entry
      ? Object.assign({}, entry, {
          coverage: containment.projectCoverage(entry.binding.occurrenceId, entry.coverage),
        })
      : entry,
  );
  // Only passing primary evidence fulfills coverage; secondary evidence remains diagnostic.
  const passingEntries = entries.filter((entry) => entry.result.status === "pass");
  const primaryCoverageIds = coverageIdsForRole(passingEntries, "primary");
  for (const requirement of qaProfileEvidencePlan.evaluateProof(
    params.profilePlan,
    params.evidence,
  )) {
    if (requirement.obligation === "required" && !requirement.qualified) {
      primaryCoverageIds.delete(requirement.coverageId);
    }
  }
  const secondaryCoverageIds = coverageIdsForRole(entries, "secondary");
  const categoryReports = params.categories.map((category) => {
    const coverageIds = normalizeSortedUniqueTrimmedStringList(category.coverageIds);
    const fulfilledCoverageIdCount = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    const secondaryOnlyCoverageIdCount = coverageIds.filter(
      (coverageId) => !primaryCoverageIds.has(coverageId) && secondaryCoverageIds.has(coverageId),
    ).length;
    const missingCoverageIds = coverageIds.filter(
      (coverageId) => !primaryCoverageIds.has(coverageId),
    );
    const counts = fulfillmentCounts(coverageIds.length, fulfilledCoverageIdCount);
    return {
      id: category.id,
      surfaceId: category.taxonomySurfaceId,
      name: category.taxonomyCategoryName,
      status: statusForCategory({
        coverageIdCount: coverageIds.length,
        fulfilledCoverageIdCount,
      }),
      features: featureCounts(category.features, primaryCoverageIds),
      coverageIds: {
        total: counts.total,
        fulfilled: counts.fulfilled,
        secondaryOnly: secondaryOnlyCoverageIdCount,
        missing: counts.missing,
        fulfillmentPercent: counts.fulfillmentPercent,
      },
      missingCoverageIds,
    };
  });
  const profileCoverageIds = normalizeSortedUniqueTrimmedStringList(
    params.categories.flatMap((category) => category.coverageIds),
  );
  const coverageIdCount = profileCoverageIds.length;
  const fulfilledCoverageIdCount = profileCoverageIds.filter((coverageId) =>
    primaryCoverageIds.has(coverageId),
  ).length;
  const fulfilledCategoryCount = categoryReports.filter(
    (category) => category.status === "fulfilled",
  ).length;
  const partialCategoryCount = categoryReports.filter(
    (category) => category.status === "partial",
  ).length;
  const profileFeatures = params.categories.flatMap((category) => category.features);
  return {
    filters: {
      surface: params.filters.surface?.trim() || null,
      category: params.filters.category?.trim() || null,
    },
    run: {
      evidenceEntryCount: entries.length,
    },
    categories: fulfillmentCounts(
      categoryReports.length,
      fulfilledCategoryCount,
      partialCategoryCount,
    ),
    features: featureCounts(profileFeatures, primaryCoverageIds),
    coverageIds: fulfillmentCounts(coverageIdCount, fulfilledCoverageIdCount),
    categoryReports,
  };
}

export async function attachQaProfileScorecardEvidenceToFile(params: {
  evidencePath: string;
  evidenceMode?: QaScorecardEvidenceMode;
  profile: string;
  profilePlan: QaProfileEvidencePlan;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(params.evidencePath, "utf8")),
  );
  const scorecard = buildQaProfileScorecardEvidence({
    evidence,
    profilePlan: params.profilePlan,
    filters: params.filters,
    categories: params.categories,
  });
  const nextEvidence = attachQaEvidenceScorecard({
    summary: evidence,
    evidenceMode: params.evidenceMode,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard,
  });
  await fs.writeFile(params.evidencePath, `${JSON.stringify(nextEvidence, null, 2)}\n`, "utf8");
  return scorecard;
}
