import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveLocalVitestEnv } from "./lib/vitest-local-scheduling.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  cleanupVitestProcessGroupAfterExit,
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const SUPPRESSED_VITEST_STDERR_PATTERNS = ["[PLUGIN_TIMINGS]"];
const DEFAULT_VITEST_GATE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VITEST_PROGRESS_PULSE_INTERVAL_MS = 60 * 1000;
const require = createRequire(import.meta.url);

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeVitestGateJobId(value) {
  const sanitized = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return sanitized || "vitest-gate";
}

export function resolveVitestGateJobId({
  env = process.env,
  now = () => Date.now(),
  randomUUID = crypto.randomUUID,
} = {}) {
  const explicit = env.OPENCLAW_VITEST_GATE_JOB_ID?.trim();
  if (explicit) {
    return sanitizeVitestGateJobId(explicit);
  }
  const timestamp = new Date(now()).toISOString().replace(/[:]/g, "");
  return sanitizeVitestGateJobId(`vitest-${timestamp}-${randomUUID().slice(0, 8)}`);
}

export function resolveVitestGateLogPath({ env = process.env, jobId, cwd = process.cwd() } = {}) {
  const explicit = env.OPENCLAW_VITEST_GATE_LOG_FILE?.trim();
  if (explicit) {
    return path.resolve(cwd, explicit);
  }
  const dir =
    env.OPENCLAW_VITEST_GATE_LOG_DIR?.trim() || path.join(os.tmpdir(), "openclaw-vitest-gates");
  return path.join(path.resolve(cwd, dir), `${sanitizeVitestGateJobId(jobId)}.log`);
}

export function resolveVitestGateTimeoutMs(env = process.env) {
  const configured = parsePositiveInt(env.OPENCLAW_VITEST_GATE_TIMEOUT_MS);
  if (configured !== null) {
    return configured;
  }
  return Object.hasOwn(env, "OPENCLAW_VITEST_GATE_TIMEOUT_MS")
    ? null
    : DEFAULT_VITEST_GATE_TIMEOUT_MS;
}

export function resolveVitestGateCleanupTimeoutMs(env = process.env) {
  return parsePositiveInt(env.OPENCLAW_VITEST_GATE_CLEANUP_TIMEOUT_MS) ?? 5_000;
}

export function resolveVitestProgressPulseIntervalMs(env = process.env) {
  const explicit = parsePositiveInt(
    env.OPENCLAW_VITEST_PROGRESS_PULSE_INTERVAL_MS ?? env.OPENCLAW_PROGRESS_PULSE_INTERVAL_MS,
  );
  if (explicit !== null) {
    return explicit;
  }
  const noOutputTimeoutMs = resolveVitestNoOutputTimeoutMs(env);
  if (noOutputTimeoutMs !== null) {
    return Math.max(1_000, Math.floor(noOutputTimeoutMs / 2));
  }
  return DEFAULT_VITEST_PROGRESS_PULSE_INTERVAL_MS;
}

