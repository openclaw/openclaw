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
  QA_MATURITY_SCORE_LABEL_BANDS,
  activeQaMaturityTaxonomySurfaces,
  qaMaturityFamilyOrder,
  qaMaturityCoverageCategoryKey,
  qaMaturityScoreObjectForScore,
  qaMaturityTaxonomyLevelMap,
  parseQaMaturityTaxonomy,
  parseQaMaturityScores,
  validateQaMaturityScoresAgainstTaxonomy,
  type QaMaturityCoverageScores,
  type QaMaturityScoreObject,
  type QaMaturityScoreSurface,
  type QaMaturityScoreSurfaceLts,
  type QaMaturityScores,
  type QaMaturityTaxonomy,
  type QaMaturityTaxonomyLevel,
  type QaMaturityTaxonomySurface,
} from "../../extensions/qa-lab/src/scorecard-taxonomy.js";

const DEFAULT_TAXONOMY_PATH = "taxonomy.yaml";
const DEFAULT_SCORES_PATH = "qa/maturity-scores.yaml";
const DEFAULT_OUTPUT_DIR = "docs";

type Args = {
  taxonomy: string;
  scores: string;
  docsRoot: string;
  outputDir: string;
  staticAssetsDir?: string;
  evidenceDir?: string;
  check: boolean;
  strictInputs: boolean;
};

type EvidenceSummary = {
  sourcePath: string;
  path: string;
  generatedAt: string;
  profile: string;
  entryCount: number;
  statuses: StatusCounts;
  scorecard?: QaEvidenceScorecardJson;
};

type StatusCounts = Record<QaEvidenceStatus, number>;

const EMPTY_STATUS_COUNTS: StatusCounts = {
  pass: 0,
  fail: 0,
  blocked: 0,
  skipped: 0,
};

type RenderInputs = {
  taxonomy: QaMaturityTaxonomy;
  scores: QaMaturityScores;
  coverage: DerivedCoverageScores;
};

type DocsRouteIndex = {
  routes: Set<string>;
  redirects: Map<string, string>;
};

type RenderMaturityScorecardInputs = Pick<RenderInputs, "taxonomy" | "scores" | "coverage"> & {
  evidenceSummaries: EvidenceSummary[];
};

type DerivedCoverageScores = QaMaturityCoverageScores & {
  surfaces: Map<string, QaMaturityScoreObject>;
  rollups: {
    surface_average?: QaMaturityScoreObject;
    category_average?: QaMaturityScoreObject;
  };
  warnings: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    taxonomy: DEFAULT_TAXONOMY_PATH,
    scores: DEFAULT_SCORES_PATH,
    docsRoot: DEFAULT_OUTPUT_DIR,
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
    } else if (arg === "--docs-root") {
      args.docsRoot = next();
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
  --scores <path>       Aggregate score YAML path (default: qa/maturity-scores.yaml)
  --docs-root <path>    Public docs source root for route validation (default: docs)
  --output-dir <path>   Directory for maturity/scorecard.md and maturity/taxonomy.md
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

function markdownSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[/:]/g, " ")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeRoutePath(route: string): string {
  return route.replace(/^\/+/, "").replace(/\/+$/, "");
}

function collectDocsRouteIndex(docsRoot: string): DocsRouteIndex {
  const routes = new Set<string>();
  const redirects = new Map<string, string>();
  if (!fs.existsSync(docsRoot)) {
    return { routes, redirects };
  }
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "internal" && path.relative(docsRoot, fullPath) === "internal") {
          continue;
        }
        visit(fullPath);
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        routes.add(
          path
            .relative(docsRoot, fullPath)
            .replaceAll(path.sep, "/")
            .replace(/\.(md|mdx)$/i, ""),
        );
      }
    }
  };
  visit(docsRoot);

  const docsJsonPath = path.join(docsRoot, "docs.json");
  if (fs.existsSync(docsJsonPath)) {
    const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf8")) as {
      redirects?: Array<{ source?: string; destination?: string }>;
    };
    for (const redirect of docsJson.redirects ?? []) {
      if (!redirect.source || !redirect.destination || redirect.destination.startsWith("http")) {
        continue;
      }
      redirects.set(normalizeRoutePath(redirect.source), normalizeRoutePath(redirect.destination));
    }
  }
  return { routes, redirects };
}

