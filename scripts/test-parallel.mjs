import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelTestPrefixes } from "../vitest.channel-paths.mjs";

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
  // Provider runtime contract imports plugin runtimes plus async ESM mocks;
  // keep it off the shared fast lane to avoid teardown stalls on this host.
  "src/plugins/contracts/runtime.contract.test.ts",
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
  // Uses temp repos + module cache resets; keep it off vmForks to avoid ref-resolution flakes.
  "src/infra/git-commit.test.ts",
  // Expensive schema build/bootstrap checks; keep coverage but run in isolated lane.
  "src/config/schema.test.ts",
  "src/config/schema.tags.test.ts",
  // CLI smoke/agent flows are stable but setup-heavy.
  "src/cli/program.smoke.test.ts",
  "src/commands/agent.test.ts",
  "src/media/store.test.ts",
  "src/media/store.header-ext.test.ts",
  "extensions/whatsapp/src/media.test.ts",
  "extensions/whatsapp/src/auto-reply.web-auto-reply.falls-back-text-media-send-fails.test.ts",
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
  // Skills discovery/snapshot suites are filesystem-heavy and high-variance in vmForks lanes.
  "src/agents/skills.test.ts",
  "src/agents/skills.buildworkspaceskillsnapshot.test.ts",
  "extensions/acpx/src/runtime.test.ts",
  // Shell-heavy script harness can contend under vmForks startup bursts.
  "test/scripts/ios-team-id.test.ts",
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
  "extensions/whatsapp/src/auto-reply.web-auto-reply.compresses-common-formats-jpeg-cap.test.ts",
  // Setup-heavy bot bootstrap suite.
  "extensions/telegram/src/bot.create-telegram-bot.test.ts",
  // Medium-heavy bot behavior suite; move off unit-fast critical path.
  "extensions/telegram/src/bot.test.ts",
  // Slack slash registration tests are setup-heavy and can bottleneck unit-fast.
  "extensions/slack/src/monitor/slash.test.ts",
  // Uses process-level unhandledRejection listeners; keep it off vmForks to avoid cross-file leakage.
  "extensions/imessage/src/monitor.shutdown.unhandled-rejection.test.ts",
  // Mutates process.cwd() and mocks core module loaders; isolate from the shared fast lane.
  "src/infra/git-commit.test.ts",
];
const unitIsolatedFiles = unitIsolatedFilesRaw.filter((file) => fs.existsSync(file));
const unitSingletonIsolatedFilesRaw = [
  // These pass clean in isolation but can hang on fork shutdown after sharing
  // the broad unit-fast lane on this host; keep them in dedicated processes.
  "src/cli/command-secret-gateway.test.ts",
];
const unitSingletonIsolatedFiles = unitSingletonIsolatedFilesRaw.filter((file) =>
  fs.existsSync(file),
);
const unitThreadSingletonFilesRaw = [
  // These suites terminate cleanly under the threads pool but can hang during
  // forks worker shutdown on this host.
  "src/channels/plugins/actions/actions.test.ts",
  "src/infra/outbound/deliver.test.ts",
  "src/infra/outbound/deliver.lifecycle.test.ts",
  "src/infra/outbound/message.channels.test.ts",
  "src/infra/outbound/message-action-runner.poll.test.ts",
  "src/tts/tts.test.ts",
];
const unitThreadSingletonFiles = unitThreadSingletonFilesRaw.filter((file) => fs.existsSync(file));
const unitVmForkSingletonFilesRaw = [
  "src/channels/plugins/contracts/inbound.telegram.contract.test.ts",
];
const unitVmForkSingletonFiles = unitVmForkSingletonFilesRaw.filter((file) => fs.existsSync(file));
const groupedUnitIsolatedFiles = unitIsolatedFiles.filter(
  (file) => !unitSingletonIsolatedFiles.includes(file) && !unitThreadSingletonFiles.includes(file),
);
const channelSingletonFilesRaw = [];
const channelSingletonFiles = channelSingletonFilesRaw.filter((file) => fs.existsSync(file));

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
// vmForks is a big win for transform/import heavy suites. Node 24 is stable again
// for the default unit-fast lane after moving the known flaky files to fork-only
// isolation, but Node 25+ still falls back to process forks until re-validated.
// Keep it opt-out via OPENCLAW_TEST_VM_FORKS=0, and let users force-enable with =1.
const supportsVmForks = Number.isFinite(nodeMajor) ? nodeMajor <= 24 : true;
const useVmForks =
  process.env.OPENCLAW_TEST_VM_FORKS === "1" ||
  (process.env.OPENCLAW_TEST_VM_FORKS !== "0" && !isWindows && supportsVmForks && !lowMemLocalHost);
