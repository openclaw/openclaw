import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// On Windows, `.cmd` launchers can fail with `spawn EINVAL` when invoked without a shell
// (especially under GitHub Actions + Git Bash). Use `shell: true` and let the shell resolve pnpm.
const pnpm = "pnpm";

const unitIsolatedFilesRaw = [
  "src/plugins/loader.test.ts",
  "src/plugins/tools.optional.test.ts",
  "src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts",
  "src/security/fix.test.ts",
  "src/security/audit.test.ts",
  "src/utils.test.ts",
  "src/auto-reply/tool-meta.test.ts",
  "src/auto-reply/envelope.test.ts",
  "src/commands/auth-choice.test.ts",
  "src/media/store.test.ts",
  "src/media/store.header-ext.test.ts",
  "src/web/media.test.ts",
  "src/web/auto-reply.web-auto-reply.falls-back-text-media-send-fails.test.ts",
  "src/browser/server.covers-additional-endpoint-branches.test.ts",
  "src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts",
  "src/browser/server.agent-contract-snapshot-endpoints.test.ts",
  "src/browser/server.agent-contract-form-layout-act-commands.test.ts",
  "src/browser/server.skips-default-maxchars-explicitly-set-zero.test.ts",
  "src/browser/server.auth-token-gates-http.test.ts",
  "src/browser/server-context.remote-tab-ops.test.ts",
  "src/browser/server-context.ensure-tab-available.prefers-last-target.test.ts",
  // Keep this high-variance heavy file off the unit-fast critical path.
  "src/auto-reply/reply.block-streaming.test.ts",
  // Integration test is process-heavy and can bottleneck unit-fast.
  "test/git-hooks-pre-commit.integration.test.ts",
  // Archive extraction/fixture-heavy suite; keep off unit-fast critical path.
  "src/hooks/install.test.ts",
  // Setup-heavy bot bootstrap suite.
  "src/telegram/bot.create-telegram-bot.test.ts",
  // Medium-heavy bot behavior suite; move off unit-fast critical path.
  "src/telegram/bot.test.ts",
  // Slack slash registration tests are setup-heavy and can bottleneck unit-fast.
  "src/slack/monitor/slash.test.ts",
  // Uses process-level unhandledRejection listeners; keep it off vmForks to avoid cross-file leakage.
  "src/imessage/monitor.shutdown.unhandled-rejection.test.ts",
];
const unitIsolatedFiles = unitIsolatedFilesRaw.filter((file) => fs.existsSync(file));

const children = new Set();
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isMacOS = process.platform === "darwin" || process.env.RUNNER_OS === "macOS";
const isWindows = process.platform === "win32" || process.env.RUNNER_OS === "Windows";
const isWindowsCi = isCI && isWindows;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
// vmForks is a big win for transform/import heavy suites, but Node 24 had
// regressions with Vitest's vm runtime in this repo. Keep it opt-out via
// OPENCLAW_TEST_VM_FORKS=0, and let users force-enable with =1.
const supportsVmForks = Number.isFinite(nodeMajor) ? nodeMajor !== 24 : true;
const useVmForks =
  process.env.OPENCLAW_TEST_VM_FORKS === "1" ||
  (process.env.OPENCLAW_TEST_VM_FORKS !== "0" && !isWindows && supportsVmForks);
const disableIsolation = process.env.OPENCLAW_TEST_NO_ISOLATE === "1";
const runs = [
  ...(useVmForks
    ? [
        {
          name: "unit-fast",
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=vmForks",
            ...(disableIsolation ? ["--isolate=false"] : []),
            ...unitIsolatedFiles.flatMap((file) => ["--exclude", file]),
          ],
        },
        {
          name: "unit-isolated",
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=forks",
            ...unitIsolatedFiles,
          ],
        },
      ]
    : [
        {
          name: "unit",
          args: ["vitest", "run", "--config", "vitest.unit.config.ts"],
        },
      ]),
  {
    name: "extensions",
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.extensions.config.ts",
      ...(useVmForks ? ["--pool=vmForks"] : []),
    ],
  },
  {
    name: "gateway",
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.gateway.config.ts",
      // Gateway tests are sensitive to vmForks behavior (global state + env stubs).
      // Keep them on process forks for determinism even when other suites use vmForks.
      "--pool=forks",
    ],
  },
];
const shardOverride = Number.parseInt(process.env.OPENCLAW_TEST_SHARDS ?? "", 10);
const shardCount = isWindowsCi
  ? Number.isFinite(shardOverride) && shardOverride > 1
    ? shardOverride
    : 2
  : 1;
