import fs from "node:fs";
import path from "node:path";
import { channelTestRoots } from "../../vitest.channel-paths.mjs";
import { isProviderExtensionRoot } from "../../vitest.extension-provider-paths.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listAvailableExtensionIds } from "./changed-extensions.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 6;

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
  const usesProviderConfig = roots.some((root) => isProviderExtensionRoot(root));
  const config = usesChannelConfig
    ? "vitest.extension-channels.config.ts"
    : usesProviderConfig
      ? "vitest.extension-providers.config.ts"
      : "vitest.extensions.config.ts";
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

function mergeTestPlans(plans) {
  const groupsByConfig = new Map();

  for (const plan of plans) {
    const current = groupsByConfig.get(plan.config) ?? {
      config: plan.config,
      extensionIds: [],
      roots: [],
      testFileCount: 0,
    };

    current.extensionIds.push(plan.extensionId);
    current.roots.push(...plan.roots);
    current.testFileCount += plan.testFileCount;
    groupsByConfig.set(plan.config, current);
  }

  const planGroups = [...groupsByConfig.values()]
    .map((group) => ({
      ...group,
      extensionIds: group.extensionIds.toSorted((left, right) => left.localeCompare(right)),
      roots: [...new Set(group.roots)],
    }))
    .toSorted((left, right) => left.config.localeCompare(right.config));

  return {
    extensionCount: plans.length,
    extensionIds: plans
      .map((plan) => plan.extensionId)
      .toSorted((left, right) => left.localeCompare(right)),
    hasTests: plans.length > 0,
    planGroups,
    testFileCount: plans.reduce((sum, plan) => sum + plan.testFileCount, 0),
  };
}

export function resolveExtensionBatchPlan(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const plans = extensionIds
    .map((extensionId) => resolveExtensionTestPlan({ cwd, targetArg: extensionId }))
    .filter((plan) => plan.hasTests);

  return mergeTestPlans(plans);
}

function pickLeastLoadedShard(shards) {
  return shards.reduce((bestIndex, shard, index) => {
    if (bestIndex === -1) {
      return index;
    }
    const best = shards[bestIndex];
    if (shard.testFileCount !== best.testFileCount) {
      return shard.testFileCount < best.testFileCount ? index : bestIndex;
    }
    if (shard.plans.length !== best.plans.length) {
      return shard.plans.length < best.plans.length ? index : bestIndex;
    }
    return index < bestIndex ? index : bestIndex;
  }, -1);
}

export function createExtensionTestShards(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const shardCount = Math.max(1, Number.parseInt(String(params.shardCount ?? ""), 10) || 1);
  const plans = extensionIds
    .map((extensionId) => resolveExtensionTestPlan({ cwd, targetArg: extensionId }))
    .filter((plan) => plan.hasTests)
    .toSorted((left, right) => {
      if (left.testFileCount !== right.testFileCount) {
        return right.testFileCount - left.testFileCount;
      }
      return left.extensionId.localeCompare(right.extensionId);
    });

  const effectiveShardCount = Math.min(shardCount, Math.max(1, plans.length));
  const shards = Array.from({ length: effectiveShardCount }, () => ({
    plans: [],
    testFileCount: 0,
  }));

  for (const plan of plans) {
    const targetIndex = pickLeastLoadedShard(shards);
    shards[targetIndex].plans.push(plan);
    shards[targetIndex].testFileCount += plan.testFileCount;
  }

  return shards
    .map((shard, index) => ({
      index,
      checkName: `checks-fast-extensions-shard-${index + 1}`,
      ...mergeTestPlans(shard.plans),
    }))
    .filter((shard) => shard.hasTests);
}
