import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const unitIsolatedFiles = [
  "src/plugins/loader.test.ts",
  "src/plugins/tools.optional.test.ts",
  "src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts",
  "src/security/fix.test.ts",
  "src/utils.test.ts",
  "src/auto-reply/tool-meta.test.ts",
  "src/commands/auth-choice.test.ts",
  "src/media/store.header-ext.test.ts",
  "src/browser/server.covers-additional-endpoint-branches.test.ts",
  "src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts",
  "src/browser/server.agent-contract-snapshot-endpoints.test.ts",
  "src/browser/server.agent-contract-form-layout-act-commands.test.ts",
  "src/browser/server.serves-status-starts-browser-requested.test.ts",
  "src/browser/server.skips-default-maxchars-explicitly-set-zero.test.ts",
  "src/browser/server.auth-token-gates-http.test.ts",
  "src/browser/server-context.remote-tab-ops.test.ts",
  "src/browser/server-context.ensure-tab-available.prefers-last-target.test.ts",
];

const children = new Set();
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isMacOS = process.platform === "darwin" || process.env.RUNNER_OS === "macOS";
const isWindows = process.platform === "win32" || process.env.RUNNER_OS === "Windows";
const isWindowsCi = isCI && isWindows;
const useVmForks =
  process.env.OPENCLAW_TEST_VM_FORKS === "1" ||
  (process.env.OPENCLAW_TEST_VM_FORKS !== "0" && !isWindows);
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
      ...(useVmForks ? ["--pool=vmForks"] : []),
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
const overrideWorkers = Number.parseInt(process.env.OPENCLAW_TEST_WORKERS ?? "", 10);
const resolvedOverride =
  Number.isFinite(overrideWorkers) && overrideWorkers > 0 ? overrideWorkers : null;
// Keep gateway serial on Windows CI and CI by default; run in parallel locally
// for lower wall-clock time. CI can opt in via OPENCLAW_TEST_PARALLEL_GATEWAY=1.
const keepGatewaySerial =
  isWindowsCi ||
  process.env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
  (isCI && process.env.OPENCLAW_TEST_PARALLEL_GATEWAY !== "1");
const parallelRuns = keepGatewaySerial ? runs.filter((entry) => entry.name !== "gateway") : runs;
const serialRuns = keepGatewaySerial ? runs.filter((entry) => entry.name === "gateway") : [];
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const defaultUnitWorkers = localWorkers;
const defaultExtensionsWorkers = Math.max(1, Math.min(4, Math.floor(localWorkers / 4)));
const defaultGatewayWorkers = Math.max(1, Math.min(4, localWorkers));

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
    return 1;
  }
  if (name === "extensions") {
    return defaultExtensionsWorkers;
  }
  if (name === "gateway") {
    return defaultGatewayWorkers;
  }
  return defaultUnitWorkers;
};

const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
];

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
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      env: { ...process.env, VITEST_GROUP: entry.name, NODE_OPTIONS: nextNodeOptions },
      shell: process.platform === "win32",
    });
    children.add(child);
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
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: nextNodeOptions },
      shell: process.platform === "win32",
    });
    children.add(child);
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
