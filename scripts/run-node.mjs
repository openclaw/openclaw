#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runRuntimePostBuild } from "./runtime-postbuild.mjs";

const buildScript = "scripts/tsdown-build.mjs";
const compilerArgs = [buildScript, "--no-clean"];

const runNodeSourceRoots = ["src", "extensions"];
const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;
const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

export const isBuildRelevantRunNodePath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith("extensions/")) {
    return isBuildRelevantSourcePath(normalizedPath.slice("extensions/".length));
  }
  return false;
};

const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

export const isRestartRelevantRunNodePath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith("extensions/")) {
    return isRestartRelevantExtensionPath(normalizedPath.slice("extensions/".length));
  }
  return false;
};

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath, sourceRoot, sourceRootName) => {
  const relativePath = normalizePath(path.relative(sourceRoot, filePath));
  if (relativePath.startsWith("..")) {
    return false;
  }
  return !isBuildRelevantRunNodePath(path.posix.join(sourceRootName, relativePath));
};

const findLatestMtime = (dirPath, shouldSkip, deps) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
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
      const mtime = statMtime(fullPath, deps.fs);
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

const runGit = (gitArgs, deps) => {
  try {
    const result = deps.spawnSync("git", gitArgs, {
      cwd: deps.cwd,
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

const resolveGitHead = (deps) => {
  const head = runGit(["rev-parse", "HEAD"], deps);
  return head || null;
};

const readGitStatus = (deps) => {
  try {
    const result = deps.spawnSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal", "--", ...runNodeWatchedPaths],
      {
        cwd: deps.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout ?? "";
  } catch {
    return null;
  }
};

const parseGitStatusPaths = (output) =>
  output
    .split("\n")
    .flatMap((line) => line.slice(3).split(" -> "))
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);

const hasDirtySourceTree = (deps) => {
  const output = readGitStatus(deps);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some((repoPath) => isBuildRelevantRunNodePath(repoPath));
};

const readBuildStamp = (deps) => {
  const mtime = statMtime(deps.buildStampPath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(deps.buildStampPath, "utf8").trim();
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

const hasSourceMtimeChanged = (stampMtime, deps) => {
  let latestSourceMtime = null;
  for (const sourceRoot of deps.sourceRoots) {
    const sourceMtime = findLatestMtime(
      sourceRoot.path,
      (candidate) => isExcludedSource(candidate, sourceRoot.path, sourceRoot.name),
      deps,
    );
    if (sourceMtime != null && (latestSourceMtime == null || sourceMtime > latestSourceMtime)) {
      latestSourceMtime = sourceMtime;
    }
  }
  return latestSourceMtime != null && latestSourceMtime > stampMtime;
};

const shouldBuild = (deps) => {
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stamp = readBuildStamp(deps);
  if (stamp.mtime == null) {
    return true;
  }
  if (statMtime(deps.distEntry, deps.fs) == null) {
    return true;
  }

  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      return true;
    }
  }

  const currentHead = resolveGitHead(deps);
  if (currentHead && !stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime, deps);
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime, deps);
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    if (dirty === true) {
      return true;
    }
    if (dirty === false) {
      return false;
    }
  }

  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    return true;
  }
  return false;
};

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  deps.stderr.write(`[openclaw] ${message}\n`);
};

const runOpenClaw = async (deps) => {
  const nodeProcess = deps.spawn(deps.execPath, ["openclaw.mjs", ...deps.args], {
    cwd: deps.cwd,
    env: deps.env,
    stdio: "inherit",
  });
  const res = await new Promise((resolve) => {
    nodeProcess.on("exit", (exitCode, exitSignal) => {
      resolve({ exitCode, exitSignal });
    });
  });
  if (res.exitSignal) {
    return 1;
  }
  return res.exitCode ?? 1;
};

const syncRuntimeArtifacts = (deps) => {
  try {
    runRuntimePostBuild({ cwd: deps.cwd });
  } catch (error) {
    logRunner(
      `Failed to write runtime build artifacts: ${error?.message ?? "unknown error"}`,
      deps,
    );
    return false;
  }
  return true;
};

const writeBuildStamp = (deps) => {
  try {
    deps.fs.mkdirSync(deps.distRoot, { recursive: true });
    const stamp = {
      builtAt: Date.now(),
      head: resolveGitHead(deps),
    };
    deps.fs.writeFileSync(deps.buildStampPath, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`, deps);
  }
};

export async function runNodeMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    spawnSync: params.spawnSync ?? spawnSync,
    fs: params.fs ?? fs,
    stderr: params.stderr ?? process.stderr,
    execPath: params.execPath ?? process.execPath,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
  };

  deps.distRoot = path.join(deps.cwd, "dist");
  deps.distEntry = path.join(deps.distRoot, "/entry.js");
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  deps.sourceRoots = runNodeSourceRoots.map((sourceRoot) => ({
    name: sourceRoot,
    path: path.join(deps.cwd, sourceRoot),
  }));
  deps.configFiles = runNodeConfigFiles.map((filePath) => path.join(deps.cwd, filePath));

  if (!shouldBuild(deps)) {
    if (!syncRuntimeArtifacts(deps)) {
      return 1;
    }
    return await runOpenClaw(deps);
  }

  logRunner("Building TypeScript (dist is stale).", deps);
  const buildCmd = deps.execPath;
  const buildArgs = compilerArgs;
  const build = deps.spawn(buildCmd, buildArgs, {
    cwd: deps.cwd,
    env: deps.env,
    stdio: "inherit",
  });

  const buildRes = await new Promise((resolve) => {
    build.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
  if (buildRes.exitSignal) {
    return 1;
  }
  if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
    return buildRes.exitCode;
  }
  if (!syncRuntimeArtifacts(deps)) {
    return 1;
  }
  writeBuildStamp(deps);
  return await runOpenClaw(deps);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
