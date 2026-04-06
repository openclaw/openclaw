#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = path.join(rootDir, "src", "canvas-host", "a2ui", ".bundle.hash");
const outputFile = path.join(rootDir, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const a2uiRendererDir = path.join(rootDir, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(rootDir, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const inputPaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];

function fail(message) {
  console.error(message);
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isWindowsUncPath(filePath) {
  return process.platform === "win32" && filePath.startsWith("\\\\");
}

function resolveCommandCwd(useShell) {
  if (useShell && isWindowsUncPath(rootDir)) {
    const drive = process.env.SystemDrive || "C:";
    return `${drive}\\`;
  }
  return rootDir;
}

function resolveExecutables(command) {
  if (process.platform !== "win32") {
    return [command];
  }
  if (command === "pnpm") {
    const executables = [];
    if (process.env.OPENCLAW_PNPM_CMD) {
      executables.push(process.env.OPENCLAW_PNPM_CMD);
    }
    executables.push("pnpm.cmd", "pnpm");
    return executables;
  }
  if (command === "rolldown") {
    return ["rolldown.cmd", "rolldown"];
  }
  return [command];
}

function resolveLocalBin(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.join(rootDir, "node_modules", ".bin", `${name}${ext}`);
}

/**
 * Windows `node.exe` (including WSL-invoked) expects `tsc.cmd`; Linux pnpm installs
 * in WSL often leave only a shell `tsc` shim. Prefer `.cmd` when present; otherwise use
 * `pnpm exec tsc` so resolution matches mixed WSL/Windows installs.
 * @returns {{ kind: "path"; executable: string } | { kind: "pnpm-exec" } | null}
 */
function resolveLocalTscCommand() {
  const binDir = path.join(rootDir, "node_modules", ".bin");
  const tscCmd = path.join(binDir, "tsc.cmd");
  const tscShim = path.join(binDir, "tsc");
  if (process.platform === "win32") {
    if (existsSync(tscCmd)) {
      return { kind: "path", executable: tscCmd };
    }
    if (existsSync(tscShim)) {
      return { kind: "pnpm-exec" };
    }
    return null;
  }
  if (existsSync(tscShim)) {
    return { kind: "path", executable: tscShim };
  }
  return null;
}

function resolvePnpmStoreRolldownBin() {
  const candidates = [
    path.join(rootDir, "node_modules", ".pnpm", "node_modules", "rolldown", "bin", "cli.mjs"),
  ];
  const pnpmDir = path.join(rootDir, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith("rolldown@")) {
        continue;
      }
      candidates.push(path.join(pnpmDir, entry, "node_modules", "rolldown", "bin", "cli.mjs"));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Entry point for running pnpm without `pnpm.cmd`/`cmd.exe`. Needed when `cwd` is a UNC path,
 * because cmd.exe cannot use a UNC working directory and would drop repo context.
 * @returns {string | null}
 */
function isPnpmNodeEntrypoint(filePath) {
  const lower = filePath.toLowerCase();
  return (
    existsSync(filePath) &&
    (lower.endsWith("pnpm.cjs") || lower.endsWith("pnpm.js") || lower.endsWith("pnpm.mjs"))
  );
}

function resolvePnpmEntrypoint() {
  const fromEnv = process.env.npm_execpath || process.env.NPM_EXECPATH;
  if (fromEnv && isPnpmNodeEntrypoint(fromEnv)) {
    const lower = fromEnv.toLowerCase();
    if (!lower.endsWith(".cmd")) {
      return fromEnv;
    }
  }
  const direct = path.join(rootDir, "node_modules", "pnpm", "bin", "pnpm.cjs");
  if (existsSync(direct)) {
    return direct;
  }
  const pnpmDir = path.join(rootDir, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith("pnpm@")) {
        continue;
      }
      const candidate = path.join(pnpmDir, entry, "node_modules", "pnpm", "bin", "pnpm.cjs");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return resolvePnpmEntrypointFromPath();
}

/** Use a drive-letter cwd for `where` when the repo root is UNC (Windows). */
function whereCommandCwd() {
  if (isWindowsUncPath(rootDir)) {
    const drive = process.env.SystemDrive || "C:";
    return `${drive}\\`;
  }
  return rootDir;
}

/**
 * Parse a Node-runnable pnpm entrypoint from a Windows `pnpm.cmd` wrapper.
 * @param {string} cmdPath
 * @returns {string | null}
 */
function readPnpmEntrypointFromCmdWrapper(cmdPath) {
  try {
    const text = readFileSync(cmdPath, "utf8");
    const matches = text.matchAll(/["']([^"'\r\n]+pnpm\.(?:cjs|mjs|js))["']/gi);
    for (const match of matches) {
      const rawPath = match[1];
      if (!rawPath) {
        continue;
      }
      const expandedPath = rawPath.replace(/%~?dp0%?/gi, `${path.dirname(cmdPath)}\\`);
      const candidate = path.isAbsolute(expandedPath)
        ? path.normalize(expandedPath)
        : path.resolve(path.dirname(cmdPath), expandedPath);
      if (isPnpmNodeEntrypoint(candidate)) {
        return candidate;
      }
    }
  } catch {
    // unreadable or missing
  }
  return null;
}

/**
 * Resolve a Node-runnable pnpm entrypoint from PATH shims (`pnpm.cmd`, direct `pnpm.js`, etc.).
 * Needed when `npm_execpath` is a WSL path (invisible to win32 `existsSync`) and the repo
 * does not vendor pnpm under `node_modules`.
 * @returns {string | null}
 */
function resolvePnpmEntrypointFromPath() {
  const cwd = whereCommandCwd();
  for (const name of ["pnpm.cmd", "pnpm"]) {
    const whereResult = spawnSync("where", [name], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    if (whereResult.error || whereResult.status !== 0) {
      continue;
    }
    const lines = whereResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (isPnpmNodeEntrypoint(line)) {
        return line;
      }
      if (lower.endsWith(".cmd")) {
        const npmLayout = path.join(path.dirname(line), "node_modules", "pnpm", "bin", "pnpm.cjs");
        if (isPnpmNodeEntrypoint(npmLayout)) {
          return npmLayout;
        }
        const fromWrapper = readPnpmEntrypointFromCmdWrapper(line);
        if (fromWrapper) {
          return fromWrapper;
        }
      }
    }
  }
  return null;
}

/**
 * Standalone / PATH `pnpm.exe` can run with UNC cwd without `cmd.exe`.
 * @returns {string | null}
 */
function resolvePnpmExeFromPath() {
  const cwd = whereCommandCwd();
  const whereResult = spawnSync("where", ["pnpm.exe"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (whereResult.error || whereResult.status !== 0) {
    return null;
  }
  const line = whereResult.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line || !line.toLowerCase().endsWith(".exe") || !existsSync(line)) {
    return null;
  }
  return line;
}

function resolveExecutableCandidate(executable) {
  if (process.platform !== "win32" || !executable.toLowerCase().endsWith(".cmd")) {
    return executable;
  }

  if (path.isAbsolute(executable)) {
    return existsSync(executable) ? executable : null;
  }

  const whereResult = spawnSync("where", [executable], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (whereResult.error || whereResult.status !== 0) {
    return null;
  }

  const resolved = whereResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return resolved ?? null;
}

function createCommandError(code, command, args, details) {
  const error = new Error(details.message);
  error.code = code;
  error.command = command;
  error.args = args;
  error.details = details;
  return error;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ spawnCwd?: string }} [options] When set, used as `cwd` instead of UNC `.cmd` workaround
 *   (`pnpm exec` must run with the repo root so local bins resolve).
 */
function runCommand(command, args, options) {
  const executables = resolveExecutables(command);
  let lastNonZero = null;
  for (const executable of executables) {
    const candidate = resolveExecutableCandidate(executable);
    if (!candidate) {
      continue;
    }
    const useShell = process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd");
    const cwd = options?.spawnCwd !== undefined ? options.spawnCwd : resolveCommandCwd(useShell);

    if (command === "pnpm" && process.platform === "win32" && isWindowsUncPath(cwd)) {
      const pnpmEntrypoint = resolvePnpmEntrypoint();
      const pnpmExe = pnpmEntrypoint ? null : resolvePnpmExeFromPath();
      if (!pnpmEntrypoint && !pnpmExe) {
        throw createCommandError("OPENCLAW_COMMAND_NOT_FOUND", command, args, {
          message: `Cannot run pnpm with UNC working directory (${cwd}). cmd.exe cannot keep a UNC cwd; ensure pnpm is on PATH (pnpm.cmd / pnpm.exe), install deps for a local pnpm.cjs, or use a mapped drive letter.`,
        });
      }
      const uncResult = pnpmEntrypoint
        ? spawnSync(process.execPath, [pnpmEntrypoint, ...args], {
            cwd,
            stdio: "inherit",
            shell: false,
          })
        : spawnSync(pnpmExe, args, {
            cwd,
            stdio: "inherit",
            shell: false,
          });
      const candidateLabel = pnpmEntrypoint ?? pnpmExe;
      if (uncResult.error) {
        throw uncResult.error;
      }
      if (uncResult.status !== 0) {
        throw createCommandError("OPENCLAW_COMMAND_FAILED", command, args, {
          candidate: candidateLabel,
          status: uncResult.status ?? "unknown",
          message: `Command failed: ${[command, ...args].join(" ")} (pnpm: ${candidateLabel}, exit: ${uncResult.status ?? "unknown"})`,
        });
      }
      return;
    }

    const result = spawnSync(candidate, args, {
      cwd,
      stdio: "inherit",
      shell: useShell,
    });
    if (!result.error) {
      if (result.status !== 0) {
        lastNonZero = {
          candidate,
          status: result.status ?? "unknown",
        };
        continue;
      }
      return;
    }
    if (result.error.code !== "ENOENT" && result.error.code !== "EINVAL") {
      throw result.error;
    }
  }
  if (lastNonZero) {
    const printable = [command, ...args].join(" ");
    throw createCommandError("OPENCLAW_COMMAND_FAILED", command, args, {
      ...lastNonZero,
      message: `Command failed after trying executable fallbacks: ${printable} (last candidate: ${lastNonZero.candidate}, exit: ${lastNonZero.status})`,
    });
  }
  throw createCommandError("OPENCLAW_COMMAND_NOT_FOUND", command, args, {
    message: `Command not found: ${command}`,
  });
}

function hasRolldown() {
  if (existsSync(resolveLocalBin("rolldown")) || resolvePnpmStoreRolldownBin()) {
    return true;
  }
  const executables = resolveExecutables("rolldown");
  for (const executable of executables) {
    const candidate = resolveExecutableCandidate(executable);
    if (!candidate) {
      continue;
    }
    const useShell = process.platform === "win32" && candidate.toLowerCase().endsWith(".cmd");
    const result = spawnSync(candidate, ["--version"], {
      cwd: resolveCommandCwd(useShell),
      stdio: "ignore",
      shell: useShell,
    });
    if (!result.error) {
      if (result.status === 0) {
        return true;
      }
      continue;
    }
    if (result.error.code !== "ENOENT" && result.error.code !== "EINVAL") {
      continue;
    }
  }
  return false;
}

function canRunCommand(command, args) {
  try {
    runCommand(command, args);
    return true;
  } catch (error) {
    if (error?.code === "OPENCLAW_COMMAND_NOT_FOUND" || error?.code === "OPENCLAW_COMMAND_FAILED") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ continueOnCommandFailure?: boolean }} [options]
 * @returns {boolean}
 */
function tryRunCommand(command, args, options) {
  const continueOnCommandFailure = options?.continueOnCommandFailure ?? false;
  try {
    runCommand(command, args);
    return true;
  } catch (error) {
    if (error?.code === "OPENCLAW_COMMAND_NOT_FOUND") {
      return false;
    }
    // Local `.bin` wrappers and `.cmd` shims can exit non-zero on partial/stale installs.
    // Only fall through when the wrapper also fails a lightweight `--version` probe; if the
    // probe succeeds, a non-zero bundle run is a real rolldown/config failure and should surface.
    if (continueOnCommandFailure && error?.code === "OPENCLAW_COMMAND_FAILED") {
      if (canRunCommand(command, ["--version"])) {
        throw error;
      }
      return false;
    }
    throw error;
  }
}

function runStep(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** Prefer `resolvePnpmRunner` on normal Windows cwd; use UNC-safe `runCommand` on `\\\\` roots. */
function runPnpm(pnpmArgs) {
  if (process.platform === "win32" && isWindowsUncPath(rootDir)) {
    runCommand("pnpm", pnpmArgs, { spawnCwd: rootDir });
    return;
  }
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

async function walkFiles(entryPath, files) {
  const stat = await fs.stat(entryPath);
  if (!stat.isDirectory()) {
    files.push(entryPath);
    return;
  }
  const entries = await fs.readdir(entryPath);
  for (const entry of entries) {
    await walkFiles(path.join(entryPath, entry), files);
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const inputPath of inputPaths) {
    await walkFiles(inputPath, files);
  }
  files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(normalizePath(path.relative(rootDir, filePath)));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  const hasRendererDir = await pathExists(a2uiRendererDir);
  const hasAppDir = await pathExists(a2uiAppDir);
  const hasOutputFile = await pathExists(outputFile);
  if (!hasRendererDir || !hasAppDir) {
    if (hasOutputFile) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    if (process.env.OPENCLAW_SPARSE_PROFILE || process.env.OPENCLAW_A2UI_SKIP_MISSING === "1") {
      console.error(
        "A2UI sources missing; skipping bundle because OPENCLAW_A2UI_SKIP_MISSING=1 or OPENCLAW_SPARSE_PROFILE is set.",
      );
      return;
    }
    fail(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash();
  if (await pathExists(hashFile)) {
    const previousHash = (await fs.readFile(hashFile, "utf8")).trim();
    if (previousHash === currentHash && hasOutputFile) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  const tscConfig = path.join(a2uiRendererDir, "tsconfig.json");
  const tscCommand = resolveLocalTscCommand();
  if (!tscCommand) {
    fail(
      `Local TypeScript binary missing under ${path.join(rootDir, "node_modules", ".bin")} (expected tsc or tsc.cmd on Windows)`,
    );
  }
  if (tscCommand.kind === "path") {
    const tscExe = tscCommand.executable;
    const isWindowsTscCmd =
      process.platform === "win32" && tscExe.toLowerCase().endsWith("tsc.cmd");
    try {
      runCommand(tscExe, ["-p", tscConfig]);
    } catch (error) {
      // Stale or broken `tsc.cmd` shims can fail even when `pnpm exec tsc` works.
      if (isWindowsTscCmd && error && typeof error === "object" && error.code === "OPENCLAW_COMMAND_FAILED") {
        runPnpm(["-s", "exec", "tsc", "-p", tscConfig]);
      } else {
        throw error;
      }
    }
  } else {
    runPnpm(["-s", "exec", "tsc", "-p", tscConfig]);
  }

  const rolldownConfig = path.join(a2uiAppDir, "rolldown.config.mjs");
  const localRolldown = resolveLocalBin("rolldown");
  const pnpmStoreRolldown = resolvePnpmStoreRolldownBin();
  if (
    (pnpmStoreRolldown &&
      tryRunCommand(process.execPath, [pnpmStoreRolldown, "-c", rolldownConfig])) ||
    (existsSync(localRolldown) &&
      tryRunCommand(localRolldown, ["-c", rolldownConfig], {
        continueOnCommandFailure: true,
      })) ||
    (hasRolldown() &&
      tryRunCommand("rolldown", ["-c", rolldownConfig], {
        continueOnCommandFailure: true,
      }))
  ) {
    await fs.writeFile(hashFile, `${currentHash}\n`, "utf8");
    return;
  }

  runPnpm(["-s", "dlx", "rolldown", "-c", rolldownConfig]);
  await fs.writeFile(hashFile, `${currentHash}\n`, "utf8");
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
