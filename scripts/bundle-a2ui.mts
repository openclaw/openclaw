#!/usr/bin/env node
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  finalizeBuildStepCache,
  resolveBuildStepCacheState,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./lib/build-artifact-cache.mts";
import { resolvePnpmRunner } from "./pnpm-runner.mts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(rootDir, "extensions", "canvas");
const require = createRequire(path.join(pluginDir, "package.json"));
const outputFile =
  process.env.OPENCLAW_A2UI_BUNDLE_OUT ??
  path.join(pluginDir, "src", "host", "a2ui", "a2ui.bundle.js");
const outputV09File = process.env.OPENCLAW_A2UI_BUNDLE_OUT
  ? `${process.env.OPENCLAW_A2UI_BUNDLE_OUT}.v0.9.js`
  : path.join(pluginDir, "src", "host", "a2ui", "a2ui-v0.9.bundle.js");
const a2uiAppDir = path.join(pluginDir, "src", "host", "a2ui-app");

function fail(message: string) {
  console.error(message);
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function runStep(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    // Two small dialects do not benefit from native pools sized to a many-core host.
    env: {
      ...process.env,
      RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS?.trim() || "4",
      ROLLDOWN_WORKER_THREADS: process.env.ROLLDOWN_WORKER_THREADS?.trim() || "4",
    },
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runPnpm(pnpmArgs: string[]) {
  const runner = resolvePnpmRunner({
    pnpmArgs,
    nodeExecPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    comSpec: process.env.ComSpec,
    platform: process.platform,
  });
  runStep(runner.command, runner.args, {
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

async function main() {
  const hasAppDir = await pathExists(a2uiAppDir);
  const hasOutputFile = await pathExists(outputFile);
  const hasV09OutputFile = await pathExists(outputV09File);
  let hasA2uiPackage = true;
  try {
    require.resolve("@solidjs/compiler");
    require.resolve("@solidjs/web");
    require.resolve("solid-js");
    require.resolve("signal-utils/map");
    require.resolve("@a2ui/web_core/v0_9");
  } catch {
    hasA2uiPackage = false;
  }
  if (!hasA2uiPackage || !hasAppDir) {
    if (hasOutputFile && hasV09OutputFile) {
      console.log("A2UI package missing; keeping prebuilt bundle.");
      return;
    }
    if (process.env.OPENCLAW_SPARSE_PROFILE || process.env.OPENCLAW_A2UI_SKIP_MISSING === "1") {
      console.error(
        "A2UI package missing; skipping bundle because OPENCLAW_A2UI_SKIP_MISSING=1 or OPENCLAW_SPARSE_PROFILE is set.",
      );
      return;
    }
    fail(
      `A2UI package missing and no complete prebuilt bundle found at: ${outputFile}, ${outputV09File}`,
    );
  }

  const outputs = [outputFile, outputV09File].map((file) => path.relative(rootDir, file));
  const step: BuildCacheStep = {
    label: "canvas-a2ui",
    cache: {
      inputs: [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "patches",
        "extensions/canvas/package.json",
        "extensions/canvas/src/host/a2ui-app",
        "scripts/bundle-a2ui.mts",
        "scripts/pnpm-runner.mts",
        "scripts/windows-cmd-helpers.mjs",
        "scripts/lib/build-artifact-cache.mts",
      ],
      env: ["NODE_ENV", "SOURCE_DATE_EPOCH"],
      outputs,
      requiredOutputs: outputs,
    },
  };
  // Explicit output locations belong to callers, not the shared candidate cache.
  const cache =
    process.env.OPENCLAW_BUILD_CACHE !== "0" && !process.env.OPENCLAW_A2UI_BUNDLE_OUT
      ? resolveBuildStepCacheState(step, { rootDir })
      : undefined;
  if (cache?.fresh && (!cache.restorable || restoreBuildStepCacheOutputs(cache, { rootDir }))) {
    console.log("A2UI bundle up to date; shared artifacts reused.");
    return;
  }

  const localRolldownCli = [
    path.join(rootDir, "node_modules", "rolldown", "bin", "cli.mjs"),
    path.join(rootDir, "node_modules", ".pnpm", "node_modules", "rolldown", "bin", "cli.mjs"),
  ].find((candidate) => existsSync(candidate));

  const configPath = path.join(a2uiAppDir, "rolldown.config.mjs");
  if (localRolldownCli) {
    runStep(process.execPath, [localRolldownCli, "-c", configPath]);
  } else {
    runPnpm(["-s", "exec", "rolldown", "-c", configPath]);
  }

  if (cache) {
    finalizeBuildStepCache(step, cache, { rootDir });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
