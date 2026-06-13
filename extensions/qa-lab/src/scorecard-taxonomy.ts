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
  coverageIds: z.array(qaScorecardIdSchema).default([]),
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
      for (const [coverageIndex, coverageId] of category.coverageIds.entries()) {
        if (seenCoverageIds.has(coverageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["categories", categoryIndex, "coverageIds", coverageIndex],
            message: `duplicate coverage id in category ${category.id}: ${coverageId}`,
          });
        }
        seenCoverageIds.add(coverageId);
      }
    }
  });

export type QaScorecardEvidenceRefKind = z.infer<typeof qaScorecardEvidenceRefKindSchema>;

const qaMaturityCategorySchema = z.object({
  id: qaScorecardIdSchema,
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
  | "coverage-id-missing-primary-evidence"
  | "coverage-id-not-found"
  | "taxonomy-ref-not-found"
  | "taxonomy-category-ref-not-found"
  | "profile-category-ref-not-found"
  | "category-without-profile-or-coverage"
  | "mapped-category-missing-profile-membership"
  | "profile-category-missing-coverage-mapping"
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
  evidence: Array<{
    kind: QaScorecardEvidenceRefKind;
    path: string;
    coverageIds: string[];
    role: "primary" | "secondary";
  }>;
  missingCoverageIds: string[];
  missingPrimaryEvidenceCoverageIds: string[];
};

export type QaScorecardProfileReport = {
  id: string;
  categoryIds: string[];
  fulfilledCategoryCount: number;
  requiredCategoryCount: number;
  fulfillmentPercent: number;
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
  fulfilledCategoryCount: number;
  requiredCategoryCount: number;
  taxonomyFulfillmentPercent: number;
  evidenceRefCount: number;
  mappedCoverageIdCount: number;
  mappedCoverageIdPercent: number;
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

function maturityCategoryId(surfaceId: string, categoryId: string) {
  return `${surfaceId}.${categoryId}`;
}

function buildMaturityCategoriesById(taxonomy: QaMaturityTaxonomy | null) {
  const categoriesById = new Map<string, { surfaceId: string; name: string }>();
  if (!taxonomy) {
    return categoriesById;
  }
  for (const surface of taxonomy.surfaces) {
    for (const category of surface.categories) {
      categoriesById.set(maturityCategoryId(surface.id, category.id), {
        surfaceId: surface.id,
        name: category.name,
      });
    }
  }
  return categoriesById;
}

function pathExists(repoRoot: string | undefined, relativePath: string) {
  if (!isRepoRootRelativeRef(relativePath)) {
    return false;
  }
  return repoRoot ? fs.existsSync(path.join(repoRoot, relativePath)) : true;
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
      fulfilledCategoryCount: 0,
      requiredCategoryCount: 0,
      taxonomyFulfillmentPercent: 0,
      evidenceRefCount: 0,
      mappedCoverageIdCount: 0,
      mappedCoverageIdPercent: 0,
      unmappedCoverageIdCount: 0,
      unmappedCoverageIds: [],
      validationIssueCount: 1,
      validationIssues: [issue],
      categories: [],
    };
  }

  const qaScenarioRefsByCoverageId = new Map<string, Set<string>>();
  const primaryScenarioRefsByCoverageId = new Map<string, Set<string>>();
  const secondaryScenarioRefsByCoverageId = new Map<string, Set<string>>();
  const addScenarioCoverageRef = (
    map: Map<string, Set<string>>,
    coverageId: string,
    sourcePath: string,
  ) => {
    const refs = map.get(coverageId) ?? new Set<string>();
    refs.add(sourcePath);
    map.set(coverageId, refs);
  };
  for (const scenario of params.scenarios) {
    for (const coverageId of scenario.coverage?.primary ?? []) {
      addScenarioCoverageRef(primaryScenarioRefsByCoverageId, coverageId, scenario.sourcePath);
      addScenarioCoverageRef(qaScenarioRefsByCoverageId, coverageId, scenario.sourcePath);
    }
    for (const coverageId of scenario.coverage?.secondary ?? []) {
      addScenarioCoverageRef(secondaryScenarioRefsByCoverageId, coverageId, scenario.sourcePath);
      addScenarioCoverageRef(qaScenarioRefsByCoverageId, coverageId, scenario.sourcePath);
    }
  }

  const issues: QaScorecardValidationIssue[] = [];
  const categories: QaScorecardCategoryMappingReport[] = [];
  const mappedCoverageIds = new Set<string>();
  const evidenceRefs = new Set<string>();
  const categoryIds = new Set(params.taxonomy.categories.map((category) => category.id));
  const maturityTaxonomy = readQaMaturityTaxonomy(
    params.repoRoot,
    params.taxonomy.taxonomy.sourcePath,
  );
  const maturityCategoriesById = buildMaturityCategoriesById(maturityTaxonomy);
  const profileCategoryIdsByCategoryId = new Map<string, Set<string>>();
  const requiredCategoryIds = new Set<string>();
  for (const profile of params.taxonomy.profiles) {
    for (const categoryId of profile.categoryIds) {
      requiredCategoryIds.add(categoryId);
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
  }

  if (!pathExists(params.repoRoot, params.taxonomy.taxonomy.sourcePath) || !maturityTaxonomy) {
    issues.push({
      code: "taxonomy-ref-not-found",
      severity: "warning",
      ref: params.taxonomy.taxonomy.sourcePath,
      message: `Scorecard executable mapping references missing maturity taxonomy ${params.taxonomy.taxonomy.sourcePath}`,
    });
  }

  const mappingStatusByCategoryId = new Map<
    string,
    QaScorecardCategoryMappingReport["mappingStatus"]
  >();

  for (const category of params.taxonomy.categories) {
    const missingCoverageIds: string[] = [];
    const missingPrimaryEvidenceCoverageIds: string[] = [];
    const categoryEvidenceByPath = new Map<
      string,
      {
        kind: "qa-scenario";
        path: string;
        coverageIds: Set<string>;
        role: "primary" | "secondary";
      }
    >();
    const membershipProfileIds =
      profileCategoryIdsByCategoryId.get(category.id) ?? new Set<string>();
    const sortedMembershipProfileIds = [...membershipProfileIds].toSorted();
    const maturityCategory = maturityCategoriesById.get(category.id);
    const taxonomyCategoryExists = Boolean(maturityCategory);

    if (maturityTaxonomy && !taxonomyCategoryExists) {
      issues.push({
        code: "taxonomy-category-ref-not-found",
        severity: "warning",
        categoryId: category.id,
        ref: category.id,
        message: `${category.id} references missing maturity taxonomy category id`,
      });
    }

    const addCategoryEvidence = (
      coverageId: string,
      sourcePath: string,
      role: "primary" | "secondary",
    ) => {
      evidenceRefs.add(`qa-scenario:${sourcePath}`);
      const existing = categoryEvidenceByPath.get(sourcePath);
      if (existing) {
        existing.coverageIds.add(coverageId);
        if (role === "primary") {
          existing.role = "primary";
        }
        return;
      }
      categoryEvidenceByPath.set(sourcePath, {
        kind: "qa-scenario",
        path: sourcePath,
        coverageIds: new Set([coverageId]),
        role,
      });
    };

    for (const coverageId of category.coverageIds) {
      mappedCoverageIds.add(coverageId);
      const primaryRefs = primaryScenarioRefsByCoverageId.get(coverageId) ?? new Set<string>();
      const secondaryRefs = secondaryScenarioRefsByCoverageId.get(coverageId) ?? new Set<string>();
      if (primaryRefs.size === 0 && secondaryRefs.size === 0) {
        missingCoverageIds.push(coverageId);
        issues.push({
          code: "coverage-id-not-found",
          severity: "warning",
          categoryId: category.id,
          ref: coverageId,
          message: `${category.id} maps coverage ID ${coverageId} with no QA scenario evidence`,
        });
        continue;
      }
      if (primaryRefs.size === 0) {
        missingPrimaryEvidenceCoverageIds.push(coverageId);
        issues.push({
          code: "coverage-id-missing-primary-evidence",
          severity: "warning",
          categoryId: category.id,
          ref: coverageId,
          message: `${category.id} maps coverage ID ${coverageId} with secondary-only QA scenario evidence`,
        });
      }
      for (const sourcePath of primaryRefs) {
        addCategoryEvidence(coverageId, sourcePath, "primary");
      }
      for (const sourcePath of secondaryRefs) {
        addCategoryEvidence(coverageId, sourcePath, "secondary");
      }
    }

    if (membershipProfileIds.size === 0 && category.coverageIds.length > 0) {
      issues.push({
        code: "mapped-category-missing-profile-membership",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} maps coverage IDs but is not selected by any scorecard profile`,
      });
    }

    if (membershipProfileIds.size === 0 && category.coverageIds.length === 0) {
      issues.push({
        code: "category-without-profile-or-coverage",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} has no scorecard profile membership or coverage IDs`,
      });
    }

    const mappingStatus =
      category.coverageIds.length === 0 || !taxonomyCategoryExists
        ? "missing"
        : missingCoverageIds.length > 0 || missingPrimaryEvidenceCoverageIds.length > 0
          ? "partial"
          : "mapped";
    mappingStatusByCategoryId.set(category.id, mappingStatus);

    if (membershipProfileIds.size > 0 && mappingStatus !== "mapped") {
      issues.push({
        code: "profile-category-missing-coverage-mapping",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} is selected by scorecard profile(s) ${sortedMembershipProfileIds.join(", ")} but has incomplete coverage mapping`,
      });
    }

    const evidence = [...categoryEvidenceByPath.values()]
      .map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        coverageIds: [...ref.coverageIds].toSorted(),
        role: ref.role,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    categories.push({
      id: category.id,
      taxonomySurfaceId: maturityCategory?.surfaceId ?? category.id.split(".")[0] ?? "unknown",
      taxonomyCategoryName: maturityCategory?.name ?? "unknown",
      mappingStatus,
      profiles: sortedMembershipProfileIds,
      coverageIds: [...category.coverageIds],
      evidence,
      missingCoverageIds,
      missingPrimaryEvidenceCoverageIds,
    });
  }

  const profiles = params.taxonomy.profiles.map((profile) => {
    const knownCategoryIds = profile.categoryIds.filter((categoryId) =>
      categoryIds.has(categoryId),
    );
    const fulfilledCategoryCount = knownCategoryIds.filter(
      (categoryId) => mappingStatusByCategoryId.get(categoryId) === "mapped",
    ).length;
    const requiredCategoryCount = profile.categoryIds.length;
    return {
      id: profile.id,
      categoryIds: knownCategoryIds,
      fulfilledCategoryCount,
      requiredCategoryCount,
      fulfillmentPercent:
        requiredCategoryCount === 0
          ? 100
          : Number(((fulfilledCategoryCount / requiredCategoryCount) * 100).toFixed(1)),
    };
  });
  const fulfilledCategoryCount = [...requiredCategoryIds].filter(
    (categoryId) => mappingStatusByCategoryId.get(categoryId) === "mapped",
  ).length;
  const requiredCategoryCount = requiredCategoryIds.size;
  const taxonomyFulfillmentPercent =
    requiredCategoryCount === 0
      ? 100
      : Number(((fulfilledCategoryCount / requiredCategoryCount) * 100).toFixed(1));
  const allCoverageIds = [...qaScenarioRefsByCoverageId.keys()].toSorted();
  const unmappedCoverageIds = allCoverageIds.filter(
    (coverageId) => !mappedCoverageIds.has(coverageId),
  );
  const totalCoverageIds = new Set([...allCoverageIds, ...mappedCoverageIds]).size;
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
    fulfilledCategoryCount,
    requiredCategoryCount,
    taxonomyFulfillmentPercent,
    evidenceRefCount: evidenceRefs.size,
    mappedCoverageIdCount: mappedCoverageIds.size,
    mappedCoverageIdPercent,
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
