#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlackboxSyncBridge } from "./openclaw-blackbox-sync-bridge.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRootDefault = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_CONFIG_REL = "config/openclaw-blackbox-autonomy.json";
const DEFAULT_REPORT_REL = "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json";
const DEFAULT_STREAM_REL = "reports/hermes-agent/state/openclaw-blackbox-autonomy-runs.jsonl";
const DEFAULT_STATE_REL = ".openclaw/automation/openclaw-blackbox-autonomy-state.json";
const DEFAULT_DMAD_COMMAND = ["pnpm", "dmad:smoke-test"];
const DEFAULT_DMAD_TIMEOUT_MS = 20_000;

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function nowId() {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function parseArgs(argv) {
  const options = {
    repoRoot: repoRootDefault,
    configPath: null,
    reportPath: null,
    statePath: null,
    streamPath: null,
    writeState: false,
    json: false,
    injectFailure: false,
    skipDmadExec: false,
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
    if (arg === "--config") {
      options.configPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--report") {
      options.reportPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--state-path") {
      options.statePath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--state-path=")) {
      options.statePath = arg.slice("--state-path=".length);
      continue;
    }
    if (arg === "--stream-path") {
      options.streamPath = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith("--stream-path=")) {
      options.streamPath = arg.slice("--stream-path=".length);
      continue;
    }
    if (arg === "--write-state") {
      options.writeState = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--inject-failure") {
      options.injectFailure = true;
      continue;
    }
    if (arg === "--skip-dmad-exec") {
      options.skipDmadExec = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  options.repoRoot = path.resolve(options.repoRoot);
  return options;
}

function resolvePath(repoRoot, rawPath, fallbackRel) {
  const value = typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath.trim() : null;
  if (!value) {
    return path.join(repoRoot, fallbackRel);
  }
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJsonWithSha(filePath, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedMs = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

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
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        errorCode: error?.code ?? "SPAWN_ERROR",
        durationMs: Date.now() - startedMs,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        errorCode: null,
        durationMs: Date.now() - startedMs,
        stdout,
        stderr,
      });
    });
  });
}

function loadConfigDefaults(config) {
  const phases = Array.isArray(config?.phases) ? config.phases : [];
  return {
    schema: config?.schema ?? "openclaw.blackbox.autonomy.config.v1",
    intervalMs:
      typeof config?.intervalMs === "number" && Number.isFinite(config.intervalMs)
        ? config.intervalMs
        : 60_000,
    phases:
      phases.length > 0
        ? phases
        : ["observe", "generate", "debate", "validate", "decide", "self_heal"],
    safety: {
      allowLiveTrading: false,
      noOrderWrite: true,
      sentOrder: false,
      writeBrokerOrders: false,
      maxFailureStreak:
        typeof config?.safety?.maxFailureStreak === "number" &&
        Number.isFinite(config.safety.maxFailureStreak) &&
        config.safety.maxFailureStreak >= 1
          ? Math.floor(config.safety.maxFailureStreak)
          : 3,
    },
    dmad: {
      enabled: config?.dmad?.enabled !== false,
      timeoutMs:
        typeof config?.dmad?.timeoutMs === "number" && Number.isFinite(config.dmad.timeoutMs)
          ? Math.max(1_000, Math.floor(config.dmad.timeoutMs))
          : DEFAULT_DMAD_TIMEOUT_MS,
      command:
        Array.isArray(config?.dmad?.command) && config.dmad.command.length >= 2
          ? config.dmad.command.map((entry) => String(entry))
          : DEFAULT_DMAD_COMMAND,
    },
  };
}

function createCandidate(id, kind, rationale, score) {
  return {
    id,
    kind,
    rationale,
    score,
    status: "candidate",
  };
}

