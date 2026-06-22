#!/usr/bin/env node
// Renders public maturity scorecard docs from the root taxonomy and score aggregate.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceScorecardJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "../../extensions/qa-lab/src/evidence-summary.js";
import {
  QA_MATURITY_SCORE_KEYS,
  parseQaMaturityScores,
  type QaMaturityScoreCategory,
  type QaMaturityScoreKey,
  type QaMaturityScoreLastRun,
  type QaMaturityScoreObject,
  type QaMaturityScoreSurface,
  type QaMaturityScoreSurfaceLts,
  type QaMaturityScores,
} from "../../extensions/qa-lab/src/scorecard-taxonomy.js";

const DEFAULT_TAXONOMY_PATH = "taxonomy.yaml";
const DEFAULT_SCORES_PATH = "docs/maturity-scores.yaml";
const DEFAULT_OUTPUT_DIR = "docs";

type Args = {
  taxonomy: string;
  scores: string;
  outputDir: string;
  staticAssetsDir?: string;
  evidenceDir?: string;
  check: boolean;
  strictInputs: boolean;
};

type TaxonomyLevel = {
  id: string;
  code?: string;
  label?: string;
  meaning?: string;
  promotion_bar?: string;
};

type TaxonomyFeature = {
  name: string;
  coverageIds?: string[];
};

type TaxonomyCategory = {
  id: string;
  name: string;
  category_note: string;
  features: TaxonomyFeature[];
  docs?: string[];
  human_lts_override?: boolean;
};

type TaxonomySurface = {
  id: string;
  name: string;
  family: string;
  level: string;
  archived?: boolean;
  categories: TaxonomyCategory[];
  rationale?: string;
  completeness_instructions?: string;
  last_score_run?: QaMaturityScoreLastRun;
};

type TaxonomyProfile = {
  id: string;
  includeAllCategories?: boolean;
  categoryIds?: string[];
  evidenceMode?: string;
  description?: string;
};

type Taxonomy = {
  version: number;
  title: string;
  levels: TaxonomyLevel[];
  surfaces: TaxonomySurface[];
  profiles?: TaxonomyProfile[];
};

type CountSummary = QaEvidenceScorecardJson["categories"];
type EvidenceScorecard = QaEvidenceScorecardJson;

type EvidenceSummary = {
  sourcePath: string;
  path: string;
  generatedAt: string;
  profile: string;
  entryCount: number;
  statuses: StatusCounts;
  scorecard?: EvidenceScorecard;
};

type StatusCounts = Record<QaEvidenceStatus, number>;

const EMPTY_STATUS_COUNTS: StatusCounts = {
  pass: 0,
  fail: 0,
  blocked: 0,
  skipped: 0,
};

type RenderInputs = {
  taxonomy: Taxonomy;
  scores: QaMaturityScores;
  taxonomyPath: string;
  scoresPath: string;
};

