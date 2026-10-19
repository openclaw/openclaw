import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateManagedChild } from "./lib/managed-child-process.mts";
import { isCiEnvironment, requirePinnedBun } from "./lib/pinned-bun.mts";
import { resolveTestRuntime } from "./lib/test-runtime.mts";
import { resolveVitestCliEntry } from "./lib/vitest-build-prerequisites.mts";
import { resolveVitestHomeSelection } from "./lib/vitest-home-selection.mts";
import { resolveVitestNoOutputTimeoutMs } from "./lib/vitest-process-env.mts";
import { exitVitestBySignal, spawnOwnedVitestProcess } from "./lib/vitest-process.mts";
import { resolveVitestTestCommand } from "./lib/vitest-test-runtime.mts";
import { createVitestWorkerRun } from "./lib/vitest-worker-run.mts";
import {
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mts";

function testLiveUsage() {
  return [
    "Usage: node --import tsx scripts/test-live.mts [options] [--] [vitest targets/args...]",
    "",
    "Runs live Vitest suites with OPENCLAW_LIVE_TEST=1.",
    "",
    "Options:",
    "  --codex-harness        Enable the live Codex harness.",
    "  --quiet, --quiet-live  Keep live test output quiet.",
    "  --no-quiet, --no-quiet-live",
    "                         Show live test output.",
    "  -h, --help             Show this help without starting live tests.",
  ].join("\n");
}

export function parseTestLiveArgs(argv: string[]) {
  const forwardedArgs: string[] = [];
  let quietOverride: "0" | "1" | undefined;
  let forceCodexHarness = false;
  let help = false;
  let passthrough = false;

  for (const arg of argv) {
    if (passthrough) {
      forwardedArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--codex-harness") {
      forceCodexHarness = true;
      continue;
    }
    if (arg === "--quiet" || arg === "--quiet-live") {
      quietOverride = "1";
      continue;
    }
    if (arg === "--no-quiet" || arg === "--no-quiet-live") {
      quietOverride = "0";
      continue;
    }
    forwardedArgs.push(arg);
  }
  return {
    forceCodexHarness,
    forwardedArgs,
    help,
    quietOverride,
  };
}

export type TestLiveArgs = ReturnType<typeof parseTestLiveArgs>;

export function buildTestLiveEnv(args: TestLiveArgs, baseEnv = process.env) {
  return {
    ...baseEnv,
    CI: baseEnv.CI || "1",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: baseEnv.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN || "false",
    pnpm_config_verify_deps_before_run: baseEnv.pnpm_config_verify_deps_before_run || "false",
    OPENCLAW_LIVE_TEST: baseEnv.OPENCLAW_LIVE_TEST || "1",
    OPENCLAW_LIVE_TEST_QUIET: args.quietOverride ?? baseEnv.OPENCLAW_LIVE_TEST_QUIET ?? "1",
    ...(args.forceCodexHarness ? { OPENCLAW_LIVE_CODEX_HARNESS: "1" } : {}),
  };
}

export function resolveTestLiveHeartbeatMs(baseEnv = process.env) {
  const value = baseEnv.OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS;
  if (value === undefined || value === "") {
    return 20_000;
  }
  const text = value.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: ${text}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: ${text}`);
  }
  return parsed;
}

export function buildTestLiveVitestArgs(args: TestLiveArgs) {
  return ["run", "--config", "test/vitest/vitest.live.config.ts", ...args.forwardedArgs];
}

export async function main(argv = process.argv.slice(2), baseEnv = process.env) {
  const args = parseTestLiveArgs(argv);
  if (args.help) {
    console.log(testLiveUsage());
    return;
  }

  const runtime = resolveTestRuntime(baseEnv);
  const env = {
    ...buildTestLiveEnv(args, baseEnv),
    OPENCLAW_VITEST_RUNTIME: runtime,
    // The child's noninteractive CI default must not replace a local cached fork
    // with PATH Bun. Bind it first; the launch still verifies its pinned revision.
    ...(runtime === "bun" && !isCiEnvironment(baseEnv)
      ? { OPENCLAW_BUN_PATH: requirePinnedBun(baseEnv) }
      : {}),
  };
  const heartbeatMs = resolveTestLiveHeartbeatMs(baseEnv);
  const noOutputTimeoutMs = resolveVitestNoOutputTimeoutMs(baseEnv);
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let timedOut = false;

  const vitestArgs = buildTestLiveVitestArgs(args);
  const testCommand = resolveVitestTestCommand(
    [resolveVitestCliEntry({ env }), ...vitestArgs],
    env,
  );
  // Live suites need the same compiled native owners as ordinary tests; source
  // loaders cannot acquire Linux subreaper custody. Join every borrower before cleanup.
  const workers = createVitestWorkerRun(env);
  const cliIndex = testCommand.args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
  testCommand.args.splice(
    cliIndex,
    0,
    fileURLToPath(new URL("./lib/vitest-worker-bootstrap.mts", import.meta.url)),
    workers.descriptor.directory,
  );
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const { child, completion } = spawnOwnedVitestProcess({
      ...testCommand,
      options: {
        detached: shouldUseDetachedVitestProcessGroup(),
        env: { ...env, ...testCommand.envOverrides },
        stdio: ["inherit", "pipe", "pipe", "ipc"],
      },
      homeMode: resolveVitestHomeSelection(vitestArgs, { env }),
    });
    const childCleanup = installVitestProcessGroupCleanup({
      child,
      forceSignal: "SIGKILL",
      forceSignalDelayMs: 100,
    });

    const teardown = () => {
      clearInterval(heartbeat);
      childCleanup.teardown();
    };

    const noteOutput = () => {
      lastOutputAt = Date.now();
      lastHeartbeatAt = lastOutputAt;
    };

    child.stdout?.on("data", (chunk) => {
      noteOutput();
      process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      noteOutput();
      process.stderr.write(chunk);
    });

    const heartbeat = setInterval(
      () => {
        const now = Date.now();
        const quietMs = now - lastOutputAt;
        if (noOutputTimeoutMs !== null && quietMs >= noOutputTimeoutMs) {
          timedOut = true;
          clearInterval(heartbeat);
          process.stderr.write(
            `[test:live] no output for ${noOutputTimeoutMs}ms; terminating stalled Vitest process group\n`,
          );
          terminateManagedChild(child, "SIGKILL");
          return;
        }
        if (quietMs < heartbeatMs || now - lastHeartbeatAt < heartbeatMs) {
          return;
        }
        const elapsedSec = Math.max(1, Math.round((now - startedAt) / 1_000));
        const quietSec = Math.max(1, Math.round(quietMs / 1_000));
        process.stderr.write(
          `[test:live] still running (${elapsedSec}s elapsed, ${quietSec}s since last output)\n`,
        );
        lastHeartbeatAt = now;
      },
      Math.min(heartbeatMs, noOutputTimeoutMs ?? heartbeatMs),
    );
    heartbeat.unref?.();

    try {
      const { code, signal } = await workers.borrow(child, completion, noteOutput);
      interrupted ??=
        childCleanup.getForwardedSignal() ?? (timedOut ? undefined : (signal ?? undefined));
      if (signal && !timedOut && !childCleanup.getForwardedSignal()) {
        process.stderr.write(`[test:live] vitest exited via signal=${signal}\n`);
      }
      if ((code ?? 1) !== 0 && !interrupted) {
        process.stderr.write(`[test:live] vitest exited code=${code ?? 1}\n`);
      }
      process.exitCode = timedOut ? 1 : (code ?? 1);
    } finally {
      teardown();
    }
  } finally {
    try {
      await workers.dispose();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (interrupted) {
        await exitVitestBySignal(interrupted);
      }
    }
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
