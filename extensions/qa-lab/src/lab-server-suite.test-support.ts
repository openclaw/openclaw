import { writeFile } from "node:fs/promises";
import path from "node:path";

type QaLabSuiteScenarioFixture = {
  name: string;
  status: "pass" | "fail" | "skip";
  steps: unknown[];
  details?: string;
};

export async function writeQaLabSuiteResultFixture(
  outputDir: string,
  params?: {
    scenarios?: QaLabSuiteScenarioFixture[];
    watchUrl?: string;
  },
) {
  const scenarios = params?.scenarios ?? [
    { name: "Channel chat baseline", status: "pass" as const, steps: [] },
  ];
  const report = "# QA report\n";
  const evidencePath = path.join(outputDir, "qa-evidence.json");
  const reportPath = path.join(outputDir, "qa-suite-report.md");
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  await Promise.all([
    writeFile(
      evidencePath,
      JSON.stringify({
        entries: scenarios.map((scenario) => ({ result: { status: scenario.status } })),
      }),
      "utf8",
    ),
    writeFile(reportPath, report, "utf8"),
    writeFile(
      summaryPath,
      JSON.stringify({
        run: { status: "completed" },
        counts: {
          total: scenarios.length,
          passed: scenarios.filter((scenario) => scenario.status === "pass").length,
          failed: scenarios.filter((scenario) => scenario.status === "fail").length,
          skipped: scenarios.filter((scenario) => scenario.status === "skip").length,
        },
        scenarios,
      }),
      "utf8",
    ),
  ]);
  return {
    evidencePath,
    outputDir,
    report,
    reportPath,
    scenarios,
    summaryPath,
    ...(params?.watchUrl ? { watchUrl: params.watchUrl } : {}),
  };
}
