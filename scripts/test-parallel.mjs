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
  // Runtime source guard scans are sensitive to filesystem contention.
  "src/security/temp-path-guard.test.ts",
  "src/security/audit.test.ts",
  "src/utils.test.ts",
  "src/auto-reply/tool-meta.test.ts",
  "src/auto-reply/envelope.test.ts",
  "src/commands/auth-choice.test.ts",
  // Process supervision + docker setup suites are stable but setup-heavy.
  "src/process/supervisor/supervisor.test.ts",
  "src/docker-setup.test.ts",
  // Filesystem-heavy skills sync suite.
  "src/agents/skills.build-workspace-skills-prompt.syncs-merged-skills-into-target-workspace.test.ts",
  // Real git hook integration test; keep signal, move off unit-fast critical path.
  "test/git-hooks-pre-commit.test.ts",
  // Setup-heavy doctor command suites; keep them off the unit-fast critical path.
  "src/commands/doctor.warns-state-directory-is-missing.test.ts",
  "src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.test.ts",
  "src/commands/doctor.runs-legacy-state-migrations-yes-mode-without.test.ts",
  // Setup-heavy CLI update flow suite; move off unit-fast critical path.
  "src/cli/update-cli.test.ts",
  // Expensive schema build/bootstrap checks; keep coverage but run in isolated lane.
  "src/config/schema.test.ts",
  "src/config/schema.tags.test.ts",
  // CLI smoke/agent flows are stable but setup-heavy.
  "src/cli/program.smoke.test.ts",
  "src/commands/agent.test.ts",
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
  // Keep this high-variance heavy file off the unit-fast critical path.
  "src/auto-reply/reply.block-streaming.test.ts",
  // Archive extraction/fixture-heavy suite; keep off unit-fast critical path.
  "src/hooks/install.test.ts",
  // Download/extraction safety cases can spike under unit-fast contention.
  "src/agents/skills-install.download.test.ts",
  // Heavy runner/exec/archive suites are stable but contend on shared resources under vmForks.
  "src/agents/pi-embedded-runner.test.ts",
  "src/agents/bash-tools.test.ts",
  "src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts",
  "src/agents/bash-tools.exec.background-abort.test.ts",
  "src/agents/subagent-announce.format.test.ts",
  "src/infra/archive.test.ts",
  "src/cli/daemon-cli.coverage.test.ts",
  // Model normalization test imports config/model discovery stack; keep off unit-fast critical path.
  "src/agents/models-config.normalizes-gemini-3-ids-preview-google-providers.test.ts",
  // Auth profile rotation suite is retry-heavy and high-variance under vmForks contention.
  "src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts",
  // Heavy trigger command scenarios; keep off unit-fast critical path to reduce contention noise.
  "src/auto-reply/reply.triggers.trigger-handling.filters-usage-summary-current-model-provider.test.ts",
  "src/auto-reply/reply.triggers.trigger-handling.targets-active-session-native-stop.test.ts",
  "src/auto-reply/reply.triggers.group-intro-prompts.test.ts",
  "src/auto-reply/reply.triggers.trigger-handling.handles-inline-commands-strips-it-before-agent.test.ts",
  "src/web/auto-reply.web-auto-reply.compresses-common-formats-jpeg-cap.test.ts",
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
const hostCpuCount = os.cpus().length;
const hostMemoryGiB = Math.floor(os.totalmem() / 1024 ** 3);
// Keep aggressive local defaults for high-memory workstations (Mac Studio class).
const highMemLocalHost = !isCI && hostMemoryGiB >= 96;
const lowMemLocalHost = !isCI && hostMemoryGiB < 64;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
// vmForks is a big win for transform/import heavy suites, but Node 24 had
// regressions with Vitest's vm runtime in this repo, and low-memory local hosts
// are more likely to hit per-worker V8 heap ceilings. Keep it opt-out via
// OPENCLAW_TEST_VM_FORKS=0, and let users force-enable with =1.
const supportsVmForks = Number.isFinite(nodeMajor) ? nodeMajor !== 24 : true;
const useVmForks =
  process.env.OPENCLAW_TEST_VM_FORKS === "1" ||
  (process.env.OPENCLAW_TEST_VM_FORKS !== "0" && !isWindows && supportsVmForks && !lowMemLocalHost);
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
const configuredShardCount =
  Number.isFinite(shardOverride) && shardOverride > 1 ? shardOverride : null;
