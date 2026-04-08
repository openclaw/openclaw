import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readQaBootstrapScenarioCatalog } from "../../../extensions/qa-lab/api.js";
import {
  kovaRunArtifactSchema,
  type KovaRunArtifact,
  type KovaScenarioResult,
} from "../contracts/run-artifact.js";
import {
  ensureDir,
  readJsonFile,
  resolveKovaRunDir,
  writeJsonFile,
  writeTextFile,
} from "../lib/fs.js";
import { resolveGitCommit, resolveGitDirty } from "../lib/git.js";
import { updateKovaRunIndex } from "../lib/run-index.js";
import type { KovaBackend, KovaBackendRunSelection } from "./types.js";

type KovaMultipassPlan = {
  version: 2;
  runId: string;
  vmName: string;
  image: string;
  hostRepoPath: string;
  hostGuestScriptPath: string;
  guestMountedRepoPath: string;
  guestRepoPath: string;
  guestArtifactsPath: string;
  guestScriptPath: string;
  providerMode: "mock-openai" | "live-frontier";
  scenarioIds: string[];
  hostCommands: string[];
  qaCommand: string[];
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

const qaSummaryScenarioStepSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["pass", "fail"]),
  details: z.string().trim().min(1).optional(),
});

const qaSummaryScenarioSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["pass", "fail"]),
  details: z.string().trim().min(1).optional(),
  steps: z.array(qaSummaryScenarioStepSchema),
});

const qaSummarySchema = z.object({
  scenarios: z.array(qaSummaryScenarioSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

const MULTIPASS_MOUNTED_REPO_PATH = "/workspace/openclaw-host";
const MULTIPASS_IMAGE = "lts";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildVmName(runId: string) {
  const suffix = runId
    .replace(/^kova_/, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
  return `kova-${suffix}`.slice(0, 48);
}

function execFileAsync(file: string, args: string[]) {
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(message));
        return;
      }
      resolve({
        stdout,
        stderr,
      });
    });
  });
}

async function resolveMultipassAvailability() {
  try {
    const result = await execFileAsync("multipass", ["version"]);
    return {
      available: true as const,
      binaryPath: "multipass",
      version: result.stdout.trim() || result.stderr.trim(),
    };
  } catch {
    return {
      available: false as const,
      binaryPath: null,
      version: null,
    };
  }
}

function buildQaCommand(selection: KovaBackendRunSelection, guestArtifactsPath: string) {
  const command = [
    "pnpm",
    "openclaw",
    "qa",
    "suite",
    "--output-dir",
    guestArtifactsPath,
    "--provider-mode",
    selection.providerMode ?? "mock-openai",
  ];
  for (const scenarioId of selection.scenarioIds ?? []) {
    command.push("--scenario", scenarioId);
  }
  return command;
}

function buildGuestRepoPath(vmName: string) {
  return `/home/ubuntu/${vmName}/repo`;
}

