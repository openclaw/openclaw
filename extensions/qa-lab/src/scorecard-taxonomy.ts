// Qa Lab plugin module validates taxonomy-backed QA scorecard evidence.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { resolveQaRepoPath, type QaRepoPathKind } from "./repo-path.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export const QA_MATURITY_TAXONOMY_PATH = "taxonomy.yaml";

const qaScorecardIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, {
    message: "scorecard ids must use lowercase dotted or dashed tokens",
  });

const qaCoverageIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/, {
    message: "coverage ids must use lowercase dotted tokens",
  });

function isRepoRootRelativeRef(value: string) {
  return !path.isAbsolute(value) && value.split(/[\\/]+/u).every((part) => part !== "..");
}

const qaCoverageEvidenceRoleSchema = z.enum(["primary", "secondary"]);
export const qaScorecardEvidenceModeSchema = z.enum(["full", "slim"]);

const qaScorecardProfileSchema = z.object({
  id: qaScorecardIdSchema,
  description: z.string().trim().min(1),
  evidenceMode: qaScorecardEvidenceModeSchema.optional(),
  includeAllCategories: z.boolean().default(false),
  categoryIds: z.array(qaScorecardIdSchema).default([]),
});

const qaMaturityFeatureSchema = z.object({
  name: z.string().trim().min(1),
  coverageIds: z.array(qaCoverageIdSchema).default([]),
  description: z.string().trim().min(1).optional(),
});

const qaMaturityCategorySchema = z.object({
  id: qaScorecardIdSchema,
  name: z.string().trim().min(1),
  features: z.array(qaMaturityFeatureSchema).default([]),
});

const qaMaturitySurfaceSchema = z.object({
  id: qaScorecardIdSchema,
  name: z.string().trim().min(1),
  level: z.string().trim().min(1).optional(),
  level_code: z.string().trim().min(1).optional(),
  categories: z.array(qaMaturityCategorySchema).default([]),
});

const qaMaturityTaxonomySchema = z
  .object({
    version: z.number(),
    title: z.string().trim().min(1),
    profiles: z.array(qaScorecardProfileSchema).default([]),
    surfaces: z.array(qaMaturitySurfaceSchema).default([]),
  })
  .superRefine((taxonomy, ctx) => {
    const seenProfileIds = new Set<string>();
    for (const [profileIndex, profile] of taxonomy.profiles.entries()) {
      if (seenProfileIds.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "id"],
          message: `duplicate scorecard profile id: ${profile.id}`,
        });
      }
      seenProfileIds.add(profile.id);

      if (profile.includeAllCategories && profile.categoryIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "categoryIds"],
          message: `profile ${profile.id} cannot set categoryIds when includeAllCategories is true`,
        });
      }

      const seenProfileCategoryIds = new Set<string>();
      for (const [categoryIndex, categoryId] of profile.categoryIds.entries()) {
        if (seenProfileCategoryIds.has(categoryId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileIndex, "categoryIds", categoryIndex],
            message: `duplicate category id in profile ${profile.id}: ${categoryId}`,
          });
        }
        seenProfileCategoryIds.add(categoryId);
      }
    }
  });

export type QaNativeCoverageEvidenceKind = "script" | "vitest" | "playwright";
export type QaScorecardEvidenceKind = QaNativeCoverageEvidenceKind | "qa-scenario";
export type QaScorecardEvidenceMode = z.infer<typeof qaScorecardEvidenceModeSchema>;
type QaCoverageEvidenceRole = z.infer<typeof qaCoverageEvidenceRoleSchema>;
type QaMaturityTaxonomy = z.infer<typeof qaMaturityTaxonomySchema>;

export type QaScorecardValidationIssueCode =
  | "coverage-id-missing-primary-evidence"
  | "coverage-id-not-found"
  | "evidence-ref-not-found"
  | "taxonomy-ref-not-found"
  | "taxonomy-category-ref-not-found"
  | "profile-category-ref-not-found"
  | "profile-category-missing-evidence";

