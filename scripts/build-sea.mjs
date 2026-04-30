#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const PACKAGE_ROOT_FILES = ["CHANGELOG.md", "LICENSE", "openclaw.mjs", "README.md", "package.json"];
const PACKAGE_ROOT_DIRS = ["assets", "docs", "patches", "skills"];
const RUNTIME_SCRIPT_FILES = [
  "scripts/npm-runner.mjs",
  "scripts/preinstall-package-manager-warning.mjs",
  "scripts/lib/bundled-runtime-deps-install.mjs",
  "scripts/lib/package-dist-imports.mjs",
  "scripts/postinstall-bundled-plugins.mjs",
  "scripts/windows-cmd-helpers.mjs",
];

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if ((platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64")) {
    return `${platform}-${arch}`;
  }
  throw new Error(`unsupported SEA host: ${platform}-${arch}`);
}

function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== "--");
  const options = {
    copyNodeModules: false,
    outDir: path.join(ROOT_DIR, "dist-sea"),
    skipBuild: false,
    target: currentTarget(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      options.target = args[(index += 1)] ?? "";
    } else if (arg?.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg === "--out-dir") {
      options.outDir = args[(index += 1)] ?? "";
    } else if (arg?.startsWith("--out-dir=")) {
      options.outDir = arg.slice("--out-dir=".length);
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--copy-node-modules") {
      options.copyNodeModules = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!SUPPORTED_TARGETS.has(options.target)) {
    throw new Error(`unsupported SEA target '${options.target}'`);
  }
  options.outDir = path.resolve(ROOT_DIR, options.outDir);
  return options;
}

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

function runCapture(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function copyFile(relativePath, outDir) {
  const sourcePath = path.join(ROOT_DIR, relativePath);
  if (!(await exists(sourcePath))) {
    return false;
  }
  const targetPath = path.join(outDir, relativePath);
  await ensureParentDir(targetPath);
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

function shouldCopyPackageTreeEntry(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || normalized.includes("/.DS_Store") || normalized.endsWith("/.DS_Store")) {
    return false;
  }
  if (normalized === "docs/.generated" || normalized.startsWith("docs/.generated/")) {
    return false;
  }
  if (normalized === "docs/channels/qa-channel.md") {
    return false;
  }
  return true;
}

async function copyTree(relativePath, outDir) {
  const sourcePath = path.join(ROOT_DIR, relativePath);
  if (!(await exists(sourcePath))) {
    return false;
  }
  const targetPath = path.join(outDir, relativePath);
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const sourceRelativePath = path.relative(ROOT_DIR, source).replace(/\\/g, "/");
      return shouldCopyPackageTreeEntry(sourceRelativePath);
    },
  });
  return true;
}

async function copyDistInventory(outDir) {
  const inventoryPath = path.join(ROOT_DIR, "dist", "postinstall-inventory.json");
  const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
    throw new Error("invalid dist/postinstall-inventory.json");
  }
  for (const relativePath of inventory) {
    await copyFile(relativePath, outDir);
  }
  await copyFile("dist/postinstall-inventory.json", outDir);
  return inventory.length;
}

async function stageNodeModules(outDir, copyNodeModules) {
  const sourcePath = path.join(ROOT_DIR, "node_modules");
  const targetPath = path.join(outDir, "node_modules");
  if (!(await exists(sourcePath))) {
    throw new Error("missing node_modules; run pnpm install first");
  }
  if (copyNodeModules) {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      dereference: false,
    });
    return "copied";
  }
  await fs.symlink(sourcePath, targetPath, "dir");
  return "symlinked";
}

async function fetchNodeForTarget(target) {
  if (process.env.OPENCLAW_SEA_NODE_PATH && target === currentTarget()) {
    return path.resolve(ROOT_DIR, process.env.OPENCLAW_SEA_NODE_PATH);
  }
  const stdout = await runCapture(
    process.execPath,
    [path.join(ROOT_DIR, "scripts/fetch-node-for-sea.mjs"), "--target", target],
    ROOT_DIR,
  );
  const binaryPath = stdout.trim().split(/\r?\n/u).at(-1);
  if (!binaryPath) {
    throw new Error(`failed to resolve official Node.js binary for ${target}`);
  }
  return binaryPath;
}

