import fs from "node:fs";
import path from "node:path";
import { channelTestRoots } from "../../vitest.channel-paths.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function normalizeRelative(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function countTestFiles(rootPath) {
  let total = 0;
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
      if (entry.isFile() && (fullPath.endsWith(".test.ts") || fullPath.endsWith(".test.tsx"))) {
        total += 1;
      }
    }
  }

  return total;
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
    roots.push(normalizeRelative(path.relative(repoRoot, pairedCoreRoot)));
  }

  const usesChannelConfig = roots.some((root) => channelTestRoots.includes(root));
  const config = usesChannelConfig ? "vitest.channels.config.ts" : "vitest.extensions.config.ts";
  const testFileCount = roots.reduce(
    (sum, root) => sum + countTestFiles(path.join(repoRoot, root)),
    0,
  );

  return {
    config,
    extensionDir: relativeExtensionDir,
    extensionId,
    hasTests: testFileCount > 0,
    roots,
    testFileCount,
  };
}