export type QaScorecardValidationIssue = {
  code: QaScorecardValidationIssueCode;
  severity: "warning";
  categoryId?: string;
  ref?: string;
  message: string;
};

export type QaScorecardEvidenceReport = {
  coverageId: string;
  kind: QaScorecardEvidenceKind;
  path: string | null;
  role: QaCoverageEvidenceRole;
  scenarioRefs: string[];
};

export type QaScorecardCategoryCoverageReport = {
  id: string;
  taxonomySurfaceId: string;
  taxonomyCategoryName: string;
  coverageStatus: "covered" | "partial" | "missing";
  profiles: string[];
  coverageIds: string[];
  fulfilledCoverageIds: string[];
  evidence: QaScorecardEvidenceReport[];
  scenarioRefs: string[];
  missingCoverageIds: string[];
  missingEvidenceRefs: string[];
};

export type QaScorecardProfileReport = {
  id: string;
  evidenceMode: QaScorecardEvidenceMode;
  categoryIds: string[];
};

export type QaScorecardTaxonomyReport = {
  taxonomyPath: string | null;
  title: string | null;
  taxonomy: {
    sourcePath: string;
  } | null;
  profileCount: number;
  profiles: QaScorecardProfileReport[];
  categoryCount: number;
  requiredCategoryCount: number;
  fulfilledCategoryCount: number;
  categoryFulfillmentPercent: number;
  requiredFeatureCount: number;
  fulfilledFeatureCount: number;
  taxonomyFulfillmentPercent: number;
  evidenceRefCount: number;
  scenarioCoverageIdCount: number;
  unknownCoverageIdCount: number;
  unknownCoverageIds: string[];
  validationIssueCount: number;
  validationIssues: QaScorecardValidationIssue[];
  categories: QaScorecardCategoryCoverageReport[];
};

type MaturityCategoryRef = {
  id: string;
  surfaceId: string;
  categoryName: string;
  features: MaturityFeatureRef[];
  coverageIds: string[];
};

type MaturityFeatureRef = {
  name: string;
  coverageIds: string[];
};

type MaturityCoverageRef = {
  coverageId: string;
  categoryId: string;
  surfaceId: string;
};

function resolveRepoPath(relativePath: string, kind: QaRepoPathKind = "file") {
  return resolveQaRepoPath(import.meta.dirname, relativePath, kind);
}

function repoRootFromPath(filePath: string) {
  return path.dirname(filePath);
}

function formatZodIssuePath(pathLocal: PropertyKey[]) {
  return pathLocal.length ? pathLocal.map(String).join(".") : "<root>";
}