const disableIsolation = process.env.OPENCLAW_TEST_NO_ISOLATE === "1";
const includeGatewaySuite = process.env.OPENCLAW_TEST_INCLUDE_GATEWAY === "1";
const includeExtensionsSuite = process.env.OPENCLAW_TEST_INCLUDE_EXTENSIONS === "1";
const rawTestProfile = process.env.OPENCLAW_TEST_PROFILE?.trim().toLowerCase();
const testProfile =
  rawTestProfile === "low" ||
  rawTestProfile === "max" ||
  rawTestProfile === "normal" ||
  rawTestProfile === "serial"
    ? rawTestProfile
    : "normal";
// Even on low-memory hosts, keep the isolated lane split so files like
// git-commit.test.ts still get the worker/process isolation they require.
const shouldSplitUnitRuns = testProfile !== "serial";
const runs = [
  ...(shouldSplitUnitRuns
    ? [
        {
          name: "unit-fast",
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            `--pool=${useVmForks ? "vmForks" : "forks"}`,
            ...(disableIsolation ? ["--isolate=false"] : []),
            ...[
              ...unitIsolatedFiles,
              ...unitSingletonIsolatedFiles,
              ...unitThreadSingletonFiles,
              ...unitVmForkSingletonFiles,
            ].flatMap((file) => ["--exclude", file]),
          ],
        },
        ...(groupedUnitIsolatedFiles.length > 0
          ? [
              {
                name: "unit-isolated",
                args: [
                  "vitest",
                  "run",
                  "--config",
                  "vitest.unit.config.ts",
                  "--pool=forks",
                  ...groupedUnitIsolatedFiles,
                ],
              },
            ]
          : []),
        ...unitSingletonIsolatedFiles.map((file) => ({
          name: `${path.basename(file, ".test.ts")}-isolated`,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            `--pool=${useVmForks ? "vmForks" : "forks"}`,
            file,
          ],
        })),
        ...unitThreadSingletonFiles.map((file) => ({
          name: `${path.basename(file, ".test.ts")}-threads`,
          args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=threads", file],
        })),
        ...unitVmForkSingletonFiles.map((file) => ({
          name: `${path.basename(file, ".test.ts")}-vmforks`,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            `--pool=${useVmForks ? "vmForks" : "forks"}`,
            ...(disableIsolation ? ["--isolate=false"] : []),
            file,
          ],
        })),
        ...channelSingletonFiles.map((file) => ({
          name: `${path.basename(file, ".test.ts")}-channels-isolated`,
          args: ["vitest", "run", "--config", "vitest.channels.config.ts", "--pool=forks", file],
        })),
      ]
    : [
        {
          name: "unit",
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            `--pool=${useVmForks ? "vmForks" : "forks"}`,
            ...(disableIsolation ? ["--isolate=false"] : []),
          ],
        },
      ]),
  ...(includeExtensionsSuite
    ? [
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
      ]
    : []),
  ...(includeGatewaySuite
    ? [
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
      ]
    : []),
];
const shardOverride = Number.parseInt(process.env.OPENCLAW_TEST_SHARDS ?? "", 10);
const configuredShardCount =
  Number.isFinite(shardOverride) && shardOverride > 1 ? shardOverride : null;
