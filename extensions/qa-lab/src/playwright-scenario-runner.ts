import fs from "node:fs/promises";
import path from "node:path";
import {
  buildPlaywrightEvidenceSummary,
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

export type QaPlaywrightScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaSeedScenarioWithSource["execution"], { kind: "playwright" }>;
};

export type QaPlaywrightScenarioRunParams = {
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
};

export function isQaPlaywrightScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaPlaywrightScenario {
  return scenario.execution.kind === "playwright";
}

function buildPlaywrightSteps(scenario: QaPlaywrightScenario): QaScenarioCommandStep[] {
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

async function runQaPlaywrightScenario(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaPlaywrightScenario;
}) {
  return await runScenarioCommandSteps({
    ...params,
    steps: buildPlaywrightSteps(params.scenario),
  });
}

function buildPlaywrightScenarioEvidence(params: {
  artifactPaths: { kind: string; path: string }[];
  generatedAt: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  results: readonly QaScenarioCommandResultEntry<QaPlaywrightScenario>[];
  env?: NodeJS.ProcessEnv;
}) {
  const evidence = buildPlaywrightEvidenceSummary({
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

export async function runQaPlaywrightScenarios(
  params: QaPlaywrightScenarioRunParams,
): Promise<QaScenarioRunArtifacts<QaPlaywrightScenario>> {
  const scenarios = params.scenarios.filter(isQaPlaywrightScenario);
  if (scenarios.length === 0) {
    throw new Error("qa suite found no Playwright scenarios to run.");
  }
  await fs.mkdir(params.outputDir, { recursive: true });
  const runCommand = params.runCommand ?? runQaScenarioCommand;
  const env = {
    ...process.env,
    ...params.env,
  };
  const results: QaScenarioCommandResultEntry<QaPlaywrightScenario>[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runQaPlaywrightScenario({
        env,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenario,
      }),
    );
  }
  const generatedAt = new Date().toISOString();
  const reportPath = path.join(params.outputDir, "qa-playwright-report.md");
  const artifactPaths = buildScenarioArtifactPaths({
    reportPath,
    repoRoot: params.repoRoot,
    results,
  });
  const evidence = buildPlaywrightScenarioEvidence({
    artifactPaths,
    env,
    generatedAt,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    results,
  });
  const paths = await writeScenarioEvidenceFiles({
    evidence,
    generatedAt,
    outputDir: params.outputDir,
    reportFilename: "qa-playwright-report.md",
    reportTitle: "QA Playwright Scenario Report",
    repoRoot: params.repoRoot,
    results,
  });
  return {
    ...paths,
    outputDir: params.outputDir,
    results,
  };
}
