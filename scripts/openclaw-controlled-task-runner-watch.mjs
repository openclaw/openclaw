#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WATCH_SCHEMA = "openclaw.controlled-task-runner.watch.v1";
const RUNNER_SCRIPT_REL = "scripts/openclaw-controlled-task-runner.mjs";
const STATE_DIR_REL = "reports/hermes-agent/state";
const LATEST_REPORT_NAME = "openclaw-controlled-task-runner-watch-latest.json";
const RUN_STREAM_NAME = "openclaw-controlled-task-runner-watch-runs.jsonl";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RESTART_DELAY_MS = 3_000;
const DEFAULT_TASK_ID = "blackbox_autonomy_tick";

function usage() {
  return [
    "Usage:",
    "  node scripts/openclaw-controlled-task-runner-watch.mjs [--task <task-id>] [--interval-ms <ms>] [--restart-delay-ms <ms>] [--max-cycles <n>] [--once] [--json]",
    "  (default task: blackbox_autonomy_tick)",
    "",
    "Examples:",
    "  node scripts/openclaw-controlled-task-runner-watch.mjs",
    "  node scripts/openclaw-controlled-task-runner-watch.mjs --task autonomous_inventory_check --interval-ms 10000 --json",
    "  node scripts/openclaw-controlled-task-runner-watch.mjs --once --json",
  ].join("\n");
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function buildComparableSignature(report) {
  const blockers = Array.isArray(report?.remaining_blockers)
    ? Array.from(
        new Set(
          report.remaining_blockers
            .map((item) => normalizeText(String(item)))
            .filter((item) => item !== null),
        ),
      ).sort()
    : [];
  const summary = {
    lane: normalizeText(report?.lane) ?? "unknown",
    taskId: normalizeText(report?.task?.id) ?? "unknown",
    nextSafeTaskId: normalizeText(report?.next_safe_task?.id) ?? "unknown",
    nextSafeTaskCardId: normalizeText(report?.next_safe_task?.card_id) ?? "none",
    proposalStatus:
      normalizeText(report?.validation_result?.next_safe_task_card_proposal?.status) ?? "unknown",
    blockers,
  };
  const source = JSON.stringify(summary);
  return {
    source,
    hash: hashText(source),
    summary,
  };
}

function parseTrailingJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { value: null, error: "runner stdout is empty" };
  }
  let cursor = trimmed.lastIndexOf("{");
  while (cursor >= 0) {
    const candidate = trimmed.slice(cursor);
    try {
      return { value: JSON.parse(candidate), error: null };
    } catch {
      cursor = trimmed.lastIndexOf("{", cursor - 1);
    }
  }
  return { value: null, error: "runner stdout has no parseable JSON object" };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonLine(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: 1,
        errorCode: error?.code ?? "SPAWN_ERROR",
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        errorCode: null,
        stdout,
        stderr,
      });
    });
  });
}

async function runRunnerCycle(repoRoot, taskId) {
  const args = [RUNNER_SCRIPT_REL, "--run", "--json"];
  if (taskId) {
    args.push("--task", taskId);
  }
  const commandResult = await runCommand(process.execPath, args, repoRoot);
  const parsed = parseTrailingJsonObject(commandResult.stdout);
  const runnerReport = parsed.value;
  const parseError = parsed.error;

  const coreResult = normalizeText(runnerReport?.core_result) ?? "unknown";
  const successful =
    commandResult.exitCode === 0 && parseError === null && coreResult === "success";
  const signature = successful && runnerReport ? buildComparableSignature(runnerReport) : null;

  return {
    runner: {
      command: [process.execPath, ...args].join(" "),
      startedAt: commandResult.startedAt,
      finishedAt: commandResult.finishedAt,
      durationMs: commandResult.durationMs,
      exitCode: commandResult.exitCode,
      errorCode: commandResult.errorCode,
      stdoutTail: commandResult.stdout.slice(-600),
      stderrTail: commandResult.stderr.slice(-400),
      parseError,
      coreResult,
      reportPath: normalizeText(runnerReport?.report_paths?.runPath) ?? null,
      latestPath: normalizeText(runnerReport?.report_paths?.latestPath) ?? null,
    },
    successful,
    runnerReport,
    signature,
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    taskId: DEFAULT_TASK_ID,
    intervalMs: DEFAULT_INTERVAL_MS,
    restartDelayMs: DEFAULT_RESTART_DELAY_MS,
    maxCycles: 0,
    once: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
      continue;
    }
    if (arg === "--task") {
      options.taskId = normalizeText(argv[++index] ?? "");
      continue;
    }
    if (arg.startsWith("--task=")) {
      options.taskId = normalizeText(arg.slice("--task=".length));
      continue;
    }
    if (arg === "--interval-ms") {
      options.intervalMs = numberOr(argv[++index], options.intervalMs);
      continue;
    }
    if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = numberOr(arg.slice("--interval-ms=".length), options.intervalMs);
      continue;
    }
    if (arg === "--restart-delay-ms") {
      options.restartDelayMs = numberOr(argv[++index], options.restartDelayMs);
      continue;
    }
    if (arg.startsWith("--restart-delay-ms=")) {
      options.restartDelayMs = numberOr(
        arg.slice("--restart-delay-ms=".length),
        options.restartDelayMs,
      );
      continue;
    }
    if (arg === "--max-cycles") {
      options.maxCycles = numberOr(argv[++index], options.maxCycles);
      continue;
    }
    if (arg.startsWith("--max-cycles=")) {
      options.maxCycles = numberOr(arg.slice("--max-cycles=".length), options.maxCycles);
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.repoRoot = path.resolve(options.repoRoot);
  options.intervalMs = Math.max(
    1_000,
    Math.floor(numberOr(options.intervalMs, DEFAULT_INTERVAL_MS)),
  );
  options.restartDelayMs = Math.max(
    100,
    Math.floor(numberOr(options.restartDelayMs, DEFAULT_RESTART_DELAY_MS)),
  );
  options.maxCycles = Math.max(0, Math.floor(numberOr(options.maxCycles, 0)));

  return options;
}

