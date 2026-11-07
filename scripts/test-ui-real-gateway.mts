// Spend the existing two UI worker slots on desktop + serial, then qualified fixtures.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createPrebuiltUiE2eVitestConfig } from "../test/vitest/vitest.ui-e2e-prebuilt.config.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  runManagedCommand,
  signalExitCode,
  type RunManagedCommandOptions,
} from "./lib/managed-child-process.mts";
import { createVitestCacheSlots, resolveVitestCacheRoot } from "./lib/vitest-cache-slots.mts";
import { mergeVitestExitCodes } from "./lib/vitest-outcome.mts";
import { resolveVitestProcessEnv } from "./lib/vitest-process-env.mts";
import { getVitestWorkerDescriptor } from "./lib/vitest-worker-descriptor.mts";
import { createVitestWorkerRun, type VitestWorkerRun } from "./lib/vitest-worker-run.mts";

const configPath = "test/vitest/vitest.ui-e2e-prebuilt.config.ts";
const desktopFile = "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts";

export async function runRealGatewayUiTests(
  reporterArgs: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const config = createPrebuiltUiE2eVitestConfig(env, []);
  const workers = config.test!.maxWorkers;
  const runDesktop = env.OPENCLAW_UI_E2E_RUN_DESKTOP === "true";
  const desktopEnv: NodeJS.ProcessEnv = { ...env, OPENCLAW_VITEST_MAX_WORKERS: "1" };
  delete desktopEnv.OPENCLAW_VITEST_INCLUDE_FILE;
  delete desktopEnv.OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE;
  let receivedSignal: NodeJS.Signals | undefined;
  let compiledWorkers: VitestWorkerRun | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal;
  };
  const withCache = createVitestCacheSlots();
  const run = async (args: string[], childEnv = env, workerRun?: VitestWorkerRun) => {
    return withCache(
      {
        config: configPath,
        env: childEnv,
        watchMode: false,
        ...(env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.trim()
          ? {}
          : { cacheAssignment: { kind: "scheduler" as const, root: resolveVitestCacheRoot(env) } }),
      },
      async ({ env: assignedEnv }) => {
        if (receivedSignal) {
          return { code: signalExitCode(receivedSignal), groupJoined: true };
        }
        const launch = (onReady?: RunManagedCommandOptions["onReady"]) =>
          runManagedCommand({
            bin: process.execPath,
            args: workerRun
              ? [
                  fileURLToPath(new URL("./lib/vitest-worker-bootstrap.mts", import.meta.url)),
                  workerRun.descriptor.directory,
                  ...(workerRun.descriptor.preset === "runtime" ? ["--worker-preset=runtime"] : []),
                  ...args,
                ]
              : args,
            env: assignedEnv,
            stdio: workerRun ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
            onReady,
            onSignal,
            requireProcessTreeExit: true,
            waitForCleanupRelease: true,
          });
        const code = await (workerRun ? workerRun.withBorrower(launch) : launch());
        return { code, groupJoined: true };
      },
    ).then(({ code }) => code);
  };
  const vitest = (projects: string[] = [], maxWorkers = workers) =>
    run(
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        configPath,
        "--configLoader",
        "runner",
        ...reporterArgs,
        "--maxWorkers",
        String(maxWorkers),
        ...projects.flatMap((project) => ["--project", project]),
        "--exclude",
        desktopFile,
      ],
      env,
      compiledWorkers,
    );
  const desktop = async () => {
    const code = await run(["--import", "tsx", "scripts/test-desktop-resize-real.mts"], desktopEnv);
    if (code > 1) {
      return code;
    }
    // The desktop bootstrap reports assertion and cleanup failures with the same exit code.
    const receipt: unknown = JSON.parse(
      await readFile(
        path.join(".artifacts/control-ui-e2e/real-gateway/desktop-resize", "receipt.json"),
        "utf8",
      ),
    );
    const cleanup = isRecord(receipt) ? receipt.cleanup : undefined;
    if (
      !isRecord(cleanup) ||
      cleanup.joined !== true ||
      cleanup.unjoinedWork !== false ||
      cleanup.testOwnersClosed !== true ||
      cleanup.listenersClosed !== true
    ) {
      throw new Error("Desktop cleanup did not join; refusing further UI fixtures");
    }
    return code;
  };
  if (!runDesktop) {
    return vitest();
  }
  // An explicitly owned cache leaf cannot be split between concurrent writers.
  if (workers !== 2 || env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.trim()) {
    const desktopCode = await desktop();
    if (desktopCode > 1) {
      return desktopCode;
    }
    return mergeVitestExitCodes(desktopCode, await vitest());
  }
  const projects = config.test!.projects!;
  const selected = (names: string[]) =>
    names.filter((name) =>
      projects.some(
        (project) =>
          typeof project === "object" &&
          project !== null &&
          "test" in project &&
          project.test?.name === name &&
          project.test.include?.some((file) => file !== desktopFile),
      ),
    );
  const serial = selected(["ui-e2e-serial", "ui-e2e-serial-standalone"]);
  const qualified = selected(["ui-e2e-real-gateway", "ui-e2e-real-gateway-standalone"]);
  // The two Vitest phases borrow one generation; the desktop carrier owns its separate lifecycle.
  if (serial.length && qualified.length) {
    compiledWorkers = createVitestWorkerRun(
      resolveVitestProcessEnv(env),
      getVitestWorkerDescriptor(),
      "runtime",
    );
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let code = 0;
  try {
    const outcomes = await Promise.allSettled([
      serial.length ? vitest(serial, 1) : Promise.resolve(0),
      desktop(),
    ]);
    const errors = outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "UI proof phase or cleanup failed");
    }
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        code = mergeVitestExitCodes(code, outcome.value);
      }
    }
    if (code <= 1 && qualified.length) {
      code = mergeVitestExitCodes(code, await vitest(qualified));
    }
  } finally {
    try {
      await compiledWorkers?.dispose({ interrupted: Boolean(receivedSignal) });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  return receivedSignal ? signalExitCode(receivedSignal) : code;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runRealGatewayUiTests().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