type RenderMaturityScorecardInputs = RenderInputs & {
  evidenceSummaries: EvidenceSummary[];
  scoreWarnings: string[];
  evidenceWarnings: string[];
  staticAssetsPath?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    taxonomy: DEFAULT_TAXONOMY_PATH,
    scores: DEFAULT_SCORES_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    staticAssetsDir: undefined,
    evidenceDir: undefined,
    check: false,
    strictInputs: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--strict-inputs") {
      args.strictInputs = true;
      continue;
    }
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--taxonomy") {
      args.taxonomy = next();
    } else if (arg === "--scores") {
      args.scores = next();
    } else if (arg === "--output-dir") {
      args.outputDir = next();
    } else if (arg === "--static-assets-dir") {
      args.staticAssetsDir = next();
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = next();
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: node --import tsx scripts/qa/render-maturity-docs.ts [options]

Options:
  --taxonomy <path>     Taxonomy YAML path (default: taxonomy.yaml)
  --scores <path>       Aggregate score YAML path (default: docs/maturity-scores.yaml)
  --output-dir <path>   Directory for maturity-scorecard.md, taxonomy.md, and taxonomy-outline.md
  --static-assets-dir <path>
                        Copy source YAML and QA evidence JSON for docs components
  --evidence-dir <path> Optional directory containing qa-evidence.json artifacts
  --check               Fail when output files are stale
  --strict-inputs       Fail on score or evidence input warnings
  -h, --help            Show this help
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown maturity docs option: ${arg}`);
    }
  }
  return args;
}

function readYaml(filePath: string): unknown {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertArray<T = unknown>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value as T[];
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateTaxonomy(taxonomy: Taxonomy, taxonomyPath: string): void {
  assertObject(taxonomy, taxonomyPath);
  if (taxonomy.version !== 1) {
    throw new Error(`${taxonomyPath} must declare version: 1`);
  }
  assertString(taxonomy.title, `${taxonomyPath}.title`);
  assertArray(taxonomy.levels, `${taxonomyPath}.levels`);
  assertArray(taxonomy.surfaces, `${taxonomyPath}.surfaces`);
  const profileIds = new Set<string>();
  for (const [profileIndex, profile] of assertArray<TaxonomyProfile>(
    taxonomy.profiles ?? [],
    `${taxonomyPath}.profiles`,
  ).entries()) {
    assertObject(profile, `${taxonomyPath}.profiles[${profileIndex}]`);
    const id = assertString(profile.id, `${taxonomyPath}.profiles[${profileIndex}].id`);
    if (profileIds.has(id)) {
      throw new Error(`${taxonomyPath}: duplicate profile id ${id}`);
    }
    profileIds.add(id);
    if (profile.includeAllCategories && profile.categoryIds?.length) {
      throw new Error(
        `${taxonomyPath}: profile ${id} cannot combine includeAllCategories and categoryIds`,
      );
    }
  }

  const categoryIds = new Set<string>();
  for (const [surfaceIndex, surface] of taxonomy.surfaces.entries()) {
    assertObject(surface, `${taxonomyPath}.surfaces[${surfaceIndex}]`);
    const surfaceId = assertString(surface.id, `${taxonomyPath}.surfaces[${surfaceIndex}].id`);
    assertString(surface.name, `${taxonomyPath}.${surfaceId}.name`);
    assertString(surface.family, `${taxonomyPath}.${surfaceId}.family`);
    assertString(surface.level, `${taxonomyPath}.${surfaceId}.level`);
    for (const [categoryIndex, category] of assertArray<TaxonomyCategory>(
      surface.categories,
      `${taxonomyPath}.${surfaceId}.categories`,
    ).entries()) {
      assertObject(category, `${taxonomyPath}.${surfaceId}.categories[${categoryIndex}]`);
      const localCategoryId = assertString(
        category.id,
        `${taxonomyPath}.${surfaceId}.categories[${categoryIndex}].id`,
      );
      const categoryId = `${surfaceId}.${localCategoryId}`;
      if (categoryIds.has(categoryId)) {
        throw new Error(`${taxonomyPath}: duplicate category id ${categoryId}`);
      }
      categoryIds.add(categoryId);
      assertString(category.name, `${taxonomyPath}.${surfaceId}.${categoryId}.name`);
      assertString(
        category.category_note,
        `${taxonomyPath}.${surfaceId}.${categoryId}.category_note`,
      );
      for (const [featureIndex, feature] of assertArray<TaxonomyFeature>(
        category.features,
        `${taxonomyPath}.${surfaceId}.${categoryId}.features`,
      ).entries()) {
        assertObject(
          feature,
          `${taxonomyPath}.${surfaceId}.${categoryId}.features[${featureIndex}]`,
        );
        assertString(
          feature.name,
          `${taxonomyPath}.${surfaceId}.${categoryId}.features[${featureIndex}].name`,
        );
        assertArray<string>(
          feature.coverageIds ?? [],
          `${taxonomyPath}.${surfaceId}.${categoryId}.features[${featureIndex}].coverageIds`,
        );
      }
    }
  }
  for (const profile of taxonomy.profiles ?? []) {
    for (const categoryId of profile.categoryIds ?? []) {
      if (!categoryIds.has(categoryId)) {
        throw new Error(
          `${taxonomyPath}: profile ${profile.id} references missing category ${categoryId}`,
        );
      }
    }
  }
}

function taxonomyCategoryIndex(taxonomy: Taxonomy): {
  active: TaxonomySurface[];
  surfaces: Map<string, { surface: TaxonomySurface; categories: Map<string, TaxonomyCategory> }>;
} {
  const active = activeSurfaces(taxonomy);
  const surfaces = new Map<
    string,
    { surface: TaxonomySurface; categories: Map<string, TaxonomyCategory> }
  >();
  for (const surface of active) {
    const categories = new Map<string, TaxonomyCategory>();
    for (const category of surface.categories) {
      if (categories.has(category.name)) {
        throw new Error(`taxonomy.yaml: ${surface.id}: duplicate category name ${category.name}`);
      }
      categories.set(category.name, category);
    }
    surfaces.set(surface.id, { surface, categories });
  }
  return { active, surfaces };
}

function averageScore(rows: QaMaturityScoreSurface[], key: QaMaturityScoreKey): number {
  return Math.round(rows.reduce((sum, row) => sum + row.scores[key].score, 0) / rows.length);
}

function averageCategoryScore(rows: QaMaturityScoreCategory[], key: QaMaturityScoreKey): number {
  return Math.round(rows.reduce((sum, row) => sum + row[key].score, 0) / rows.length);
}

function expectedLtsSupported(
  scoreCategory: QaMaturityScoreCategory,
  taxonomyCategory: TaxonomyCategory,
): boolean {
  return (
    (scoreCategory.quality.score > 80 && scoreCategory.coverage.score > 90) ||
    taxonomyCategory.human_lts_override === true
  );
}

function expectedSurfaceLtsStatus(supportedCategories: number, totalCategories: number): string {
  if (supportedCategories === 0) {
    return "none";
  }
  return supportedCategories === totalCategories ? "full" : "partial";
}

function validateScores(
  scores: QaMaturityScores,
  scoresPath: string,
  taxonomy: Taxonomy,
): string[] {
  const warnings: string[] = [];
  assertObject(scores, scoresPath);
  if (scores.version !== 1) {
    throw new Error(`${scoresPath} must declare version: 1`);
  }
  assertObject(scores.counts, `${scoresPath}.counts`);
  assertObject(scores.rollups, `${scoresPath}.rollups`);
  const scoreSurfaces = assertArray<QaMaturityScoreSurface>(
    scores.surfaces,
    `${scoresPath}.surfaces`,
  );
  const taxonomyIndex = taxonomyCategoryIndex(taxonomy);
  if (scores.counts.active_surfaces !== scoreSurfaces.length) {
    throw new Error(
      `${scoresPath}.counts.active_surfaces must match score surface count (${scoreSurfaces.length})`,
    );
  }
  if (scores.counts.active_surfaces !== taxonomyIndex.active.length) {
    throw new Error(
      `${scoresPath}.counts.active_surfaces must match active taxonomy surfaces (${taxonomyIndex.active.length})`,
    );
  }

  const taxonomyCategoryCount = taxonomyIndex.active.reduce(
    (count, surface) => count + surface.categories.length,
    0,
  );
  if (scores.counts.category_scores !== taxonomyCategoryCount) {
    throw new Error(
      `${scoresPath}.counts.category_scores must match active taxonomy categories (${taxonomyCategoryCount})`,
    );
  }

  const seenSurfaceIds = new Set<string>();
  const allScoreCategories: QaMaturityScoreCategory[] = [];
  for (const [surfaceIndex, scoreSurface] of scoreSurfaces.entries()) {
    assertObject(scoreSurface, `${scoresPath}.surfaces[${surfaceIndex}]`);
    const surfaceId = assertString(scoreSurface.id, `${scoresPath}.surfaces[${surfaceIndex}].id`);
    if (seenSurfaceIds.has(surfaceId)) {
      throw new Error(`${scoresPath}: duplicate surface id ${surfaceId}`);
    }
    seenSurfaceIds.add(surfaceId);

    const taxonomySurface = taxonomyIndex.surfaces.get(surfaceId);
    if (!taxonomySurface) {
      warnings.push(`${scoresPath}: surface ${surfaceId} is not an active taxonomy surface`);
    }
    assertString(scoreSurface.name, `${scoresPath}.${surfaceId}.name`);

    const categories = assertArray<QaMaturityScoreCategory>(
      scoreSurface.categories,
      `${scoresPath}.${surfaceId}.categories`,
    );
    if (taxonomySurface && categories.length !== taxonomySurface.categories.size) {
      throw new Error(
        `${scoresPath}.${surfaceId}.categories must match taxonomy category count (${taxonomySurface.categories.size})`,
      );
    }

    const seenCategoryNames = new Set<string>();
    let supportedCategories = 0;
    for (const [categoryIndex, scoreCategory] of categories.entries()) {
      assertObject(scoreCategory, `${scoresPath}.${surfaceId}.categories[${categoryIndex}]`);
      const categoryName = assertString(
        scoreCategory.name,
        `${scoresPath}.${surfaceId}.categories[${categoryIndex}].name`,
      );
      if (seenCategoryNames.has(categoryName)) {
        throw new Error(`${scoresPath}.${surfaceId}: duplicate category name ${categoryName}`);
      }
      seenCategoryNames.add(categoryName);
      const lts = scoreCategory.lts;
      assertObject(lts, `${scoresPath}.${surfaceId}.${categoryName}.lts`);
      if (typeof lts.supported !== "boolean") {
        throw new Error(`${scoresPath}.${surfaceId}.${categoryName}.lts.supported must be boolean`);
      }
      if (typeof lts.human_override !== "boolean") {
        throw new Error(
          `${scoresPath}.${surfaceId}.${categoryName}.lts.human_override must be boolean`,
        );
      }

      const taxonomyCategory = taxonomySurface?.categories.get(categoryName);
      if (taxonomySurface && !taxonomyCategory) {
        warnings.push(
          `${scoresPath}.${surfaceId}: score category ${categoryName} is not in taxonomy`,
        );
      }
      if (taxonomyCategory) {
        if (lts.human_override !== Boolean(taxonomyCategory.human_lts_override)) {
          throw new Error(
            `${scoresPath}.${surfaceId}.${categoryName}.lts.human_override must match taxonomy human_lts_override`,
          );
        }
        const expectedSupported = expectedLtsSupported(scoreCategory, taxonomyCategory);
        if (lts.supported !== expectedSupported) {
          throw new Error(
            `${scoresPath}.${surfaceId}.${categoryName}.lts.supported must match score threshold or taxonomy human_lts_override`,
          );
        }
      }
      if (lts.supported) {
        supportedCategories += 1;
      }
      allScoreCategories.push(scoreCategory);
    }

    const surfaceLts = scoreSurface.lts;
    assertObject(surfaceLts, `${scoresPath}.${surfaceId}.lts`);
    if (surfaceLts.supported_categories !== supportedCategories) {
      throw new Error(
        `${scoresPath}.${surfaceId}.lts.supported_categories must equal supported category count (${supportedCategories})`,
      );
    }
    if (surfaceLts.total_categories !== categories.length) {
      throw new Error(
        `${scoresPath}.${surfaceId}.lts.total_categories must equal score category count (${categories.length})`,
      );
    }
    const expectedStatus = expectedSurfaceLtsStatus(supportedCategories, categories.length);
    if (surfaceLts.status !== expectedStatus) {
      throw new Error(`${scoresPath}.${surfaceId}.lts.status must be ${expectedStatus}`);
    }
  }

  for (const surfaceId of taxonomyIndex.surfaces.keys()) {
    if (!seenSurfaceIds.has(surfaceId)) {
      warnings.push(`${scoresPath}: missing active taxonomy surface ${surfaceId}`);
    }
  }
  if (scores.counts.category_scores !== allScoreCategories.length) {
    throw new Error(
      `${scoresPath}.counts.category_scores must match score category count (${allScoreCategories.length})`,
    );
  }

  const rollups = scores.rollups;
  for (const key of QA_MATURITY_SCORE_KEYS) {
    const expectedSurfaceAverage = averageScore(scoreSurfaces, key);
    if (rollups.surface_average[key].score !== expectedSurfaceAverage) {
      throw new Error(
        `${scoresPath}.rollups.surface_average.${key}.score must be ${expectedSurfaceAverage}`,
      );
    }
    const expectedCategoryAverage = averageCategoryScore(allScoreCategories, key);
    if (rollups.category_average[key].score !== expectedCategoryAverage) {
      throw new Error(
        `${scoresPath}.rollups.category_average.${key}.score must be ${expectedCategoryAverage}`,
      );
    }
  }
  return warnings;
}

function familyTitle(value: string): string {
  const titles: Record<string, string> = {
    "platform-app": "Platform",
    "provider-tool": "Provider and tool",
  };
  return (
    titles[value] ??
    value
      .replaceAll("-", " ")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

type RenderScalar = string | number | boolean | null | undefined;

function markdownEscape(value: RenderScalar): string {
  return String(value ?? "").replaceAll("|", "\\|");
}

function yamlCode(value: RenderScalar): string {
  return `\`${markdownEscape(value)}\``;
}

