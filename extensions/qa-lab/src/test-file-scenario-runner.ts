import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { toRepoRelativePath } from "./cli-paths.js";
import { QaSuiteArtifactError } from "./errors.js";
import {
  buildPlaywrightEvidenceSummary,
  buildVitestEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  type QaEvidenceStatus,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaProviderMode } from "./providers/index.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { shellQuote } from "./shell-quote.js";

export type QaTestFileScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaSeedScenarioWithSource["execution"], { kind: "vitest" | "playwright" }>;
};

export type QaTestFileExecutionKind = "vitest" | "playwright";

export type QaTestFileScenarioRunParams = {
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
};

export type QaScenarioCommandExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type QaScenarioCommandResult = {
  exitCode: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type QaScenarioCommandRunner = (
  command: QaScenarioCommandExecution,
) => Promise<QaScenarioCommandResult>;

type QaScenarioCommandStep = {
  args: string[];
  command: string;
};

type QaTestFileScenarioResult = {
  durationMs: number;
  failureMessage?: string;
  logPath: string;
  scenario: QaTestFileScenario;
  status: QaEvidenceStatus;
};

export type QaTestFileScenarioRunResult = {
  evidencePath: string;
  executionKind: QaTestFileExecutionKind;
  outputDir: string;
  reportPath: string;
  results: QaTestFileScenarioResult[];
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

function formatCommand(step: QaScenarioCommandStep) {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

function runQaScenarioCommand(
  execution: QaScenarioCommandExecution,
): Promise<QaScenarioCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      env: execution.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? (signal ? 1 : 0),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function buildScenarioEvidenceTarget(scenario: QaTestFileScenario) {
  const surfaces =
    scenario.surfaces && scenario.surfaces.length > 0 ? scenario.surfaces : [scenario.surface];
  return {
    id: scenario.id,
    title: scenario.title,
    sourcePath: scenario.execution.path,
    primaryCoverageIds: scenario.coverage?.primary ?? [],
    secondaryCoverageIds: scenario.coverage?.secondary ?? [],
    surfaceIds: surfaces,
    categoryIds: uniqueStrings([scenario.category].filter(Boolean) as string[]),
    docsRefs: scenario.docsRefs,
    codeRefs: scenario.codeRefs,
  };
}

async function runScenarioCommandSteps(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
  steps: readonly QaScenarioCommandStep[];
}): Promise<QaTestFileScenarioResult> {
  const startedAt = Date.now();
  const logPath = path.join(params.outputDir, `${params.scenario.id}.log`);
  const logChunks: string[] = [];
  let failureMessage: string | undefined;
  for (const step of params.steps) {
    logChunks.push(`$ ${formatCommand(step)}\n`);
    try {
      const result = await params.runCommand({
        command: step.command,
        args: step.args,
        cwd: params.repoRoot,
        env: params.env,
      });
      if (result.stdout) {
        logChunks.push(result.stdout);
      }
      if (result.stderr) {
        logChunks.push(result.stderr);
      }
      if (result.exitCode !== 0 || result.signal) {
        failureMessage = result.signal
          ? `${path.basename(step.command)} terminated by ${result.signal}`
          : `${path.basename(step.command)} exited with ${result.exitCode}`;
        break;
      }
    } catch (error) {
      failureMessage = formatErrorMessage(error);
      logChunks.push(`${failureMessage}\n`);
      break;
    }
    logChunks.push("\n");
  }
  await fs.writeFile(logPath, logChunks.join(""), "utf8");
  const durationMs = Math.max(1, Date.now() - startedAt);
  return {
    scenario: params.scenario,
    status: failureMessage ? "fail" : "pass",
    durationMs,
    logPath,
    ...(failureMessage ? { failureMessage } : {}),
  };
}

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
  results: readonly QaTestFileScenarioResult[];
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

function buildScenarioArtifactPaths(params: {
  reportPath: string;
  repoRoot: string;
  results: readonly QaTestFileScenarioResult[];
}) {
  return [
    { kind: "report", path: toRepoRelativePath(params.repoRoot, params.reportPath) },
    ...params.results.map((result) => ({
      kind: "log",
      path: toRepoRelativePath(params.repoRoot, result.logPath),
    })),
  ];
}

function renderTestFileScenarioReport(params: {
  evidencePath: string;
  generatedAt: string;
  repoRoot: string;
  results: readonly QaTestFileScenarioResult[];
  title: string;
}) {
  const lines = [
    `# ${params.title}`,
    "",
    `Generated at: ${params.generatedAt}`,
    `Evidence summary: ${toRepoRelativePath(params.repoRoot, params.evidencePath)}`,
    "",
    "## Results",
    "",
  ];
  for (const result of params.results) {
    const logPath = toRepoRelativePath(params.repoRoot, result.logPath);
    lines.push(
      `- ${result.scenario.id}: ${result.status}`,
      `  - kind: ${result.scenario.execution.kind}`,
      `  - path: ${result.scenario.execution.path}`,
      `  - durationMs: ${Math.round(result.durationMs)}`,
      `  - log: ${logPath}`,
    );
    if (result.failureMessage) {
      lines.push(`  - failure: ${result.failureMessage.split("\n")[0]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeTestFileEvidenceFiles(params: {
  evidence: unknown;
  generatedAt: string;
  outputDir: string;
  reportFilename: string;
  reportTitle: string;
  repoRoot: string;
  results: readonly QaTestFileScenarioResult[];
}): Promise<Pick<QaTestFileScenarioRunResult, "evidencePath" | "reportPath">> {
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const reportPath = path.join(params.outputDir, params.reportFilename);
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, "utf8");
  const report = renderTestFileScenarioReport({
    evidencePath,
    generatedAt: params.generatedAt,
    repoRoot: params.repoRoot,
    results: params.results,
    title: params.reportTitle,
  });
  await fs.writeFile(reportPath, report, "utf8");
  await assertQaTestFileArtifactWritten("evidence", evidencePath);
  await assertQaTestFileArtifactWritten("report", reportPath);
  return { evidencePath, reportPath };
}

async function assertQaTestFileArtifactWritten(kind: "evidence" | "report", filePath: string) {
  try {
    await fs.access(filePath);
  } catch (error) {
    throw new QaSuiteArtifactError(
      `${kind}_missing`,
      `QA suite did not produce ${kind} artifact at ${filePath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function runQaTestFileScenarios(
  params: QaTestFileScenarioRunParams,
): Promise<QaTestFileScenarioRunResult> {
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
  const results: QaTestFileScenarioResult[] = [];
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
  const paths = await writeTestFileEvidenceFiles({
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
    executionKind: kind,
    outputDir: params.outputDir,
    results,
  };
}