const windowsCiArgs = isWindowsCi ? ["--dangerouslyIgnoreUnhandledErrors"] : [];
const silentArgs =
  process.env.OPENCLAW_TEST_SHOW_PASSED_LOGS === "1" ? [] : ["--silent=passed-only"];
const rawPassthroughArgs = process.argv.slice(2);
const passthroughArgs =
  rawPassthroughArgs[0] === "--" ? rawPassthroughArgs.slice(1) : rawPassthroughArgs;
const rawTestProfile = process.env.OPENCLAW_TEST_PROFILE?.trim().toLowerCase();
const testProfile =
  rawTestProfile === "low" ||
  rawTestProfile === "max" ||
  rawTestProfile === "normal" ||
  rawTestProfile === "serial"
    ? rawTestProfile
    : "normal";
const overrideWorkers = Number.parseInt(process.env.OPENCLAW_TEST_WORKERS ?? "", 10);
const resolvedOverride =
  Number.isFinite(overrideWorkers) && overrideWorkers > 0 ? overrideWorkers : null;
// Keep gateway serial on Windows CI and CI by default; run in parallel locally
// for lower wall-clock time. CI can opt in via OPENCLAW_TEST_PARALLEL_GATEWAY=1.
const keepGatewaySerial =
  isWindowsCi ||
  process.env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
  testProfile === "serial" ||
  (isCI && process.env.OPENCLAW_TEST_PARALLEL_GATEWAY !== "1");
const parallelRuns = keepGatewaySerial ? runs.filter((entry) => entry.name !== "gateway") : runs;
const serialRuns = keepGatewaySerial ? runs.filter((entry) => entry.name === "gateway") : [];
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const defaultWorkerBudget =
  testProfile === "low"
    ? {
        unit: 2,
        unitIsolated: 1,
        extensions: 1,
        gateway: 1,
      }
    : testProfile === "serial"
      ? {
          unit: 1,
          unitIsolated: 1,
          extensions: 1,
          gateway: 1,
        }
      : testProfile === "max"
        ? {
            unit: localWorkers,
            unitIsolated: Math.min(4, localWorkers),
            extensions: Math.max(1, Math.min(6, Math.floor(localWorkers / 2))),
            gateway: Math.max(1, Math.min(2, Math.floor(localWorkers / 4))),
          }
        : {
            // Local `pnpm test` runs multiple vitest groups concurrently;
            // keep per-group workers conservative to avoid pegging all cores.
            unit: Math.max(2, Math.min(8, Math.floor(localWorkers / 2))),
            unitIsolated: 1,
            extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
            gateway: 2,
          };

// Keep worker counts predictable for local runs; trim macOS CI workers to avoid worker crashes/OOM.
// In CI on linux/windows, prefer Vitest defaults to avoid cross-test interference from lower worker counts.
const maxWorkersForRun = (name) => {
  if (resolvedOverride) {
    return resolvedOverride;
  }
  if (isCI && !isMacOS) {
    return null;
  }
  if (isCI && isMacOS) {
    return 1;
  }
  if (name === "unit-isolated") {
    return defaultWorkerBudget.unitIsolated;
  }
  if (name === "extensions") {
    return defaultWorkerBudget.extensions;
  }
  if (name === "gateway") {
    return defaultWorkerBudget.gateway;
  }
  return defaultWorkerBudget.unit;
};

const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
  "--disable-warning=MaxListenersExceededWarning",
];

const DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB = 4096;
const maxOldSpaceSizeMb = (() => {
  // CI can hit Node heap limits (especially on large suites). Allow override, default to 4GB.
  const raw = process.env.OPENCLAW_TEST_MAX_OLD_SPACE_SIZE_MB ?? "";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  if (isCI && !isWindows) {
    return DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB;
  }
  return null;
})();

function resolveReportDir() {
  const raw = process.env.OPENCLAW_VITEST_REPORT_DIR?.trim();
  if (!raw) {
    return null;
  }
  try {
    fs.mkdirSync(raw, { recursive: true });
  } catch {
    return null;
  }
  return raw;
}