function htmlAttributeEscape(value: RenderScalar): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scoreText(value?: QaMaturityScoreObject): string {
  if (!value || typeof value !== "object") {
    return "`Unscored`";
  }
  return `\`${markdownEscape(value.label ?? "")} (${markdownEscape(value.score ?? "")}%)\``;
}

function levelText(
  surface: QaMaturityScoreSurface | TaxonomySurface,
  taxonomyLevels: Map<string, TaxonomyLevel>,
): string {
  const scoreLevel = surface.level;
  if (scoreLevel && typeof scoreLevel === "object") {
    return [scoreLevel.code, scoreLevel.label].filter(Boolean).join(" ");
  }
  const levelId = typeof scoreLevel === "string" ? scoreLevel : "";
  const level = taxonomyLevels.get(levelId);
  return [level?.code, level?.label ?? levelId].filter(Boolean).join(" ");
}

function lastRunText(surface: { last_score_run?: QaMaturityScoreLastRun }): string {
  const lastRun = surface.last_score_run;
  if (!lastRun || typeof lastRun !== "object") {
    return "";
  }
  return [lastRun.status, lastRun.completed_at ? `on ${lastRun.completed_at}` : ""]
    .filter(Boolean)
    .join(" ");
}

function ltsText(lts?: QaMaturityScoreSurfaceLts): string {
  if (!lts || typeof lts !== "object") {
    return "unscored";
  }
  return `${lts.status ?? "unknown"} (${lts.supported_categories ?? 0}/${lts.total_categories ?? 0})`;
}

