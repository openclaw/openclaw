#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const STATE_DIR_REL = "reports/hermes-agent/state";
const MODEL_REQUEST =
  "Check Hermes and OpenClaw dialogue status, plan automatic dialogue to automatic execution to final report. Return JSON. risk_notes must be array with exactly these four strings: registry writes disabled, SQLite writes disabled, worker execution disabled, live actions disabled.";
const MAX_DECIDE_ATTEMPTS = 3;
const BUILD_RETRY_ATTEMPTS = 3;
const BUILD_RETRY_DELAY_MS = 2500;
const ENABLE_OPTIONAL_LOOPS = process.env.OPENCLAW_ONECLICK_ENABLE_OPTIONAL_LOOPS === "1";
const OPENCLAW_ENTRY = "openclaw.mjs";

const TASKFLOW_DIALOGUER_COVERAGE_REL =
  "reports/hermes-agent/state/hermes-flow-20260506T175813-taskflow-registry-task-dialoguer-status-summary-coverage-report.json";
const TASKFLOW_MEMORY_LOOP_REL =
  "reports/hermes-agent/state/hermes-flow-20260506T175813-taskflow-registry-controlled-executor-activation-memory-layer-sandwich-loop-report.json";

const PIPELINE = [
  {
    cmd: "plan-model-backed-dialogue-decision-handoff",
    inputSuffix: "-model-backed-dialogue-decision-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-handoff-intake-coverage",
    inputSuffix: "-model-backed-dialogue-decision-handoff-plan.json",
  },
  {
    cmd: "report-model-backed-dialogue-intake-release-summary",
    inputSuffix: "-model-backed-dialogue-handoff-intake-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-intake-release-summary-coverage",
    inputSuffix: "-model-backed-dialogue-intake-release-summary-report.json",
  },
  {
    cmd: "preflight-model-backed-dialogue-controlled-executor-intake-activation",
    inputSuffix: "-model-backed-dialogue-intake-release-summary-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-preflight-coverage",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-preflight-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-final-readiness-summary",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-preflight-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-final-readiness-summary-coverage",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-final-readiness-summary-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-proposal",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-final-readiness-summary-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-proposal-coverage",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-proposal-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-final-readiness-summary",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-proposal-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-final-readiness-summary-coverage",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-final-readiness-summary-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-next-safe-task-decision",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-final-readiness-summary-coverage-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-next-safe-task-decision-coverage",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-next-safe-task-decision-report.json",
  },
  {
    cmd: "report-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-activation-readiness-delta",
    inputSuffix:
      "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-next-safe-task-decision-coverage-report.json",
  },
];

function toPosixPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function toRepoRelativePath(repoRoot, absolutePath) {
  return toPosixPath(path.relative(repoRoot, absolutePath));
}

function extractTraceId(decisionFileName) {
  return decisionFileName.replace(/-model-backed-dialogue-decision\.json$/, "");
}

