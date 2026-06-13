import fs from "node:fs/promises";
import path from "node:path";
import {
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

export type QaVitestScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaSeedScenarioWithSource["execution"], { kind: "vitest" }>;
};

export type QaVitestScenarioRunParams = {
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
};

export function isQaVitestScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaVitestScenario {
  return scenario.execution.kind === "vitest";
}

function buildVitestSteps(scenario: QaVitestScenario): QaScenarioCommandStep[] {
  return [
    {
      command: process.execPath,
      args: ["scripts/run-vitest.mjs", scenario.execution.path, "--reporter=verbose"],
    },
  ];
}

async function runQaVitestScenario(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaVitestScenario;
}) {
  return await runScenarioCommandSteps({
    ...params,
    steps: buildVitestSteps(params.scenario),
  });
}

function buildVitestScenarioEvidence(params: {
  artifactPaths: { kind: string; path: string }[];
  generatedAt: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  results: readonly QaScenarioCommandResultEntry<QaVitestScenario>[];
  env?: NodeJS.ProcessEnv;
}) {
  const evidence = buildVitestEvidenceSummary({
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

export async function runQaVitestScenarios(
  params: QaVitestScenarioRunParams,
): Promise<QaScenarioRunArtifacts<QaVitestScenario>> {
  const scenarios = params.scenarios.filter(isQaVitestScenario);
  if (scenarios.length === 0) {
    throw new Error("qa suite found no Vitest scenarios to run.");
  }
  await fs.mkdir(params.outputDir, { recursive: true });
  const runCommand = params.runCommand ?? runQaScenarioCommand;
  const env = {
    ...process.env,
    ...params.env,
  };
  const results: QaScenarioCommandResultEntry<QaVitestScenario>[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runQaVitestScenario({
        env,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenario,
      }),
    );
  }
  const generatedAt = new Date().toISOString();
  const reportPath = path.join(params.outputDir, "qa-vitest-report.md");
  const artifactPaths = buildScenarioArtifactPaths({
    reportPath,
    repoRoot: params.repoRoot,
    results,
  });
  const evidence = buildVitestScenarioEvidence({
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
    reportFilename: "qa-vitest-report.md",
    reportTitle: "QA Vitest Scenario Report",
    repoRoot: params.repoRoot,
    results,
  });
  return {
    ...paths,
    outputDir: params.outputDir,
    results,
  };
}