const shardCount = configuredShardCount ?? (isWindowsCi ? 2 : 1);
const shardIndexOverride = (() => {
  const parsed = Number.parseInt(process.env.OPENCLAW_TEST_SHARD_INDEX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();

if (shardIndexOverride !== null && shardCount <= 1) {
  console.error(
    `[test-parallel] OPENCLAW_TEST_SHARD_INDEX=${String(
      shardIndexOverride,
    )} requires OPENCLAW_TEST_SHARDS>1.`,
  );
  process.exit(2);
}

if (shardIndexOverride !== null && shardIndexOverride > shardCount) {
  console.error(
    `[test-parallel] OPENCLAW_TEST_SHARD_INDEX=${String(
      shardIndexOverride,
    )} exceeds OPENCLAW_TEST_SHARDS=${String(shardCount)}.`,
  );
  process.exit(2);
}
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
const parallelGatewayEnabled =
  process.env.OPENCLAW_TEST_PARALLEL_GATEWAY === "1" || (!isCI && highMemLocalHost);
// Keep gateway serial by default except when explicitly requested or on high-memory local hosts.
const keepGatewaySerial =
  isWindowsCi ||
  process.env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
  testProfile === "serial" ||
  !parallelGatewayEnabled;
const parallelRuns = keepGatewaySerial ? runs.filter((entry) => entry.name !== "gateway") : runs;
const serialRuns = keepGatewaySerial ? runs.filter((entry) => entry.name === "gateway") : [];
const baseLocalWorkers = Math.max(4, Math.min(16, hostCpuCount));
const loadAwareDisabledRaw = process.env.OPENCLAW_TEST_LOAD_AWARE?.trim().toLowerCase();
const loadAwareDisabled = loadAwareDisabledRaw === "0" || loadAwareDisabledRaw === "false";
const loadRatio =
  !isCI && !loadAwareDisabled && process.platform !== "win32" && hostCpuCount > 0
    ? os.loadavg()[0] / hostCpuCount
    : 0;
// Keep the fast-path unchanged on normal load; only throttle under extreme host pressure.
const extremeLoadScale = loadRatio >= 1.1 ? 0.75 : loadRatio >= 1 ? 0.85 : 1;
const localWorkers = Math.max(4, Math.min(16, Math.floor(baseLocalWorkers * extremeLoadScale)));
const defaultWorkerBudget =
  testProfile === "low"
    ? {
        unit: 2,
        unitIsolated: 1,
        extensions: 4,
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
        : highMemLocalHost
          ? {
              // High-memory local hosts can prioritize wall-clock speed.
              unit: Math.max(4, Math.min(14, Math.floor((localWorkers * 7) / 8))),
              unitIsolated: Math.max(1, Math.min(2, Math.floor(localWorkers / 6) || 1)),
              extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
              gateway: Math.max(2, Math.min(6, Math.floor(localWorkers / 2))),
            }
          : lowMemLocalHost
            ? {
                // Sub-64 GiB local hosts are prone to OOM with large vmFork runs.
                unit: 2,
                unitIsolated: 1,
                extensions: 4,
                gateway: 1,
              }
            : {
                // 64-95 GiB local hosts: conservative split with some parallel headroom.
                unit: Math.max(2, Math.min(8, Math.floor(localWorkers / 2))),
                unitIsolated: 1,
                extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
                gateway: 1,
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
    // vmForks with a single worker has shown cross-file leakage in extension suites.
    // Fall back to process forks when we intentionally clamp that lane to one worker.
    const entryArgs =
      entry.name === "extensions" && maxWorkers === 1 && entry.args.includes("--pool=vmForks")
        ? entry.args.map((arg) => (arg === "--pool=vmForks" ? "--pool=forks" : arg))
        : entry.args;
    const args = maxWorkers
      ? [
          ...entryArgs,
          "--maxWorkers",
          String(maxWorkers),
          ...silentArgs,
          ...reporterArgs,
          ...windowsCiArgs,
          ...extraArgs,
        ]
      : [...entryArgs, ...silentArgs, ...reporterArgs, ...windowsCiArgs, ...extraArgs];
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
  if (shardIndexOverride !== null) {
    return runOnce(entry, ["--shard", `${shardIndexOverride}/${shardCount}`]);
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
