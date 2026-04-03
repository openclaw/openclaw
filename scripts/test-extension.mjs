#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { channelTestRoots } from "../vitest.channel-paths.mjs";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { loadTestRunnerBehavior } from "./test-runner-manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pnpm = "pnpm";
const testRunnerBehavior = loadTestRunnerBehavior();

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
}

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

function hasGitCommit(ref) {
  if (!ref || /^0+$/.test(ref)) {
    return false;
  }

  try {
    runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveChangedPathsBase(params = {}) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  const fallbackBaseRef = params.fallbackBaseRef;

  if (hasGitCommit(base)) {
    return base;
  }

  if (fallbackBaseRef) {
    const remoteBaseRef = fallbackBaseRef.startsWith("origin/")
      ? fallbackBaseRef
      : `origin/${fallbackBaseRef}`;
    if (hasGitCommit(remoteBaseRef)) {
      const mergeBase = runGit(["merge-base", remoteBaseRef, head]).trim();
      if (hasGitCommit(mergeBase)) {
        return mergeBase;
      }
    }
  }

  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  throw new Error(`Git base revision is unavailable locally: ${base}`);
}

function listChangedPaths(base, head = "HEAD") {
  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  return runGit(["diff", "--name-only", base, head])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasExtensionPackage(extensionId) {
  return fs.existsSync(path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR, extensionId, "package.json"));
}

export function listAvailableExtensionIds() {
  const extensionsDir = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR);
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

    const extensionMatch = relativePath.match(
      new RegExp(`^${BUNDLED_PLUGIN_PATH_PREFIX.replace("/", "\\/")}([^/]+)(?:/|$)`),
    );
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
  const head = params.head ?? "HEAD";
  const unavailableBaseBehavior = params.unavailableBaseBehavior ?? "error";

  try {
    const base = resolveChangedPathsBase(params);
    return detectChangedExtensionIds(listChangedPaths(base, head));
  } catch (error) {
    if (unavailableBaseBehavior === "all") {
      return listAvailableExtensionIds();
    }
    if (unavailableBaseBehavior === "empty") {
      return [];
    }
    throw error;
  }
}

function resolveExtensionDirectory(targetArg, cwd = process.cwd()) {
  if (targetArg) {
    const asGiven = path.resolve(cwd, targetArg);
    if (fs.existsSync(path.join(asGiven, "package.json"))) {
      return asGiven;
    }

    const byName = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR, targetArg);
    if (fs.existsSync(path.join(byName, "package.json"))) {
      return byName;
    }

    throw new Error(
      `Unknown extension target "${targetArg}". Use a plugin name like "slack" or a path inside the bundled plugin workspace tree.`,
    );
  }

  let current = cwd;
  while (true) {
    if (
      normalizeRelative(path.relative(repoRoot, current)).startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
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
    "No extension target provided, and current working directory is not inside the bundled plugin workspace tree.",
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
  const testFiles = roots
    .flatMap((root) => collectTestFiles(path.join(repoRoot, root)))
    .map((filePath) => normalizeRelative(path.relative(repoRoot, filePath)));
  const { isolatedTestFiles, sharedTestFiles } = partitionExtensionTestFiles({ config, testFiles });

  return {
    config,
    extensionDir: relativeExtensionDir,
    extensionId,
    isolatedTestFiles,
    roots,
    sharedTestFiles,
    testFiles,
  };
}

export function partitionExtensionTestFiles(params) {
  const testFiles = params.testFiles.map((filePath) => normalizeRelative(filePath));
  let isolatedEntries = [];
  let isolatedPrefixes = [];

  if (params.config === "vitest.channels.config.ts") {
    isolatedEntries = testRunnerBehavior.channels.isolated;
    isolatedPrefixes = testRunnerBehavior.channels.isolatedPrefixes;
  } else if (params.config === "vitest.extensions.config.ts") {
    isolatedEntries = testRunnerBehavior.extensions.isolated;
  }

  const isolatedEntrySet = new Set(isolatedEntries.map((entry) => entry.file));
  const isolatedTestFiles = testFiles.filter(
    (file) =>
      isolatedEntrySet.has(file) || isolatedPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  const isolatedTestFileSet = new Set(isolatedTestFiles);
  const sharedTestFiles = testFiles.filter((file) => !isolatedTestFileSet.has(file));

  return { isolatedTestFiles, sharedTestFiles };
}

async function runVitestBatch(params) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      pnpm,
      ["exec", "vitest", "run", "--config", params.config, ...params.files, ...params.args],
      {
        cwd: repoRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: params.env,
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function printUsage() {
  console.error("Usage: pnpm test:extension <extension-name|path> [vitest args...]");
  console.error("       node scripts/test-extension.mjs [extension-name|path] [vitest args...]");
  console.error("       node scripts/test-extension.mjs --list");
  console.error(
    "       node scripts/test-extension.mjs --list-changed --base <git-ref> [--head <git-ref>]",
  );
  console.error("       node scripts/test-extension.mjs <extension> --require-tests");
}

function printNoTestsMessage(plan, requireTests) {
  const message = `No tests found for ${plan.extensionDir}. Run "pnpm test:extension ${plan.extensionId} -- --dry-run" to inspect the resolved roots.`;
  if (requireTests) {
    console.error(message);
    return 1;
  }
  console.log(`[test-extension] ${message} Skipping.`);
  return 0;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const requireTests =
    rawArgs.includes("--require-tests") ||
    process.env.OPENCLAW_TEST_EXTENSION_REQUIRE_TESTS === "1";
  const json = rawArgs.includes("--json");
  const list = rawArgs.includes("--list");
  const listChanged = rawArgs.includes("--list-changed");
  const args = rawArgs.filter(
    (arg) =>
      arg !== "--" &&
      arg !== "--dry-run" &&
      arg !== "--require-tests" &&
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

  if (dryRun) {
    if (json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      console.log(`[test-extension] ${plan.extensionId}`);
      console.log(`config: ${plan.config}`);
      console.log(`roots: ${plan.roots.join(", ")}`);
      console.log(`tests: ${plan.testFiles.length}`);
      console.log(`shared: ${plan.sharedTestFiles.length}`);
      console.log(`isolated: ${plan.isolatedTestFiles.length}`);
    }
    return;
  }

  if (plan.testFiles.length === 0) {
    process.exit(printNoTestsMessage(plan, requireTests));
  }

  if (plan.testFiles.length === 0) {
    process.exit(printNoTestsMessage(plan, requireTests));
  }

  console.log(
    `[test-extension] Running ${plan.testFiles.length} test files for ${plan.extensionId} with ${plan.config}`,
  );

  if (plan.sharedTestFiles.length > 0 && plan.isolatedTestFiles.length > 0) {
    console.log(
      `[test-extension] Split into ${plan.sharedTestFiles.length} shared and ${plan.isolatedTestFiles.length} isolated files`,
    );
  }

  if (plan.sharedTestFiles.length > 0) {
    const sharedExitCode = await runVitestBatch({
      args: passthroughArgs,
      config: plan.config,
      env: process.env,
      files: plan.sharedTestFiles,
    });
    if (sharedExitCode !== 0) {
      process.exit(sharedExitCode);
    }
  }

  if (plan.isolatedTestFiles.length > 0) {
    const isolatedExitCode = await runVitestBatch({
      args: passthroughArgs,
      config: plan.config,
      env: { ...process.env, OPENCLAW_TEST_ISOLATE: "1" },
      files: plan.isolatedTestFiles,
    });
    process.exit(isolatedExitCode);
  }

  process.exit(0);
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  await run();
}