function frontmatter(title: string, summary: string): string[] {
  return ["---", `title: "${title}"`, `summary: "${summary}"`, "---", ""];
}

function generatedNotice(): string[] {
  return [
    "> This page is generated during OpenClaw release validation so the scores stay consistent across releases.",
    "",
  ];
}

function renderMetadataComment({
  taxonomyPath,
  scoresPath,
  evidenceSummaries,
  scoreWarnings,
  evidenceWarnings,
  staticAssetsPath,
}: RenderMaturityScorecardInputs): string[] {
  const scorecardCount = evidenceSummaries.filter((item) => item.scorecard).length;
  const staticAssetsAttribute = staticAssetsPath
    ? ` static-assets="${htmlAttributeEscape(staticAssetsPath)}"`
    : "";
  return [
    `<!-- <maturity-render taxonomy="${htmlAttributeEscape(taxonomyPath)}" scores="${htmlAttributeEscape(scoresPath)}" evidence-files="${evidenceSummaries.length}" evidence-scorecards="${scorecardCount}" score-warnings="${scoreWarnings.length}" evidence-warnings="${evidenceWarnings.length}"${staticAssetsAttribute} /> -->`,
    "",
  ];
}

function activeSurfaces(taxonomy: Taxonomy): TaxonomySurface[] {
  return taxonomy.surfaces.filter((surface) => !surface.archived);
}