const shardCount = configuredShardCount ?? (isWindowsCi ? 2 : 1);
const shardIndexOverride = (() => {
  const parsed = Number.parseInt(process.env.OPENCLAW_TEST_SHARD_INDEX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();
const OPTION_TAKES_VALUE = new Set([
  "-t",
  "-c",
  "-r",
  "--testNamePattern",
  "--config",
  "--root",
  "--dir",
  "--reporter",
  "--outputFile",
  "--pool",
  "--execArgv",
  "--vmMemoryLimit",
  "--maxWorkers",
  "--environment",
  "--shard",
  "--changed",
  "--sequence",
  "--inspect",
  "--inspectBrk",
  "--testTimeout",
  "--hookTimeout",
  "--bail",
  "--retry",
  "--diff",
  "--exclude",
  "--project",
  "--slowTestThreshold",
  "--teardownTimeout",
  "--attachmentsDir",
  "--mode",
  "--api",
  "--browser",
  "--maxConcurrency",
  "--mergeReports",
  "--configLoader",
  "--experimental",
]);
const SINGLE_RUN_ONLY_FLAGS = new Set(["--coverage", "--outputFile", "--mergeReports"]);

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
const parsePassthroughArgs = (args) => {
  const fileFilters = [];
  const optionArgs = [];
  let consumeNextAsOptionValue = false;

  for (const arg of args) {
    if (consumeNextAsOptionValue) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = false;
      continue;
    }
    if (arg === "--") {
      optionArgs.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = !arg.includes("=") && OPTION_TAKES_VALUE.has(arg);
      continue;
    }
    fileFilters.push(arg);
  }

  return { fileFilters, optionArgs };
};
const { fileFilters: passthroughFileFilters, optionArgs: passthroughOptionArgs } =
  parsePassthroughArgs(passthroughArgs);
const passthroughRequiresSingleRun = passthroughOptionArgs.some((arg) => {
  if (!arg.startsWith("-")) {
    return false;
  }
  const [flag] = arg.split("=", 1);
  return SINGLE_RUN_ONLY_FLAGS.has(flag);
});
const baseConfigPrefixes = ["src/agents/", "src/auto-reply/", "src/commands/", "test/", "ui/"];
const normalizeRepoPath = (value) => value.split(path.sep).join("/");
const walkTestFiles = (rootDir) => {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      fullPath.endsWith(".test.ts") ||
      fullPath.endsWith(".live.test.ts") ||
      fullPath.endsWith(".e2e.test.ts")
    ) {
      files.push(normalizeRepoPath(fullPath));
    }
  }
  return files;
};
const allKnownTestFiles = [
  ...new Set([
    ...walkTestFiles("src"),
    ...walkTestFiles("extensions"),
    ...walkTestFiles("test"),
    ...walkTestFiles(path.join("ui", "src", "ui")),
  ]),
];
const inferTarget = (fileFilter) => {
  const isolated = unitIsolatedFiles.includes(fileFilter);
  if (fileFilter.endsWith(".live.test.ts")) {
    return { owner: "live", isolated };
  }
  if (fileFilter.endsWith(".e2e.test.ts")) {
    return { owner: "e2e", isolated };
  }
  if (channelTestPrefixes.some((prefix) => fileFilter.startsWith(prefix))) {
    return { owner: "channels", isolated };
  }
  if (fileFilter.startsWith("extensions/")) {
    return { owner: "extensions", isolated };
  }
  if (fileFilter.startsWith("src/gateway/")) {
    return { owner: "gateway", isolated };
  }
  if (baseConfigPrefixes.some((prefix) => fileFilter.startsWith(prefix))) {
    return { owner: "base", isolated };
  }
  if (fileFilter.startsWith("src/")) {
    return { owner: "unit", isolated };
  }
  return { owner: "base", isolated };
};
const resolveFilterMatches = (fileFilter) => {
  const normalizedFilter = normalizeRepoPath(fileFilter);
  if (fs.existsSync(fileFilter)) {
    const stats = fs.statSync(fileFilter);
    if (stats.isFile()) {
      return [normalizedFilter];
    }
    if (stats.isDirectory()) {
      const prefix = normalizedFilter.endsWith("/") ? normalizedFilter : `${normalizedFilter}/`;
      return allKnownTestFiles.filter((file) => file.startsWith(prefix));
    }
  }
  if (/[*?[\]{}]/.test(normalizedFilter)) {
    return allKnownTestFiles.filter((file) => path.matchesGlob(file, normalizedFilter));
  }
  return allKnownTestFiles.filter((file) => file.includes(normalizedFilter));
};
const isVmForkSingletonUnitFile = (fileFilter) => unitVmForkSingletonFiles.includes(fileFilter);
const isThreadSingletonUnitFile = (fileFilter) => unitThreadSingletonFiles.includes(fileFilter);
const createTargetedEntry = (owner, isolated, filters) => {
  const name = isolated ? `${owner}-isolated` : owner;
  const forceForks = isolated;
  if (owner === "unit-vmforks") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        `--pool=${useVmForks ? "vmForks" : "forks"}`,
        ...(disableIsolation ? ["--isolate=false"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "unit") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        `--pool=${forceForks ? "forks" : useVmForks ? "vmForks" : "forks"}`,
        ...(disableIsolation ? ["--isolate=false"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "unit-threads") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=threads", ...filters],
    };
  }
  if (owner === "extensions") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.extensions.config.ts",
        ...(forceForks ? ["--pool=forks"] : useVmForks ? ["--pool=vmForks"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "gateway") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.gateway.config.ts", "--pool=forks", ...filters],
    };
  }
  if (owner === "channels") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.channels.config.ts",
        ...(forceForks ? ["--pool=forks"] : useVmForks ? ["--pool=vmForks"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "live") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.live.config.ts", ...filters],
    };
  }
  if (owner === "e2e") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.e2e.config.ts", ...filters],
    };
  }
  return {
    name,
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      ...(forceForks ? ["--pool=forks"] : []),
      ...filters,
    ],
  };
};
const targetedEntries = (() => {
  if (passthroughFileFilters.length === 0) {
    return [];
  }
  const groups = passthroughFileFilters.reduce((acc, fileFilter) => {
    const matchedFiles = resolveFilterMatches(fileFilter);
    if (matchedFiles.length === 0) {
      const normalizedFile = normalizeRepoPath(fileFilter);
      const target = inferTarget(normalizedFile);
      const owner = isThreadSingletonUnitFile(normalizedFile)
        ? "unit-threads"
        : isVmForkSingletonUnitFile(normalizedFile)
          ? "unit-vmforks"
          : target.owner;
      const key = `${owner}:${target.isolated ? "isolated" : "default"}`;
      const files = acc.get(key) ?? [];
      files.push(normalizedFile);
      acc.set(key, files);
      return acc;
    }
    for (const matchedFile of matchedFiles) {
      const target = inferTarget(matchedFile);
      const owner = isThreadSingletonUnitFile(matchedFile)
        ? "unit-threads"
        : isVmForkSingletonUnitFile(matchedFile)
          ? "unit-vmforks"
          : target.owner;
      const key = `${owner}:${target.isolated ? "isolated" : "default"}`;
      const files = acc.get(key) ?? [];
      files.push(matchedFile);
      acc.set(key, files);
    }
    return acc;
  }, new Map());
  return Array.from(groups, ([key, filters]) => {
    const [owner, mode] = key.split(":");
    return createTargetedEntry(owner, mode === "isolated", [...new Set(filters)]);
  });
})();
// Node 25 local runs still show cross-process worker shutdown contention even
// after moving the known heavy files into singleton lanes.
const topLevelParallelEnabled =
  testProfile !== "low" && testProfile !== "serial" && !(!isCI && nodeMajor >= 25);
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
  if (name === "unit-isolated" || name.endsWith("-isolated")) {
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

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    const maxWorkers = maxWorkersForRun(entry.name);
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
          ...windowsCiArgs,
          ...extraArgs,
        ]
      : [...entryArgs, ...silentArgs, ...windowsCiArgs, ...extraArgs];
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

