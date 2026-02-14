#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const compiler = "tsdown";
const compilerArgs = ["exec", compiler, "--no-clean"];

const distRoot = path.join(cwd, "dist");
const distEntry = path.join(distRoot, "/entry.js");
const buildStampPath = path.join(distRoot, ".buildstamp");
const srcRoot = path.join(cwd, "src");
const configFiles = [path.join(cwd, "tsconfig.json"), path.join(cwd, "package.json")];
const gitWatchedPaths = ["src", "tsconfig.json", "package.json"];

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

const runGit = (args) => {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
};

const resolveGitHead = () => {
  const head = runGit(["rev-parse", "HEAD"]);
  return head || null;
};

const hasDirtySourceTree = () => {
  const output = runGit([
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--",
    ...gitWatchedPaths,
  ]);
  if (output === null) {
    return null;
  }
  return output.length > 0;
};

const readBuildStamp = () => {
  const mtime = statMtime(buildStampPath);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = fs.readFileSync(buildStampPath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return { mtime, head };
  } catch {
    return { mtime, head: null };
  }
};

const hasSourceMtimeChanged = (stampMtime) => {
  const srcMtime = findLatestMtime(srcRoot, isExcludedSource);
  return srcMtime != null && srcMtime > stampMtime;
};

const shouldBuild = () => {
  if (env.OPENCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stamp = readBuildStamp();
  if (stamp.mtime == null) {
    return true;
  }
  if (statMtime(distEntry) == null) {
    return true;
  }

  for (const filePath of configFiles) {
    const mtime = statMtime(filePath);
    if (mtime != null && mtime > stamp.mtime) {
      return true;
    }
  }

  const currentHead = resolveGitHead();
  if (currentHead && !stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime);
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime);
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree();
    if (dirty === true) {
      return true;
    }
    if (dirty === false) {
      return false;
    }
  }

  if (hasSourceMtimeChanged(stamp.mtime)) {
    return true;
  }
  return false;
};

const logRunner = (message) => {
  if (env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  process.stderr.write(`[openclaw] ${message}\n`);
};

const runNode = () => {
  const nodeProcess = spawn(process.execPath, ["openclaw.mjs", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (exitCode, exitSignal) => {
    if (exitSignal) {
      process.exit(1);
    }
    process.exit(exitCode ?? 1);
  });
};

const writeBuildStamp = () => {
  try {
    fs.mkdirSync(distRoot, { recursive: true });
    const stamp = {
      builtAt: Date.now(),
      head: resolveGitHead(),
    };
    fs.writeFileSync(buildStampPath, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
  }
};

if (!shouldBuild()) {
  runNode();
} else {
  logRunner("Building TypeScript (dist is stale).");
  const buildCmd = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const buildArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...compilerArgs] : compilerArgs;
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
    runNode();
  });
}
