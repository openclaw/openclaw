// Qa Lab plugin module validates the report-only scorecard taxonomy fixture.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export const QA_SCORECARD_TAXONOMY_PATH = "qa/scorecard/maturity-evidence-map.yaml";
export const QA_MATURITY_TAXONOMY_PATH = "taxonomy.yaml";

const QA_SCORECARD_PROFILE_IDS = ["smoke-ci", "release"] as const;
const QA_SCORECARD_RETIRED_PROFILE_IDS = new Set([
  "core",
  "full",
  "extended",
  "soak",
  "manual",
  "advisory",
]);

function isQaScorecardProfileId(
  profileId: string,
): profileId is (typeof QA_SCORECARD_PROFILE_IDS)[number] {
  return QA_SCORECARD_PROFILE_IDS.includes(profileId as (typeof QA_SCORECARD_PROFILE_IDS)[number]);
}

const qaScorecardIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, {
    message: "scorecard and coverage ids must use lowercase dotted or dashed tokens",
  });

function isRepoRootRelativeRef(value: string) {
  return !path.isAbsolute(value) && value.split(/[\\/]+/u).every((part) => part !== "..");
}

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

const qaScorecardFreshnessRuleSchema = z.enum([
  "target-ref",
  "target-ref-and-release-package",
  "release-candidate",
  "latest-advisory-run",
]);

const qaScorecardSupportStatusSchema = z.enum(["lts-included", "deferred", "advisory"]);

const qaScorecardProfileSchema = z.object({
  id: qaScorecardIdSchema,
  description: z.string().trim().min(1),
  categoryIds: z.array(qaScorecardIdSchema).default([]),
});

const qaScorecardCategorySchema = z.object({
  id: qaScorecardIdSchema,
  taxonomySurfaceId: qaScorecardIdSchema,
  taxonomyCategoryName: z.string().trim().min(1),
  supportStatus: qaScorecardSupportStatusSchema,
  releaseBlocking: z.boolean(),
  requirement: z.string().trim().min(1),
  evidenceRequired: z.string().trim().min(1),
  evidence: z.object({
    profiles: z.array(qaScorecardIdSchema).default([]),
    liveProofRequired: z.boolean(),
    freshness: qaScorecardFreshnessRuleSchema,
    coverageIds: z.array(qaScorecardIdSchema).default([]),
    scenarioRefs: z.array(qaScorecardRepoRefSchema).default([]),
    docsRefs: z.array(qaScorecardRepoRefSchema).default([]),
    codeRefs: z.array(qaScorecardRepoRefSchema).default([]),
    notes: z.string().trim().min(1).optional(),
  }),
});

const qaScorecardTaxonomySchema = z
  .object({
    version: z.literal(1),
    id: qaScorecardIdSchema,
    title: z.string().trim().min(1),
    sourceRef: qaScorecardRepoRefSchema,
    taxonomyRef: qaScorecardRepoRefSchema,
    scoreSnapshotRef: qaScorecardRepoRefSchema.optional(),
    status: z.enum(["initial", "candidate", "active"]),
    mappingAuthority: z.enum(["scaffold", "authoritative"]),
    mappingOwner: z.string().trim().min(1),
    reportOnly: z.boolean(),
    notes: z.string().trim().min(1).optional(),
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

    for (const requiredProfileId of QA_SCORECARD_PROFILE_IDS) {
      if (!seenProfileIds.has(requiredProfileId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles"],
          message: `missing required scorecard profile id: ${requiredProfileId}`,
        });
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

      if (category.supportStatus === "lts-included" && !category.releaseBlocking) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryIndex, "releaseBlocking"],
          message: `LTS-included category ${category.id} must be release-blocking`,
        });
      }
      if (category.supportStatus !== "lts-included" && category.releaseBlocking) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryIndex, "releaseBlocking"],
          message: `${category.supportStatus} category ${category.id} must not be release-blocking`,
        });
      }

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
  | "scenario-ref-not-found"
  | "scenario-ref-not-covered-by-category"
  | "docs-ref-not-found"
  | "code-ref-not-found"
  | "source-ref-not-found"
  | "taxonomy-ref-not-found"
  | "taxonomy-category-ref-not-found"
  | "profile-category-ref-not-found"
  | "score-snapshot-ref-not-found"
  | "blocking-category-without-evidence-mapping"
  | "non-advisory-category-missing-profile-membership"
  | "release-blocking-category-missing-release-profile"
  | "advisory-category-has-profile-membership"
  | "unsupported-profile-name"
  | "category-profile-missing-top-level-membership"
  | "profile-membership-missing-category-profile"
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
  supportStatus: string;
  releaseBlocking: boolean;
  mappingStatus: "mapped" | "partial" | "missing";
  profiles: string[];
  liveProofRequired: boolean;
  freshness: string;
  coverageIds: string[];
  scenarioRefs: string[];
  missingCoverageIds: string[];
  missingScenarioRefs: string[];
};

