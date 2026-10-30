import fs from "node:fs/promises";
import path from "node:path";
import { createQaArtifactRunId } from "./artifact-run-id.js";
import { resolveRepoRelativeOutputDir } from "./cli-paths.js";

const QA_REPORT_LABELS = {
  "qa-runtime-parity": "QA runtime parity",
  "qa-runtime-token-efficiency": "QA runtime token efficiency",
  "qa-agentic-parity": "QA parity",
  "qa-confidence": "QA confidence",
  "qa-jsonl-replay": "QA JSONL replay",
} as const;

export async function writeQaCliReport(
  outputDir: string,
  stem: keyof typeof QA_REPORT_LABELS,
  report: string,
  summary: unknown,
) {
  const label = QA_REPORT_LABELS[stem];
  const reportPath = path.join(outputDir, `${stem}-report.md`);
  const summaryPath = path.join(outputDir, `${stem}-summary.json`);
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${label} report: ${reportPath}\n`);
  process.stdout.write(`${label} summary: ${summaryPath}\n`);
}

export function resolveQaCommandOutputDir(
  repoRoot: string,
  outputDir: string | undefined,
  kind: string,
) {
  return (
    resolveRepoRelativeOutputDir(repoRoot, outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `${kind}-${createQaArtifactRunId()}`)
  );
}

export function writeQaCommandVerdict(label: string, pass: boolean) {
  process.stdout.write(`${label} verdict: ${pass ? "pass" : "fail"}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}
