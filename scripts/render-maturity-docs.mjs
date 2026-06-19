#!/usr/bin/env node
// Renders public maturity scorecard docs from the root taxonomy and score aggregate.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const DEFAULT_TAXONOMY_PATH = "taxonomy.yaml";
const DEFAULT_SCORES_PATH = "docs/maturity-scores.yaml";
const DEFAULT_OUTPUT_DIR = "docs";

function parseArgs(argv) {
  const args = {
    taxonomy: DEFAULT_TAXONOMY_PATH,
    scores: DEFAULT_SCORES_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    evidenceDir: undefined,
    check: false,
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
    const next = () => {
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
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = next();
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: node scripts/render-maturity-docs.mjs [options]

Options:
  --taxonomy <path>     Taxonomy YAML path (default: taxonomy.yaml)
  --scores <path>       Aggregate score YAML path (default: docs/maturity-scores.yaml)
  --output-dir <path>   Directory for maturity-scorecard.md, taxonomy.md, and taxonomy-outline.md
  --evidence-dir <path> Optional directory containing qa-evidence.json artifacts
  --check               Fail when output files are stale
  -h, --help            Show this help
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown maturity docs option: ${arg}`);
    }
  }
  return args;
}

function readYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateTaxonomy(taxonomy, taxonomyPath) {
  assertObject(taxonomy, taxonomyPath);
  if (taxonomy.version !== 1) {
    throw new Error(`${taxonomyPath} must declare version: 1`);
  }
  assertString(taxonomy.title, `${taxonomyPath}.title`);
  assertArray(taxonomy.levels, `${taxonomyPath}.levels`);
  assertArray(taxonomy.surfaces, `${taxonomyPath}.surfaces`);
  const profileIds = new Set();
  for (const [profileIndex, profile] of assertArray(
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

  const categoryIds = new Set();
  for (const [surfaceIndex, surface] of taxonomy.surfaces.entries()) {
    assertObject(surface, `${taxonomyPath}.surfaces[${surfaceIndex}]`);
    const surfaceId = assertString(surface.id, `${taxonomyPath}.surfaces[${surfaceIndex}].id`);
    assertString(surface.name, `${taxonomyPath}.${surfaceId}.name`);
    assertString(surface.family, `${taxonomyPath}.${surfaceId}.family`);
    assertString(surface.level, `${taxonomyPath}.${surfaceId}.level`);
    for (const [categoryIndex, category] of assertArray(
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
      for (const [featureIndex, feature] of assertArray(
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
        assertArray(
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

function validateScores(scores, scoresPath) {
  assertObject(scores, scoresPath);
  if (scores.version !== 1) {
    throw new Error(`${scoresPath} must declare version: 1`);
  }
  assertObject(scores.counts, `${scoresPath}.counts`);
  assertObject(scores.rollups, `${scoresPath}.rollups`);
  assertArray(scores.surfaces, `${scoresPath}.surfaces`);
}

function familyTitle(value) {
  const titles = {
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

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|");
}

function yamlCode(value) {
  return `\`${markdownEscape(value)}\``;
}

function scoreText(value) {
  if (!value || typeof value !== "object") {
    return "`Unscored`";
  }
  return `\`${markdownEscape(value.label ?? "")} (${markdownEscape(value.score ?? "")}%)\``;
}

function levelText(surface, taxonomyLevels) {
  const scoreLevel = surface.level;
  if (scoreLevel && typeof scoreLevel === "object") {
    return [scoreLevel.code, scoreLevel.label].filter(Boolean).join(" ");
  }
  const level = taxonomyLevels.get(surface.level);
  return [level?.code, level?.label ?? surface.level].filter(Boolean).join(" ");
}

function lastRunText(surface) {
  const lastRun = surface.last_score_run;
  if (!lastRun || typeof lastRun !== "object") {
    return "";
  }
  return [lastRun.status, lastRun.completed_at ? `on ${lastRun.completed_at}` : ""]
    .filter(Boolean)
    .join(" ");
}

function ltsText(lts) {
  if (!lts || typeof lts !== "object") {
    return "unscored";
  }
  return `${lts.status ?? "unknown"} (${lts.supported_categories ?? 0}/${lts.total_categories ?? 0})`;
}

function frontmatter(title, summary) {
  return ["---", `title: "${title}"`, `summary: "${summary}"`, "---", ""];
}

function generatedNotice(inputs) {
  const parts = [
    "This file is generated from",
    yamlCode(inputs.taxonomyPath),
    "and",
    `${yamlCode(inputs.scoresPath)}.`,
    "Run",
    yamlCode("pnpm maturity:render"),
    "after editing scorecard sources.",
  ];
  return [
    "> " + parts.join(" "),
    "> Committed docs intentionally exclude the old maintainer inventory tree; per-run QA evidence stays in GitHub Actions artifacts.",
    "",
  ];
}

function activeSurfaces(taxonomy) {
  return taxonomy.surfaces.filter((surface) => !surface.archived);
}

function surfaceScoreMap(scores) {
  return new Map(scores.surfaces.map((surface) => [surface.id, surface]));
}

function taxonomyLevelMap(taxonomy) {
  return new Map(taxonomy.levels.map((level) => [level.id, level]));
}

function categoryScoreMap(scoreSurface) {
  return new Map((scoreSurface?.categories ?? []).map((category) => [category.name, category]));
}

function familyOrder(surfaces) {
  const seen = [];
  for (const surface of surfaces) {
    if (!seen.includes(surface.family)) {
      seen.push(surface.family);
    }
  }
  return seen;
}

function categoryProfiles(taxonomy) {
  const profilesByCategory = new Map();
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

function collectQaEvidenceFiles(root) {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const visit = (dir) => {
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

function countStatuses(entries) {
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  for (const entry of entries ?? []) {
    const status = entry?.result?.status;
    if (Object.hasOwn(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function countText(counts) {
  if (!counts || typeof counts !== "object") {
    return "";
  }
  return `${counts.fulfilled ?? 0}/${counts.total ?? 0} (${numberText(counts.fulfillmentPercent)}%)`;
}

function readScorecard(payload, filePath) {
  const scorecard = payload?.scorecard;
  if (scorecard === undefined) {
    return undefined;
  }
  assertObject(scorecard, `${filePath}.scorecard`);
  assertObject(scorecard.run, `${filePath}.scorecard.run`);
  assertObject(scorecard.categories, `${filePath}.scorecard.categories`);
  assertObject(scorecard.features, `${filePath}.scorecard.features`);
  assertArray(scorecard.categoryReports, `${filePath}.scorecard.categoryReports`);
  for (const [index, category] of scorecard.categoryReports.entries()) {
    assertObject(category, `${filePath}.scorecard.categoryReports[${index}]`);
    assertString(category.id, `${filePath}.scorecard.categoryReports[${index}].id`);
    assertString(category.surfaceId, `${filePath}.scorecard.categoryReports[${index}].surfaceId`);
    assertString(category.name, `${filePath}.scorecard.categoryReports[${index}].name`);
    assertString(category.status, `${filePath}.scorecard.categoryReports[${index}].status`);
    assertObject(category.features, `${filePath}.scorecard.categoryReports[${index}].features`);
    assertArray(
      category.missingCoverageIds,
      `${filePath}.scorecard.categoryReports[${index}].missingCoverageIds`,
    );
  }
  return scorecard;
}

function readEvidenceSummaries(evidenceDir) {
  return collectQaEvidenceFiles(evidenceDir).map((filePath) => {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return {
      path: path.relative(process.cwd(), filePath),
      generatedAt: payload.generatedAt ?? "",
      profile: payload.profile ?? "",
      evidenceMode: payload.evidenceMode ?? "",
      entryCount: entries.length,
      statuses: countStatuses(entries),
      scorecard: readScorecard(payload, filePath),
    };
  });
}

function renderEvidenceSection(evidenceSummaries) {
  const lines = ["## QA evidence artifacts", ""];
  if (evidenceSummaries.length === 0) {
    lines.push(
      "No `qa-evidence.json` artifact directory was provided for this render.",
      "Use the `Maturity scorecard` workflow with a source run id, or run `pnpm maturity:render -- --evidence-dir <downloaded-artifacts> --output-dir <output-dir>` locally to produce an evidence-enriched docs artifact.",
      "",
    );
    return lines;
  }

  lines.push(
    "These rows come from the deterministic `scorecard` field in each `qa-evidence.json` artifact. Subjective maturity scores still come from `docs/maturity-scores.yaml`.",
    "",
    "| Evidence file | Profile | Mode | Generated | Entries | Result counts | Category fulfillment | Feature fulfillment |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const item of evidenceSummaries) {
    const scorecard = item.scorecard;
    const categoryFulfillment = countText(scorecard?.categories);
    const featureFulfillment = countText(scorecard?.features);
    const statusText = `pass ${item.statuses.pass}, fail ${item.statuses.fail}, blocked ${item.statuses.blocked}, skipped ${item.statuses.skipped}`;
    lines.push(
      `| ${yamlCode(item.path)} | ${markdownEscape(item.profile)} | ${markdownEscape(item.evidenceMode)} | ${markdownEscape(item.generatedAt)} | ${item.entryCount} | ${markdownEscape(statusText)} | ${markdownEscape(categoryFulfillment)} | ${markdownEscape(featureFulfillment)} |`,
    );
  }
  lines.push("");

  const categoryRows = evidenceSummaries.flatMap((item) =>
    (item.scorecard?.categoryReports ?? []).map((category) => ({ item, category })),
  );
  if (categoryRows.length > 0) {
    lines.push(
      "### Deterministic QA scorecard",
      "",
      "| Profile | Surface | Category | QA status | Features | Secondary-only | Missing coverage IDs |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const { item, category } of categoryRows) {
      const features = countText(category.features);
      lines.push(
        `| ${markdownEscape(item.profile)} | ${yamlCode(category.surfaceId)} | ${yamlCode(category.id)} ${markdownEscape(category.name)} | ${markdownEscape(category.status)} | ${markdownEscape(features)} | ${category.features.secondaryOnly ?? 0} | ${markdownEscape((category.missingCoverageIds ?? []).join(", "))} |`,
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
}) {
  const levels = taxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity scorecard",
      "Generated OpenClaw maturity scorecard for product, platform, provider, channel, and QA surfaces.",
    ),
    "# Maturity scorecard",
    "",
    ...generatedNotice({ taxonomyPath, scoresPath }),
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

  if ((taxonomy.profiles ?? []).length > 0) {
    lines.push(
      "## QA profiles",
      "",
      "| Profile | Evidence mode | Scope | Description |",
      "| --- | --- | --- | --- |",
    );
    for (const profile of taxonomy.profiles) {
      const scope = profile.includeAllCategories
        ? "All categories"
        : `${(profile.categoryIds ?? []).length} categories`;
      lines.push(
        `| ${yamlCode(profile.id)} | ${markdownEscape(profile.evidenceMode ?? "full")} | ${markdownEscape(scope)} | ${markdownEscape(profile.description)} |`,
      );
    }
    lines.push("");
  }

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

function renderTaxonomy({ taxonomy, scores, taxonomyPath, scoresPath }) {
  const levels = taxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const profilesByCategory = categoryProfiles(taxonomy);
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy",
      "Generated taxonomy reference for OpenClaw maturity scorecard surfaces, categories, features, docs, and QA coverage IDs.",
    ),
    "# Maturity taxonomy",
    "",
    ...generatedNotice({ taxonomyPath, scoresPath }),
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

function renderTaxonomyOutline({ taxonomy, taxonomyPath, scoresPath }) {
  const surfaces = activeSurfaces(taxonomy);
  const lines = [
    ...frontmatter(
      "Maturity taxonomy outline",
      "Generated outline of OpenClaw maturity scorecard surfaces, categories, and feature coverage IDs.",
    ),
    "# Maturity taxonomy outline",
    "",
    ...generatedNotice({ taxonomyPath, scoresPath }),
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

function writeOrCheck(outputPath, content, check) {
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

function anyOutputExists(outputDir, outputs) {
  return [...outputs.keys()].some((fileName) => fs.existsSync(path.join(outputDir, fileName)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const taxonomyPath = path.normalize(args.taxonomy);
  const scoresPath = path.normalize(args.scores);
  const outputDir = path.normalize(args.outputDir);
  const taxonomy = readYaml(taxonomyPath);
  const scores = readYaml(scoresPath);
  validateTaxonomy(taxonomy, taxonomyPath);
  validateScores(scores, scoresPath);
  const evidenceSummaries = readEvidenceSummaries(args.evidenceDir);
  const outputs = new Map([
    [
      "maturity-scorecard.md",
      renderMaturityScorecard({ taxonomy, scores, taxonomyPath, scoresPath, evidenceSummaries }),
    ],
    ["taxonomy.md", renderTaxonomy({ taxonomy, scores, taxonomyPath, scoresPath })],
    ["taxonomy-outline.md", renderTaxonomyOutline({ taxonomy, taxonomyPath, scoresPath })],
  ]);
  if (args.check && !anyOutputExists(outputDir, outputs)) {
    process.stdout.write(
      `maturity docs are not initialized in ${outputDir}; skipping generated-doc drift check\n`,
    );
    return;
  }
  const changed = [];
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
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