export type QaScorecardProfileReport = {
  id: string;
  categoryIds: string[];
};

export type QaScorecardTaxonomyReport = {
  taxonomyPath: string | null;
  taxonomyId: string | null;
  title: string | null;
  taxonomyRef: string | null;
  scoreSnapshotRef: string | null;
  status: string | null;
  mappingAuthority: string | null;
  mappingOwner: string | null;
  reportOnly: boolean;
  profileCount: number;
  profiles: QaScorecardProfileReport[];
  categoryCount: number;
  releaseBlockingCategoryCount: number;
  advisoryCategoryCount: number;
  ltsIncludedCategoryCount: number;
  deferredCategoryCount: number;
  mappedCoverageIdCount: number;
  mappedScenarioCount: number;
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

function repoRootFromFixturePath(fixturePath: string) {
  return path.dirname(path.dirname(path.dirname(fixturePath)));
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

function readQaMaturityTaxonomy(repoRoot: string | undefined, taxonomyRef: string) {
  const taxonomyPath = repoRoot ? path.join(repoRoot, taxonomyRef) : resolveRepoPath(taxonomyRef);
  if (!taxonomyPath || !fs.existsSync(taxonomyPath)) {
    return null;
  }
  return parseQaMaturityTaxonomy(
    YAML.parse(fs.readFileSync(taxonomyPath, "utf8")) as unknown,
    taxonomyRef,
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

function reportMissingRepoRefs(params: {
  repoRoot: string | undefined;
  categoryId: string;
  refs: readonly string[];
  code: "docs-ref-not-found" | "code-ref-not-found";
  label: "docs" | "code";
  issues: QaScorecardValidationIssue[];
}) {
  for (const ref of params.refs) {
    if (pathExists(params.repoRoot, ref)) {
      continue;
    }
    params.issues.push({
      code: params.code,
      severity: "warning",
      categoryId: params.categoryId,
      ref,
      message: `${params.categoryId} references missing ${params.label} ref ${ref}`,
    });
  }
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
      message: `Scorecard taxonomy fixture not found at ${QA_SCORECARD_TAXONOMY_PATH}`,
    } satisfies QaScorecardValidationIssue;
    return {
      taxonomyPath: params.taxonomyPath ?? null,
      taxonomyId: null,
      title: null,
      taxonomyRef: null,
      scoreSnapshotRef: null,
      status: null,
      mappingAuthority: null,
      mappingOwner: null,
      reportOnly: true,
      profileCount: 0,
      profiles: [],
      categoryCount: 0,
      releaseBlockingCategoryCount: 0,
      advisoryCategoryCount: 0,
      ltsIncludedCategoryCount: 0,
      deferredCategoryCount: 0,
      mappedCoverageIdCount: 0,
      mappedScenarioCount: 0,
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
  const scenarioRefsByCoverageId = new Map<string, Set<string>>();
  for (const scenario of params.scenarios) {
    for (const coverageId of scenarioCoverageIds(scenario)) {
      const refs = scenarioRefsByCoverageId.get(coverageId) ?? new Set<string>();
      refs.add(scenario.sourcePath);
      scenarioRefsByCoverageId.set(coverageId, refs);
    }
  }

  const issues: QaScorecardValidationIssue[] = [];
  const categories: QaScorecardCategoryMappingReport[] = [];
  const mappedCoverageIds = new Set<string>();
  const mappedScenarioRefs = new Set<string>();
  const categoryIds = new Set(params.taxonomy.categories.map((category) => category.id));
  const maturityTaxonomy = readQaMaturityTaxonomy(params.repoRoot, params.taxonomy.taxonomyRef);
  const maturityCategoryKeys = buildMaturityCategoryKeys(maturityTaxonomy);
  const profileCategoryIdsByCategoryId = new Map<string, Set<string>>();
  const profiles = params.taxonomy.profiles.map((profile) => {
    const supportedProfile = isQaScorecardProfileId(profile.id);
    if (!supportedProfile) {
      issues.push({
        code: "unsupported-profile-name",
        severity: "warning",
        ref: profile.id,
        message: QA_SCORECARD_RETIRED_PROFILE_IDS.has(profile.id)
          ? `${profile.id} is a retired scorecard profile name; use smoke-ci or release`
          : `${profile.id} is not a supported scorecard profile; use smoke-ci or release`,
      });
    }

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
      if (!supportedProfile) {
        continue;
      }
      const profileIds = profileCategoryIdsByCategoryId.get(categoryId) ?? new Set<string>();
      profileIds.add(profile.id);
      profileCategoryIdsByCategoryId.set(categoryId, profileIds);
    }

    return {
      id: profile.id,
      categoryIds: profile.categoryIds.filter((categoryId) => categoryIds.has(categoryId)),
    };
  });

  if (!pathExists(params.repoRoot, params.taxonomy.sourceRef)) {
    issues.push({
      code: "source-ref-not-found",
      severity: "warning",
      ref: params.taxonomy.sourceRef,
      message: `Scorecard taxonomy references missing source ref ${params.taxonomy.sourceRef}`,
    });
  }
  if (!pathExists(params.repoRoot, params.taxonomy.taxonomyRef) || !maturityTaxonomy) {
    issues.push({
      code: "taxonomy-ref-not-found",
      severity: "warning",
      ref: params.taxonomy.taxonomyRef,
      message: `Scorecard executable mapping references missing maturity taxonomy ${params.taxonomy.taxonomyRef}`,
    });
  }
  if (
    params.taxonomy.scoreSnapshotRef &&
    !pathExists(params.repoRoot, params.taxonomy.scoreSnapshotRef)
  ) {
    issues.push({
      code: "score-snapshot-ref-not-found",
      severity: "warning",
      ref: params.taxonomy.scoreSnapshotRef,
      message: `Scorecard executable mapping references missing score snapshot ${params.taxonomy.scoreSnapshotRef}`,
    });
  }

  for (const category of params.taxonomy.categories) {
    const missingCoverageIds: string[] = [];
    const missingScenarioRefs: string[] = [];
    const declaredProfileIds = new Set(category.evidence.profiles);
    const supportedDeclaredProfileIds = new Set(
      [...declaredProfileIds].filter(isQaScorecardProfileId),
    );
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

    for (const profileId of declaredProfileIds) {
      const supportedProfile = isQaScorecardProfileId(profileId);
      if (!supportedProfile) {
        issues.push({
          code: "unsupported-profile-name",
          severity: "warning",
          categoryId: category.id,
          ref: profileId,
          message: QA_SCORECARD_RETIRED_PROFILE_IDS.has(profileId)
            ? `${category.id} declares retired profile ${profileId}; use smoke-ci or release`
            : `${category.id} declares unsupported profile ${profileId}; use smoke-ci or release`,
        });
      }

      if (supportedProfile && !membershipProfileIds.has(profileId)) {
        issues.push({
          code: "category-profile-missing-top-level-membership",
          severity: "warning",
          categoryId: category.id,
          ref: profileId,
          message: `${category.id} declares ${profileId} evidence, but the taxonomy profile does not include the category`,
        });
      }
    }

    for (const profileId of membershipProfileIds) {
      if (!declaredProfileIds.has(profileId)) {
        issues.push({
          code: "profile-membership-missing-category-profile",
          severity: "warning",
          categoryId: category.id,
          ref: profileId,
          message: `${category.id} belongs to the ${profileId} taxonomy profile, but its evidence profiles do not declare that selector`,
        });
      }
    }

    if (category.releaseBlocking && !membershipProfileIds.has("release")) {
      issues.push({
        code: "release-blocking-category-missing-release-profile",
        severity: "warning",
        categoryId: category.id,
        ref: "release",
        message: `${category.id} is release-blocking but is not selected by the release profile`,
      });
    }

    if (
      category.supportStatus === "advisory" &&
      (membershipProfileIds.size > 0 || declaredProfileIds.size > 0)
    ) {
      const runnableProfiles = [
        ...new Set([...membershipProfileIds, ...declaredProfileIds]),
      ].toSorted();
      issues.push({
        code: "advisory-category-has-profile-membership",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} is advisory metadata but belongs to runnable profile(s): ${runnableProfiles.join(", ")}`,
      });
    }

    if (
      category.supportStatus !== "advisory" &&
      membershipProfileIds.size === 0 &&
      supportedDeclaredProfileIds.size === 0
    ) {
      issues.push({
        code: "non-advisory-category-missing-profile-membership",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} is ${category.supportStatus} but has no runnable smoke-ci or release profile membership`,
      });
    }

    for (const coverageId of category.evidence.coverageIds) {
      const scenarioRefs = scenarioRefsByCoverageId.get(coverageId);
      if (!scenarioRefs) {
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
      for (const scenarioRef of scenarioRefs) {
        mappedScenarioRefs.add(scenarioRef);
      }
    }

    const categoryCoverageIds = new Set(category.evidence.coverageIds);
    for (const scenarioRef of category.evidence.scenarioRefs) {
      const scenarioCoverage = coverageIdsByScenarioRef.get(scenarioRef);
      if (!scenarioCoverage) {
        missingScenarioRefs.push(scenarioRef);
        issues.push({
          code: "scenario-ref-not-found",
          severity: "warning",
          categoryId: category.id,
          ref: scenarioRef,
          message: `${category.id} references missing scenario ${scenarioRef}`,
        });
        continue;
      }
      mappedScenarioRefs.add(scenarioRef);
      if (
        categoryCoverageIds.size > 0 &&
        ![...scenarioCoverage].some((coverageId) => categoryCoverageIds.has(coverageId))
      ) {
        issues.push({
          code: "scenario-ref-not-covered-by-category",
          severity: "warning",
          categoryId: category.id,
          ref: scenarioRef,
          message: `${category.id} references ${scenarioRef} without one of the category coverage IDs`,
        });
      }
    }

    reportMissingRepoRefs({
      repoRoot: params.repoRoot,
      categoryId: category.id,
      refs: category.evidence.docsRefs,
      code: "docs-ref-not-found",
      label: "docs",
      issues,
    });
    reportMissingRepoRefs({
      repoRoot: params.repoRoot,
      categoryId: category.id,
      refs: category.evidence.codeRefs,
      code: "code-ref-not-found",
      label: "code",
      issues,
    });

    if (
      category.releaseBlocking &&
      category.evidence.coverageIds.length === 0 &&
      category.evidence.scenarioRefs.length === 0
    ) {
      issues.push({
        code: "blocking-category-without-evidence-mapping",
        severity: "warning",
        categoryId: category.id,
        message: `${category.id} is release-blocking but has no coverage IDs or scenario refs`,
      });
    }

    const mappingStatus =
      category.evidence.coverageIds.length === 0 && category.evidence.scenarioRefs.length === 0
        ? "missing"
        : missingCoverageIds.length > 0 || missingScenarioRefs.length > 0
          ? "partial"
          : "mapped";
    categories.push({
      id: category.id,
      taxonomySurfaceId: category.taxonomySurfaceId,
      taxonomyCategoryName: category.taxonomyCategoryName,
      supportStatus: category.supportStatus,
      releaseBlocking: category.releaseBlocking,
      mappingStatus,
      profiles: sortedMembershipProfileIds,
      liveProofRequired: category.evidence.liveProofRequired,
      freshness: category.evidence.freshness,
      coverageIds: [...category.evidence.coverageIds],
      scenarioRefs: [...category.evidence.scenarioRefs],
      missingCoverageIds,
      missingScenarioRefs,
    });
  }

  const allCoverageIds = [...scenarioRefsByCoverageId.keys()].toSorted();
  const unmappedCoverageIds = allCoverageIds.filter(
    (coverageId) => !mappedCoverageIds.has(coverageId),
  );

  return {
    taxonomyPath: params.taxonomyPath ?? QA_SCORECARD_TAXONOMY_PATH,
    taxonomyId: params.taxonomy.id,
    title: params.taxonomy.title,
    taxonomyRef: params.taxonomy.taxonomyRef,
    scoreSnapshotRef: params.taxonomy.scoreSnapshotRef ?? null,
    status: params.taxonomy.status,
    mappingAuthority: params.taxonomy.mappingAuthority,
    mappingOwner: params.taxonomy.mappingOwner,
    reportOnly: params.taxonomy.reportOnly,
    profileCount: params.taxonomy.profiles.length,
    profiles,
    categoryCount: params.taxonomy.categories.length,
    releaseBlockingCategoryCount: params.taxonomy.categories.filter(
      (category) => category.releaseBlocking,
    ).length,
    advisoryCategoryCount: params.taxonomy.categories.filter(
      (category) => category.supportStatus === "advisory",
    ).length,
    ltsIncludedCategoryCount: params.taxonomy.categories.filter(
      (category) => category.supportStatus === "lts-included",
    ).length,
    deferredCategoryCount: params.taxonomy.categories.filter(
      (category) => category.supportStatus === "deferred",
    ).length,
    mappedCoverageIdCount: mappedCoverageIds.size,
    mappedScenarioCount: mappedScenarioRefs.size,
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
    repoRoot: taxonomyPath ? repoRootFromFixturePath(taxonomyPath) : undefined,
    scenarios,
  });
}