function basenameForTrace(traceId, suffix) {
  return `${traceId}${suffix}`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

async function listDecisionFiles(stateDir) {
  const entries = await fs.readdir(stateDir);
  return entries.filter((name) =>
    /^hermes-[0-9]{14}-[a-f0-9]+-model-backed-dialogue-decision\.json$/.test(name),
  );
}

async function findNewestFile(stateDir, files) {
  const withStats = await Promise.all(
    files.map(async (name) => {
      const absolute = path.join(stateDir, name);
      const stat = await fs.stat(absolute);
      return { absolute, name, mtimeMs: stat.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0] ?? null;
}

async function runPnpm(args, { allowFailure = false } = {}) {
  console.log(`[oneclick] pnpm ${args.join(" ")}`);
  const child = spawn("pnpm", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const status = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (status !== 0 && !allowFailure) {
    throw new Error(`pnpm ${args.join(" ")} failed with exit code ${String(status)}`);
  }
  return { status };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPnpmWithRetry(args, { attempts = 1, delayMs = 0 } = {}) {
  let finalStatus = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runPnpm(args, { allowFailure: true });
    finalStatus = result.status;
    if (result.status === 0) {
      return;
    }
    if (attempt < attempts) {
      console.log(
        `[oneclick] retry ${attempt}/${attempts} for pnpm ${args.join(" ")} after ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error(
    `pnpm ${args.join(" ")} failed with exit code ${String(finalStatus)} after ${String(attempts)} attempts`,
  );
}

async function runOpenClaw(args, { allowFailure = false } = {}) {
  console.log(`[oneclick] node ${OPENCLAW_ENTRY} ${args.join(" ")}`);
  const child = spawn(process.execPath, [OPENCLAW_ENTRY, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });

  const status = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (status !== 0 && !allowFailure) {
    throw new Error(
      `node ${OPENCLAW_ENTRY} ${args.join(" ")} failed with exit code ${String(status)}`,
    );
  }
  return { status };
}

async function ensureAutoTradingDaemon() {
  const checkArgs = ["capital-hft:auto-trading-watch:daemon-check"];
  const first = await runPnpm(checkArgs, { allowFailure: true });
  if (first.status === 0) {
    return "running";
  }
  await runPnpm(["capital-hft:auto-trading-watch:daemon"]);
  await runPnpm(checkArgs);
  return "started";
}

async function runHermesStep(cmd, inputRel) {
  await runOpenClaw(["hermes", cmd, inputRel, "--output-dir", STATE_DIR_REL]);
}

async function runDecisionWithCoverage(repoRoot) {
  const stateDir = path.join(repoRoot, STATE_DIR_REL);
  await fs.mkdir(stateDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_DECIDE_ATTEMPTS; attempt += 1) {
    const before = new Set(await listDecisionFiles(stateDir));
    await runOpenClaw(["hermes", "decide", "--output-dir", STATE_DIR_REL, MODEL_REQUEST]);

    const after = await listDecisionFiles(stateDir);
    const created = after.filter((name) => !before.has(name));
    const candidate =
      created.length > 0
        ? await findNewestFile(stateDir, created)
        : await findNewestFile(stateDir, after);
    if (!candidate) {
      throw new Error("No model-backed dialogue decision artifact found after decide.");
    }

    const traceId = extractTraceId(candidate.name);
    const decisionRel = toRepoRelativePath(repoRoot, candidate.absolute);
    await runHermesStep("report-model-backed-dialogue-decision-coverage", decisionRel);

    const coveragePath = path.join(
      stateDir,
      basenameForTrace(traceId, "-model-backed-dialogue-decision-coverage-report.json"),
    );
    const coverage = await readJson(coveragePath);
    if (coverage.status === "coverage_pass" && coverage.validation_status === "pass") {
      return { traceId, decisionPath: candidate.absolute, coveragePath };
    }

    console.log(
      `[oneclick] decision coverage attempt ${attempt} blocked, retrying with a new decision artifact.`,
    );
  }

  throw new Error("Unable to generate a coverage_pass model-backed dialogue decision.");
}

async function runModelBackedPipeline(repoRoot, traceId) {
  for (const step of PIPELINE) {
    const inputFileName = basenameForTrace(traceId, step.inputSuffix);
    const inputAbs = path.join(repoRoot, STATE_DIR_REL, inputFileName);
    if (!(await fileExists(inputAbs))) {
      throw new Error(`Missing pipeline input: ${inputAbs}`);
    }
    await runHermesStep(step.cmd, toRepoRelativePath(repoRoot, inputAbs));
  }
}

async function runOptionalTaskflowLoops(repoRoot) {
  const results = {
    controlledDialogue: null,
    closedLoop: null,
  };

  const dialoguerSource = path.join(repoRoot, TASKFLOW_DIALOGUER_COVERAGE_REL);
  if (await fileExists(dialoguerSource)) {
    await runOpenClaw([
      "hermes",
      "run-taskflow-registry-controlled-dialogue-executor-dry-run",
      toRepoRelativePath(repoRoot, dialoguerSource),
      "--output-dir",
      STATE_DIR_REL,
    ]);
    const reportPath = path.join(
      repoRoot,
      STATE_DIR_REL,
      "hermes-flow-20260506T175813-taskflow-registry-controlled-dialogue-executor-dry-run.json",
    );
    if (await fileExists(reportPath)) {
      const report = await readJson(reportPath);
      results.controlledDialogue = {
        status: report.status ?? "",
        validation: report.validation_status ?? "",
        dialogueStarted: report.dialogue_started ?? false,
        executionStarted: report.execution_started ?? false,
        nextSafeTask: report.next_safe_task ?? "",
      };
    }
  }

  const memoryLoopSource = path.join(repoRoot, TASKFLOW_MEMORY_LOOP_REL);
  if (await fileExists(memoryLoopSource)) {
    await runOpenClaw([
      "hermes",
      "run-taskflow-registry-controlled-executor-activation-memory-layer-sandwich-loop-dry-run",
      toRepoRelativePath(repoRoot, memoryLoopSource),
      "--output-dir",
      STATE_DIR_REL,
    ]);
    const reportPath = path.join(
      repoRoot,
      STATE_DIR_REL,
      "hermes-flow-20260506T175813-taskflow-registry-controlled-executor-activation-memory-layer-sandwich-loop-dry-run-report.json",
    );
    if (await fileExists(reportPath)) {
      const report = await readJson(reportPath);
      results.closedLoop = {
        status: report.status ?? "",
        validation: report.validation_status ?? "",
        runStarted: report.run?.started ?? false,
        runCompleted: report.run?.completed ?? false,
        executionStarted: report.execution_started ?? false,
        nextSafeTask: report.next_safe_task ?? "",
      };
    }
  }

  return results;
}

async function buildAndWriteFinalReport(repoRoot, traceId, daemonState, optionalLoops) {
  const stateDir = path.join(repoRoot, STATE_DIR_REL);

  const readStatus = async (suffix) => {
    const filePath = path.join(stateDir, basenameForTrace(traceId, suffix));
    const payload = await readJson(filePath);
    return {
      filePath,
      status: payload.status ?? "",
      validation: payload.validation_status ?? "",
      executionStartAllowed: payload.execution_start_allowed,
      operatorApproved: payload.operator_approved,
      nextSafeTask: payload.next_safe_task ?? "",
    };
  };

  const decisionCoverage = await readStatus("-model-backed-dialogue-decision-coverage-report.json");
  const handoffPlan = await readStatus("-model-backed-dialogue-decision-handoff-plan.json");
  const intakeCoverage = await readStatus(
    "-model-backed-dialogue-handoff-intake-coverage-report.json",
  );
  const intakeSummary = await readStatus(
    "-model-backed-dialogue-intake-release-summary-report.json",
  );
  const decisionReport = await readStatus(
    "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-next-safe-task-decision-report.json",
  );
  const deltaReport = await readStatus(
    "-model-backed-dialogue-controlled-executor-intake-activation-execution-manifest-activation-readiness-delta-report.json",
  );

  const finalReportPath = path.join(stateDir, `${traceId}-autonomous-oneclick-report.md`);

  const lines = [
    "# OpenClaw Hermes Autonomous One-Click Report",
    "",
    `- trace_id: ${traceId}`,
    `- generated_at: ${new Date().toISOString()}`,
    `- mode: dry_run + read_only`,
    `- daemon_state: ${daemonState}`,
    "",
    "## Model-Backed Dialogue Chain",
    "",
    `- decision_coverage: ${decisionCoverage.status} (${decisionCoverage.validation})`,
    `- handoff_plan: ${handoffPlan.status} (${handoffPlan.validation})`,
    `- intake_coverage: ${intakeCoverage.status} (${intakeCoverage.validation})`,
    `- intake_release_summary: ${intakeSummary.status} (${intakeSummary.validation})`,
    `- execution_manifest_next_safe_task_decision: ${decisionReport.status} (${decisionReport.validation})`,
    `- activation_readiness_delta: ${deltaReport.status} (${deltaReport.validation})`,
    "",
    "## Safety Gates",
    "",
    `- execution_start_allowed: ${String(deltaReport.executionStartAllowed)}`,
    `- operator_approved: ${String(deltaReport.operatorApproved)}`,
    `- next_safe_task: ${deltaReport.nextSafeTask}`,
    "",
    "## Optional TaskFlow Dry-Run Loops",
    "",
  ];

  if (optionalLoops.controlledDialogue) {
    lines.push(
      `- controlled_dialogue_dry_run: ${optionalLoops.controlledDialogue.status} (${optionalLoops.controlledDialogue.validation}), dialogue_started=${String(optionalLoops.controlledDialogue.dialogueStarted)}, execution_started=${String(optionalLoops.controlledDialogue.executionStarted)}`,
      `- controlled_dialogue_next_safe_task: ${optionalLoops.controlledDialogue.nextSafeTask}`,
    );
  } else {
    lines.push("- controlled_dialogue_dry_run: not_run");
  }

  if (optionalLoops.closedLoop) {
    lines.push(
      `- closed_loop_dry_run: ${optionalLoops.closedLoop.status} (${optionalLoops.closedLoop.validation}), run_started=${String(optionalLoops.closedLoop.runStarted)}, run_completed=${String(optionalLoops.closedLoop.runCompleted)}, execution_started=${String(optionalLoops.closedLoop.executionStarted)}`,
      `- closed_loop_next_safe_task: ${optionalLoops.closedLoop.nextSafeTask}`,
    );
  } else {
    lines.push("- closed_loop_dry_run: not_run");
  }

  lines.push(
    "",
    "## Conclusion",
    "",
    "One-click autonomous pipeline completed for all currently executable safe parts.",
    "Real write/execution remains blocked by approval gates by design.",
    "",
  );

  await fs.writeFile(finalReportPath, `${lines.join("\n")}\n`, "utf8");
  return finalReportPath;
}

async function main() {
  const repoRoot = process.cwd();
  await runPnpm(["autonomous:inventory:check"]);
  await runPnpmWithRetry(["build"], {
    attempts: BUILD_RETRY_ATTEMPTS,
    delayMs: BUILD_RETRY_DELAY_MS,
  });
  const daemonState = await ensureAutoTradingDaemon();

  const { traceId } = await runDecisionWithCoverage(repoRoot);
  await runModelBackedPipeline(repoRoot, traceId);
  const optionalLoops = ENABLE_OPTIONAL_LOOPS
    ? await runOptionalTaskflowLoops(repoRoot)
    : { controlledDialogue: null, closedLoop: null };
  const finalReportPath = await buildAndWriteFinalReport(
    repoRoot,
    traceId,
    daemonState,
    optionalLoops,
  );

  await runPnpm(["autonomous:inventory:check"]);

  const finalReportRel = toRepoRelativePath(repoRoot, finalReportPath);
  console.log(`[oneclick] done`);
  console.log(`[oneclick] report=${finalReportRel}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[oneclick] failed: ${message}`);
  process.exitCode = 1;
});