async function writeSeaEntrypoints(outDir) {
  const seaMainPath = path.join(outDir, "openclaw-sea-main.cjs");
  const sidecarPath = path.join(outDir, "openclaw-sea-sidecar.cjs");
  await fs.writeFile(
    seaMainPath,
    `const { createRequire } = require("node:module");
const path = require("node:path");
const process = require("node:process");

const packageRoot = process.env.OPENCLAW_SEA_PACKAGE_ROOT || path.dirname(process.execPath);
const userArgs = process.argv.slice(1);
if (userArgs[0] && isExecutableArg(userArgs[0])) {
  userArgs.shift();
}
try {
  process.chdir(packageRoot);
} catch {
  // Keep the original cwd if the sidecar package is not a directory.
}
process.env.OPENCLAW_SEA = process.env.OPENCLAW_SEA || "1";
process.argv = [process.execPath, path.join(packageRoot, "openclaw.mjs"), ...userArgs];

const requireFromExecutable = createRequire(process.execPath);
requireFromExecutable(path.join(packageRoot, "openclaw-sea-sidecar.cjs"));

function isExecutableArg(value) {
  if (value === process.execPath) {
    return true;
  }
  const base = path.basename(value).toLowerCase();
  return base === "openclaw" || base === "openclaw.exe";
}
`,
    "utf8",
  );
  await fs.writeFile(
    sidecarPath,
    `const path = require("node:path");
const process = require("node:process");
const { pathToFileURL } = require("node:url");

const packageRoot = process.env.OPENCLAW_SEA_PACKAGE_ROOT || path.dirname(process.execPath);

(async () => {
  await import(pathToFileURL(path.join(packageRoot, "openclaw.mjs")).href);
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
`,
    "utf8",
  );
  return { seaMainPath, sidecarPath };
}

async function writeSeaConfig({ binaryPath, executablePath, outDir, seaMainPath }) {
  const seaConfigPath = path.join(outDir, "sea-config.json");
  await fs.writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: seaMainPath,
        output: binaryPath,
        executable: executablePath,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return seaConfigPath;
}

async function writeManifest({
  binaryPath,
  builderNodePath,
  distFileCount,
  executablePath,
  nodeModulesMode,
  options,
  outDir,
  sidecarPath,
}) {
  const binaryStats = await fs.stat(binaryPath);
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        mode: "node-sea-trampoline-with-package-sidecar",
        target: options.target,
        binary: path.basename(binaryPath),
        binaryBytes: binaryStats.size,
        nodeBuilder: builderNodePath,
        nodeExecutable: executablePath,
        nodeModules: nodeModulesMode,
        distFileCount,
        sidecar: path.basename(sidecarPath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function signDarwinBinaryIfNeeded(binaryPath, target) {
  if (!target.startsWith("darwin-")) {
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error(`codesign is required for ${target} SEA binaries`);
  }
  await run("codesign", ["--sign", "-", "--force", binaryPath], ROOT_DIR);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hostTarget = currentTarget();
  const builderNodePath = await fetchNodeForTarget(hostTarget);
  const executablePath =
    process.env.OPENCLAW_SEA_EXECUTABLE_PATH ||
    (options.target === hostTarget && process.env.OPENCLAW_SEA_NODE_PATH
      ? path.resolve(ROOT_DIR, process.env.OPENCLAW_SEA_NODE_PATH)
      : await fetchNodeForTarget(options.target));
  const binaryPath = path.join(
    options.outDir,
    process.platform === "win32" ? "openclaw.exe" : "openclaw",
  );

  if (!options.skipBuild) {
    console.error("==> Building OpenClaw dist artifacts");
    await run("pnpm", ["build:docker"], ROOT_DIR);
  }

  console.error("==> Writing package dist inventory");
  await run(
    "node",
    ["--import", "tsx", path.join(ROOT_DIR, "scripts/write-package-dist-inventory.ts")],
    ROOT_DIR,
  );

  console.error(`==> Preparing ${path.relative(ROOT_DIR, options.outDir)}`);
  await fs.rm(options.outDir, { recursive: true, force: true });
  await fs.mkdir(options.outDir, { recursive: true });
  const { seaMainPath, sidecarPath } = await writeSeaEntrypoints(options.outDir);
  const seaConfigPath = await writeSeaConfig({
    binaryPath,
    executablePath,
    outDir: options.outDir,
    seaMainPath,
  });

  console.error(`==> Building SEA executable for ${options.target}`);
  await run(builderNodePath, ["--build-sea", seaConfigPath], ROOT_DIR);
  await fs.chmod(binaryPath, 0o755);
  await signDarwinBinaryIfNeeded(binaryPath, options.target);

  console.error("==> Staging package sidecar");
  const distFileCount = await copyDistInventory(options.outDir);
  for (const relativePath of PACKAGE_ROOT_FILES) {
    await copyFile(relativePath, options.outDir);
  }
  await fs.chmod(path.join(options.outDir, "openclaw.mjs"), 0o755);
  for (const relativePath of PACKAGE_ROOT_DIRS) {
    await copyTree(relativePath, options.outDir);
  }
  for (const relativePath of RUNTIME_SCRIPT_FILES) {
    await copyFile(relativePath, options.outDir);
  }
  if (await exists(path.join(ROOT_DIR, "dist-runtime"))) {
    await fs.cp(path.join(ROOT_DIR, "dist-runtime"), path.join(options.outDir, "dist-runtime"), {
      recursive: true,
      dereference: false,
    });
  }
  const nodeModulesMode = await stageNodeModules(options.outDir, options.copyNodeModules);
  await writeManifest({
    binaryPath,
    builderNodePath,
    distFileCount,
    executablePath,
    nodeModulesMode,
    options,
    outDir: options.outDir,
    sidecarPath,
  });

  console.error(`==> SEA package ready: ${path.relative(ROOT_DIR, binaryPath)}`);
  console.log(pathToFileURL(binaryPath).href);
}

await main();