function formatProgressElapsedMs(elapsedMs) {
  const ms = Math.max(0, Math.floor(Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeRawProgressDump(value) {
  const text = value ?? "";
  if (!text.trim()) {
    return false;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length >= 3) {
    return true;
  }
  return (
    text.length > 500 ||
    /Process exited with code\s+\d+/i.test(text) ||
    /\[PLUGIN_TIMINGS\]/i.test(text) ||
    /(?:^|\n)\s*(?:\$\s*)?(?:pnpm|npm|node|vitest)\b.*(?:\n|$)/i.test(text) ||
    /(?:stdout|stderr|toolResult|function_call|stack trace)/i.test(text)
  );
}

function sanitizeProgressField(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  if (looksLikeRawProgressDump(raw)) {
    return "[suppressed raw output; see gate log]";
  }
  const singleLine = raw.replace(/\s+/g, " ").trim();
  return singleLine.length > 220 ? `${singleLine.slice(0, 217)}...` : singleLine;
}

export function resolveVitestProgressPulseMetadata({ env = process.env, argv = [] } = {}) {
  return {
    planPath: sanitizeProgressField(
      env.OPENCLAW_ACTIVE_PLAN_PATH ?? env.OPENCLAW_PLAN_PATH,
      "not configured",
    ),
    waveNumber: sanitizeProgressField(
      env.OPENCLAW_ACTIVE_WAVE_NUMBER ?? env.OPENCLAW_WAVE_NUMBER,
      "?",
    ),
    waveTotal: sanitizeProgressField(
      env.OPENCLAW_ACTIVE_WAVE_TOTAL ?? env.OPENCLAW_WAVE_TOTAL,
      "?",
    ),
    currentGate: sanitizeProgressField(
      env.OPENCLAW_CURRENT_GATE ?? env.OPENCLAW_VITEST_CURRENT_GATE ?? argv.join(" "),
      "vitest gate",
    ),
    nextAction: sanitizeProgressField(
      env.OPENCLAW_NEXT_ACTION ?? env.OPENCLAW_VITEST_NEXT_ACTION,
      "wait for scoped gate completion",
    ),
  };
}

export function buildVitestProgressPulse(params) {
  const metadata = {
    planPath: sanitizeProgressField(params.planPath, "not configured"),
    waveNumber: sanitizeProgressField(params.waveNumber, "?"),
    waveTotal: sanitizeProgressField(params.waveTotal, "?"),
    currentGate: sanitizeProgressField(params.currentGate, "vitest gate"),
    nextAction: sanitizeProgressField(params.nextAction, "wait for scoped gate completion"),
  };
  const job = sanitizeProgressField(params.jobId, "vitest-gate");
  return (
    `[progress] job=${job}; plan=${metadata.planPath}; wave=${metadata.waveNumber}/${metadata.waveTotal}; ` +
    `elapsed=${formatProgressElapsedMs(params.elapsedMs)}; gate=${metadata.currentGate}; ` +
    `next=${metadata.nextAction}`
  );
}

export function installVitestProgressPulse(params) {
  const intervalMs = Math.max(0, Math.floor(params.intervalMs ?? 0));
  if (intervalMs <= 0) {
    return () => {};
  }
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const nowFn = params.nowFn ?? Date.now;
  const startedAtMs = Number.isFinite(params.startedAtMs) ? params.startedAtMs : nowFn();
  let active = true;
  let timer = null;
  const schedule = () => {
    timer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      params.log?.(
        buildVitestProgressPulse({
          ...params.metadata,
          jobId: params.jobId,
          elapsedMs: Math.max(0, nowFn() - startedAtMs),
        }),
      );
      schedule();
    }, intervalMs);
  };
  schedule();
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };
}

export function resolveVitestGateMetadata({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  now,
  randomUUID,
} = {}) {
  const jobId = resolveVitestGateJobId({ env, now, randomUUID });
  return {
    jobId,
    argv: [...argv],
    logPath: resolveVitestGateLogPath({ env, jobId, cwd }),
    timeoutMs: resolveVitestGateTimeoutMs(env),
    cleanupTimeoutMs: resolveVitestGateCleanupTimeoutMs(env),
  };
}

function createMultiWriteTarget(targets) {
  return {
    write(chunk) {
      for (const target of targets) {
        target.write(chunk);
      }
    },
  };
}

function openVitestGateLogStream(gate) {
  if (!gate?.logPath) {
    return null;
  }
  fs.mkdirSync(path.dirname(gate.logPath), { recursive: true });
  const stream = fs.createWriteStream(gate.logPath, { flags: "a" });
  stream.write(
    `[vitest] job=${gate.jobId} started=${new Date().toISOString()} ` +
      `timeoutMs=${gate.timeoutMs ?? "none"} argv=${JSON.stringify(gate.argv)}\n`,
  );
  return stream;
}

export function resolveVitestNodeArgs(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_VITEST_ENABLE_MAGLEV)) {
    return [];
  }

  return ["--no-maglev"];
}

export function resolveVitestCliEntry() {
  const vitestPackageJson = require.resolve("vitest/package.json");
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

export function resolveVitestNoOutputTimeoutMs(env = process.env) {
  return parsePositiveInt(env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS);
}

export function resolveVitestSpawnParams(env = process.env, platform = process.platform) {
  return {
    env: resolveVitestSpawnEnv(env),
    detached: shouldUseDetachedVitestProcessGroup(platform),
    stdio: ["inherit", "pipe", "pipe"],
  };
}

export function resolveVitestSpawnEnv(env = process.env) {
  const nextEnv = resolveLocalVitestEnv(env);
  if (!shouldApplyNativeWorkerBudget(nextEnv)) {
    return nextEnv;
  }

  const nativeWorkerCount = String(resolveNativeWorkerCount(nextEnv));
  return {
    ...nextEnv,
    RAYON_NUM_THREADS: nextEnv.RAYON_NUM_THREADS?.trim() || nativeWorkerCount,
    TOKIO_WORKER_THREADS: nextEnv.TOKIO_WORKER_THREADS?.trim() || nativeWorkerCount,
  };
}

function shouldApplyNativeWorkerBudget(env) {
  if (env.RAYON_NUM_THREADS?.trim() && env.TOKIO_WORKER_THREADS?.trim()) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL === "1" || resolveExplicitVitestWorkerBudget(env) !== null
  );
}

function resolveNativeWorkerCount(env) {
  return Math.min(resolveExplicitVitestWorkerBudget(env) ?? 1, 4);
}