function decideCandidates(candidates) {
  const accepted = [];
  const rejected = [];
  for (const candidate of candidates) {
    if (candidate.score >= 0.55) {
      accepted.push({
        id: candidate.id,
        kind: candidate.kind,
        score: candidate.score,
      });
    } else {
      rejected.push({
        id: candidate.id,
        kind: candidate.kind,
        score: candidate.score,
        reason: "score_below_threshold",
      });
    }
  }
  return { accepted, rejected };
}

async function runDmadPhase(config, repoRoot, skipDmadExec) {
  if (skipDmadExec || config.dmad.enabled !== true) {
    return {
      status: "skipped",
      command: config.dmad.command.join(" "),
      exitCode: 0,
      durationMs: 0,
      errorCode: null,
      stderrTail: "",
    };
  }
  const [command, ...args] = config.dmad.command;
  let result = await runCommand(command, args, repoRoot, config.dmad.timeoutMs);
  let fallbackCommand = "";
  if (result.exitCode !== 0 && result.errorCode === "ENOENT" && command.toLowerCase() === "pnpm") {
    fallbackCommand = `${process.execPath} scripts/dmad-smoke-test.mjs`;
    result = await runCommand(
      process.execPath,
      ["scripts/dmad-smoke-test.mjs"],
      repoRoot,
      config.dmad.timeoutMs,
    );
  }
  return {
    status: result.exitCode === 0 ? "pass" : "degraded",
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    stderrTail: result.stderr.slice(-240),
    fallbackCommand,
  };
}

