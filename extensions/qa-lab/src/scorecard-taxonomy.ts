// Qa Lab plugin module validates the scorecard evidence mapping overlay.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isRepoRootRelativeRef } from "./cli-paths.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export const QA_SCORECARD_TAXONOMY_PATH = "taxonomy-mappings.yaml";
export const QA_MATURITY_TAXONOMY_PATH = "taxonomy.yaml";

const qaScorecardIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, {
    message: "scorecard and coverage ids must use lowercase dotted or dashed tokens",
  });

const qaScorecardRepoRefSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9._/-]+$/, {
    message: "repo refs must be repo-root relative paths",
  })
  .refine(isRepoRootRelativeRef, {
    message: "repo refs must not be absolute or contain parent-directory segments",
  });

const qaScorecardEvidenceRefKindSchema = z.enum([
  "qa-scenario",
  "vitest",
  "playwright",
  "live-transport-check",
]);

const qaScorecardTaxonomyRefSchema = z
  .object({
    sourcePath: qaScorecardRepoRefSchema,
  })
  .strict();

const qaScorecardProfileSchema = z.object({
  id: qaScorecardIdSchema,
  description: z.string().trim().min(1),
  categoryIds: z.array(qaScorecardIdSchema).default([]),
});

const qaScorecardCategorySchema = z.object({
  id: qaScorecardIdSchema,
  taxonomySurfaceId: qaScorecardIdSchema,
  taxonomyCategoryName: z.string().trim().min(1),
  evidence: z.object({
    coverageIds: z.array(qaScorecardIdSchema).default([]),
    evidenceRefs: z
      .array(
        z
          .object({
            kind: qaScorecardEvidenceRefKindSchema,
            path: qaScorecardRepoRefSchema,
          })
          .strict(),
      )
      .default([]),
  }),
});

const qaScorecardTaxonomySchema = z
  .object({
    version: z.literal(1),
    id: qaScorecardIdSchema,
    title: z.string().trim().min(1),
    taxonomy: qaScorecardTaxonomyRefSchema,
    profiles: z.array(qaScorecardProfileSchema).min(1),
    categories: z.array(qaScorecardCategorySchema).min(1),
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

    const seenCategoryIds = new Set<string>();
    for (const [categoryIndex, category] of taxonomy.categories.entries()) {
      if (seenCategoryIds.has(category.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryIndex, "id"],
          message: `duplicate scorecard category id: ${category.id}`,
        });
      }
      seenCategoryIds.add(category.id);

      const seenCoverageIds = new Set<string>();
      for (const [coverageIndex, coverageId] of category.evidence.coverageIds.entries()) {
        if (seenCoverageIds.has(coverageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["categories", categoryIndex, "evidence", "coverageIds", coverageIndex],
            message: `duplicate coverage id in category ${category.id}: ${coverageId}`,
          });
        }
        seenCoverageIds.add(coverageId);
      }
    }
  });

export type QaScorecardEvidenceRefKind = z.infer<typeof qaScorecardEvidenceRefKindSchema>;

const qaMaturityCategorySchema = z.object({
  name: z.string().trim().min(1),
});

const qaMaturitySurfaceSchema = z.object({
  id: qaScorecardIdSchema,
  name: z.string().trim().min(1),
  level: z.string().trim().min(1).optional(),
  level_code: z.string().trim().min(1).optional(),
  categories: z.array(qaMaturityCategorySchema).default([]),
});

const qaMaturityTaxonomySchema = z.object({
  version: z.number(),
  title: z.string().trim().min(1),
  surfaces: z.array(qaMaturitySurfaceSchema).default([]),
});

export type QaScorecardTaxonomy = z.infer<typeof qaScorecardTaxonomySchema>;
export type QaScorecardTaxonomyCategory = QaScorecardTaxonomy["categories"][number];
type QaMaturityTaxonomy = z.infer<typeof qaMaturityTaxonomySchema>;

export type QaScorecardValidationIssueCode =
  | "coverage-id-not-found"
  | "evidence-ref-not-found"
  | "evidence-ref-not-covered-by-category"
  | "taxonomy-ref-not-found"
  | "taxonomy-category-ref-not-found"
  | "profile-category-ref-not-found"
  | "category-without-profile-or-evidence"
  | "mapped-category-missing-profile-membership"
  | "profile-category-missing-evidence-mapping"
  | "taxonomy-fixture-not-found";

export type QaScorecardValidationIssue = {
  code: QaScorecardValidationIssueCode;
  severity: "warning";
  categoryId?: string;
  ref?: string;
  message: string;
};

