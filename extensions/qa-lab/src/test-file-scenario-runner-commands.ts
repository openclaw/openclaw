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

type QaTestFileRunnerDefinition = {
  buildEvidenceSummary: typeof buildVitestEvidenceSummary;
  buildSteps(scenario: QaTestFileScenario, context: { outputDir: string }): QaScenarioCommandStep[];
};

function vitestReporterArgs(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): string[] {
  return [
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile.json=${resolveNativeVitestReportPath(scenario, context.outputDir)}`,
  ];
}

function vitestSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const e2eConfigArgs = scenario.execution.path.endsWith(".e2e.test.ts")
    ? ["run", "--config", "test/vitest/vitest.e2e.config.ts"]
    : [];
  return [
    {
      command: process.execPath,
      args: [
        "scripts/run-vitest.mjs",
        ...e2eConfigArgs,
        scenario.execution.path,
        ...vitestReporterArgs(scenario, context),
      ],
    },
  ];
}

function playwrightSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const testNamePattern =
    scenario.execution.kind === "playwright" ? scenario.execution.testNamePattern : undefined;
  const testNameArgs = testNamePattern ? ["--testNamePattern", testNamePattern] : [];
  return [
    {
      command: process.execPath,
      args: ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"],
    },
    {
      command: process.execPath,
      args: [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        scenario.execution.path,
        ...vitestReporterArgs(scenario, context),
        ...testNameArgs,
      ],
    },
  ];
}

function replaceScriptArgTokens(
  args: readonly string[] | undefined,
  context: { outputDir: string; scenarioId: string },
) {
  return (args ?? []).map((arg) =>
    arg
      .replaceAll("${outputDir}", context.outputDir)
      .replaceAll("${scenarioId}", context.scenarioId),
  );
}

function scriptSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const scenarioOutputDir = path.join(context.outputDir, scenario.id);
  const scriptArgs =
    scenario.execution.kind === "script"
      ? replaceScriptArgTokens(scenario.execution.args, {
          outputDir: scenarioOutputDir,
          scenarioId: scenario.id,
        })
      : [];
  return [
    {
      command: resolveQaScriptRuntimeExecutable(),
      args: ["--import", "tsx", scenario.execution.path, ...scriptArgs],
    },
  ];
}

export function resolveQaScriptRuntimeExecutable(): string {
  // Removal: run source QA producers directly on Bun after oven-sh/bun#35690 lets
  // tsx's module hooks resolve OpenClaw's private local plugin-SDK aliases.
  return process.versions.bun ? "node" : process.execPath;
}

const testFileRunnerDefinitions: Record<QaTestFileExecutionKind, QaTestFileRunnerDefinition> = {
  script: {
    buildEvidenceSummary: buildScriptEvidenceSummary,
    buildSteps: scriptSteps,
  },
  vitest: {
    buildEvidenceSummary: buildVitestEvidenceSummary,
    buildSteps: vitestSteps,
  },
  playwright: {
    buildEvidenceSummary: buildPlaywrightEvidenceSummary,
    buildSteps: playwrightSteps,
  },
};

export { testFileRunnerDefinitions };