function formatLine(cycle) {
  return [
    "[controlled-watch]",
    `cycle=${cycle.cycleIndex}`,
    `status=${cycle.status}`,
    `restart=${cycle.restartReason ?? "none"}`,
    `stable=${cycle.stableStreak}`,
    `task=${cycle.taskId ?? "unknown"}`,
    `next=${cycle.nextSafeTaskId ?? "unknown"}`,
    `exit=${cycle.runner.exitCode}`,
    `waitMs=${cycle.nextSleepMs}`,
  ].join(" ");
}

export async function runControlledTaskRunnerWatch(rawOptions = {}) {
  const options = {
    repoRoot: path.resolve(rawOptions.repoRoot ?? process.cwd()),
    taskId: normalizeText(rawOptions.taskId ?? DEFAULT_TASK_ID),
    intervalMs: Math.max(1_000, Math.floor(numberOr(rawOptions.intervalMs, DEFAULT_INTERVAL_MS))),
    restartDelayMs: Math.max(
      100,
      Math.floor(numberOr(rawOptions.restartDelayMs, DEFAULT_RESTART_DELAY_MS)),
    ),
    maxCycles: Math.max(0, Math.floor(numberOr(rawOptions.maxCycles, 0))),
    once: rawOptions.once === true,
    json: rawOptions.json === true,
  };
  const stateDir = path.join(options.repoRoot, STATE_DIR_REL);
  const latestPath = path.join(stateDir, LATEST_REPORT_NAME);
  const streamPath = path.join(stateDir, RUN_STREAM_NAME);

  let stopRequested = false;
  process.once("SIGINT", () => {
    stopRequested = true;
  });
  process.once("SIGTERM", () => {
    stopRequested = true;
  });

  let cycleIndex = 0;
  let restartCount = 0;
  let stableStreak = 0;
  let baselineSignature = null;
  let lastCycle = null;
  let lastReport = null;

  while (!stopRequested) {
    cycleIndex += 1;
    const cycleResult = await runRunnerCycle(options.repoRoot, options.taskId);
    const taskId = normalizeText(cycleResult.runnerReport?.task?.id) ?? null;
    const nextSafeTaskId = normalizeText(cycleResult.runnerReport?.next_safe_task?.id) ?? null;
    let restartReason = null;

    if (!cycleResult.successful) {
      restartReason =
        cycleResult.runner.exitCode !== 0
          ? "runner_command_failed"
          : cycleResult.runner.coreResult !== "success"
            ? "runner_core_result_failed"
            : cycleResult.runner.parseError !== null
              ? "runner_report_parse_failed"
              : "runner_unknown_failure";
      stableStreak = 0;
      restartCount += 1;
    } else if (
      baselineSignature !== null &&
      cycleResult.signature !== null &&
      cycleResult.signature.hash !== baselineSignature.hash
    ) {
      restartReason = "runner_state_changed";
      stableStreak = 0;
      restartCount += 1;
      baselineSignature = cycleResult.signature;
    } else {
      stableStreak += 1;
      if (baselineSignature === null && cycleResult.signature !== null) {
        baselineSignature = cycleResult.signature;
      }
    }

    const nextSleepMs = restartReason ? options.restartDelayMs : options.intervalMs;
    const cycle = {
      cycleIndex,
      generatedAt: new Date().toISOString(),
      status: restartReason ? "restarted" : "steady",
      restartReason,
      stableStreak,
      restartCount,
      taskId,
      nextSafeTaskId,
      nextSleepMs,
      baselineSignatureHash: baselineSignature?.hash ?? null,
      baselineSummary: baselineSignature?.summary ?? null,
      runner: cycleResult.runner,
    };
    lastCycle = cycle;

    const report = {
      schema: WATCH_SCHEMA,
      generatedAt: cycle.generatedAt,
      status: stopRequested ? "stopped" : "running",
      mode: options.once ? "once" : "watch",
      config: {
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        intervalMs: options.intervalMs,
        restartDelayMs: options.restartDelayMs,
        maxCycles: options.maxCycles,
      },
      summary: {
        cyclesExecuted: cycleIndex,
        restartCount,
        stableStreak,
        lastRestartReason: cycle.restartReason,
      },
      cycle,
      files: {
        latestPath: toPosix(path.relative(options.repoRoot, latestPath)),
        streamPath: toPosix(path.relative(options.repoRoot, streamPath)),
      },
    };
    lastReport = report;

    await writeJson(latestPath, report);
    await appendJsonLine(streamPath, report);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatLine(cycle)}\n`);
    }

    if (stopRequested || options.once) {
      break;
    }
    if (options.maxCycles > 0 && cycleIndex >= options.maxCycles) {
      break;
    }
    await sleep(nextSleepMs);
  }

  return { report: lastReport, cycle: lastCycle };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runControlledTaskRunnerWatch(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `controlled task runner watch failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
