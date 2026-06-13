import fs from "node:fs/promises";
import path from "node:path";
import {
  buildPlaywrightEvidenceSummary,
  buildVitestEvidenceSummary,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaProviderMode } from "./providers/index.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  buildScenarioArtifactPaths,
  buildScenarioEvidenceTarget,
  runQaScenarioCommand,
  runScenarioCommandSteps,
  writeScenarioEvidenceFiles,
  type QaScenarioCommandResultEntry,
  type QaScenarioCommandRunner,
  type QaScenarioCommandStep,
  type QaScenarioRunArtifacts,
} from "./scenario-command-runner.js";

export type QaTestFileScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaSeedScenarioWithSource["execution"], { kind: "vitest" | "playwright" }>;
};

type QaTestFileExecutionKind = QaTestFileScenario["execution"]["kind"];

export type QaTestFileScenarioRunParams = {
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
};

type QaTestFileRunnerDefinition = {
  buildEvidenceSummary: typeof buildVitestEvidenceSummary;
  buildSteps(scenario: QaTestFileScenario): QaScenarioCommandStep[];
  reportFilename: string;
  reportTitle: string;
};

export function isQaTestFileScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaTestFileScenario {
  return scenario.execution.kind === "vitest" || scenario.execution.kind === "playwright";
}

function vitestSteps(scenario: QaTestFileScenario): QaScenarioCommandStep[] {
  return [
    {
      command: process.execPath,
      args: ["scripts/run-vitest.mjs", scenario.execution.path, "--reporter=verbose"],
    },
  ];
}

function playwrightSteps(scenario: QaTestFileScenario): QaScenarioCommandStep[] {
  return [
    {
      command: process.execPath,
      args: ["scripts/ensure-playwright-chromium.mjs"],
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
        "--reporter=verbose",
      ],
    },
  ];
}

const testFileRunnerDefinitions: Record<QaTestFileExecutionKind, QaTestFileRunnerDefinition> = {
  vitest: {
    buildEvidenceSummary: buildVitestEvidenceSummary,
    buildSteps: vitestSteps,
    reportFilename: "qa-vitest-report.md",
    reportTitle: "QA Vitest Scenario Report",
  },
  playwright: {
    buildEvidenceSummary: buildPlaywrightEvidenceSummary,
    buildSteps: playwrightSteps,
    reportFilename: "qa-playwright-report.md",
    reportTitle: "QA Playwright Scenario Report",
  },
};

async function runQaTestFileScenario(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
}) {
  const definition = testFileRunnerDefinitions[params.scenario.execution.kind];
  return await runScenarioCommandSteps({
    ...params,
    steps: definition.buildSteps(params.scenario),
  });
}

function resolveTestFileExecutionKind(scenarios: readonly QaTestFileScenario[]) {
  const kinds = new Set(scenarios.map((scenario) => scenario.execution.kind));
  if (kinds.size > 1) {
    throw new Error("qa suite cannot mix Vitest and Playwright scenarios in one invocation.");
  }
  const [kind] = kinds;
  return kind;
}

function buildTestFileEvidence(params: {
  artifactPaths: { kind: string; path: string }[];
  generatedAt: string;
  kind: QaTestFileExecutionKind;
  primaryModel: string;
  providerMode: QaProviderMode;
  results: readonly QaScenarioCommandResultEntry<QaTestFileScenario>[];
  env?: NodeJS.ProcessEnv;
}) {
  const definition = testFileRunnerDefinitions[params.kind];
  const evidence = definition.buildEvidenceSummary({
    artifactPaths: params.artifactPaths,
    env: params.env,
    generatedAt: params.generatedAt,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    targets: params.results.map((result) => buildScenarioEvidenceTarget(result.scenario)),
    results: params.results.map((result) => ({
      id: result.scenario.id,
      status: result.status,
      durationMs: result.durationMs,
      failureMessage: result.failureMessage,
    })),
  });
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    entries: evidence.entries,
  });
}

export async function runQaTestFileScenarios(
  params: QaTestFileScenarioRunParams,
): Promise<QaScenarioRunArtifacts<QaTestFileScenario>> {
  const scenarios = params.scenarios.filter(isQaTestFileScenario);
  const kind = resolveTestFileExecutionKind(scenarios);
  if (!kind) {
    throw new Error("qa suite found no Vitest or Playwright scenarios to run.");
  }
  const definition = testFileRunnerDefinitions[kind];
  await fs.mkdir(params.outputDir, { recursive: true });
  const runCommand = params.runCommand ?? runQaScenarioCommand;
  const env = {
    ...process.env,
    ...params.env,
  };
  const results: QaScenarioCommandResultEntry<QaTestFileScenario>[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runQaTestFileScenario({
        env,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenario,
      }),
    );
  }
  const generatedAt = new Date().toISOString();
  const reportPath = path.join(params.outputDir, definition.reportFilename);
  const artifactPaths = buildScenarioArtifactPaths({
    reportPath,
    repoRoot: params.repoRoot,
    results,
  });
  const evidence = buildTestFileEvidence({
    artifactPaths,
    env,
    generatedAt,
    kind,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    results,
  });
  const paths = await writeScenarioEvidenceFiles({
    evidence,
    generatedAt,
    outputDir: params.outputDir,
    reportFilename: definition.reportFilename,
    reportTitle: definition.reportTitle,
    repoRoot: params.repoRoot,
    results,
  });
  return {
    ...paths,
    outputDir: params.outputDir,
    results,
  };
}
