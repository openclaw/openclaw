#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SCENARIO_DIR = "qa/evals/context-compaction";

function parseArgs(argv) {
  const args = {
    scenarioDir: DEFAULT_SCENARIO_DIR,
    out: "",
    minPassRate: 1,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--scenario-dir": {
        args.scenarioDir = argv[++index] ?? args.scenarioDir;
        break;
      }
      case "--out": {
        args.out = argv[++index] ?? "";
        break;
      }
      case "--min-pass-rate": {
        args.minPassRate = Number(argv[++index] ?? args.minPassRate);
        break;
      }
      case "--json": {
        args.json = true;
        break;
      }
      case "--help":
      case "-h": {
        printHelp();
        process.exit(0);
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }
  if (!Number.isFinite(args.minPassRate) || args.minPassRate < 0 || args.minPassRate > 1) {
    throw new Error("--min-pass-rate must be a number from 0 to 1");
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: node scripts/context-compaction-quality-probes.mjs [options]\n\nOptions:\n  --scenario-dir <dir>   Directory of scenario JSON files (default: ${DEFAULT_SCENARIO_DIR})\n  --out <path>           Write a markdown report\n  --min-pass-rate <n>    Exit non-zero when pass rate is below n (default: 1)\n  --json                 Print JSON instead of markdown\n`,
  );
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAll(haystack, needles) {
  const normalized = normalize(haystack);
  return needles.every((needle) => normalized.includes(normalize(needle)));
}

function gradeProbe(summary, probe) {
  const groups = probe.mustIncludeAny;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`Probe ${probe.id} must define non-empty mustIncludeAny`);
  }
  const missingGroups = groups.filter(
    (group) => !Array.isArray(group) || group.length === 0 || !includesAll(summary, group),
  );
  return {
    id: probe.id,
    category: probe.category,
    question: probe.question,
    passed: missingGroups.length === 0,
    missingGroups,
  };
}

function validateScenario(scenario, file) {
  for (const field of ["id", "title", "summary", "probes"]) {
    if (scenario[field] === undefined) {
      throw new Error(`${file} missing ${field}`);
    }
  }
  if (!Array.isArray(scenario.probes) || scenario.probes.length === 0) {
    throw new Error(`${file} must include at least one probe`);
  }
}

async function loadScenarios(scenarioDir) {
  const entries = await readdir(scenarioDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(scenarioDir, entry.name))
    .toSorted();
  if (files.length === 0) {
    throw new Error(`No scenario JSON files found in ${scenarioDir}`);
  }
  const scenarios = [];
  for (const file of files) {
    const scenario = JSON.parse(await readFile(file, "utf8"));
    validateScenario(scenario, file);
    scenarios.push({ ...scenario, file });
  }
  return scenarios;
}

function gradeScenario(scenario) {
  const probes = scenario.probes.map((probe) => gradeProbe(scenario.summary, probe));
  const passed = probes.filter((probe) => probe.passed).length;
  return {
    id: scenario.id,
    title: scenario.title,
    file: scenario.file,
    probeCount: probes.length,
    passed,
    failed: probes.length - passed,
    passRate: probes.length === 0 ? 0 : passed / probes.length,
    probes,
  };
}

function summarize(results) {
  const probeCount = results.reduce((sum, result) => sum + result.probeCount, 0);
  const passed = results.reduce((sum, result) => sum + result.passed, 0);
  const failed = probeCount - passed;
  const byCategory = new Map();
  for (const result of results) {
    for (const probe of result.probes) {
      const current = byCategory.get(probe.category) ?? {
        category: probe.category,
        passed: 0,
        failed: 0,
      };
      if (probe.passed) {
        current.passed += 1;
      } else {
        current.failed += 1;
      }
      byCategory.set(probe.category, current);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    scenarioCount: results.length,
    probeCount,
    passed,
    failed,
    passRate: probeCount === 0 ? 0 : passed / probeCount,
    byCategory: [...byCategory.values()].toSorted((left, right) =>
      left.category.localeCompare(right.category),
    ),
    results,
  };
}

function formatMissing(group) {
  return group.map((item) => `\`${item}\``).join(" + ");
}

function renderMarkdown(report) {
  const lines = [
    "# Context-compaction quality probe report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Scenarios: ${report.scenarioCount}`,
    `Probes: ${report.passed}/${report.probeCount} passed (${(report.passRate * 100).toFixed(1)}%)`,
    "",
    "## Category summary",
    "",
    "| Category | Passed | Failed |",
    "| --- | ---: | ---: |",
  ];
  lines.push(
    ...report.byCategory.map((row) => `| ${row.category} | ${row.passed} | ${row.failed} |`),
  );
  lines.push("", "## Scenario results", "");
  for (const result of report.results) {
    lines.push(
      `### ${result.title} (${result.id})`,
      "",
      `File: \`${result.file}\``,
      `Result: ${result.passed}/${result.probeCount} passed`,
      "",
    );
    for (const probe of result.probes) {
      const marker = probe.passed ? "PASS" : "FAIL";
      lines.push(`- ${marker} [${probe.category}] ${probe.id}: ${probe.question}`);
      if (!probe.passed) {
        lines.push(`  - Missing groups: ${probe.missingGroups.map(formatMissing).join("; ")}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = await loadScenarios(args.scenarioDir);
  const report = summarize(scenarios.map(gradeScenario));
  const output = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (args.out) {
    await writeFile(args.out, output);
  } else {
    process.stdout.write(output);
  }
  if (report.passRate < args.minPassRate) {
    console.error(
      `context-compaction probe pass rate ${(report.passRate * 100).toFixed(1)}% below minimum ${(args.minPassRate * 100).toFixed(1)}%`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
