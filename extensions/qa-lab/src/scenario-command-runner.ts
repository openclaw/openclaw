// Shared command/report mechanics for qa scenario execution kinds.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_EVIDENCE_FILENAME, type QaEvidenceStatus } from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export type QaScenarioCommandExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type QaScenarioCommandResult = {
  exitCode: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type QaScenarioCommandRunner = (
  command: QaScenarioCommandExecution,
) => Promise<QaScenarioCommandResult>;

export type QaScenarioCommandStep = {
  args: string[];
  command: string;
};

export type QaRunnableScenario = QaSeedScenarioWithSource & {
  execution: QaSeedScenarioWithSource["execution"] & {
    path: string;
  };
};

export type QaScenarioCommandResultEntry<TScenario extends QaRunnableScenario> = {
  durationMs: number;
  failureMessage?: string;
  logPath: string;
  scenario: TScenario;
  status: QaEvidenceStatus;
};

export type QaScenarioRunArtifacts<TScenario extends QaRunnableScenario> = {
  evidencePath: string;
  outputDir: string;
  reportPath: string;
  results: QaScenarioCommandResultEntry<TScenario>[];
};

export function toRepoRelativePath(repoRoot: string, absolutePath: string) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(step: QaScenarioCommandStep) {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

export function runQaScenarioCommand(
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

export function buildScenarioEvidenceTarget(scenario: QaRunnableScenario) {
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

export async function runScenarioCommandSteps<TScenario extends QaRunnableScenario>(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: TScenario;
  steps: readonly QaScenarioCommandStep[];
}): Promise<QaScenarioCommandResultEntry<TScenario>> {
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

export function buildScenarioArtifactPaths<TScenario extends QaRunnableScenario>(params: {
  reportPath: string;
  repoRoot: string;
  results: readonly QaScenarioCommandResultEntry<TScenario>[];
}) {
  return [
    { kind: "report", path: toRepoRelativePath(params.repoRoot, params.reportPath) },
    ...params.results.map((result) => ({
      kind: "log",
      path: toRepoRelativePath(params.repoRoot, result.logPath),
    })),
  ];
}

export function renderScenarioCommandReport<TScenario extends QaRunnableScenario>(params: {
  evidencePath: string;
  generatedAt: string;
  repoRoot: string;
  results: readonly QaScenarioCommandResultEntry<TScenario>[];
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

export async function writeScenarioEvidenceFiles<TScenario extends QaRunnableScenario>(params: {
  evidence: unknown;
  generatedAt: string;
  outputDir: string;
  reportFilename: string;
  reportTitle: string;
  repoRoot: string;
  results: readonly QaScenarioCommandResultEntry<TScenario>[];
}): Promise<Pick<QaScenarioRunArtifacts<TScenario>, "evidencePath" | "reportPath">> {
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const reportPath = path.join(params.outputDir, params.reportFilename);
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, "utf8");
  const report = renderScenarioCommandReport({
    evidencePath,
    generatedAt: params.generatedAt,
    repoRoot: params.repoRoot,
    results: params.results,
    title: params.reportTitle,
  });
  await fs.writeFile(reportPath, report, "utf8");
  return { evidencePath, reportPath };
}
