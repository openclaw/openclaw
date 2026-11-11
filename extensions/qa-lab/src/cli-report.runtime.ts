import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "openclaw/plugin-sdk/path-existence-runtime";
import {
  buildQaAgenticParityComparison,
  buildQaRuntimeParityReport,
  renderQaAgenticParityMarkdownReport,
  renderQaRuntimeParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";
import {
  resolveQaCommandOutputDir,
  writeQaCliReport,
  writeQaCommandVerdict,
} from "./cli-report.js";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import {
  QA_FRONTIER_PARITY_BASELINE_LABEL,
  QA_FRONTIER_PARITY_CANDIDATE_LABEL,
} from "./providers/live-frontier/parity.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  buildQaScorecardGapReport,
  renderQaScorecardGapMarkdownReport,
} from "./scorecard-gap-report.js";
import { readQaMaturityTaxonomySource } from "./scorecard-taxonomy.js";
import { readCompletedQaSuiteSummaryFile } from "./suite-summary.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
} from "./token-efficiency-report.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
} from "./tool-coverage-report.js";

export async function runQaParityReportCommand(opts: {
  repoRoot?: string;
  candidateSummary?: string;
  baselineSummary?: string;
  candidateLabel?: string;
  baselineLabel?: string;
  outputDir?: string;
  runtimeAxis?: boolean;
  summary?: string;
  tokenEfficiency?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  if (opts.tokenEfficiency === true && opts.runtimeAxis !== true) {
    throw new Error("--token-efficiency requires --runtime-axis.");
  }
  const outputDir = resolveQaCommandOutputDir(repoRoot, opts.outputDir, "parity");
  await fs.mkdir(outputDir, { recursive: true });

  if (opts.runtimeAxis === true) {
    if (!opts.summary?.trim()) {
      throw new Error("--runtime-axis requires --summary.");
    }
    const summaryPath = path.resolve(repoRoot, opts.summary);
    // SAFETY: report inputs are completed suite artifacts with the producer-owned parity shape.
    const summary = (await readCompletedQaSuiteSummaryFile(summaryPath)) as QaParitySuiteSummary;
    const reportPayload = buildQaRuntimeParityReport({ summary });
    await writeQaCliReport(
      outputDir,
      "qa-runtime-parity",
      renderQaRuntimeParityMarkdownReport(reportPayload),
      reportPayload,
    );
    process.stdout.write(`QA runtime parity verdict: ${reportPayload.pass ? "pass" : "fail"}\n`);

    let tokenEfficiencyPass = true;
    if (opts.tokenEfficiency === true) {
      const tokenPayload = buildTokenEfficiencyReport({
        summary,
      });
      tokenEfficiencyPass = tokenPayload.pass;
      await writeQaCliReport(
        outputDir,
        "qa-runtime-token-efficiency",
        renderTokenEfficiencyMarkdownReport(tokenPayload),
        tokenPayload,
      );
      process.stdout.write(
        `QA runtime token efficiency verdict: ${tokenPayload.status === "skipped" ? "skipped" : tokenPayload.pass ? "pass" : "fail"}\n`,
      );
    }

    if (!reportPayload.pass || !tokenEfficiencyPass) {
      process.exitCode = 1;
    }
    return;
  }

  if (!opts.candidateSummary?.trim() || !opts.baselineSummary?.trim()) {
    throw new Error(
      "--candidate-summary and --baseline-summary are required unless --runtime-axis is set.",
    );
  }
  const candidateSummaryPath = path.resolve(repoRoot, opts.candidateSummary);
  const baselineSummaryPath = path.resolve(repoRoot, opts.baselineSummary);
  const candidateSummary = (await readCompletedQaSuiteSummaryFile(
    candidateSummaryPath,
  )) as QaParitySuiteSummary; // SAFETY: completed suite producers own this report shape.
  const baselineSummary = (await readCompletedQaSuiteSummaryFile(
    baselineSummaryPath,
  )) as QaParitySuiteSummary; // SAFETY: completed suite producers own this report shape.

  const comparison = buildQaAgenticParityComparison({
    candidateLabel: opts.candidateLabel?.trim() || QA_FRONTIER_PARITY_CANDIDATE_LABEL,
    baselineLabel: opts.baselineLabel?.trim() || QA_FRONTIER_PARITY_BASELINE_LABEL,
    candidateSummary,
    baselineSummary,
  });
  await writeQaCliReport(
    outputDir,
    "qa-agentic-parity",
    renderQaAgenticParityMarkdownReport(comparison),
    comparison,
  );
  writeQaCommandVerdict("QA parity", comparison.pass);
}

async function assertCoverageOutputPreservesInput(
  inputPath: string,
  outputPath: string | undefined,
  inputKind: "evidence" | "summary",
) {
  if (!outputPath) {
    return;
  }
  const input = await fs.stat(inputPath);
  const output = await fs.stat(outputPath).catch((error: unknown) => {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  });
  if (output && input.dev === output.dev && input.ino === output.ino) {
    throw new Error(`--output must not overwrite the input ${inputKind} artifact.`);
  }
}

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
    await assertCoverageOutputPreservesInput(evidencePath, outputPath, "evidence");
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
      const summaryPath = path.resolve(repoRoot, opts.summary);
      const completed = await readCompletedQaSuiteSummaryFile(summaryPath);
      await assertCoverageOutputPreservesInput(summaryPath, outputPath, "summary");
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