function resolveExplicitVitestWorkerBudget(env) {
  return parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
}

export function shouldSuppressVitestStderrLine(line) {
  return SUPPRESSED_VITEST_STDERR_PATTERNS.some((pattern) => line.includes(pattern));
}

export function resolveDirectNodeVitestArgs(pnpmArgs) {
  return pnpmArgs[0] === "exec" && pnpmArgs[1] === "node" ? pnpmArgs.slice(2) : null;
}

function spawnVitestProcess({ pnpmArgs, spawnParams }) {
  const directNodeArgs = resolveDirectNodeVitestArgs(pnpmArgs);
  if (directNodeArgs) {
    return spawn(process.execPath, directNodeArgs, spawnParams);
  }
  return spawnPnpmRunner({
    pnpmArgs,
    ...spawnParams,
  });
}

export function installVitestNoOutputWatchdog(params) {
  const timeoutMs = params.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return () => {};
  }

  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const forceKillAfterMs = params.forceKillAfterMs ?? 5_000;
  const streams = params.streams?.filter(Boolean) ?? [];
  const label = params.label?.trim();
  const suffix = label ? ` (${label})` : "";

  let active = true;
  let silenceTimer = null;
  let forceKillTimer = null;

  const clearForceKillTimer = () => {
    if (forceKillTimer !== null) {
      clearTimeoutFn(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeoutFn(silenceTimer);
      silenceTimer = null;
    }
  };

  const resetSilenceTimer = () => {
    if (!active) {
      return;
    }
    clearSilenceTimer();
    silenceTimer = setTimeoutFn(() => {
      if (!active) {
        return;
      }
      params.log?.(
        `[vitest] no output for ${timeoutMs}ms; terminating stalled Vitest process group${suffix}.`,
      );
      params.onTimeout?.();
      if (forceKillAfterMs > 0) {
        clearForceKillTimer();
        forceKillTimer = setTimeoutFn(() => {
          if (!active) {
            return;
          }
          params.log?.(
            `[vitest] process group still alive after ${forceKillAfterMs}ms; sending SIGKILL${suffix}.`,
          );
          params.onForceKill?.();
        }, forceKillAfterMs);
      }
    }, timeoutMs);
  };

  const handleActivity = () => {
    clearForceKillTimer();
    resetSilenceTimer();
  };

  const listeners = streams.map((stream) => {
    const handler = () => {
      handleActivity();
    };
    stream.on("data", handler);
    return { stream, handler };
  });

  resetSilenceTimer();

  return () => {
    if (!active) {
      return;
    }
    active = false;
    clearSilenceTimer();
    clearForceKillTimer();
    for (const { stream, handler } of listeners) {
      stream.off("data", handler);
    }
  };
}

export function installVitestGateTimeout(params) {
  const timeoutMs = params.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return () => {};
  }

  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const forceKillAfterMs = params.forceKillAfterMs ?? 5_000;
  let active = true;
  let forceKillTimer = null;
  const timer = setTimeoutFn(() => {
    if (!active) {
      return;
    }
    params.log?.(
      `[vitest] gate job ${params.jobId ?? "unknown"} exceeded timeout budget ${timeoutMs}ms; ` +
        "terminating process group.",
    );
    params.onTimeout?.();
    if (forceKillAfterMs > 0) {
      forceKillTimer = setTimeoutFn(() => {
        if (!active) {
          return;
        }
        params.log?.(
          `[vitest] gate job ${params.jobId ?? "unknown"} still alive after timeout SIGTERM; ` +
            "sending SIGKILL.",
        );
        params.onForceKill?.();
      }, forceKillAfterMs);
    }
  }, timeoutMs);

  return () => {
    if (!active) {
      return;
    }
    active = false;
    clearTimeoutFn(timer);
    if (forceKillTimer !== null) {
      clearTimeoutFn(forceKillTimer);
      forceKillTimer = null;
    }
  };
}

export function forwardVitestOutput(stream, target, shouldSuppressLine = () => false) {
  if (!stream) {
    return;
  }

  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffered.slice(0, newlineIndex + 1);
      buffered = buffered.slice(newlineIndex + 1);
      if (!shouldSuppressLine(line)) {
        target.write(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0 && !shouldSuppressLine(buffered)) {
      target.write(buffered);
    }
  });
}