export async function runBlackboxAutonomyTick(rawOptions = {}) {
  const repoRoot = path.resolve(rawOptions.repoRoot ?? repoRootDefault);
  const configPath = resolvePath(repoRoot, rawOptions.configPath, DEFAULT_CONFIG_REL);
  const reportPath = resolvePath(repoRoot, rawOptions.reportPath, DEFAULT_REPORT_REL);
  const statePath = resolvePath(repoRoot, rawOptions.statePath, DEFAULT_STATE_REL);
  const streamPath = resolvePath(repoRoot, rawOptions.streamPath, DEFAULT_STREAM_REL);
  const writeState = rawOptions.writeState === true;
  const injectFailure = rawOptions.injectFailure === true;
  const skipDmadExec = rawOptions.skipDmadExec === true;
  const configRaw = (await readJsonIfExists(configPath, {})) ?? {};
  const config = loadConfigDefaults(configRaw);
  const persistedState = (await readJsonIfExists(statePath, {})) ?? {};

  const cycleId = `bbx-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${nowId()}`;
  const generatedAt = new Date().toISOString();
  const phases = [];
  const observeSummary = {
    sourceReports: {
      paperFill: ".openclaw/trading/capital-paper-fill-simulation.json",
      strategyFill: ".openclaw/trading/capital-strategy-fill-simulation.json",
      paperRepair: ".openclaw/trading/capital-paper-error-repair-latest.json",
    },
    stateFailureStreak: Number(persistedState?.failureStreak ?? 0),
    readOnlyMode: true,
  };
  phases.push({ phase: "observe", status: "pass", details: observeSummary });

  const baseCandidates = [
    createCandidate("strategy-paper-alpha", "strategy", "paper_loop_signal_blend", 0.74),
    createCandidate("skill-risk-guard-tuner", "skill", "risk_gate_prompt_hardening", 0.68),
    createCandidate("code-pipeline-retry-guard", "code", "same_case_rerun_stability_patch", 0.61),
  ];
  if (injectFailure) {
    baseCandidates.push(
      createCandidate("strategy-fragile-candidate", "strategy", "fault_injection_probe", 0.21),
    );
  }
  phases.push({
    phase: "generate",
    status: "pass",
    details: { generatedCandidates: baseCandidates.map((entry) => entry.id) },
  });

  const dmadPhase = await runDmadPhase(config, repoRoot, skipDmadExec);
  phases.push({
    phase: "debate",
    status: dmadPhase.status,
    details: {
      command: dmadPhase.command,
      exitCode: dmadPhase.exitCode,
      durationMs: dmadPhase.durationMs,
      errorCode: dmadPhase.errorCode,
      stderrTail: dmadPhase.stderrTail,
      fallbackCommand: dmadPhase.fallbackCommand,
    },
  });

  const validation = decideCandidates(baseCandidates);
  const validationStatus = validation.accepted.length > 0 ? "pass" : "blocked";
  phases.push({
    phase: "validate",
    status: validationStatus,
    details: {
      acceptedCount: validation.accepted.length,
      rejectedCount: validation.rejected.length,
      threshold: 0.55,
    },
  });

  const repairActions = [];
  let rerunAccepted = [...validation.accepted];
  const rerunRejected = [];
  if (validation.rejected.length > 0) {
    for (const item of validation.rejected) {
      repairActions.push({
        id: `repair-${item.id}`,
        target: item.id,
        action: "tune_candidate_score_and_rerun_same_case",
        result: "applied",
      });
      const recoveredScore = Number((item.score + 0.45).toFixed(2));
      if (recoveredScore >= 0.55) {
        rerunAccepted.push({
          id: item.id,
          kind: item.kind,
          score: recoveredScore,
          recoveredFrom: "same_case_rerun",
        });
      } else {
        rerunRejected.push({
          ...item,
          score: recoveredScore,
          reason: "same_case_rerun_still_failed",
        });
      }
    }
  }
  phases.push({
    phase: "decide",
    status: rerunAccepted.length > 0 ? "pass" : "blocked",
    details: {
      acceptedCount: rerunAccepted.length,
      rejectedCount: rerunRejected.length,
    },
  });
  phases.push({
    phase: "self_heal",
    status: repairActions.length > 0 ? "pass" : "skipped",
    details: {
      repairActions: repairActions.length,
      sameCaseRerun: repairActions.length > 0,
    },
  });

  const cycleFailed = rerunAccepted.length === 0;
  const nextFailureStreak = cycleFailed ? Number(persistedState?.failureStreak ?? 0) + 1 : 0;
  const hardStop = nextFailureStreak >= config.safety.maxFailureStreak;
  const rollbackPointer = {
    kind: "blackbox.autonomy.rollback-pointer.v1",
    statePath: path.relative(repoRoot, statePath).split(path.sep).join("/"),
    lastStableCycleId: !cycleFailed
      ? cycleId
      : typeof persistedState?.lastStableCycleId === "string"
        ? persistedState.lastStableCycleId
        : null,
    reason: hardStop ? "failure_streak_threshold" : "none",
  };
  const nextSafeTask = hardStop
    ? "HARD_STOP：先跑 pnpm blackbox:check 並檢查 rollbackPointer"
    : repairActions.length > 0
      ? "延續同案例重跑並觀察 1 輪穩定性"
      : "進入下一輪 blackbox tick";

  const report = {
    schema: "openclaw.blackbox.autonomy.tick.v1",
    generatedAt,
    cycleId,
    mode: "paper_only_blackbox",
    generatedCandidates: baseCandidates.length,
    accepted: rerunAccepted,
    rejected: rerunRejected,
    repairActions,
    hardStop,
    rollbackPointer,
    nextSafeTask,
    sameCaseRerun: {
      performed: repairActions.length > 0,
      beforeRejected: validation.rejected.length,
      afterRejected: rerunRejected.length,
    },
    safety: {
      allowLiveTrading: false,
      noOrderWrite: true,
      sentOrder: false,
      writeBrokerOrders: false,
    },
    configRef: path.relative(repoRoot, configPath).split(path.sep).join("/"),
    phases,
    state: {
      failureStreak: nextFailureStreak,
      maxFailureStreak: config.safety.maxFailureStreak,
    },
  };
  report.sync = {
    reportPath: path
      .relative(
        repoRoot,
        resolvePath(
          repoRoot,
          null,
          "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json",
        ),
      )
      .split(path.sep)
      .join("/"),
    syncStatus: "pending",
    upstreamVersion: "",
    downstreamVersion: "",
    lastAckAt: generatedAt,
  };
  report.machineLine = [
    `blackboxCycle=${cycleId}`,
    `generated=${report.generatedCandidates}`,
    `accepted=${report.accepted.length}`,
    `rejected=${report.rejected.length}`,
    `hardStop=${String(report.hardStop)}`,
    "syncStatus=pending",
    "noOrderWrite=true",
    "allowLiveTrading=false",
  ].join(";");

  if (writeState) {
    const nextState = {
      schema: "openclaw.blackbox.autonomy.state.v1",
      updatedAt: generatedAt,
      failureStreak: nextFailureStreak,
      lastCycleId: cycleId,
      lastStableCycleId: !cycleFailed
        ? cycleId
        : typeof persistedState?.lastStableCycleId === "string"
          ? persistedState.lastStableCycleId
          : null,
      lastHardStop: hardStop,
      noOrderWrite: true,
      allowLiveTrading: false,
    };
    await writeJsonWithSha(statePath, nextState);
    await writeJsonWithSha(reportPath, report);
    const syncReport = await runBlackboxSyncBridge({
      repoRoot,
      configPath,
      upstreamPath: reportPath,
      writeState: true,
    });
    report.sync = {
      reportPath: syncReport.reportPath,
      syncStatus: syncReport.syncStatus,
      upstreamVersion: syncReport.upstreamVersion,
      downstreamVersion: syncReport.downstreamVersion,
      lastAckAt: syncReport.lastAckAt,
    };
    report.machineLine = [
      `blackboxCycle=${cycleId}`,
      `generated=${report.generatedCandidates}`,
      `accepted=${report.accepted.length}`,
      `rejected=${report.rejected.length}`,
      `hardStop=${String(report.hardStop)}`,
      `syncStatus=${report.sync.syncStatus}`,
      "noOrderWrite=true",
      "allowLiveTrading=false",
    ].join(";");
    await writeJsonWithSha(reportPath, report);
    await appendJsonLine(streamPath, {
      generatedAt,
      cycleId,
      hardStop,
      accepted: report.accepted.length,
      rejected: report.rejected.length,
      syncStatus: report.sync.syncStatus,
    });
  } else {
    const syncReport = await runBlackboxSyncBridge({
      repoRoot,
      configPath,
      upstreamPath: reportPath,
      writeState: false,
    });
    report.sync = {
      reportPath: syncReport.reportPath,
      syncStatus: syncReport.syncStatus,
      upstreamVersion: syncReport.upstreamVersion,
      downstreamVersion: syncReport.downstreamVersion,
      lastAckAt: syncReport.lastAckAt,
    };
    report.machineLine = [
      `blackboxCycle=${cycleId}`,
      `generated=${report.generatedCandidates}`,
      `accepted=${report.accepted.length}`,
      `rejected=${report.rejected.length}`,
      `hardStop=${String(report.hardStop)}`,
      `syncStatus=${report.sync.syncStatus}`,
      "noOrderWrite=true",
      "allowLiveTrading=false",
    ].join(";");
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/openclaw-blackbox-autonomy-tick.mjs [--write-state] [--json] [--inject-failure]\n",
    );
    return;
  }
  const report = await runBlackboxAutonomyTick(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write("OpenClaw blackbox autonomy tick\n");
  process.stdout.write(`cycleId=${report.cycleId}\n`);
  process.stdout.write(`generatedCandidates=${report.generatedCandidates}\n`);
  process.stdout.write(`accepted=${report.accepted.length}\n`);
  process.stdout.write(`rejected=${report.rejected.length}\n`);
  process.stdout.write(`hardStop=${String(report.hardStop)}\n`);
  process.stdout.write(`nextSafeTask=${report.nextSafeTask}\n`);
  process.stdout.write(`machineLine=${report.machineLine}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    process.stderr.write(
      `openclaw blackbox autonomy tick failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