function surfaceScoreMap(scores: QaMaturityScores): Map<string, QaMaturityScoreSurface> {
  return new Map(scores.surfaces.map((surface) => [surface.id, surface]));
}

function taxonomyLevelMap(taxonomy: Taxonomy): Map<string, TaxonomyLevel> {
  return new Map(taxonomy.levels.map((level) => [level.id, level]));
}

function categoryScoreMap(
  scoreSurface?: QaMaturityScoreSurface,
): Map<string, QaMaturityScoreCategory> {
  return new Map((scoreSurface?.categories ?? []).map((category) => [category.name, category]));
}

function familyOrder(surfaces: TaxonomySurface[]): string[] {
  const seen: string[] = [];
  for (const surface of surfaces) {
    if (!seen.includes(surface.family)) {
      seen.push(surface.family);
    }
  }
  return seen;
}

function categoryProfiles(taxonomy: Taxonomy): Map<string, string[]> {
  const profilesByCategory = new Map<string, string[]>();
  for (const profile of taxonomy.profiles ?? []) {
    const categoryIds = profile.includeAllCategories
      ? activeSurfaces(taxonomy).flatMap((surface) =>
          surface.categories.map((category) => `${surface.id}.${category.id}`),
        )
      : (profile.categoryIds ?? []);
    for (const categoryId of categoryIds) {
      const profiles = profilesByCategory.get(categoryId) ?? [];
      profiles.push(profile.id);
      profilesByCategory.set(categoryId, profiles);
    }
  }
  return profilesByCategory;
}

function collectQaEvidenceFiles(root?: string): string[] {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name === "qa-evidence.json") {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files.toSorted((left, right) => left.localeCompare(right));
}

function countStatuses(entries: QaEvidenceSummaryJson["entries"]): StatusCounts {
  const counts: StatusCounts = { ...EMPTY_STATUS_COUNTS };
  for (const entry of entries) {
    counts[entry.result.status] += 1;
  }
  return counts;
}

function numberText(value: unknown): string {
  return Number.isFinite(value) ? String(value) : "";
}

function countText(counts?: CountSummary): string {
  if (!counts || typeof counts !== "object") {
    return "";
  }
  return `${counts.fulfilled ?? 0} of ${counts.total ?? 0} (${numberText(counts.fulfillmentPercent)}%)`;
}

function checkSetTitle(profile: string): string {
  const normalized = profile.trim();
  if (!normalized || normalized === "release") {
    return "Release validation";
  }
  return familyTitle(normalized);
}

function resultCountsText(statuses: StatusCounts): string {
  return [
    `${statuses.pass} passed`,
    `${statuses.fail} failed`,
    `${statuses.blocked} blocked`,
    `${statuses.skipped} skipped`,
  ].join(", ");
}

function readinessStatusText(status: string): string {
  if (status === "fulfilled") {
    return "Ready";
  }
  if (status === "partial") {
    return "Partially reviewed";
  }
  if (status === "missing") {
    return "Needs review";
  }
  return status;
}

function followUpText(missingCoverageIds: readonly string[]): string {
  if (missingCoverageIds.length === 0) {
    return "None";
  }
  return `${missingCoverageIds.length} capability ${missingCoverageIds.length === 1 ? "gap" : "gaps"}`;
}

