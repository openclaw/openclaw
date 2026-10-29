// Run the producer's parallel source checks with one full compiled-worker owner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";
import {
  resolveSharedVitestCompilerEnv,
  resolveVitestProcessEnv,
} from "./lib/vitest-process-env.mts";
import { getVitestWorkerDescriptor } from "./lib/vitest-worker-descriptor.mts";
import { createVitestWorkerRun } from "./lib/vitest-worker-run.mts";

async function runBuiltSourceVerifiers(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // The caller retains the independent path when compiler environments differ.
  if (env.CHANNEL_NODE_OPTIONS !== "--max-old-space-size=8192") {
    throw new Error("Shared built source verifiers require matching compiler Node options");
  }
  const runnerTemp = env.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new Error("Shared built source verifiers require RUNNER_TEMP");
  }
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal;
  };

  const checks = [
    {
      name: "channels",
      config: "test/vitest/vitest.channels.config.ts",
      maxWorkers: env.CHANNEL_MAX_WORKERS,
    },
    {
      name: "core-support-boundary",
      config: "test/vitest/vitest.full-core-support-boundary.config.ts",
      maxWorkers: "2",
    },
  ].map((check) => ({
    name: check.name,
    config: check.config,
    env: resolveVitestProcessEnv({
      ...env,
      NODE_OPTIONS: env.CHANNEL_NODE_OPTIONS,
      OPENCLAW_VITEST_MAX_WORKERS: check.maxWorkers,
    }),
  }));
  // Tests retain their individual limits; only compiler preparation shares the intersection.
  const compilerEnv = resolveSharedVitestCompilerEnv(checks.map((check) => check.env));
  const workers = createVitestWorkerRun(compilerEnv, getVitestWorkerDescriptor(), "full");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const run = async (check: (typeof checks)[number]) => {
    const logPath = path.join(runnerTemp, `${check.name}.log`);
    const log = fs.openSync(logPath, "w");
    const completion = Promise.withResolvers<number>();
    let borrower: Promise<number> | undefined;
    try {
      const code = await runManagedCommand({
        bin: process.execPath,
        args: [
          fileURLToPath(new URL("./lib/vitest-worker-bootstrap.mts", import.meta.url)),
          workers.descriptor.directory,
          "scripts/run-vitest.mjs",
          "run",
          "--config",
          check.config,
        ],
        env: {
          ...check.env,
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
            runnerTemp,
            "vitest-module-cache",
            check.name,
          ),
        },
        stdio: ["inherit", log, log, "ipc"],
        onReady(child) {
          borrower = workers.borrow(child, completion.promise);
        },
        onSignal,
        requireProcessTreeExit: true,
        waitForCleanupRelease: true,
      });
      completion.resolve(code);
      return code;
    } catch (error) {
      if (borrower) {
        completion.reject(error);
      }
      throw error;
    } finally {
      try {
        await borrower;
      } finally {
        fs.closeSync(log);
      }
    }
  };

  let code = 0;
  try {
    const outcomes = await Promise.allSettled(checks.map(run));
    for (const [index, outcome] of outcomes.entries()) {
      const check = checks[index]!;
      console.log(`::group::${check.name} log`);
      process.stdout.write(fs.readFileSync(path.join(runnerTemp, `${check.name}.log`)));
      console.log("::endgroup::");
      if (outcome.status === "rejected" || outcome.value !== 0) {
        code = 1;
        console.error(`::error title=${check.name} failed::${check.name} failed`);
        if (outcome.status === "rejected") {
          console.error(outcome.reason);
        }
      }
    }
  } finally {
    try {
      await workers.dispose({ interrupted: Boolean(receivedSignal) });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  return receivedSignal ? signalExitCode(receivedSignal) : code;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runBuiltSourceVerifiers().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