function parseQaMaturityTaxonomy(value: unknown, label = QA_MATURITY_TAXONOMY_PATH) {
  const parsed = qaMaturityTaxonomySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${formatZodIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}: ${issues}`);
}

function readQaMaturityTaxonomy(repoRoot: string | undefined) {
  const taxonomyPath = repoRoot
    ? path.join(repoRoot, QA_MATURITY_TAXONOMY_PATH)
    : resolveRepoPath(QA_MATURITY_TAXONOMY_PATH);
  if (!taxonomyPath || !fs.existsSync(taxonomyPath)) {
    return null;
  }
  return parseQaMaturityTaxonomy(
    YAML.parse(fs.readFileSync(taxonomyPath, "utf8")) as unknown,
    QA_MATURITY_TAXONOMY_PATH,
  );
}

function pathExists(repoRoot: string | undefined, relativePath: string) {
  if (!isRepoRootRelativeRef(relativePath)) {
    return false;
  }
  return repoRoot ? fs.existsSync(path.join(repoRoot, relativePath)) : true;
}

function scenarioCoverageIds(scenario: QaSeedScenarioWithSource) {
  return [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])];
}

type ScenarioEvidenceRef = {
  sourcePath: string;
  kind: QaScorecardEvidenceKind;
  path: string | null;
};

function scenarioEvidenceKind(scenario: QaSeedScenarioWithSource): QaScorecardEvidenceKind {
  return scenario.execution.kind === "flow" ? "qa-scenario" : scenario.execution.kind;
}

function scenarioEvidencePath(scenario: QaSeedScenarioWithSource) {
  return scenario.execution.kind === "flow" ? null : scenario.execution.path;
}

function collectScenarioEvidenceByCoverageId(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  role: QaCoverageEvidenceRole;
}) {
  const refsByCoverageId = new Map<string, ScenarioEvidenceRef[]>();
  for (const scenario of params.scenarios) {
    const coverageIds =
      params.role === "primary"
        ? (scenario.coverage?.primary ?? [])
        : (scenario.coverage?.secondary ?? []);
    for (const coverageId of coverageIds) {
      const refs = refsByCoverageId.get(coverageId) ?? [];
      refs.push({
        sourcePath: scenario.sourcePath,
        kind: scenarioEvidenceKind(scenario),
        path: scenarioEvidencePath(scenario),
      });
      refsByCoverageId.set(coverageId, refs);
    }
  }
  return refsByCoverageId;
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function percent(part: number, total: number) {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

function buildMaturityRefs(taxonomy: QaMaturityTaxonomy | null) {
  const categories = new Map<string, MaturityCategoryRef>();
  const coverageIds = new Map<string, MaturityCoverageRef[]>();
  if (!taxonomy) {
    return { categories, coverageIds };
  }

  for (const surface of taxonomy.surfaces) {
    for (const category of surface.categories) {
      const categoryId = `${surface.id}.${category.id}`;
      const features = category.features.map((feature) => ({
        name: feature.name,
        coverageIds: uniqueSorted(feature.coverageIds),
      }));
      const categoryCoverageIds = uniqueSorted(features.flatMap((feature) => feature.coverageIds));
      for (const coverageId of categoryCoverageIds) {
        const refs = coverageIds.get(coverageId) ?? [];
        refs.push({
          coverageId,
          categoryId,
          surfaceId: surface.id,
        });
        coverageIds.set(coverageId, refs);
      }
      categories.set(categoryId, {
        id: categoryId,
        surfaceId: surface.id,
        categoryName: category.name,
        features,
        coverageIds: categoryCoverageIds,
      });
    }
  }
  return { categories, coverageIds };
}

export function readQaScorecardFeatureCoverageByCategory(repoRoot?: string) {
  const maturityRefs = buildMaturityRefs(readQaMaturityTaxonomy(repoRoot));
  return new Map(
    [...maturityRefs.categories.entries()].map(([categoryId, category]) => [
      categoryId,
      category.features.map((feature) => feature.coverageIds),
    ]),
  );
}

export function readQaScorecardProfileOptions(profileId: string | undefined, repoRoot?: string) {
  const profile = profileId?.trim();
  if (!profile) {
    return { evidenceMode: "full" as const };
  }
  return {
    evidenceMode:
      readQaMaturityTaxonomy(repoRoot)?.profiles.find((entry) => entry.id === profile)
        ?.evidenceMode ?? "full",
  };
}

function pushMissingPrimaryIssues(params: {
  issues: QaScorecardValidationIssue[];
  category: MaturityCategoryRef;
  coverageIdsWithPrimaryEvidence: ReadonlySet<string>;
  coverageIdsWithSecondaryEvidence: ReadonlySet<string>;
}) {
  for (const feature of params.category.features) {
    for (const coverageId of feature.coverageIds) {
      if (params.coverageIdsWithPrimaryEvidence.has(coverageId)) {
        continue;
      }
      const reason = params.coverageIdsWithSecondaryEvidence.has(coverageId)
        ? "only has secondary evidence"
        : "has no primary evidence";
      params.issues.push({
        code: "coverage-id-missing-primary-evidence",
        severity: "warning",
        categoryId: params.category.id,
        ref: coverageId,
        message: `${params.category.id} feature ${feature.name} coverage ID ${coverageId} ${reason}`,
      });
    }
  }
}

function collectEvidenceReportsForCoverageId(params: {
  coverageId: string;
  role: QaCoverageEvidenceRole;
  refs: readonly ScenarioEvidenceRef[];
  repoRoot?: string;
  categoryId: string;
  issues: QaScorecardValidationIssue[];
  missingEvidenceRefsByCategoryId: Map<string, Set<string>>;
}) {
  const grouped = new Map<string, QaScorecardEvidenceReport>();
  for (const ref of params.refs) {
    if (ref.path && !pathExists(params.repoRoot, ref.path)) {
      const missingRefs =
        params.missingEvidenceRefsByCategoryId.get(params.categoryId) ?? new Set();
      missingRefs.add(ref.path);
      params.missingEvidenceRefsByCategoryId.set(params.categoryId, missingRefs);
      params.issues.push({
        code: "evidence-ref-not-found",
        severity: "warning",
        categoryId: params.categoryId,
        ref: ref.path,
        message: `${params.categoryId} references missing ${ref.kind} evidence ${ref.path}`,
      });
      continue;
    }

    const key = `${ref.kind}\0${ref.path ?? ""}`;
    const report =
      grouped.get(key) ??
      ({
        coverageId: params.coverageId,
        kind: ref.kind,
        path: ref.path,
        role: params.role,
        scenarioRefs: [],
      } satisfies QaScorecardEvidenceReport);
    report.scenarioRefs.push(ref.sourcePath);
    grouped.set(key, report);
  }

  return [...grouped.values()].map((report) => {
    report.scenarioRefs = uniqueSorted(report.scenarioRefs);
    return report;
  });
}

export function buildQaScorecardTaxonomyReport(params: {
  taxonomy: QaMaturityTaxonomy | null;
  taxonomyPath?: string | null;
  repoRoot?: string;
  scenarios: readonly QaSeedScenarioWithSource[];
}): QaScorecardTaxonomyReport {
  const maturityRefs = buildMaturityRefs(params.taxonomy);
  const issues: QaScorecardValidationIssue[] = [];
  const categories: QaScorecardCategoryCoverageReport[] = [];
  const primaryScenarioRefsByCoverageId = collectScenarioEvidenceByCoverageId({
    scenarios: params.scenarios,
    role: "primary",
  });
  const secondaryScenarioRefsByCoverageId = collectScenarioEvidenceByCoverageId({
    scenarios: params.scenarios,
    role: "secondary",
  });
  const allScenarioCoverageIds = uniqueSorted(params.scenarios.flatMap(scenarioCoverageIds));
  const missingEvidenceRefsByCategoryId = new Map<string, Set<string>>();

  if (!pathExists(params.repoRoot, QA_MATURITY_TAXONOMY_PATH) || !params.taxonomy) {
    issues.push({
      code: "taxonomy-ref-not-found",
      severity: "warning",
      ref: QA_MATURITY_TAXONOMY_PATH,
      message: `Scorecard taxonomy not found at ${QA_MATURITY_TAXONOMY_PATH}`,
    });
  }

  for (const coverageId of allScenarioCoverageIds) {
    if (!maturityRefs.coverageIds.has(coverageId)) {
      issues.push({
        code: "coverage-id-not-found",
        severity: "warning",
        ref: coverageId,
        message: `QA scenario references missing taxonomy coverage ID ${coverageId}`,
      });
    }
  }

  const profileCategoryIdsByCategoryId = new Map<string, Set<string>>();
  const profiles =
    params.taxonomy?.profiles.map((profile) => {
      const validCategoryIds: string[] = [];
      const selectedCategoryIds = profile.includeAllCategories
        ? [...maturityRefs.categories.keys()]
        : profile.categoryIds;
      for (const categoryId of selectedCategoryIds) {
        if (!maturityRefs.categories.has(categoryId)) {
          issues.push({
            code: "profile-category-ref-not-found",
            severity: "warning",
            ref: categoryId,
            message: `${profile.id} profile references missing taxonomy category ${categoryId}`,
          });
          continue;
        }
        const profileIds = profileCategoryIdsByCategoryId.get(categoryId) ?? new Set<string>();
        profileIds.add(profile.id);
        profileCategoryIdsByCategoryId.set(categoryId, profileIds);
        validCategoryIds.push(categoryId);
      }
      return {
        id: profile.id,
        evidenceMode: profile.evidenceMode ?? "full",
        categoryIds: validCategoryIds,
      };
    }) ?? [];

  const categoryIdsWithEvidence = new Set<string>();
  for (const coverageId of [
    ...primaryScenarioRefsByCoverageId.keys(),
    ...secondaryScenarioRefsByCoverageId.keys(),
  ]) {
    const coverageRefs = maturityRefs.coverageIds.get(coverageId) ?? [];
    for (const coverageRef of coverageRefs) {
      categoryIdsWithEvidence.add(coverageRef.categoryId);
    }
  }
  const relevantCategoryIds = uniqueSorted([
    ...profileCategoryIdsByCategoryId.keys(),
    ...categoryIdsWithEvidence,
  ]);

  let requiredFeatureCount = 0;
  let fulfilledFeatureCount = 0;
  for (const categoryId of relevantCategoryIds) {
    const category = maturityRefs.categories.get(categoryId);
    if (!category) {
      issues.push({
        code: "taxonomy-category-ref-not-found",
        severity: "warning",
        ref: categoryId,
        message: `${categoryId} does not match a maturity taxonomy category`,
      });
      continue;
    }

    const profileIds = uniqueSorted(profileCategoryIdsByCategoryId.get(categoryId) ?? []);
    const required = profileIds.length > 0;
    const evidenceReports: QaScorecardEvidenceReport[] = [];
    const categoryScenarioRefs = new Set<string>();
    const fulfilledCoverageIds = new Set<string>();
    const secondaryOnlyCoverageIds = new Set<string>();
    const coverageIdsWithAnyEvidence = new Set<string>();

    for (const coverageId of category.coverageIds) {
      const primaryScenarioRefs = primaryScenarioRefsByCoverageId.get(coverageId) ?? [];
      const secondaryScenarioRefs = secondaryScenarioRefsByCoverageId.get(coverageId) ?? [];
      const primaryEvidenceReports = collectEvidenceReportsForCoverageId({
        coverageId,
        role: "primary",
        refs: primaryScenarioRefs,
        repoRoot: params.repoRoot,
        categoryId,
        issues,
        missingEvidenceRefsByCategoryId,
      });
      const secondaryEvidenceReports = collectEvidenceReportsForCoverageId({
        coverageId,
        role: "secondary",
        refs: secondaryScenarioRefs,
        repoRoot: params.repoRoot,
        categoryId,
        issues,
        missingEvidenceRefsByCategoryId,
      });

      if (primaryEvidenceReports.length > 0) {
        for (const scenarioRef of primaryEvidenceReports.flatMap((report) => report.scenarioRefs)) {
          categoryScenarioRefs.add(scenarioRef);
        }
        fulfilledCoverageIds.add(coverageId);
        coverageIdsWithAnyEvidence.add(coverageId);
        evidenceReports.push(...primaryEvidenceReports);
      }

      if (secondaryEvidenceReports.length > 0) {
        for (const scenarioRef of secondaryEvidenceReports.flatMap(
          (report) => report.scenarioRefs,
        )) {
          categoryScenarioRefs.add(scenarioRef);
        }
        if (!fulfilledCoverageIds.has(coverageId)) {
          secondaryOnlyCoverageIds.add(coverageId);
        }
        coverageIdsWithAnyEvidence.add(coverageId);
        evidenceReports.push(...secondaryEvidenceReports);
      }
    }

    const fulfilledFeatureCountForCategory = category.features.filter(
      (feature) =>
        feature.coverageIds.length > 0 &&
        feature.coverageIds.every((coverageId) => fulfilledCoverageIds.has(coverageId)),
    ).length;
    if (required) {
      requiredFeatureCount += category.features.length;
      fulfilledFeatureCount += fulfilledFeatureCountForCategory;
      pushMissingPrimaryIssues({
        issues,
        category,
        coverageIdsWithPrimaryEvidence: fulfilledCoverageIds,
        coverageIdsWithSecondaryEvidence: secondaryOnlyCoverageIds,
      });
      if (fulfilledFeatureCountForCategory === 0) {
        issues.push({
          code: "profile-category-missing-evidence",
          severity: "warning",
          categoryId,
          message: `${categoryId} is selected by a runnable profile but has no primary coverage evidence`,
        });
      }
    }

    const missingCoverageIds = required
      ? category.coverageIds.filter((coverageId) => !coverageIdsWithAnyEvidence.has(coverageId))
      : [];
    const coverageStatus =
      required &&
      category.features.length > 0 &&
      fulfilledFeatureCountForCategory === category.features.length
        ? "covered"
        : evidenceReports.length > 0
          ? "partial"
          : "missing";

    categories.push({
      id: category.id,
      taxonomySurfaceId: category.surfaceId,
      taxonomyCategoryName: category.categoryName,
      coverageStatus,
      profiles: profileIds,
      coverageIds: category.coverageIds,
      fulfilledCoverageIds: uniqueSorted(fulfilledCoverageIds),
      evidence: evidenceReports.toSorted((left, right) =>
        `${left.coverageId}:${left.kind}:${left.path ?? ""}:${left.role}`.localeCompare(
          `${right.coverageId}:${right.kind}:${right.path ?? ""}:${right.role}`,
        ),
      ),
      scenarioRefs: uniqueSorted(categoryScenarioRefs),
      missingCoverageIds: uniqueSorted(missingCoverageIds),
      missingEvidenceRefs: uniqueSorted(missingEvidenceRefsByCategoryId.get(categoryId) ?? []),
    });
  }

  const requiredCategories = categories.filter((category) => category.profiles.length > 0);
  const fulfilledCategoryCount = requiredCategories.filter(
    (category) => category.coverageStatus === "covered",
  ).length;
  const unknownCoverageIds = allScenarioCoverageIds.filter(
    (coverageId) => !maturityRefs.coverageIds.has(coverageId),
  );

  return {
    taxonomyPath:
      params.taxonomyPath === undefined ? QA_MATURITY_TAXONOMY_PATH : params.taxonomyPath,
    title: params.taxonomy?.title ?? null,
    taxonomy: params.taxonomy
      ? {
          sourcePath: QA_MATURITY_TAXONOMY_PATH,
        }
      : null,
    profileCount: params.taxonomy?.profiles.length ?? 0,
    profiles,
    categoryCount: maturityRefs.categories.size,
    requiredCategoryCount: requiredCategories.length,
    fulfilledCategoryCount,
    categoryFulfillmentPercent: percent(fulfilledCategoryCount, requiredCategories.length),
    requiredFeatureCount,
    fulfilledFeatureCount,
    taxonomyFulfillmentPercent: percent(fulfilledFeatureCount, requiredFeatureCount),
    evidenceRefCount: categories.reduce((count, category) => count + category.evidence.length, 0),
    scenarioCoverageIdCount: allScenarioCoverageIds.length,
    unknownCoverageIdCount: unknownCoverageIds.length,
    unknownCoverageIds,
    validationIssueCount: issues.length,
    validationIssues: issues,
    categories,
  };
}

export function readQaScorecardTaxonomyReport(scenarios: readonly QaSeedScenarioWithSource[]) {
  const taxonomyPath = resolveRepoPath(QA_MATURITY_TAXONOMY_PATH, "file");
  const repoRoot = taxonomyPath ? repoRootFromPath(taxonomyPath) : undefined;
  return buildQaScorecardTaxonomyReport({
    taxonomy: readQaMaturityTaxonomy(repoRoot),
    taxonomyPath: taxonomyPath ? QA_MATURITY_TAXONOMY_PATH : null,
    repoRoot,
    scenarios,
  });
}
