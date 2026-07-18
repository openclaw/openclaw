// Refreshes the checked-in CLI startup benchmark fixture.
import { spawn } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import { parseFlagArgs, stringFlag, intFlag } from "./lib/arg-utils.mjs";
import { signalExitCode, terminateManagedChild } from "./lib/managed-child-process.mjs";

const CLI_STARTUP_BENCH_FIXTURE_PATH = "test/fixtures/cli-startup-bench.json";
const DEFAULT_BENCHMARK_TIMEOUT_KILL_GRACE_MS = 1_000;
const DEFAULT_BENCHMARK_PROCESS_CLEANUP_GRACE_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
// A timed-out sample can spend one grace before SIGKILL and another reaping its process group.
// Keep these preset counts aligned with COMMAND_CASES or a valid fixture run can be cut short.
const BENCHMARK_TIMEOUT_CLEANUP_WINDOWS = 2;
const BENCHMARK_CASE_COUNTS = {
  startup: 6,
  real: 14,
  all: 43,
};

function resolveTestDurationMs(envName, fallback) {
  const raw = process.env.VITEST ? process.env[envName] : undefined;
  if (!raw || !/^\d+$/u.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function resolveBenchmarkProcessTimeoutMs(opts) {
  const caseCount = BENCHMARK_CASE_COUNTS[opts.preset] ?? BENCHMARK_CASE_COUNTS.all;
  const timeoutKillGraceMs = resolveTestDurationMs(
    "OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS",
    DEFAULT_BENCHMARK_TIMEOUT_KILL_GRACE_MS,
  );
  const processCleanupGraceMs = resolveTestDurationMs(
    "OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS",
    DEFAULT_BENCHMARK_PROCESS_CLEANUP_GRACE_MS,
  );
  const totalRuns = opts.runs + opts.warmup;
  const perRunBudgetMs = opts.timeoutMs + BENCHMARK_TIMEOUT_CLEANUP_WINDOWS * timeoutKillGraceMs;
  const totalTimeoutMs = caseCount * totalRuns * perRunBudgetMs + processCleanupGraceMs;
  if (!Number.isSafeInteger(totalTimeoutMs)) {
    throw new Error("CLI startup benchmark total timeout exceeds the safe integer range");
  }
  return totalTimeoutMs;
}

function resolveTemporaryOutputPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `.${parsed.base}.tmp-${process.pid}`);
}

async function runBenchmarkDriver(args, opts) {
  const timeoutMs = resolveBenchmarkProcessTimeoutMs(opts);
  const terminationGraceMs = resolveTestDurationMs(
    "OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS",
    DEFAULT_BENCHMARK_PROCESS_CLEANUP_GRACE_MS,
  );
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let receivedSignal;
    let forceKillTimer;
    const signalHandlers = new Map();
    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      for (const [forwardedSignal, handler] of signalHandlers) {
        process.off(forwardedSignal, handler);
      }
      resolve({ receivedSignal, signal, status, timedOut });
    };
    const terminateDriver = (signal) => {
      terminateManagedChild(child, signal);
      if (forceKillTimer) {
        terminateManagedChild(child, "SIGKILL");
        return;
      }
      forceKillTimer = setTimeout(() => {
        terminateManagedChild(child, "SIGKILL");
      }, terminationGraceMs);
    };
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        receivedSignal ??= signal;
        terminateDriver(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      // The driver owns detached sample groups, so let it reap them before the
      // bounded force-kill fallback restores control to this updater.
      terminateDriver("SIGTERM");
    }, timeoutMs);

    child.once("error", () => finish(null, null));
    child.once("close", (status, signal) => finish(status, signal));
  });
}

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-update-cli-startup-bench.mjs [options]",
      "",
      "Refresh the checked-in CLI benchmark fixture.",
      "",
      "Options:",
      "  --out <path>          Output path (default: test/fixtures/cli-startup-bench.json)",
      "  --entry <path>        CLI entry to benchmark (default: openclaw.mjs)",
      "  --preset <name>       startup | real | all (default: all)",
      "  --runs <n>            Measured runs per case (default: 5)",
      "  --warmup <n>          Warmup runs per case (default: 1)",
      "  --timeout-ms <ms>     Per-run timeout (default: 30000)",
      "  --help                Show this help text",
      "",
      "Example:",
      "  node scripts/test-update-cli-startup-bench.mjs --preset all --runs 3 --warmup 1",
    ].join("\n"),
  );
  process.exit(0);
}

const opts = parseFlagArgs(
  process.argv.slice(2),
  {
    out: CLI_STARTUP_BENCH_FIXTURE_PATH,
    entry: "openclaw.mjs",
    preset: "all",
    runs: 5,
    warmup: 1,
    timeoutMs: 30_000,
  },
  [
    stringFlag("--out", "out"),
    stringFlag("--entry", "entry"),
    stringFlag("--preset", "preset"),
    intFlag("--runs", "runs", { min: 1 }),
    intFlag("--warmup", "warmup", { min: 0 }),
    intFlag("--timeout-ms", "timeoutMs", { min: 1 }),
  ],
);

const args = [
  "--import",
  "tsx",
  "scripts/bench-cli-startup.ts",
  "--entry",
  opts.entry,
  "--preset",
  opts.preset,
  "--runs",
  String(opts.runs),
  "--warmup",
  String(opts.warmup),
  "--timeout-ms",
  String(opts.timeoutMs),
  "--output",
  resolveTemporaryOutputPath(opts.out),
];

const temporaryOutputPath = args.at(-1);
// Publish only a completed report; a timed-out driver may have already written
// its output before stalling in reporting or final cleanup.
rmSync(temporaryOutputPath, { force: true });
try {
  const run = await runBenchmarkDriver(args, opts);

  if (run.status !== 0 || run.timedOut || run.receivedSignal) {
    process.exitCode = run.timedOut
      ? 1
      : run.receivedSignal
        ? signalExitCode(run.receivedSignal)
        : (run.status ?? 1);
  } else {
    renameSync(temporaryOutputPath, opts.out);
    console.log(`[test-update-cli-startup-bench] wrote fixture to ${opts.out}`);
  }
} finally {
  rmSync(temporaryOutputPath, { force: true });
}