function buildReporterArgs(entry, extraArgs) {
  const reportDir = resolveReportDir();
  if (!reportDir) {
    return [];
  }

  // Vitest supports both `--shard 1/2` and `--shard=1/2`. We use it in the
  // split-arg form, so we need to read the next arg to avoid overwriting reports.
  const shardIndex = extraArgs.findIndex((arg) => arg === "--shard");
  const inlineShardArg = extraArgs.find(
    (arg) => typeof arg === "string" && arg.startsWith("--shard="),
  );
  const shardValue =
    shardIndex >= 0 && typeof extraArgs[shardIndex + 1] === "string"
      ? extraArgs[shardIndex + 1]
      : typeof inlineShardArg === "string"
        ? inlineShardArg.slice("--shard=".length)
        : "";
  const shardSuffix = shardValue
    ? `-shard${String(shardValue).replaceAll("/", "of").replaceAll(" ", "")}`
    : "";

  const outputFile = path.join(reportDir, `vitest-${entry.name}${shardSuffix}.json`);
  return ["--reporter=default", "--reporter=json", "--outputFile", outputFile];
}

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    const maxWorkers = maxWorkersForRun(entry.name);
    const reporterArgs = buildReporterArgs(entry, extraArgs);
    const args = maxWorkers
      ? [
          ...entry.args,
          "--maxWorkers",
          String(maxWorkers),
          ...silentArgs,
          ...reporterArgs,
          ...windowsCiArgs,
          ...extraArgs,
        ]
      : [...entry.args, ...silentArgs, ...reporterArgs, ...windowsCiArgs, ...extraArgs];
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    const nextNodeOptions = WARNING_SUPPRESSION_FLAGS.reduce(
      (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
      nodeOptions,
    );
    const heapFlag =
      maxOldSpaceSizeMb && !nextNodeOptions.includes("--max-old-space-size=")
        ? `--max-old-space-size=${maxOldSpaceSizeMb}`
        : null;
    const resolvedNodeOptions = heapFlag
      ? `${nextNodeOptions} ${heapFlag}`.trim()
      : nextNodeOptions;
    let child;
    try {
      child = spawn(pnpm, args, {
        stdio: "inherit",
        env: { ...process.env, VITEST_GROUP: entry.name, NODE_OPTIONS: resolvedNodeOptions },
        shell: isWindows,
      });
    } catch (err) {
      console.error(`[test-parallel] spawn failed: ${String(err)}`);
      resolve(1);
      return;
    }
    children.add(child);
    child.on("error", (err) => {
      console.error(`[test-parallel] child error: ${String(err)}`);
    });
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 1 : 0));
    });
  });

const run = async (entry) => {
  if (shardCount <= 1) {
    return runOnce(entry);
  }
  for (let shardIndex = 1; shardIndex <= shardCount; shardIndex += 1) {
    // eslint-disable-next-line no-await-in-loop
    const code = await runOnce(entry, ["--shard", `${shardIndex}/${shardCount}`]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
};

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (passthroughArgs.length > 0) {
  const maxWorkers = maxWorkersForRun("unit");
  const args = maxWorkers
    ? [
        "vitest",
        "run",
        "--maxWorkers",
        String(maxWorkers),
        ...silentArgs,
        ...windowsCiArgs,
        ...passthroughArgs,
      ]
    : ["vitest", "run", ...silentArgs, ...windowsCiArgs, ...passthroughArgs];
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const nextNodeOptions = WARNING_SUPPRESSION_FLAGS.reduce(
    (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
    nodeOptions,
  );
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(pnpm, args, {
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: nextNodeOptions },
        shell: isWindows,
      });
    } catch (err) {
      console.error(`[test-parallel] spawn failed: ${String(err)}`);
      resolve(1);
      return;
    }
    children.add(child);
    child.on("error", (err) => {
      console.error(`[test-parallel] child error: ${String(err)}`);
    });
    child.on("exit", (exitCode, signal) => {
      children.delete(child);
      resolve(exitCode ?? (signal ? 1 : 0));
    });
  });
  process.exit(Number(code) || 0);
}

const parallelCodes = await Promise.all(parallelRuns.map(run));
const failedParallel = parallelCodes.find((code) => code !== 0);
if (failedParallel !== undefined) {
  process.exit(failedParallel);
}

for (const entry of serialRuns) {
  // eslint-disable-next-line no-await-in-loop
  const code = await run(entry);
  if (code !== 0) {
    process.exit(code);
  }
}

process.exit(0);