function docsLink(docPath: string, docsRouteIndex: DocsRouteIndex): string | undefined {
  const docsPrefix = "docs/";
  const trimmedPath = docPath.trim();
  const publicPath = trimmedPath.startsWith(docsPrefix)
    ? trimmedPath.slice(docsPrefix.length)
    : trimmedPath;
  const [pagePath = "", anchor] = publicPath.split("#", 2);
  const withoutExtension = pagePath.replace(/\.(md|mdx)$/i, "");
  const lastSegment = withoutExtension.split("/").at(-1) ?? withoutExtension;
  const title = familyTitle(anchor ?? lastSegment);
  const publicRoute = docsRouteIndex.routes.has(withoutExtension)
    ? withoutExtension
    : docsRouteIndex.redirects.get(withoutExtension);
  if (!publicRoute || !docsRouteIndex.routes.has(publicRoute)) {
    return undefined;
  }
  const publicHref = anchor ? `${publicRoute}#${anchor}` : publicRoute;
  return `[${markdownEscape(title)}](/${markdownEscape(publicHref)})`;
}

function publicSurfaceName(name: string): string {
  if (name === "Browser automation and exec/sandbox tools") {
    return "Browser automation, exec, and sandbox tools";
  }
  const slashParts = name.split("/").map((part) => part.trim());
  if (slashParts.length === 1) {
    return name;
  }
  if (slashParts.length === 2) {
    return slashParts.join(" and ");
  }
  const lastPart = slashParts.at(-1) ?? "";
  return `${slashParts.slice(0, -1).join(", ")}, and ${lastPart}`;
}

function markdownTable(rows: RenderScalar[][]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => String(row[index] ?? "")),
  );
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: string[]) =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index] ?? 3)).join(" | ")} |`;
  return [
    formatRow(normalizedRows[0] ?? []),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.slice(1).map(formatRow),
  ];
}

function scoreText(value?: QaMaturityScoreObject): string {
  if (!value || typeof value !== "object") {
    return "`Unscored`";
  }
  return `\`${markdownEscape(value.label ?? "")} (${markdownEscape(value.score ?? "")}%)\``;
}

function levelText(
  surface: QaMaturityScoreSurface | QaMaturityTaxonomySurface,
  taxonomyLevels: Map<string, QaMaturityTaxonomyLevel>,
): string {
  const scoreLevel = surface.level;
  if (scoreLevel && typeof scoreLevel === "object") {
    return [scoreLevel.code, scoreLevel.label].filter(Boolean).join(" ");
  }
  const levelId = typeof scoreLevel === "string" ? scoreLevel : "";
  const level = taxonomyLevels.get(levelId);
  return [level?.code, level?.label ?? levelId].filter(Boolean).join(" ");
}

function ltsText(lts?: QaMaturityScoreSurfaceLts): string {
  if (!lts || typeof lts !== "object") {
    return "unscored";
  }
  const supportedCategories = lts.supported_categories ?? 0;
  if (lts.status === "full") {
    return `full (${supportedCategories})`;
  }
  if (lts.status === "partial") {
    return `partial (${supportedCategories})`;
  }
  if (lts.status === "none") {
    return "none";
  }
  return lts.status ?? "unknown";
}

function renderScoreBands(): string[] {
  return [
    "## Score bands",
    "",
    ...markdownTable([
      ["Label", "Score range"],
      ...QA_MATURITY_SCORE_LABEL_BANDS.map(([label, low, high]) => [label, `${low}-${high}%`]),
    ]),
    "",
  ];
}

function latestScoreRunDate(scores: QaMaturityScores): string | undefined {
  const dates = scores.surfaces
    .map((surface) => surface.last_score_run?.completed_at)
    .filter((date): date is string => Boolean(date))
    .toSorted((left, right) => left.localeCompare(right));
  return dates.at(-1);
}

function frontmatter(title: string, summary: string): string[] {
  return ["---", `title: "${title}"`, `summary: "${summary}"`, "---", ""];
}

function surfaceScoreMap(scores: QaMaturityScores): Map<string, QaMaturityScoreSurface> {
  return new Map(scores.surfaces.map((surface) => [surface.id, surface]));
}