function readEvidenceSummaries(evidenceDir?: string): EvidenceSummary[] {
  return collectQaEvidenceFiles(evidenceDir).map((filePath) => {
    const payload = validateQaEvidenceSummaryJson(JSON.parse(fs.readFileSync(filePath, "utf8")));
    return {
      sourcePath: filePath,
      path: path.relative(process.cwd(), filePath),
      generatedAt: payload.generatedAt,
      profile: payload.profile ?? "",
      entryCount: payload.entries.length,
      statuses: countStatuses(payload.entries),
      scorecard: payload.scorecard,
    };
  });
}

function evidenceScorecardWarnings(evidenceSummaries: EvidenceSummary[]): string[] {
  return evidenceSummaries
    .filter((item) => !item.scorecard)
    .map(
      (item) =>
        `${item.path}: qa-evidence.json does not include a scorecard field; run pnpm openclaw qa run --qa-profile <id> to produce deterministic scorecard rows`,
    );
}

function writeInputWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

function enforceStrictInputs(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }
  throw new Error(
    `strict input validation failed:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
  );
}

function staticAssetPath(outputDir: string, staticAssetsDir?: string): string | undefined {
  if (!staticAssetsDir) {
    return undefined;
  }
  const relative = path.relative(outputDir, staticAssetsDir).replaceAll(path.sep, "/");
  return relative.startsWith("..") ? undefined : relative;
}

function copyStaticSourceAssets({
  evidenceSummaries,
  scoresPath,
  staticAssetsDir,
  taxonomyPath,
}: {
  evidenceSummaries: EvidenceSummary[];
  scoresPath: string;
  staticAssetsDir: string;
  taxonomyPath: string;
}): string[] {
  fs.mkdirSync(staticAssetsDir, { recursive: true });
  const copied = [
    [taxonomyPath, path.join(staticAssetsDir, "taxonomy.yaml")],
    [scoresPath, path.join(staticAssetsDir, "maturity-scores.yaml")],
  ];
  const evidenceDir = path.join(staticAssetsDir, "evidence");
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  if (evidenceSummaries.length > 0) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  for (const [index, evidence] of evidenceSummaries.entries()) {
    copied.push([
      evidence.sourcePath,
      path.join(evidenceDir, `qa-evidence-${String(index + 1).padStart(2, "0")}.json`),
    ]);
  }
  for (const [source, target] of copied) {
    fs.copyFileSync(source, target);
  }
  return copied.map(([, target]) => target);
}

function renderEvidenceSection(evidenceSummaries: EvidenceSummary[]): string[] {
  if (evidenceSummaries.length === 0) {
    return [];
  }
  const lines = [
    "## Release check summary",
    "",
    "The checks below show which scorecard areas were exercised during release validation.",
    "",
  ];

  lines.push(
    "| Check set | Completed | Checks run | Results | Areas reviewed | Capabilities reviewed |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const item of evidenceSummaries) {
    const scorecard = item.scorecard;
    lines.push(
      `| ${markdownEscape(checkSetTitle(item.profile))} | ${markdownEscape(item.generatedAt)} | ${item.entryCount} | ${markdownEscape(resultCountsText(item.statuses))} | ${markdownEscape(countText(scorecard?.categories))} | ${markdownEscape(countText(scorecard?.features))} |`,
    );
  }
  lines.push("");

  const categoryRows = evidenceSummaries.flatMap((item) =>
    (item.scorecard?.categoryReports ?? []).map((category) => ({ item, category })),
  );
  if (categoryRows.length > 0) {
    lines.push(
      "### Readiness by area",
      "",
      "| Check set | Surface | Area | Status | Capabilities reviewed | Follow-up |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const { item, category } of categoryRows) {
      const features = countText(category.features);
      lines.push(
        `| ${markdownEscape(checkSetTitle(item.profile))} | ${markdownEscape(category.surfaceId)} | ${markdownEscape(category.name)} | ${markdownEscape(readinessStatusText(category.status))} | ${markdownEscape(features)} | ${markdownEscape(followUpText(category.missingCoverageIds))} |`,
      );
    }
    lines.push("");
  }
  return lines;
}

function renderMaturityScorecard({
  taxonomy,
  scores,
  taxonomyPath,
  scoresPath,
  evidenceSummaries,
  scoreWarnings,
  evidenceWarnings,
  staticAssetsPath,
}: RenderMaturityScorecardInputs): string {
  const levels = taxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity scorecard",
      "OpenClaw release readiness scores for product areas, integrations, and supported workflows.",
    ),
    ...renderMetadataComment({
      taxonomy,
      scores,
      taxonomyPath,
      scoresPath,
      evidenceSummaries,
      scoreWarnings,
      evidenceWarnings,
      staticAssetsPath,
    }),
    "# Maturity scorecard",
    "",
    ...generatedNotice(),
    "## Overview",
    "",
    `- Active surfaces: ${scores.counts.active_surfaces}`,
    `- Category scores: ${scores.counts.category_scores}`,
    `- Process version: ${scores.process_version}`,
    "",
    "## Rollups",
    "",
    "| Basis | Coverage | Quality | Completeness |",
    "| --- | --- | --- | --- |",
    `| Surface average | ${scoreText(scores.rollups.surface_average.coverage)} | ${scoreText(scores.rollups.surface_average.quality)} | ${scoreText(scores.rollups.surface_average.completeness)} |`,
    `| Category average | ${scoreText(scores.rollups.category_average.coverage)} | ${scoreText(scores.rollups.category_average.quality)} | ${scoreText(scores.rollups.category_average.completeness)} |`,
    "",
  ];

  lines.push(
    "## Surface scorecard",
    "",
    "| Surface | Family | Level | Coverage | Quality | Completeness | LTS | Categories | Last score run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const surface of surfaces) {
    const scoreSurface = scoreSurfaces.get(surface.id);
    lines.push(
      `| [${markdownEscape(surface.name)}](/taxonomy#${surface.id}) | ${markdownEscape(familyTitle(surface.family))} | ${markdownEscape(levelText(scoreSurface ?? surface, levels))} | ${scoreText(scoreSurface?.scores?.coverage)} | ${scoreText(scoreSurface?.scores?.quality)} | ${scoreText(scoreSurface?.scores?.completeness)} | ${markdownEscape(ltsText(scoreSurface?.lts))} | ${surface.categories.length} | ${markdownEscape(lastRunText(scoreSurface ?? surface))} |`,
    );
  }
  lines.push("", ...renderEvidenceSection(evidenceSummaries));
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaxonomy({ taxonomy, scores }: Pick<RenderInputs, "taxonomy" | "scores">): string {
  const levels = taxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const profilesByCategory = categoryProfiles(taxonomy);
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy",
      "Detailed reference for the product areas and checks behind the OpenClaw maturity scorecard.",
    ),
    "# Maturity taxonomy",
    "",
    ...generatedNotice(),
    "## Maturity levels",
    "",
    "| Level | Label | Meaning | Promotion bar |",
    "| --- | --- | --- | --- |",
  ];
  for (const level of taxonomy.levels) {
    lines.push(
      `| ${yamlCode(level.code ?? level.id)} | ${markdownEscape(level.label ?? level.id)} | ${markdownEscape(level.meaning ?? "")} | ${markdownEscape(level.promotion_bar ?? "")} |`,
    );
  }

  lines.push(
    "",
    "## Surface index",
    "",
    "| Surface | Family | Level | Categories | Coverage | Quality | Completeness |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const surface of surfaces) {
    const scoreSurface = scoreSurfaces.get(surface.id);
    lines.push(
      `| [${markdownEscape(surface.name)}](#${surface.id}) | ${markdownEscape(familyTitle(surface.family))} | ${markdownEscape(levelText(scoreSurface ?? surface, levels))} | ${surface.categories.length} | ${scoreText(scoreSurface?.scores?.coverage)} | ${scoreText(scoreSurface?.scores?.quality)} | ${scoreText(scoreSurface?.scores?.completeness)} |`,
    );
  }

  lines.push("", "## Surface taxonomy", "");
  for (const family of familyOrder(surfaces)) {
    lines.push(`### ${familyTitle(family)}`, "");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      const scoreSurface = scoreSurfaces.get(surface.id);
      const categoryScores = categoryScoreMap(scoreSurface);
      lines.push(
        `#### ${surface.name}`,
        "",
        `- Surface id: ${yamlCode(surface.id)}`,
        `- Level: ${markdownEscape(levelText(scoreSurface ?? surface, levels))}`,
        `- Rationale: ${surface.rationale ?? ""}`,
        `- Completeness instructions: ${yamlCode(surface.completeness_instructions ?? "")}`,
        "",
        "| Category | Category ID | Features | Coverage IDs | Docs | Profiles | Coverage | Quality | Completeness | LTS |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const category of surface.categories) {
        const categoryId = `${surface.id}.${category.id}`;
        const featureNames = category.features.map((feature) => feature.name).join("<br>");
        const coverageIds = category.features
          .flatMap((feature) => feature.coverageIds ?? [])
          .filter(Boolean)
          .join("<br>");
        const docs = (category.docs ?? []).map((doc) => yamlCode(doc)).join("<br>");
        const profiles = (profilesByCategory.get(categoryId) ?? [])
          .map((id) => yamlCode(id))
          .join("<br>");
        const scoreCategory = categoryScores.get(category.name);
        lines.push(
          `| ${markdownEscape(category.name)} | ${yamlCode(categoryId)} | ${markdownEscape(featureNames)} | ${markdownEscape(coverageIds)} | ${docs} | ${profiles} | ${scoreText(scoreCategory?.coverage)} | ${scoreText(scoreCategory?.quality)} | ${scoreText(scoreCategory?.completeness)} | ${markdownEscape(scoreCategory?.lts?.supported ? "Yes" : "No")} |`,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaxonomyOutline({ taxonomy }: Pick<RenderInputs, "taxonomy">): string {
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy outline",
      "Generated outline of the product areas and capabilities behind the OpenClaw maturity scorecard.",
    ),
    "# Maturity taxonomy outline",
    "",
    ...generatedNotice(),
  ];
  for (const family of familyOrder(surfaces)) {
    lines.push(`## ${familyTitle(family)}`, "");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      lines.push(`### ${surface.name}`, "", `- Surface id: ${yamlCode(surface.id)}`, "");
      for (const category of surface.categories) {
        lines.push(
          `#### ${category.name}`,
          "",
          `- Category id: ${yamlCode(`${surface.id}.${category.id}`)}`,
        );
        for (const feature of category.features) {
          const coverageIds = (feature.coverageIds ?? []).map((id) => yamlCode(id)).join(", ");
          lines.push(`- ${markdownEscape(feature.name)}${coverageIds ? `: ${coverageIds}` : ""}`);
        }
        lines.push("");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function writeOrCheck(outputPath: string, content: string, check: boolean): boolean {
  const oldContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (check) {
    if (oldContent !== content) {
      throw new Error(`${outputPath} is stale; run pnpm maturity:render`);
    }
    return false;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (oldContent !== content) {
    fs.writeFileSync(outputPath, content);
    return true;
  }
  return false;
}

function anyOutputExists(outputDir: string, outputs: Map<string, string>): boolean {
  return [...outputs.keys()].some((fileName) => fs.existsSync(path.join(outputDir, fileName)));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const taxonomyPath = path.normalize(args.taxonomy);
  const scoresPath = path.normalize(args.scores);
  const outputDir = path.normalize(args.outputDir);
  const taxonomy = readYaml(taxonomyPath) as Taxonomy;
  const scores = parseQaMaturityScores(readYaml(scoresPath), scoresPath);
  validateTaxonomy(taxonomy, taxonomyPath);
  const scoreWarnings = validateScores(scores, scoresPath, taxonomy);
  const evidenceSummaries = readEvidenceSummaries(args.evidenceDir);
  const evidenceWarnings = evidenceScorecardWarnings(evidenceSummaries);
  const inputWarnings = [...scoreWarnings, ...evidenceWarnings];
  writeInputWarnings(inputWarnings);
  if (args.strictInputs) {
    enforceStrictInputs(inputWarnings);
  }
  const staticAssetsPath = staticAssetPath(outputDir, args.staticAssetsDir);
  const copiedStaticAssets =
    !args.check && args.staticAssetsDir
      ? copyStaticSourceAssets({
          evidenceSummaries,
          scoresPath,
          staticAssetsDir: args.staticAssetsDir,
          taxonomyPath,
        })
      : [];
  const outputs = new Map<string, string>([
    [
      "maturity-scorecard.md",
      renderMaturityScorecard({
        taxonomy,
        scores,
        taxonomyPath,
        scoresPath,
        evidenceSummaries,
        scoreWarnings,
        evidenceWarnings,
        staticAssetsPath,
      }),
    ],
    ["taxonomy.md", renderTaxonomy({ taxonomy, scores })],
    ["taxonomy-outline.md", renderTaxonomyOutline({ taxonomy })],
  ]);
  if (args.check && !anyOutputExists(outputDir, outputs)) {
    process.stdout.write(
      `maturity docs are not initialized in ${outputDir}; skipping generated-doc drift check\n`,
    );
    return;
  }
  const changed: string[] = [];
  for (const [fileName, content] of outputs) {
    const outputPath = path.join(outputDir, fileName);
    if (writeOrCheck(outputPath, content, args.check)) {
      changed.push(outputPath);
    }
  }
  if (args.check) {
    process.stdout.write(`maturity docs are up to date in ${outputDir}\n`);
  } else if (changed.length > 0) {
    process.stdout.write(
      `rendered maturity docs:\n${changed.map((file) => `- ${file}`).join("\n")}\n`,
    );
  } else {
    process.stdout.write(`maturity docs already up to date in ${outputDir}\n`);
  }
  if (copiedStaticAssets.length > 0) {
    process.stdout.write(
      `copied maturity static assets:\n${copiedStaticAssets.map((file) => `- ${file}`).join("\n")}\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