export type QaScorecardCategoryMappingReport = {
  id: string;
  taxonomySurfaceId: string;
  taxonomyCategoryName: string;
  mappingStatus: "mapped" | "partial" | "missing";
  profiles: string[];
  coverageIds: string[];
  evidenceRefs: Array<{
    kind: QaScorecardEvidenceRefKind;
    path: string;
  }>;
  missingCoverageIds: string[];
  missingEvidenceRefs: string[];
};

export type QaScorecardProfileReport = {
  id: string;
  categoryIds: string[];
};

export type QaScorecardTaxonomyReport = {
  taxonomyPath: string | null;
  taxonomyId: string | null;
  title: string | null;
  taxonomy: {
    sourcePath: string;
  } | null;
  profileCount: number;
  profiles: QaScorecardProfileReport[];
  categoryCount: number;
  mappedCoverageIdCount: number;
  mappedCoverageIdPercent: number;
  mappedEvidenceRefCount: number;
  unmappedCoverageIdCount: number;
  unmappedCoverageIds: string[];
  validationIssueCount: number;
  validationIssues: QaScorecardValidationIssue[];
  categories: QaScorecardCategoryMappingReport[];
};

function walkUpDirectories(start: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

function resolveRepoPath(relativePath: string, kind: "file" | "directory" = "file") {
  for (const dir of walkUpDirectories(import.meta.dirname)) {
    const candidate = path.join(dir, relativePath);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.statSync(candidate);
    if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
      return candidate;
    }
  }
  return null;
}

function repoRootFromMappingPath(mappingPath: string) {
  return path.dirname(mappingPath);
}

function formatZodIssuePath(pathLocal: PropertyKey[]) {
  return pathLocal.length ? pathLocal.map(String).join(".") : "<root>";
}

