import fs from "node:fs/promises";
import path from "node:path";
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
  QA_FRONTIER_PARITY_BASELINE_LABEL,
  QA_FRONTIER_PARITY_CANDIDATE_LABEL,
} from "./providers/live-frontier/parity.js";
import { readCompletedQaSuiteSummaryFile } from "./suite-summary.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
} from "./token-efficiency-report.js";

export { runQaCoverageReportCommand } from "./cli-coverage.runtime.js";

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