function renderGuestRunScript(plan: KovaMultipassPlan) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'command -v node >/dev/null || { echo "missing node in guest" >&2; exit 1; }',
    'command -v pnpm >/dev/null || { echo "missing pnpm in guest" >&2; exit 1; }',
    'command -v rsync >/dev/null || { echo "missing rsync in guest" >&2; exit 1; }',
    "",
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestRepoPath))}`,
    `rm -rf ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestArtifactsPath))}`,
    [
      "rsync -a --delete",
      "--exclude",
      shellQuote(".git"),
      "--exclude",
      shellQuote("node_modules"),
      "--exclude",
      shellQuote(".artifacts"),
      shellQuote(`${plan.guestMountedRepoPath}/`),
      shellQuote(`${plan.guestRepoPath}/`),
    ].join(" "),
    `cd ${shellQuote(plan.guestRepoPath)}`,
    "pnpm install --frozen-lockfile",
    plan.qaCommand.map(shellQuote).join(" "),
    "",
  ];
  return lines.join("\n");
}

function buildMultipassPlan(
  selection: KovaBackendRunSelection,
  hostGuestScriptPath: string,
): KovaMultipassPlan {
  const vmName = buildVmName(selection.runId);
  const guestRepoPath = buildGuestRepoPath(vmName);
  const guestArtifactsPath = `${MULTIPASS_MOUNTED_REPO_PATH}/.artifacts/kova/runs/${selection.runId}/qa`;
  const guestScriptPath = `/tmp/${vmName}-qa-suite.sh`;
  const qaCommand = buildQaCommand(selection, guestArtifactsPath);
  return {
    version: 2,
    runId: selection.runId,
    vmName,
    image: MULTIPASS_IMAGE,
    hostRepoPath: selection.repoRoot,
    hostGuestScriptPath,
    guestMountedRepoPath: MULTIPASS_MOUNTED_REPO_PATH,
    guestRepoPath,
    guestArtifactsPath,
    guestScriptPath,
    providerMode: selection.providerMode ?? "mock-openai",
    scenarioIds: selection.scenarioIds ?? [],
    hostCommands: [
      `multipass launch --name ${shellQuote(vmName)} ${shellQuote(MULTIPASS_IMAGE)}`,
      `multipass mount ${shellQuote(selection.repoRoot)} ${shellQuote(`${vmName}:${MULTIPASS_MOUNTED_REPO_PATH}`)}`,
      `multipass transfer ${shellQuote(hostGuestScriptPath)} ${shellQuote(`${vmName}:${guestScriptPath}`)}`,
      `multipass exec ${shellQuote(vmName)} -- chmod +x ${shellQuote(guestScriptPath)}`,
      `multipass exec ${shellQuote(vmName)} -- ${shellQuote(guestScriptPath)}`,
      `multipass delete --purge ${shellQuote(vmName)}`,
    ],
    qaCommand,
  };
}

async function appendLog(logPath: string, message: string) {
  await appendFile(logPath, message, "utf8");
}

async function runMultipassCommand(params: {
  binaryPath: string;
  logPath: string;
  args: string[];
}) {
  await appendLog(params.logPath, `$ ${[params.binaryPath, ...params.args].join(" ")}\n`);
  const result = await execFileAsync(params.binaryPath, params.args);
  if (result.stdout.trim()) {
    await appendLog(params.logPath, `${result.stdout.trim()}\n`);
  }
  if (result.stderr.trim()) {
    await appendLog(params.logPath, `${result.stderr.trim()}\n`);
  }
  await appendLog(params.logPath, "\n");
  return result;
}

function deriveQaVerdict(failedCount: number) {
  return failedCount > 0 ? "fail" : "pass";
}

function deriveQaClassification(failedCount: number) {
  return failedCount > 0
    ? {
        domain: "product" as const,
        reason: "one or more QA scenarios failed",
      }
    : {
        domain: "product" as const,
        reason: "all QA scenarios passed under current selection",
      };
}

function buildQaScenarioResultsFromSummary(params: {
  selectedScenarioIds?: string[];
  summary: z.infer<typeof qaSummarySchema>;
}) {
  const catalog = readQaBootstrapScenarioCatalog();
  const selectedScenarios =
    params.selectedScenarioIds && params.selectedScenarioIds.length > 0
      ? catalog.scenarios.filter((scenario) => params.selectedScenarioIds?.includes(scenario.id))
      : catalog.scenarios;

  return params.summary.scenarios.map((scenario, index) => {
    const catalogScenario = selectedScenarios[index];
    const passedSteps = scenario.steps.filter((step) => step.status === "pass").length;
    const failedSteps = scenario.steps.filter((step) => step.status === "fail").length;
    return {
      id: catalogScenario?.id ?? scenario.name,
      title: catalogScenario?.title ?? scenario.name,
      verdict: scenario.status,
      surface: catalogScenario?.surface,
      sourcePath: catalogScenario?.sourcePath,
      details: scenario.details,
      stepCounts: {
        total: scenario.steps.length,
        passed: passedSteps,
        failed: failedSteps,
      },
    } satisfies KovaScenarioResult;
  });
}

async function readQaSummary(runDir: string) {
  const summaryPath = path.join(runDir, "qa", "qa-suite-summary.json");
  const summary = qaSummarySchema.parse(await readJsonFile(summaryPath));
  return {
    summaryPath,
    summary,
  };
}

function createMultipassBaseArtifact(params: {
  selection: KovaBackendRunSelection;
  providerMode: "mock-openai" | "live-frontier";
  gitCommit?: string;
  gitDirty: boolean;
}): Pick<
  KovaRunArtifact,
  "schemaVersion" | "runId" | "selection" | "scenario" | "backend" | "environment"
> {
  return {
    schemaVersion: 1,
    runId: params.selection.runId,
    selection: {
      command: "run",
      target: params.selection.target,
      scenarioIds:
        params.selection.scenarioIds && params.selection.scenarioIds.length > 0
          ? params.selection.scenarioIds
          : undefined,
    },
    scenario: {
      id: params.selection.target,
      title: "QA suite",
      category: "behavior",
      capabilities: ["behavior", "qa"],
    },
    backend: {
      kind: "multipass",
      mode: params.providerMode,
    },
    environment: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      gitCommit: params.gitCommit,
      gitDirty: params.gitDirty,
    },
  };
}

export const multipassBackend: KovaBackend = {
  id: "multipass",
  title: "Multipass VM",
  supportsTarget(target): target is "qa" {
    return target === "qa";
  },
  async run(selection) {
    const startedAt = new Date();
    const runDir = resolveKovaRunDir(selection.repoRoot, selection.runId);
    await ensureDir(runDir);

    const hostLogPath = path.join(runDir, "multipass-host.log");
    const hostGuestScriptPath = path.join(runDir, "multipass-guest-run.sh");
    const plan = buildMultipassPlan(selection, hostGuestScriptPath);
    const planPath = path.join(runDir, "multipass-plan.json");
    await writeTextFile(hostGuestScriptPath, renderGuestRunScript(plan));
    await writeJsonFile(planPath, plan);
    await writeTextFile(hostLogPath, `# Kova Multipass host log\nrunId=${selection.runId}\n\n`);

    const providerMode = selection.providerMode ?? "mock-openai";
    const [gitCommit, gitDirty] = await Promise.all([
      resolveGitCommit(selection.repoRoot),
      resolveGitDirty(selection.repoRoot),
    ]);
    const baseArtifact = createMultipassBaseArtifact({
      selection,
      providerMode,
      gitCommit,
      gitDirty,
    });
    const evidencePaths = [
      runDir,
      planPath,
      hostGuestScriptPath,
      hostLogPath,
      path.join(runDir, "run.json"),
    ];

    const availability = await resolveMultipassAvailability();
    if (!availability.available || !availability.binaryPath) {
      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "infra_failed",
        verdict: "blocked",
        classification: {
          domain: "backend",
          reason: `multipass CLI not found on host; generated plan artifacts in ${runDir}`,
        },
        timing: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
        },
        scenarioResults: [],
        evidence: {
          sourceArtifactPaths: evidencePaths,
        },
        notes: [
          "backend=multipass",
          "state=missing-cli",
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          "availability=missing",
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    }

    let launched = false;
    try {
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["launch", "--name", plan.vmName, plan.image],
      });
      launched = true;
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["mount", selection.repoRoot, `${plan.vmName}:${plan.guestMountedRepoPath}`],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["transfer", hostGuestScriptPath, `${plan.vmName}:${plan.guestScriptPath}`],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["exec", plan.vmName, "--", "chmod", "+x", plan.guestScriptPath],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["exec", plan.vmName, "--", plan.guestScriptPath],
      });

      const reportPath = path.join(runDir, "qa", "qa-suite-report.md");
      const { summaryPath, summary } = await readQaSummary(runDir);
      const reportExists = await readFile(reportPath, "utf8")
        .then(() => true)
        .catch(() => false);
      if (!reportExists) {
        throw new Error(`expected QA report at ${reportPath} after Multipass run`);
      }

      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "completed",
        verdict: deriveQaVerdict(summary.counts.failed),
        classification: deriveQaClassification(summary.counts.failed),
        timing: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        counts: summary.counts,
        scenarioResults: buildQaScenarioResultsFromSummary({
          selectedScenarioIds: selection.scenarioIds,
          summary,
        }),
        evidence: {
          reportPath,
          summaryPath,
          sourceArtifactPaths: [...evidencePaths, path.join(runDir, "qa"), reportPath, summaryPath],
        },
        notes: [
          "backend=multipass",
          "state=executed",
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          `availability=${availability.binaryPath}`,
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    } catch (error) {
      await appendLog(
        hostLogPath,
        `ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "infra_failed",
        verdict: "blocked",
        classification: {
          domain: "backend",
          reason: error instanceof Error ? error.message : String(error),
        },
        timing: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
        },
        scenarioResults: [],
        evidence: {
          sourceArtifactPaths: evidencePaths,
        },
        notes: [
          "backend=multipass",
          `state=${launched ? "exec-failed" : "launch-failed"}`,
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          `availability=${availability.binaryPath}`,
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    } finally {
      if (launched) {
        await runMultipassCommand({
          binaryPath: availability.binaryPath,
          logPath: hostLogPath,
          args: ["delete", "--purge", plan.vmName],
        }).catch(async (error) => {
          await appendLog(
            hostLogPath,
            `CLEANUP ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      }
    }
  },
};