function categoryScoreMap(
  scoreSurface?: QaMaturityScoreSurface,
): Map<string, QaMaturityScoreSurface["categories"][number]> {
  return new Map((scoreSurface?.categories ?? []).map((category) => [category.name, category]));
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

function countText(counts?: QaEvidenceScorecardJson["categories"]): string {
  if (!counts || typeof counts !== "object") {
    return "";
  }
  return `${counts.fulfilled ?? 0} of ${counts.total ?? 0} (${numberText(counts.fulfillmentPercent)}%)`;
}

function averageScores(
  scores: readonly QaMaturityScoreObject[],
): QaMaturityScoreObject | undefined {
  if (scores.length === 0) {
    return undefined;
  }
  const average = Math.round(scores.reduce((sum, score) => sum + score.score, 0) / scores.length);
  return qaMaturityScoreObjectForScore(average);
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

function latestReleaseScorecard(evidenceSummaries: EvidenceSummary[]): EvidenceSummary | undefined {
  return evidenceSummaries
    .filter((item) => item.profile === "release" && item.scorecard)
    .toSorted((left, right) => left.generatedAt.localeCompare(right.generatedAt))
    .at(-1);
}

function deriveCoverageScores(
  taxonomy: QaMaturityTaxonomy,
  evidenceSummaries: EvidenceSummary[],
): DerivedCoverageScores {
  const warnings: string[] = [];
  const releaseSummary = latestReleaseScorecard(evidenceSummaries);
  const releaseScorecardSummaries = evidenceSummaries.filter(
    (item) => item.profile === "release" && item.scorecard,
  );
  if (!releaseSummary) {
    throw new Error(
      "maturity scorecard rendering requires release profile qa-evidence.json with a scorecard field; pass --evidence-dir with release QA evidence artifacts",
    );
  }
  if (releaseScorecardSummaries.length > 1) {
    warnings.push(
      `multiple release profile evidence scorecards found; using latest from ${releaseSummary.path}`,
    );
  }

  const categories = new Map<string, QaMaturityScoreObject>();
  for (const report of releaseSummary.scorecard?.categoryReports ?? []) {
    categories.set(
      qaMaturityCoverageCategoryKey(report.surfaceId, report.name),
      qaMaturityScoreObjectForScore(Math.round(report.features.fulfillmentPercent)),
    );
  }

  const surfaces = new Map<string, QaMaturityScoreObject>();
  const missingCoverage: string[] = [];
  for (const surface of activeQaMaturityTaxonomySurfaces(taxonomy)) {
    const categoryScores = surface.categories
      .map((category) => {
        const key = qaMaturityCoverageCategoryKey(surface.id, category.name);
        const score = categories.get(key);
        if (!score) {
          missingCoverage.push(
            `${releaseSummary.path}: release evidence is missing scorecard coverage for ${surface.name} / ${category.name}`,
          );
        }
        return score;
      })
      .filter((score): score is QaMaturityScoreObject => Boolean(score));
    if (categoryScores.length === surface.categories.length) {
      const surfaceScore = averageScores(categoryScores);
      if (surfaceScore) {
        surfaces.set(surface.id, surfaceScore);
      }
    }
  }
  if (missingCoverage.length > 0) {
    throw new Error(
      `maturity scorecard rendering requires complete release evidence coverage:\n${missingCoverage
        .map((item) => `- ${item}`)
        .join("\n")}`,
    );
  }

  const activeSurfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
  const expectedCategoryCount = activeSurfaces.reduce(
    (count, surface) => count + surface.categories.length,
    0,
  );
  const categoryScores = Array.from(categories.values());
  const surfaceScores = Array.from(surfaces.values());
  return {
    categories,
    surfaces,
    rollups: {
      category_average:
        categoryScores.length === expectedCategoryCount ? averageScores(categoryScores) : undefined,
      surface_average:
        surfaceScores.length === activeSurfaces.length ? averageScores(surfaceScores) : undefined,
    },
    warnings,
  };
}

function evidenceScorecardWarnings(
  evidenceSummaries: EvidenceSummary[],
  coverage: DerivedCoverageScores,
): string[] {
  return [
    ...evidenceSummaries
      .filter((item) => item.profile === "release" && !item.scorecard)
      .map(
        (item) =>
          `${item.path}: release profile qa-evidence.json does not include a scorecard field; run pnpm openclaw qa run --qa-profile release to produce deterministic scorecard rows`,
      ),
    ...coverage.warnings,
  ];
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

function surfaceNameMap(surfaces: QaMaturityTaxonomySurface[]): Map<string, string> {
  return new Map(surfaces.map((surface) => [surface.id, publicSurfaceName(surface.name)]));
}

function renderEvidenceSection(
  evidenceSummaries: EvidenceSummary[],
  surfaceNames: Map<string, string>,
): string[] {
  const scorecardSummaries = evidenceSummaries.filter((item) => item.scorecard);
  if (scorecardSummaries.length === 0) {
    return [];
  }
  const lines = [
    "## Release check summary",
    "",
    "The checks below show which scorecard areas were exercised during release validation.",
    "",
  ];

  const summaryRows: RenderScalar[][] = [
    ["Check set", "Completed", "Checks run", "Results", "Areas reviewed", "Capabilities reviewed"],
  ];
  for (const item of scorecardSummaries) {
    const scorecard = item.scorecard;
    summaryRows.push([
      markdownEscape(checkSetTitle(item.profile)),
      markdownEscape(item.generatedAt),
      item.entryCount,
      markdownEscape(resultCountsText(item.statuses)),
      markdownEscape(countText(scorecard?.categories)),
      markdownEscape(countText(scorecard?.features)),
    ]);
  }
  lines.push(...markdownTable(summaryRows), "");

  const categoryRows = scorecardSummaries.flatMap((item) =>
    (item.scorecard?.categoryReports ?? []).map((category) => ({ item, category })),
  );
  if (categoryRows.length > 0) {
    const readinessRows: RenderScalar[][] = [
      ["Check set", "Surface", "Area", "Status", "Capabilities reviewed", "Follow-up"],
    ];
    for (const { item, category } of categoryRows) {
      const features = countText(category.features);
      readinessRows.push([
        markdownEscape(checkSetTitle(item.profile)),
        markdownEscape(surfaceNames.get(category.surfaceId) ?? familyTitle(category.surfaceId)),
        markdownEscape(category.name),
        markdownEscape(readinessStatusText(category.status)),
        markdownEscape(features),
        markdownEscape(followUpText(category.missingCoverageIds)),
      ]);
    }
    lines.push("### Readiness by area", "", ...markdownTable(readinessRows), "");
  }
  return lines;
}

function renderMaturityScorecard({
  coverage,
  taxonomy,
  scores,
  evidenceSummaries,
}: RenderMaturityScorecardInputs): string {
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
  const surfaceNames = surfaceNameMap(surfaces);
  const updatedDate = latestScoreRunDate(scores);
  const lines = [
    ...frontmatter(
      "Maturity scorecard",
      "OpenClaw release readiness scores for product areas, integrations, and supported workflows.",
    ),
    "# Maturity scorecard",
    "",
    "These scores summarize release readiness across OpenClaw product areas, integrations, and supported workflows.",
    "",
    `The current scorecard covers ${scores.counts.active_surfaces} surfaces and ${scores.counts.category_scores} capability areas.`,
    "",
    "## Overall scores",
    "",
    ...markdownTable([
      ["Basis", "Coverage", "Quality", "Completeness"],
      [
        "Surface average",
        scoreText(coverage.rollups.surface_average),
        scoreText(scores.rollups.surface_average.quality),
        scoreText(scores.rollups.surface_average.completeness),
      ],
      [
        "Category average",
        scoreText(coverage.rollups.category_average),
        scoreText(scores.rollups.category_average.quality),
        scoreText(scores.rollups.category_average.completeness),
      ],
    ]),
    "",
    "- Coverage is derived from release validation results.",
    "- Quality measures reliability and operational confidence.",
    "- Completeness measures how much of the expected user workflow is available.",
    "",
    ...renderScoreBands(),
  ];

  const surfaceRows: RenderScalar[][] = [
    [
      "Surface",
      "Family",
      "Level",
      "Coverage",
      "Quality",
      "Completeness",
      "Long-term support",
      "Areas",
    ],
  ];
  for (const surface of surfaces) {
    const scoreSurface = scoreSurfaces.get(surface.id);
    const surfaceName = publicSurfaceName(surface.name);
    surfaceRows.push([
      `[${markdownEscape(surfaceName)}](/maturity/taxonomy#${markdownSlug(surfaceName)})`,
      markdownEscape(familyTitle(surface.family)),
      markdownEscape(levelText(surface, levels)),
      scoreText(coverage.surfaces.get(surface.id)),
      scoreText(scoreSurface?.scores?.quality),
      scoreText(scoreSurface?.scores?.completeness),
      markdownEscape(ltsText(scoreSurface?.lts)),
      surface.categories.length,
    ]);
  }
  lines.push(
    "## Surface scorecard",
    "",
    ...markdownTable(surfaceRows),
    "",
    ...renderEvidenceSection(evidenceSummaries, surfaceNames),
  );
  if (updatedDate) {
    lines.push(`> Last updated: ${updatedDate}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaxonomy({
  coverage,
  docsRouteIndex,
  scores,
  taxonomy,
}: RenderInputs & { docsRouteIndex: DocsRouteIndex }): string {
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy",
      "Detailed reference for the product areas and checks behind the OpenClaw maturity scorecard.",
    ),
    "# Maturity taxonomy",
    "",
    "This page explains the product areas and capability groups behind the maturity scorecard.",
    "",
    "## Maturity levels",
    "",
    ...markdownTable([
      ["Level", "Label", "Meaning", "Promotion bar"],
      ...taxonomy.levels.map((level) => [
        yamlCode(level.code ?? level.id),
        markdownEscape(level.label ?? level.id),
        markdownEscape(level.meaning ?? ""),
        markdownEscape(level.promotion_bar ?? ""),
      ]),
    ]),
    "",
    "## Product areas",
    "",
  ];

  for (const family of qaMaturityFamilyOrder(surfaces)) {
    lines.push(`### ${familyTitle(family)}`, "");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      const surfaceName = publicSurfaceName(surface.name);
      lines.push(`- [${markdownEscape(surfaceName)}](#${markdownSlug(surfaceName)})`);
    }
    lines.push("");
  }

  lines.push("## Details", "");
  for (const family of qaMaturityFamilyOrder(surfaces)) {
    lines.push(`### ${familyTitle(family)}`, "");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      const surfaceName = publicSurfaceName(surface.name);
      const scoreSurface = scoreSurfaces.get(surface.id);
      const categoryScores = categoryScoreMap(scoreSurface);
      const categoryRows: RenderScalar[][] = [
        [
          "Area",
          "Capabilities",
          "Docs",
          "Coverage",
          "Quality",
          "Completeness",
          "Long-term support",
        ],
      ];
      for (const category of surface.categories) {
        const docs = (category.docs ?? [])
          .map((doc) => docsLink(doc, docsRouteIndex))
          .filter((doc): doc is string => Boolean(doc))
          .join(", ");
        const scoreCategory = categoryScores.get(category.name);
        const coverageScore = coverage.categories.get(
          qaMaturityCoverageCategoryKey(surface.id, category.name),
        );
        categoryRows.push([
          markdownEscape(category.name),
          category.features.length,
          docs,
          scoreText(coverageScore),
          scoreText(scoreCategory?.quality),
          scoreText(scoreCategory?.completeness),
          markdownEscape(scoreCategory?.lts?.supported ? "Yes" : "No"),
        ]);
      }
      lines.push(
        `#### ${surfaceName}`,
        "",
        `- Level: ${markdownEscape(levelText(surface, levels))}`,
        `- Rationale: ${surface.rationale ?? ""}`,
        "",
        ...markdownTable(categoryRows),
      );
      lines.push("");
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const taxonomyPath = path.normalize(args.taxonomy);
  const scoresPath = path.normalize(args.scores);
  const docsRoot = path.normalize(args.docsRoot);
  const outputDir = path.normalize(args.outputDir);
  const taxonomy = parseQaMaturityTaxonomy(readYaml(taxonomyPath), taxonomyPath);
  const scores = parseQaMaturityScores(readYaml(scoresPath), scoresPath);
  const evidenceSummaries = readEvidenceSummaries(args.evidenceDir);
  const coverage = deriveCoverageScores(taxonomy, evidenceSummaries);
  const scoreWarnings = validateQaMaturityScoresAgainstTaxonomy({
    coverageScores: coverage,
    scores,
    taxonomy,
    scoresPath,
  });
  const evidenceWarnings = evidenceScorecardWarnings(evidenceSummaries, coverage);
  const inputWarnings = [...scoreWarnings, ...evidenceWarnings];
  writeInputWarnings(inputWarnings);
  if (args.strictInputs) {
    enforceStrictInputs(inputWarnings);
  }
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
      "maturity/scorecard.md",
      renderMaturityScorecard({
        coverage,
        taxonomy,
        scores,
        evidenceSummaries,
      }),
    ],
    [
      "maturity/taxonomy.md",
      renderTaxonomy({
        coverage,
        docsRouteIndex: collectDocsRouteIndex(docsRoot),
        taxonomy,
        scores,
      }),
    ],
  ]);
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