export function parseQaScorecardTaxonomy(value: unknown, label = QA_SCORECARD_TAXONOMY_PATH) {
  const parsed = qaScorecardTaxonomySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${formatZodIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}: ${issues}`);
}

export function readQaScorecardTaxonomy(): QaScorecardTaxonomy | null {
  const taxonomyPath = resolveRepoPath(QA_SCORECARD_TAXONOMY_PATH, "file");
  if (!taxonomyPath) {
    return null;
  }
  return parseQaScorecardTaxonomy(
    YAML.parse(fs.readFileSync(taxonomyPath, "utf8")) as unknown,
    QA_SCORECARD_TAXONOMY_PATH,
  );
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

function readQaMaturityTaxonomy(repoRoot: string | undefined, taxonomySourcePath: string) {
  const taxonomyPath = repoRoot
    ? path.join(repoRoot, taxonomySourcePath)
    : resolveRepoPath(taxonomySourcePath);
  if (!taxonomyPath || !fs.existsSync(taxonomyPath)) {
    return null;
  }
  return parseQaMaturityTaxonomy(
    YAML.parse(fs.readFileSync(taxonomyPath, "utf8")) as unknown,
    taxonomySourcePath,
  );
}

function maturityCategoryKey(surfaceId: string, categoryName: string) {
  return `${surfaceId}\0${categoryName}`;
}

function buildMaturityCategoryKeys(taxonomy: QaMaturityTaxonomy | null) {
  const categoryKeys = new Set<string>();
  if (!taxonomy) {
    return categoryKeys;
  }
  for (const surface of taxonomy.surfaces) {
    for (const category of surface.categories) {
      categoryKeys.add(maturityCategoryKey(surface.id, category.name));
    }
  }
  return categoryKeys;
}

function scenarioCoverageIds(scenario: QaSeedScenarioWithSource) {
  return [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])];
}

function pathExists(repoRoot: string | undefined, relativePath: string) {
  if (!isRepoRootRelativeRef(relativePath)) {
    return false;
  }
  return repoRoot ? fs.existsSync(path.join(repoRoot, relativePath)) : true;
}

function formatEvidenceRef(ref: { kind: QaScorecardEvidenceRefKind; path: string }) {
  return `${ref.kind}:${ref.path}`;
}

export function buildQaScorecardTaxonomyReport(params: {
  taxonomy: QaScorecardTaxonomy | null;
  taxonomyPath?: string | null;
  repoRoot?: string;
  scenarios: readonly QaSeedScenarioWithSource[];
}): QaScorecardTaxonomyReport {
  if (!params.taxonomy) {
    const issue = {
      code: "taxonomy-fixture-not-found",
      severity: "warning",
      ref: QA_SCORECARD_TAXONOMY_PATH,
      message: `Scorecard evidence mapping not found at ${QA_SCORECARD_TAXONOMY_PATH}`,
    } satisfies QaScorecardValidationIssue;
    return {
      taxonomyPath: params.taxonomyPath ?? null,
      taxonomyId: null,
      title: null,
      taxonomy: null,
      profileCount: 0,
      profiles: [],
      categoryCount: 0,
      mappedCoverageIdCount: 0,
      mappedCoverageIdPercent: 0,
      mappedEvidenceRefCount: 0,
      unmappedCoverageIdCount: 0,
      unmappedCoverageIds: [],
      validationIssueCount: 1,
      validationIssues: [issue],
      categories: [],
    };
  }

  const coverageIdsByScenarioRef = new Map(
    params.scenarios.map((scenario) => [
      scenario.sourcePath,
      new Set(scenarioCoverageIds(scenario)),
    ]),
  );
  const qaScenarioRefsByCoverageId = new Map<string, Set<string>>();
  for (const scenario of params.scenarios) {
    for (const coverageId of scenarioCoverageIds(scenario)) {
      const refs = qaScenarioRefsByCoverageId.get(coverageId) ?? new Set<string>();
      refs.add(scenario.sourcePath);
      qaScenarioRefsByCoverageId.set(coverageId, refs);
    }
  }

  const issues: QaScorecardValidationIssue[] = [];
  const categories: QaScorecardCategoryMappingReport[] = [];
  const mappedCoverageIds = new Set<string>();
  const mappedEvidenceRefs = new Set<string>();
  const categoryIds = new Set(params.taxonomy.categories.map((category) => category.id));
  const maturityTaxonomy = readQaMaturityTaxonomy(
    params.repoRoot,
    params.taxonomy.taxonomy.sourcePath,
  );
  const maturityCategoryKeys = buildMaturityCategoryKeys(maturityTaxonomy);
  const profileCategoryIdsByCategoryId = new Map<string, Set<string>>();
  const profiles = params.taxonomy.profiles.map((profile) => {
    for (const categoryId of profile.categoryIds) {
      if (!categoryIds.has(categoryId)) {
        issues.push({
          code: "profile-category-ref-not-found",
          severity: "warning",
          ref: categoryId,
          message: `${profile.id} profile references missing executable scorecard category ${categoryId}`,
        });
        continue;
      }
      const categoryProfileIds =
        profileCategoryIdsByCategoryId.get(categoryId) ?? new Set<string>();
      categoryProfileIds.add(profile.id);
      profileCategoryIdsByCategoryId.set(categoryId, categoryProfileIds);
    }

    return {
      id: profile.id,
      categoryIds: profile.categoryIds.filter((categoryId) => categoryIds.has(categoryId)),
    };
  });

  if (!pathExists(params.repoRoot, params.taxonomy.taxonomy.sourcePath) || !maturityTaxonomy) {
    issues.push({
      code: "taxonomy-ref-not-found",
      severity: "warning",
      ref: params.taxonomy.taxonomy.sourcePath,
      message: `Scorecard executable mapping references missing maturity taxonomy ${params.taxonomy.taxonomy.sourcePath}`,
    });
  }

  for (const category of params.taxonomy.categories) {
    const missingCoverageIds: string[] = [];
    const missingEvidenceRefs: string[] = [];
    const membershipProfileIds =
      profileCategoryIdsByCategoryId.get(category.id) ?? new Set<string>();
    const sortedMembershipProfileIds = [...membershipProfileIds].toSorted();
    const maturityKey = maturityCategoryKey(
      category.taxonomySurfaceId,
      category.taxonomyCategoryName,
    );

    if (maturityTaxonomy && !maturityCategoryKeys.has(maturityKey)) {
      issues.push({
        code: "taxonomy-category-ref-not-found",
        severity: "warning",
        categoryId: category.id,
        ref: `${category.taxonomySurfaceId}/${category.taxonomyCategoryName}`,
        message: `${category.id} references missing maturity taxonomy category ${category.taxonomySurfaceId}/${category.taxonomyCategoryName}`,
      });
    }

    for (const coverageId of category.evidence.coverageIds) {
      const qaScenarioRefs = qaScenarioRefsByCoverageId.get(coverageId);
      if (!qaScenarioRefs) {
        missingCoverageIds.push(coverageId);
        issues.push({
          code: "coverage-id-not-found",
          severity: "warning",
          categoryId: category.id,
          ref: coverageId,
          message: `${category.id} maps missing coverage id ${coverageId}`,
        });
        continue;
      }
      mappedCoverageIds.add(coverageId);
    }

    const categoryCoverageIds = new Set(category.evidence.coverageIds);
    for (const evidenceRef of category.evidence.evidenceRefs) {
      const formattedRef = formatEvidenceRef(evidenceRef);
      if (evidenceRef.kind !== "qa-scenario") {
        if (!pathExists(params.repoRoot, evidenceRef.path)) {
          missingEvidenceRefs.push(formattedRef);
          issues.push({
            code: "evidence-ref-not-found",
            severity: "warning",
            categoryId: category.id,
            ref: formattedRef,
            message: `${category.id} references missing ${formattedRef}`,
          });
          continue;
        }
        mappedEvidenceRefs.add(formattedRef);
        continue;
      }

      const scenarioCoverage = coverageIdsByScenarioRef.get(evidenceRef.path);
      if (!scenarioCoverage) {
        missingEvidenceRefs.push(formattedRef);
        issues.push({
          code: "evidence-ref-not-found",
          severity: "warning",
          categoryId: category.id,
          ref: formattedRef,
          message: `${category.id} references missing ${formattedRef}`,
        });
        continue;
      }
      mappedEvidenceRefs.add(formattedRef);
      if (
        categoryCoverageIds.size > 0 &&
        ![...scenarioCoverage].some((coverageId) => categoryCoverageIds.has(coverageId))
      ) {
        issues.push({
          code: "evidence-ref-not-covered-by-category",
          severity: "warning",
          categoryId: category.id,
          ref: formattedRef,
          message: `${category.id} references ${formattedRef} without one of the category coverage IDs`,
        });
      }
    }

    if (
      membershipProfileIds.size === 0 &&
      (category.evidence.coverageIds.length > 0 || category.evidence.evidenceRefs.length > 0)
    ) {
      issues.push({
        code: "mapped-category-missing-profile-membership",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} maps runnable evidence but is not selected by any scorecard profile`,
      });
    }

    if (
      membershipProfileIds.size === 0 &&
      category.evidence.coverageIds.length === 0 &&
      category.evidence.evidenceRefs.length === 0
    ) {
      issues.push({
        code: "category-without-profile-or-evidence",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} has no scorecard profile membership, coverage IDs, or evidence refs`,
      });
    }

    if (
      membershipProfileIds.size > 0 &&
      (category.evidence.coverageIds.length === 0 || category.evidence.evidenceRefs.length === 0)
    ) {
      issues.push({
        code: "profile-category-missing-evidence-mapping",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} is selected by scorecard profile(s) ${sortedMembershipProfileIds.join(", ")} but has incomplete coverage ID or evidence ref mapping`,
      });
    }

    const mappingStatus =
      category.evidence.coverageIds.length === 0 || category.evidence.evidenceRefs.length === 0
        ? "missing"
        : missingCoverageIds.length > 0 || missingEvidenceRefs.length > 0
          ? "partial"
          : "mapped";
    categories.push({
      id: category.id,
      taxonomySurfaceId: category.taxonomySurfaceId,
      taxonomyCategoryName: category.taxonomyCategoryName,
      mappingStatus,
      profiles: sortedMembershipProfileIds,
      coverageIds: [...category.evidence.coverageIds],
      evidenceRefs: category.evidence.evidenceRefs.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
      })),
      missingCoverageIds,
      missingEvidenceRefs,
    });
  }

  const allCoverageIds = [...qaScenarioRefsByCoverageId.keys()].toSorted();
  const unmappedCoverageIds = allCoverageIds.filter(
    (coverageId) => !mappedCoverageIds.has(coverageId),
  );
  const totalCoverageIds = mappedCoverageIds.size + unmappedCoverageIds.length;
  const mappedCoverageIdPercent =
    totalCoverageIds === 0
      ? 0
      : Number(((mappedCoverageIds.size / totalCoverageIds) * 100).toFixed(1));

  return {
    taxonomyPath: params.taxonomyPath ?? QA_SCORECARD_TAXONOMY_PATH,
    taxonomyId: params.taxonomy.id,
    title: params.taxonomy.title,
    taxonomy: params.taxonomy.taxonomy,
    profileCount: params.taxonomy.profiles.length,
    profiles,
    categoryCount: params.taxonomy.categories.length,
    mappedCoverageIdCount: mappedCoverageIds.size,
    mappedCoverageIdPercent,
    mappedEvidenceRefCount: mappedEvidenceRefs.size,
    unmappedCoverageIdCount: unmappedCoverageIds.length,
    unmappedCoverageIds,
    validationIssueCount: issues.length,
    validationIssues: issues,
    categories: categories.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

export function readQaScorecardTaxonomyReport(scenarios: readonly QaSeedScenarioWithSource[]) {
  const taxonomyPath = resolveRepoPath(QA_SCORECARD_TAXONOMY_PATH, "file");
  const taxonomy = readQaScorecardTaxonomy();
  return buildQaScorecardTaxonomyReport({
    taxonomy,
    taxonomyPath: taxonomyPath ? QA_SCORECARD_TAXONOMY_PATH : null,
    repoRoot: taxonomyPath ? repoRootFromMappingPath(taxonomyPath) : undefined,
    scenarios,
  });
}
