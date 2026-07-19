// Refreshes the checked-in CLI startup benchmark fixture.
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFlagArgs, stringFlag, intFlag } from "./lib/arg-utils.mjs";
import { signalExitCode, terminateManagedChild } from "./lib/managed-child-process.mjs";

const CLI_STARTUP_BENCH_FIXTURE_PATH = "test/fixtures/cli-startup-bench.json";
const DEFAULT_BENCHMARK_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_BENCHMARK_PROCESS_CLEANUP_GRACE_MS = 5_000;
const FORWARDED_SIGNALS =
  process.platform === "win32"
    ? ["SIGHUP", "SIGINT", "SIGTERM"]
    : ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];
const BENCHMARK_BUDGET_MESSAGE_KIND = "openclaw-cli-startup-bench-budget";
const ACTIVE_SAMPLE_MESSAGE_KIND = "openclaw-cli-startup-bench-active-sample";
const CLEARED_SAMPLE_MESSAGE_KIND = "openclaw-cli-startup-bench-cleared-sample";

function resolveTestDurationMs(envName, fallback) {
  const raw = process.env.VITEST ? process.env[envName] : undefined;
  if (!raw || !/^\d+$/u.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function resolveTemporaryOutputPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `.${parsed.base}.tmp-${process.pid}`);
}

function prepareTemporaryOutput(outputDestination) {
  if (outputDestination.exists) {
    const directory = mkdtempSync(path.join(tmpdir(), "openclaw-cli-startup-bench-"));
    return {
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
      path: path.join(directory, path.basename(outputDestination.path)),
    };
  }
  const temporaryOutputPath = resolveTemporaryOutputPath(outputDestination.path);
  rmSync(temporaryOutputPath, { force: true });
  return {
    cleanup: () => rmSync(temporaryOutputPath, { force: true }),
    path: temporaryOutputPath,
  };
}

// Direct benchmark writes followed output symlinks and retained target metadata.
// Resolve that same destination for staging, but never rename over a special file.
function resolveOutputDestination(outputPath) {
  let destinationPath = outputPath;
  const visitedPaths = new Set();

  while (true) {
    const absolutePath = path.resolve(destinationPath);
    if (visitedPaths.has(absolutePath)) {
      throw new Error(`CLI startup benchmark output symlink cycle detected at ${destinationPath}`);
    }
    visitedPaths.add(absolutePath);

    let stats;
    try {
      stats = lstatSync(destinationPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { path: destinationPath };
      }
      throw error;
    }

    if (!stats.isSymbolicLink()) {
      if (!stats.isFile()) {
        throw new Error(
          `CLI startup benchmark output must be a regular file or missing: ${destinationPath}`,
        );
      }
      // Verify the existing inode is writable before spending the benchmark budget.
      // Successful publication writes this inode in place, preserving links and metadata.
      let handle;
      try {
        handle = openSync(destinationPath, fsConstants.O_WRONLY);
      } catch (error) {
        throw new Error(`CLI startup benchmark output is not writable: ${destinationPath}`, {
          cause: error,
        });
      }
      closeSync(handle);
      return { exists: true, path: destinationPath };
    }

    const targetPath = readlinkSync(destinationPath);
    destinationPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(path.dirname(destinationPath), targetPath);
  }
}

function publishBenchmarkOutput(temporaryOutputPath, outputDestination) {
  if (outputDestination.exists) {
    writeFileSync(outputDestination.path, readFileSync(temporaryOutputPath));
    return;
  }
  renameSync(temporaryOutputPath, outputDestination.path);
}

