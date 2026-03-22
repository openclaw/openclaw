#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { channelTestRoots } from "../vitest.channel-paths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pnpm = "pnpm";

function normalizeRelative(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function isTestFile(filePath) {
  return filePath.endsWith(".test.ts") || filePath.endsWith(".test.tsx");
}

function collectTestFiles(rootPath) {
  const results = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isTestFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  return results.toSorted((left, right) => left.localeCompare(right));
}

function listChangedPaths(base, head = "HEAD") {
  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  return execFileSync("git", ["diff", "--name-only", base, head], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasExtensionPackage(extensionId) {
  return fs.existsSync(path.join(repoRoot, "extensions", extensionId, "package.json"));
}

export function listAvailableExtensionIds() {
  const extensionsDir = path.join(repoRoot, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((extensionId) => hasExtensionPackage(extensionId))
    .toSorted((left, right) => left.localeCompare(right));
}

export function detectChangedExtensionIds(changedPaths) {
  const extensionIds = new Set();

  for (const rawPath of changedPaths) {
    const relativePath = normalizeRelative(String(rawPath).trim());
    if (!relativePath) {
      continue;
    }

    const extensionMatch = relativePath.match(/^extensions\/([^/]+)(?:\/|$)/);
    if (extensionMatch) {
      const extensionId = extensionMatch[1];
      if (hasExtensionPackage(extensionId)) {
        extensionIds.add(extensionId);
      }
      continue;
    }

    const pairedCoreMatch = relativePath.match(/^src\/([^/]+)(?:\/|$)/);
    if (pairedCoreMatch && hasExtensionPackage(pairedCoreMatch[1])) {
      extensionIds.add(pairedCoreMatch[1]);
    }
  }

  return [...extensionIds].toSorted((left, right) => left.localeCompare(right));
}

export function listChangedExtensionIds(params = {}) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  return detectChangedExtensionIds(listChangedPaths(base, head));
}

function resolveExtensionDirectory(targetArg, cwd = process.cwd()) {
  if (targetArg) {
    const asGiven = path.resolve(cwd, targetArg);
    if (fs.existsSync(path.join(asGiven, "package.json"))) {
      return asGiven;
    }

    const byName = path.join(repoRoot, "extensions", targetArg);
    if (fs.existsSync(path.join(byName, "package.json"))) {
      return byName;
    }

    throw new Error(
      `Unknown extension target "${targetArg}". Use an extension name like "slack" or a path under extensions/.`,
    );
  }

  let current = cwd;
  while (true) {
    if (
      normalizeRelative(path.relative(repoRoot, current)).startsWith("extensions/") &&
      fs.existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    "No extension target provided, and current working directory is not inside extensions/.",
  );
}

export function resolveExtensionTestPlan(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const targetArg = params.targetArg;
  const extensionDir = resolveExtensionDirectory(targetArg, cwd);
  const extensionId = path.basename(extensionDir);
  const relativeExtensionDir = normalizeRelative(path.relative(repoRoot, extensionDir));

  const roots = [relativeExtensionDir];
  const pairedCoreRoot = path.join(repoRoot, "src", extensionId);
  if (fs.existsSync(pairedCoreRoot)) {
    const pairedRelativeRoot = normalizeRelative(path.relative(repoRoot, pairedCoreRoot));
    if (collectTestFiles(pairedCoreRoot).length > 0) {
      roots.push(pairedRelativeRoot);
    }
  }

  const usesChannelConfig = roots.some((root) => channelTestRoots.includes(root));
  const config = usesChannelConfig ? "vitest.channels.config.ts" : "vitest.extensions.config.ts";
  const testFiles = roots.flatMap((root) => collectTestFiles(path.join(repoRoot, root)));

  return {
    config,
    extensionDir: relativeExtensionDir,
    extensionId,
    roots,
    testFiles: testFiles.map((filePath) => normalizeRelative(path.relative(repoRoot, filePath))),
  };
}

function printUsage() {
  console.error("Usage: pnpm test:extension <extension-name|path> [vitest args...]");
  console.error("       node scripts/test-extension.mjs [extension-name|path] [vitest args...]");
  console.error("       node scripts/test-extension.mjs --list");
  console.error(
    "       node scripts/test-extension.mjs --list-changed --base <git-ref> [--head <git-ref>]",
  );
}

async function run() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const json = rawArgs.includes("--json");
  const list = rawArgs.includes("--list");
  const listChanged = rawArgs.includes("--list-changed");
  const args = rawArgs.filter(
    (arg) =>
      arg !== "--" &&
      arg !== "--dry-run" &&
      arg !== "--json" &&
      arg !== "--list" &&
      arg !== "--list-changed",
  );

  let base = "";
  let head = "HEAD";
  const passthroughArgs = [];

  if (listChanged) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--base") {
        base = args[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (arg === "--head") {
        head = args[index + 1] ?? "HEAD";
        index += 1;
        continue;
      }
      passthroughArgs.push(arg);
    }
  } else {
    passthroughArgs.push(...args);
  }

  if (list) {
    const extensionIds = listAvailableExtensionIds();
    if (json) {
      process.stdout.write(`${JSON.stringify({ extensionIds }, null, 2)}\n`);
    } else {
      for (const extensionId of extensionIds) {
        console.log(extensionId);
      }
    }
    return;
  }

  if (listChanged) {
    let extensionIds;
    try {
      extensionIds = listChangedExtensionIds({ base, head });
    } catch (error) {
      printUsage();
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ base, head, extensionIds }, null, 2)}\n`);
    } else {
      for (const extensionId of extensionIds) {
        console.log(extensionId);
      }
    }
    return;
  }

  let targetArg;
  if (passthroughArgs[0] && !passthroughArgs[0].startsWith("-")) {
    targetArg = passthroughArgs.shift();
  }

  let plan;
  try {
    plan = resolveExtensionTestPlan({ cwd: process.cwd(), targetArg });
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (plan.testFiles.length === 0) {
    console.log(
      `No tests found for ${plan.extensionDir} — skipping. Run "pnpm test:extension ${plan.extensionId} -- --dry-run" to inspect the resolved roots.`,
    );
    process.exit(0);
  }

  if (dryRun) {
    if (json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      console.log(`[test-extension] ${plan.extensionId}`);
      console.log(`config: ${plan.config}`);
      console.log(`roots: ${plan.roots.join(", ")}`);
      console.log(`tests: ${plan.testFiles.length}`);
    }
    return;
  }

  console.log(
    `[test-extension] Running ${plan.testFiles.length} test files for ${plan.extensionId} with ${plan.config}`,
  );

  const child = spawn(
    pnpm,
    ["exec", "vitest", "run", "--config", plan.config, ...plan.testFiles, ...passthroughArgs],
    {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  await run();
}
