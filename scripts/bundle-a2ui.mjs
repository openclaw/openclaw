#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
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

function runCommand(command, args) {
  const executables = resolveExecutables(command);
  for (const executable of executables) {
    const useShell = process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
    const result = spawnSync(executable, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: useShell,
    });
    if (!result.error) {
      if (result.status !== 0) {
        const printable = [command, ...args].join(" ");
        throw new Error(`Command failed: ${printable}`);
      }
      return;
    }
    if (result.error.code !== "ENOENT" && result.error.code !== "EINVAL") {
      throw result.error;
    }
  }
  throw new Error(`Command not found: ${command}`);
}

function hasRolldown() {
  const localRolldown = resolveLocalBin("rolldown");
  if (existsSync(localRolldown)) {
    return true;
  }
  const executables = resolveExecutables("rolldown");
  for (const executable of executables) {
    const useShell = process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
    const result = spawnSync(executable, ["--version"], {
      cwd: rootDir,
      stdio: "ignore",
      shell: useShell,
    });
    if (!result.error) {
      return result.status === 0;
    }
    if (result.error.code !== "ENOENT" && result.error.code !== "EINVAL") {
      return false;
    }
  }
  return false;
}

async function walk(entryPath, files) {
  const stat = await fs.stat(entryPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const inputPath of inputPaths) {
    await walk(inputPath, files);
  }
  files.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const relativePath = normalizePath(path.relative(rootDir, filePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function printFailureAndExit(err) {
  if (err instanceof Error && err.message) {
    console.error(err.message);
  }
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}

async function main() {
  if (!existsSync(a2uiRendererDir) || !existsSync(a2uiAppDir)) {
    if (existsSync(outputFile)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    throw new Error(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash();
  if (existsSync(hashFile) && existsSync(outputFile)) {
    const previousHash = (await fs.readFile(hashFile, "utf8")).trim();
    if (previousHash === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  const localTsc = resolveLocalBin("tsc");
  if (!existsSync(localTsc)) {
    throw new Error(`Local TypeScript binary missing: ${localTsc}`);
  }
  runCommand(localTsc, ["-p", path.join(a2uiRendererDir, "tsconfig.json")]);

  const rolldownConfig = path.join(a2uiAppDir, "rolldown.config.mjs");
  const localRolldown = resolveLocalBin("rolldown");
  if (existsSync(localRolldown)) {
    runCommand(localRolldown, ["-c", rolldownConfig]);
  } else if (hasRolldown()) {
    runCommand("rolldown", ["-c", rolldownConfig]);
  } else {
    runCommand("pnpm", ["-s", "dlx", "rolldown", "-c", rolldownConfig]);
  }

  await fs.writeFile(hashFile, `${currentHash}\n`);
}

main().catch(printFailureAndExit);