const run = async (entry, extraArgs = []) => {
  if (shardCount <= 1) {
    return runOnce(entry, extraArgs);
  }
  if (shardIndexOverride !== null) {
    return runOnce(entry, ["--shard", `${shardIndexOverride}/${shardCount}`, ...extraArgs]);
  }
  for (let shardIndex = 1; shardIndex <= shardCount; shardIndex += 1) {
    // eslint-disable-next-line no-await-in-loop
    const code = await runOnce(entry, ["--shard", `${shardIndex}/${shardCount}`, ...extraArgs]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
};

const runEntries = async (entries, extraArgs = []) => {
  if (topLevelParallelEnabled) {
    const codes = await Promise.all(entries.map((entry) => run(entry, extraArgs)));
    return codes.find((code) => code !== 0);
  }

  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const code = await run(entry, extraArgs);
    if (code !== 0) {
      return code;
    }
  }

  return undefined;
};

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (targetedEntries.length > 0) {
  if (passthroughRequiresSingleRun && targetedEntries.length > 1) {
    console.error(
      "[test-parallel] The provided Vitest args require a single run, but the selected test filters span multiple wrapper configs. Run one target/config at a time.",
    );
    process.exit(2);
  }
  const targetedParallelRuns = keepGatewaySerial
    ? targetedEntries.filter((entry) => entry.name !== "gateway")
    : targetedEntries;
  const targetedSerialRuns = keepGatewaySerial
    ? targetedEntries.filter((entry) => entry.name === "gateway")
    : [];
  const failedTargetedParallel = await runEntries(targetedParallelRuns, passthroughOptionArgs);
  if (failedTargetedParallel !== undefined) {
    process.exit(failedTargetedParallel);
  }
  for (const entry of targetedSerialRuns) {
    // eslint-disable-next-line no-await-in-loop
    const code = await run(entry, passthroughOptionArgs);
    if (code !== 0) {
      process.exit(code);
    }
  }
  process.exit(0);
}

if (passthroughRequiresSingleRun && passthroughOptionArgs.length > 0) {
  console.error(
    "[test-parallel] The provided Vitest args require a single run. Use the dedicated npm script for that workflow (for example `pnpm test:coverage`) or target a single test file/filter.",
  );
  process.exit(2);
}

const failedParallel = await runEntries(parallelRuns, passthroughOptionArgs);
if (failedParallel !== undefined) {
  process.exit(failedParallel);
}

for (const entry of serialRuns) {
  // eslint-disable-next-line no-await-in-loop
  const code = await run(entry, passthroughOptionArgs);
  if (code !== 0) {
    process.exit(code);
  }
}

process.exit(0);