async function runBenchmarkDriver(args) {
  const startupTimeoutMs = resolveTestDurationMs(
    "OPENCLAW_TEST_CLI_STARTUP_BENCH_STARTUP_TIMEOUT_MS",
    DEFAULT_BENCHMARK_STARTUP_TIMEOUT_MS,
  );
  const terminationGraceMs = resolveTestDurationMs(
    "OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS",
    DEFAULT_BENCHMARK_PROCESS_CLEANUP_GRACE_MS,
  );
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: process.env,
    detached: process.platform !== "win32",
  });

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let receivedSignal;
    let forceKillTimer;
    let forceKillSettleTimer;
    let activeSamplePid;
    let deadlineTimer;
    const signalHandlers = new Map();
    const onMessage = (message) => {
      if (
        message?.kind === BENCHMARK_BUDGET_MESSAGE_KIND &&
        Number.isSafeInteger(message.timeoutMs) &&
        message.timeoutMs > 0 &&
        !timedOut &&
        !receivedSignal
      ) {
        const totalTimeoutMs = message.timeoutMs + terminationGraceMs;
        if (Number.isSafeInteger(totalTimeoutMs)) {
          scheduleDeadline(totalTimeoutMs);
        }
      } else if (
        message?.kind === ACTIVE_SAMPLE_MESSAGE_KIND &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 1
      ) {
        activeSamplePid = message.pid;
      } else if (message?.kind === CLEARED_SAMPLE_MESSAGE_KIND && message.pid === activeSamplePid) {
        activeSamplePid = undefined;
      }
    };
    const terminateActiveSample = () => {
      if (!activeSamplePid) {
        return;
      }
      const pid = activeSamplePid;
      activeSamplePid = undefined;
      terminateManagedChild(
        {
          pid,
          kill: (signal) => {
            try {
              return process.kill(pid, signal);
            } catch {
              return false;
            }
          },
        },
        "SIGKILL",
      );
    };
    const finish = (status, signal, abandonChild = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceKillSettleTimer) {
        clearTimeout(forceKillSettleTimer);
      }
      for (const [forwardedSignal, handler] of signalHandlers) {
        process.off(forwardedSignal, handler);
      }
      child.off("error", onError);
      child.off("close", onClose);
      child.off("message", onMessage);
      if (abandonChild) {
        try {
          if (child.connected) {
            child.disconnect();
          }
        } catch {
          // The child may close its IPC channel while the settle deadline fires.
        }
        child.unref();
      }
      resolve({ receivedSignal, signal, status, timedOut });
    };
    const forceKillDriver = () => {
      terminateActiveSample();
      terminateManagedChild(child, "SIGKILL");
      forceKillSettleTimer ??= setTimeout(() => {
        // Signal delivery does not prove process exit. Drop the final parent
        // references so even an uninterruptible child cannot hang this updater.
        terminateActiveSample();
        finish(null, null, true);
      }, terminationGraceMs);
    };
    const terminateDriver = (signal) => {
      terminateManagedChild(child, signal);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
        forceKillDriver();
        return;
      }
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        forceKillDriver();
      }, terminationGraceMs);
    };
    const scheduleDeadline = (timeoutMs) => {
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        // The driver owns detached sample groups, so let it reap them before the
        // bounded force-kill fallback restores control to this updater.
        terminateDriver("SIGTERM");
      }, timeoutMs);
    };
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        receivedSignal ??= signal;
        clearTimeout(deadlineTimer);
        terminateDriver(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    scheduleDeadline(startupTimeoutMs);

    const onError = () => finish(null, null);
    const onClose = (status, signal) => {
      // Any still-reported sample outlived the driver cleanup path, regardless
      // of whether the driver timed out, was interrupted, or crashed independently.
      terminateActiveSample();
      finish(status, signal);
    };
    child.once("error", onError);
    child.once("close", onClose);
    child.on("message", onMessage);
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

const outputDestination = resolveOutputDestination(opts.out);
const temporaryOutput = prepareTemporaryOutput(outputDestination);
const temporaryOutputPath = temporaryOutput.path;
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
  temporaryOutputPath,
];

try {
  const run = await runBenchmarkDriver(args);

  if (run.status !== 0 || run.timedOut || run.receivedSignal) {
    process.exitCode = run.timedOut
      ? 1
      : run.receivedSignal
        ? signalExitCode(run.receivedSignal)
        : (run.status ?? 1);
  } else {
    publishBenchmarkOutput(temporaryOutputPath, outputDestination);
    console.log(`[test-update-cli-startup-bench] wrote fixture to ${opts.out}`);
  }
} finally {
  temporaryOutput.cleanup();
}
