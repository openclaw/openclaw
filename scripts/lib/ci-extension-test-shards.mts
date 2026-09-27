import { existsSync } from "node:fs";
import path from "node:path";
import { isPluginControlUiPath } from "../../test/vitest/vitest.ui-paths.mjs";
import { isTestFileTarget } from "../test-projects.test-support.mts";
import {
  isRuntimeTestFileIncluded,
  packNodeTestGroups,
  type NodeTestShard,
  type RuntimeTestSelection,
} from "./ci-node-test-plan.mts";
import { isCiProofTestFile } from "./ci-proof-test-inventory.mts";
import {
  DATABASE_WORKER_CONFIG,
  DATABASE_WORKER_TEST_JOB_FILE_LIMIT,
  estimateExtensionTestCost,
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
  shouldSplitExtensionTestProcesses,
  splitExtensionTestJobTargets,
} from "./extension-test-plan.mts";
import {
  mergeVitestPretestBuildModes,
  resolveVitestPretestBuildMode,
  type VitestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "./vitest-shard-metadata.mts";

type CwdOptions = { cwd?: string };
type ChangedExtensionConfigShard = NodeTestShard & { predictedSeconds: number };
// Share runner setup while retaining each envelope's process and memory bounds.
const CHANGED_EXTENSION_JOB_SECONDS = 300;
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";

export function resolveChangedExtensionRoots(changedPaths: string[]) {
  return [
    ...new Set(
      changedPaths.flatMap((changedPath) => {
        const [, extensionId] = changedPath.split("/");
        return extensionId ? [`extensions/${extensionId}`] : [];
      }),
    ),
  ];
}

export function createChangedExtensionConfigShards(
  extensionRoots: string[],
  options: CwdOptions &
    RuntimeTestSelection & { fullConfigInventory?: boolean; targets?: ReadonlySet<string> } = {},
): ChangedExtensionConfigShard[] {
  const selectedRoots = new Set(extensionRoots);
  const rootsByConfig = new Map<string, string[]>();
  for (const root of extensionRoots) {
    const config = resolveExtensionTestConfig(root);
    rootsByConfig.set(config, [...(rootsByConfig.get(config) ?? []), root]);
  }
  const filesByConfig = new Map<string, string[]>();
  for (const file of rootsByConfig.size > 0
    ? listExtensionTestFilesForRoots(["extensions"], options.cwd)
    : []) {
    const config = resolveExtensionTestConfig(file);
    filesByConfig.set(config, [...(filesByConfig.get(config) ?? []), file]);
    const root = file.split("/").slice(0, 2).join("/");
    if (selectedRoots.has(root)) {
      const roots = rootsByConfig.get(config) ?? [];
      if (!roots.includes(root)) {
        rootsByConfig.set(config, [...roots, root]);
      }
    }
  }
  const plans: Array<{
    config: string;
    env?: Record<string, string>;
    includePatterns?: string[];
    pretestBuildMode?: VitestPretestBuildMode;
    predictedSeconds: number;
  }> = [...rootsByConfig].flatMap(([config, roots]) => {
    const splitProcesses =
      options.targets !== undefined || shouldSplitExtensionTestProcesses(config);
    const configFiles = filesByConfig.get(config) ?? [];
    const runtimeFiltered = configFiles.some(
      (file) => !isRuntimeTestFileIncluded(file, options, options.cwd),
    );
    const testFiles = configFiles.filter(
      (file) =>
        !isCiProofTestFile(file) &&
        isRuntimeTestFileIncluded(file, options, options.cwd) &&
        (!options.targets || options.targets.has(file)) &&
        (!splitProcesses ||
          options.fullConfigInventory ||
          roots.some((root) => file.startsWith(`${root}/`))),
    );
    if ((options.targets || runtimeFiltered) && testFiles.length === 0) {
      return [];
    }
    const buildModes = new Map(
      (splitProcesses ? testFiles : []).map((file) => [
        file,
        resolveVitestPretestBuildMode([{ includePatterns: [file] }]),
      ]),
    );
    const configBuildMode = splitProcesses
      ? undefined
      : resolveVitestPretestBuildMode([{ configs: [config] }]);
    let chunks = testFiles.length > 0 ? splitExtensionTestJobTargets(config, testFiles) : [roots];
    if (
      splitProcesses &&
      chunks.filter((files) => files.some((file) => buildModes.get(file))).length > 1
    ) {
      // Explicit scopes follow the prerequisite owner even after files migrate configs.
      // Keep build consumers together before reapplying every job/process file bound.
      const runtimeFiles: string[] = [];
      const otherFiles: string[] = [];
      for (const file of testFiles) {
        const target = buildModes.get(file) ? runtimeFiles : otherFiles;
        target.push(file);
      }
      chunks = [runtimeFiles, otherFiles]
        .filter((files) => files.length > 0)
        .flatMap((files) => splitExtensionTestJobTargets(config, files));
    }
    const partitionSeconds = Math.ceil(
      estimateExtensionTestCost(config, testFiles.length, testFiles) / chunks.length,
    );
    return chunks.map((includePatterns, index) =>
      Object.assign(
        {
          config,
          pretestBuildMode: splitProcesses
            ? mergeVitestPretestBuildModes(includePatterns.map((file) => buildModes.get(file)))
            : configBuildMode,
          predictedSeconds: splitProcesses
            ? estimateExtensionTestCost(config, includePatterns.length, includePatterns)
            : partitionSeconds,
        },
        splitProcesses
          ? { includePatterns }
          : chunks.length > 1
            ? {
                // Counts size jobs only. Vitest owns the complete config inventory,
                // including unrelated plugin roots, excludes and untracked tests.
                env: {
                  OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify([
                    `--shard=${index + 1}/${chunks.length}`,
                  ]),
                },
              }
            : {},
        // Native-sharded configs keep their process contract while every shard
        // consumes the same selected inventory before Vitest partitions it.
        !splitProcesses && runtimeFiltered ? { includePatterns: testFiles } : {},
      ),
    );
  });
  return plans.map(
    ({ config, env, includePatterns, pretestBuildMode, predictedSeconds }, index) => {
      const suffix = plans.length === 1 ? "" : `-${index + 1}`;
      const shard: ChangedExtensionConfigShard = {
        checkName: `checks-node-changed-extensions-config${suffix}`,
        configs: [config],
        // No plans overlap in this row, so CI can scale the single process's worker budget.
        planConcurrency: 1,
        predictedSeconds,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: `changed-extensions-config${suffix}`,
      };
      if (pretestBuildMode) {
        shard.pretestBuildMode = pretestBuildMode;
        shard.predictedSeconds = predictedSeconds + VITEST_PRETEST_BUILD_SECONDS[pretestBuildMode];
      }
      if (includePatterns) {
        shard.includePatterns = includePatterns;
      }
      if (env) {
        shard.env = env;
      }
      return shard;
    },
  );
}

export function createChangedExtensionConfigShardsForPaths(
  changedPaths: string[],
  cwd: string,
  options: RuntimeTestSelection = {},
) {
  const relevantPaths = changedPaths.filter(
    (changedPath) =>
      changedPath.startsWith("extensions/") &&
      !isPluginControlUiPath(changedPath) &&
      (existsSync(path.join(cwd, changedPath)) || !isTestFileTarget(changedPath)),
  );
  const roots = resolveChangedExtensionRoots(relevantPaths);
  return createChangedExtensionConfigShards(roots, {
    ...options,
    cwd,
    targets: new Set(listExtensionTestFilesForRoots(roots, cwd)),
  });
}

export function packChangedExtensionConfigShards(
  shards: ChangedExtensionConfigShard[],
): NodeTestShard[] {
  const workerFileCounts = new Map(
    shards.map((shard) => [
      shard,
      shard.configs.includes(DATABASE_WORKER_CONFIG) ? (shard.includePatterns?.length ?? 0) : 0,
    ]),
  );
  const bins = packNodeTestGroups(
    shards.toSorted(
      (a, b) => b.predictedSeconds - a.predictedSeconds || a.shardName.localeCompare(b.shardName),
    ),
    // Each envelope retains its own child process. Share only the checkout;
    // runtime preparation stays separate from other configs' readers.
    (bin, shard) =>
      // Count the effective config, including files migrated from other plugins.
      bin.reduce(
        (count, entry) => count + (workerFileCounts.get(entry) ?? 0),
        workerFileCounts.get(shard) ?? 0,
      ) <= DATABASE_WORKER_TEST_JOB_FILE_LIMIT &&
      !shard.pretestBuildMode &&
      bin.every(
        (entry) =>
          !entry.pretestBuildMode &&
          entry.runner === shard.runner &&
          entry.requiresDist === shard.requiresDist,
      ) &&
      bin.reduce((seconds, entry) => seconds + entry.predictedSeconds, shard.predictedSeconds) <=
        CHANGED_EXTENSION_JOB_SECONDS,
    true,
  );
  // Singleton objects keep their full metadata and original relative order.
  return bins
    .toSorted((a, b) => shards.indexOf(a[0]) - shards.indexOf(b[0]))
    .map((bin, index) =>
      bin.length === 1
        ? bin[0]
        : {
            checkName: `checks-node-changed-extensions-bundle-${index + 1}`,
            configs: [],
            groups: bin.map((shard) => ({
              configs: shard.configs,
              ...(shard.env ? { env: shard.env } : {}),
              ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
              requiresDist: shard.requiresDist,
              runner: shard.runner,
              shard_name: shard.shardName,
            })),
            planConcurrency: 1,
            predictedSeconds: bin.reduce((seconds, shard) => seconds + shard.predictedSeconds, 0),
            requiresDist: bin[0].requiresDist,
            runner: bin[0].runner,
            shardName: `changed-extensions-bundle-${index + 1}`,
          },
    );
}