export function spawnWatchedVitestProcess({
  pnpmArgs,
  spawnParams,
  env,
  label,
  gate,
  onNoOutputTimeout,
  onGateTimeout,
}) {
  const child = spawnVitestProcess({
    pnpmArgs,
    spawnParams,
  });
  const gateState = { timeoutFired: false };
  let logStream = null;
  try {
    logStream = openVitestGateLogStream(gate);
  } catch (error) {
    console.error(
      `[vitest] unable to open gate log ${gate?.logPath ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stdoutTarget = logStream
    ? createMultiWriteTarget([process.stdout, logStream])
    : process.stdout;
  const stderrTarget = logStream
    ? createMultiWriteTarget([process.stderr, logStream])
    : process.stderr;
  const log = (message) => {
    stderrTarget.write(`${message}\n`);
  };
  const teardownChildCleanup = installVitestProcessGroupCleanup({ child });
  const teardownGateTimeout = installVitestGateTimeout({
    timeoutMs: gate?.timeoutMs,
    jobId: gate?.jobId,
    log,
    onTimeout: () => {
      gateState.timeoutFired = true;
      onGateTimeout?.();
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGTERM",
        kill: process.kill.bind(process),
      });
    },
    onForceKill: () => {
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGKILL",
        kill: process.kill.bind(process),
      });
    },
  });
  const teardownNoOutputWatchdog = installVitestNoOutputWatchdog({
    streams: [child.stdout, child.stderr],
    timeoutMs: resolveVitestNoOutputTimeoutMs(env),
    label,
    log,
    onTimeout: () => {
      onNoOutputTimeout?.();
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGTERM",
        kill: process.kill.bind(process),
      });
    },
    onForceKill: () => {
      forwardSignalToVitestProcessGroup({
        child,
        signal: "SIGKILL",
        kill: process.kill.bind(process),
      });
    },
  });
  const teardownProgressPulse = installVitestProgressPulse({
    intervalMs: resolveVitestProgressPulseIntervalMs(env),
    startedAtMs: Date.now(),
    jobId: gate?.jobId,
    metadata: resolveVitestProgressPulseMetadata({ env, argv: gate?.argv ?? [] }),
    log,
  });
  forwardVitestOutput(child.stdout, stdoutTarget);
  forwardVitestOutput(child.stderr, stderrTarget, shouldSuppressVitestStderrLine);

  return {
    child,
    gateState,
    log,
    teardown: () => {
      teardownChildCleanup();
      teardownGateTimeout();
      teardownNoOutputWatchdog();
      teardownProgressPulse();
    },
    closeLog: () => {
      if (logStream) {
        logStream.end(
          `[vitest] job=${gate?.jobId ?? "unknown"} finished=${new Date().toISOString()} ` +
            `timeoutFired=${gateState.timeoutFired}\n`,
        );
        logStream = null;
      }
    },
  };
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: 1, signal: null, error }));
  });
}

export function resolveVitestGateExitCode(params) {
  if (params.staleProcessDetected || params.timedOut || params.error) {
    return 1;
  }
  if (params.signal) {
    return 1;
  }
  return params.code ?? 1;
}

export async function runVitestGate({ argv, env = process.env, cwd = process.cwd() }) {
  const gate = resolveVitestGateMetadata({ argv, env, cwd });
  console.error(
    `[vitest] gate job ${gate.jobId}; log=${gate.logPath}; ` +
      `timeoutMs=${gate.timeoutMs ?? "none"}; cleanupTimeoutMs=${gate.cleanupTimeoutMs}`,
  );
  const watched = spawnWatchedVitestProcess({
    pnpmArgs: ["exec", "node", ...resolveVitestNodeArgs(env), resolveVitestCliEntry(), ...argv],
    spawnParams: resolveVitestSpawnParams(env),
    env,
    label: argv.join(" "),
    gate,
  });
  const { child, gateState, teardown, closeLog, log } = watched;

  const outcome = await waitForChildExit(child);
  teardown();
  if (outcome.error) {
    log(String(outcome.error));
  }
  const cleanup = await cleanupVitestProcessGroupAfterExit({
    childPid: child.pid,
    graceMs: gate.cleanupTimeoutMs,
    log,
  });
  if (cleanup.staleProcessDetected) {
    log(
      `[vitest] refusing gate acceptance because stale scoped process cleanup was required ` +
        `(clean=${cleanup.clean}).`,
    );
  }
  closeLog();
  const exitCode = resolveVitestGateExitCode({
    staleProcessDetected: cleanup.staleProcessDetected,
    timedOut: gateState.timeoutFired,
    error: outcome.error,
    signal: outcome.signal,
    code: outcome.code,
  });
  return {
    ...outcome,
    exitCode,
    gate,
    timedOut: gateState.timeoutFired,
    staleProcessDetected: cleanup.staleProcessDetected,
    staleProcessCleanupClean: cleanup.clean,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) {
    console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
    process.exit(1);
  }

  const outcome = await runVitestGate({ argv, env });
  if (outcome.signal && !outcome.timedOut && !outcome.staleProcessDetected) {
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exit(outcome.exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
