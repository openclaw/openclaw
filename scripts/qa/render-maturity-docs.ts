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
  activeQaMaturityTaxonomySurfaces,
  qaMaturityCategoryProfiles,
  qaMaturityFamilyOrder,
  qaMaturityTaxonomyLevelMap,
  parseQaMaturityTaxonomy,
  parseQaMaturityScores,
  validateQaMaturityScoresAgainstTaxonomy,
  type QaMaturityScoreLastRun,
  type QaMaturityScoreObject,
  type QaMaturityScoreSurface,
  type QaMaturityScoreSurfaceLts,
  type QaMaturityScores,
  type QaMaturityTaxonomy,
  type QaMaturityTaxonomyLevel,
  type QaMaturityTaxonomySurface,
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
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
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
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const profilesByCategory = qaMaturityCategoryProfiles(taxonomy);
  const surfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
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
  for (const family of qaMaturityFamilyOrder(surfaces)) {
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
  const surfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy outline",
      "Generated outline of the product areas and capabilities behind the OpenClaw maturity scorecard.",
    ),
    "# Maturity taxonomy outline",
    "",
    ...generatedNotice(),
  ];
  for (const family of qaMaturityFamilyOrder(surfaces)) {
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
  const taxonomy = parseQaMaturityTaxonomy(readYaml(taxonomyPath), taxonomyPath);
  const scores = parseQaMaturityScores(readYaml(scoresPath), scoresPath);
  const scoreWarnings = validateQaMaturityScoresAgainstTaxonomy({
    scores,
    taxonomy,
    scoresPath,
  });
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
