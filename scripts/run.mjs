#!/usr/bin/env node
/**
 * Runtime-agnostic script runner for openclaw.
 * Uses OPENCLAW_RUNTIME env var to determine whether to use node or bun.
 * Defaults to node for backward compatibility.
 *
 * Usage: node scripts/run.mjs [script-args...]
 * Or with bun: OPENCLAW_RUNTIME=bun bun scripts/run.mjs [script-args...]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();

// Determine runtime
const useBun = env.OPENCLAW_RUNTIME === "bun";
const runtime = useBun ? "bun" : "node";
const runtimeExec = useBun ? "bun" : process.execPath;

// Check if bun is available when requested
if (useBun) {
  try {
    // Verify bun exists
    const { execSync } = await import("node:child_process");
    execSync("which bun", { stdio: "ignore" });
  } catch {
    console.error("[openclaw] Error: OPENCLAW_RUNTIME=bun is set but 'bun' command not found.");
    console.error("[openclaw] Please install bun: https://bun.sh/docs/installation");
    console.error("[openclaw] Or unset OPENCLAW_RUNTIME to use node (default).");
    process.exit(1);
  }
}

const compilerOverride = env.OPENCLAW_TS_COMPILER ?? env.CLAWDBOT_TS_COMPILER;
const compiler = compilerOverride === "tsc" ? "tsc" : "tsgo";
const projectArgs = ["--project", "tsconfig.json"];

const distRoot = path.join(cwd, "dist");
const distEntry = path.join(distRoot, "/entry.js");
const buildStampPath = path.join(distRoot, ".buildstamp");
const srcRoot = path.join(cwd, "src");
const configFiles = [path.join(cwd, "tsconfig.json"), path.join(cwd, "package.json")];

const statMtime = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return false;
  }
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const shouldBuild = () => {
  if (env.OPENCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stampMtime = statMtime(buildStampPath);
  if (stampMtime == null) {
    return true;
  }
  if (statMtime(distEntry) == null) {
    return true;
  }

  for (const filePath of configFiles) {
    const mtime = statMtime(filePath);
    if (mtime != null && mtime > stampMtime) {
      return true;
    }
  }

  const srcMtime = findLatestMtime(srcRoot, isExcludedSource);
  if (srcMtime != null && srcMtime > stampMtime) {
    return true;
  }
  return false;
};

const logRunner = (message) => {
  if (env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  process.stderr.write(`[openclaw:${runtime}] ${message}\n`);
};

const runApp = () => {
  const entryScript = useBun ? "openclaw-bun.mjs" : "openclaw.mjs";
  const appProcess = spawn(runtimeExec, [entryScript, ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  appProcess.on("exit", (exitCode, exitSignal) => {
    if (exitSignal) {
      process.exit(1);
    }
    process.exit(exitCode ?? 1);
  });
};

const writeBuildStamp = () => {
  try {
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(buildStampPath, `${Date.now()}\n`);
  } catch (error) {
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
  }
};

if (!shouldBuild()) {
  runApp();
} else {
  logRunner("Building TypeScript (dist is stale).");

  // Determine build command based on runtime
  let buildCmd;
  let buildArgs;

  if (useBun) {
    // Bun has native TypeScript support
    buildCmd = "bun";
    buildArgs = ["build", "./src/entry.ts", "--outdir", "./dist", "--target", "node"];
    // Note: Bun build is different, may need adjustment based on project structure
    // For now, fall back to tsc with bun runtime
    buildCmd = "bun";
    buildArgs = ["x", compiler, ...projectArgs];
  } else {
    const pnpmArgs = ["exec", compiler, ...projectArgs];
    buildCmd = process.platform === "win32" ? "cmd.exe" : "pnpm";
    buildArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...pnpmArgs] : pnpmArgs;
  }

  const build = spawn(buildCmd, buildArgs, {
    cwd,
    env,
    stdio: "inherit",
  });

  build.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    if (code !== 0 && code !== null) {
      process.exit(code);
    }
    writeBuildStamp();
    runApp();
  });
}
