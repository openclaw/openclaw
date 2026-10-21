import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "openclaw/plugin-sdk/path-existence-runtime";
import type { QaParitySuiteSummary } from "./agentic-parity-report.js";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  buildQaScorecardGapReport,
  renderQaScorecardGapMarkdownReport,
} from "./scorecard-gap-report.js";
import { readQaMaturityTaxonomySource } from "./scorecard-taxonomy.js";
import { readCompletedQaSuiteSummaryFile } from "./suite-summary.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
} from "./tool-coverage-report.js";

export async function runQaCoverageReportCommand(opts: {
  repoRoot?: string;
  output?: string;
  json?: boolean;
  tools?: boolean;
  summary?: string;
  evidence?: string;
  match?: string[];
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputPath = opts.output ? path.resolve(repoRoot, opts.output) : undefined;
  const scenarios = readQaScenarioPack().scenarios;
  let body: string;
  let outputLabel = "QA coverage report";
  if (opts.evidence !== undefined) {
    if (opts.tools || opts.summary !== undefined || opts.match?.length) {
      throw new Error("--evidence cannot be combined with --tools, --summary, or --match.");
    }
    const evidencePath = path.resolve(repoRoot, opts.evidence);
    if (outputPath) {
      const input = await fs.stat(evidencePath);
      const output = await fs.stat(outputPath).catch((error: unknown) => {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
      if (output && input.dev === output.dev && input.ino === output.ino) {
        throw new Error("--output must not overwrite the input evidence artifact.");
      }
    }
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
    );
    const report = buildQaScorecardGapReport({
      taxonomy: readQaMaturityTaxonomySource(path.resolve(repoRoot, "taxonomy.yaml")),
      scenarios,
      evidence,
    });
    body = opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderQaScorecardGapMarkdownReport(report);
    outputLabel = "QA scorecard gap report";
  } else if (opts.tools === true) {
    if (opts.match && opts.match.length > 0) {
      throw new Error("--match cannot be combined with --tools.");
    }
    let summary: QaParitySuiteSummary | undefined;
    if (opts.summary?.trim()) {
      const completed = await readCompletedQaSuiteSummaryFile(path.resolve(repoRoot, opts.summary));
      // SAFETY: --summary consumes buildQaSuiteSummaryJson's runtime-parity artifact; the reader checks completion only.
      summary = completed as QaParitySuiteSummary;
    }
    const report = buildQaToolCoverageReport({ scenarios, summary });
    body = opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderQaToolCoverageMarkdownReport(report);
    outputLabel = "QA tool coverage report";
    if (summary && !report.pass) {
      process.exitCode = 1;
    }
  } else {
    if (opts.summary?.trim()) {
      throw new Error("--summary requires --tools.");
    }
    const query = opts.match?.join(" ").trim();
    if (query) {
      const matches = findQaScenarioMatches(scenarios, query);
      body = opts.json
        ? `${JSON.stringify({ query, matches }, null, 2)}\n`
        : renderQaScenarioMatchesMarkdownReport({ query, matches });
      outputLabel = "QA scenario match report";
    } else {
      const inventory = buildQaCoverageInventory(scenarios);
      body = opts.json
        ? `${JSON.stringify(inventory, null, 2)}\n`
        : renderQaCoverageMarkdownReport(inventory);
    }
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, body, "utf8");
    process.stdout.write(`${outputLabel}: ${outputPath}\n`);
    return;
  }

  process.stdout.write(body);
}
