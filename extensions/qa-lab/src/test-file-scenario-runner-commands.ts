import path from "node:path";
import {
  buildPlaywrightEvidenceSummary,
  buildScriptEvidenceSummary,
  buildVitestEvidenceSummary,
} from "./evidence-summary.js";
import type { QaTestFileExecutionKind, QaTestFileScenario } from "./scenario-catalog.js";
import { resolveNativeVitestReportPath } from "./test-file-scenario-vitest-report.js";

export type QaScenarioCommandStep = {
  args: string[];
  command: string;
};

export function buildQaScenarioCommandSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const execution = scenario.execution;
  if (execution.kind === "script") {
    const scenarioOutputDir = path.join(context.outputDir, scenario.id);
    const args = (execution.args ?? []).map((arg) =>
      arg.replaceAll("${outputDir}", scenarioOutputDir).replaceAll("${scenarioId}", scenario.id),
    );
    return [
      {
        command: resolveQaScriptRuntimeExecutable(),
        args: ["--import", "tsx", execution.path, ...args],
      },
    ];
  }

  const configArgs =
    execution.kind === "playwright"
      ? ["run", "--config", "test/vitest/vitest.ui-e2e.config.ts", "--configLoader", "runner"]
      : execution.path.endsWith(".e2e.test.ts")
        ? ["run", "--config", "test/vitest/vitest.e2e.config.ts"]
        : [];
  const steps: QaScenarioCommandStep[] = [];
  if (execution.kind === "playwright") {
    steps.push({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"],
    });
  }
  steps.push({
    command: process.execPath,
    args: [
      "scripts/run-vitest.mjs",
      ...configArgs,
      execution.path,
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile.json=${resolveNativeVitestReportPath(scenario, context.outputDir)}`,
      ...(execution.kind === "playwright" && execution.testNamePattern
        ? ["--testNamePattern", execution.testNamePattern]
        : []),
    ],
  });
  return steps;
}

export function resolveQaScriptRuntimeExecutable(): string {
  // Removal: run source QA producers directly on Bun after oven-sh/bun#35690 lets
  // tsx's module hooks resolve OpenClaw's private local plugin-SDK aliases.
  return process.versions.bun ? "node" : process.execPath;
}

export const testFileEvidenceBuilders: Record<
  QaTestFileExecutionKind,
  typeof buildVitestEvidenceSummary
> = {
  script: buildScriptEvidenceSummary,
  vitest: buildVitestEvidenceSummary,
  playwright: buildPlaywrightEvidenceSummary,
};
