// Compose scheduled coverage outside the plan modules so they remain independent.
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import {
  sharedVitestExcludePatterns,
  vitestLiveTestGlob,
} from "../../test/vitest/vitest.pattern-file.ts";
import { RELEASE_LIVE_TEST_SHARDS, selectLiveShardFiles } from "../test-live-shard.mts";
import { createChannelContractTestShards } from "./channel-contract-test-plan.mts";
import {
  listNodeTestVolumeConfigFiles,
  SCHEDULED_COVERAGE_EXCEPTIONS,
  scheduledTrackedTestFiles,
} from "./ci-node-test-inventory.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  createUiTestShardGroups,
  resolveCanonicalTargetInventory,
  type CompactNodeTestShard,
  type NodeTestShard,
  type NodeTestShardGroup,
} from "./ci-node-test-plan.mts";
import { NODE_WORKER_E2E_TEST_FILES } from "./ci-node-worker-e2e-inventory.mts";
import { createWindowsTestShards } from "./ci-windows-test-plan.mts";
import {
  createExtensionTestShards,
  listExtensionTestFilesForRoots,
} from "./extension-test-plan.mts";
import { createPluginContractTestShards } from "./plugin-contract-test-plan.mts";

let scheduledTestFiles: string[] | undefined;

/**
 * Selection coverage, not green-run evidence. Keep these inputs aligned with the
 * four scheduled owners; nightly release validation may reuse prior evidence.
 */
export function listScheduledTestFiles(): string[] {
  if (scheduledTestFiles) {
    return scheduledTestFiles;
  }
  const tracked = scheduledTrackedTestFiles();
  const inventory = resolveCanonicalTargetInventory();
  const missingConfigs = [...inventory.configs].filter(
    (config) => !inventory.completeConfigs.has(config) && !listNodeTestVolumeConfigFiles(config),
  );
  if (missingConfigs.length) {
    throw new Error(
      `Scheduled coverage needs CONFIG_FILE_OWNERS entries for: ${missingConfigs.join(", ")}`,
    );
  }
  const filesByConfig = new Map<string, string[]>();
  for (const [file, configs] of inventory.configsByFile) {
    for (const config of configs) {
      const files = filesByConfig.get(config) ?? [];
      files.push(file);
      filesByConfig.set(config, files);
    }
  }
  const configFiles = (config: string): string[] => {
    const declared = listNodeTestVolumeConfigFiles(config);
    if (declared) {
      return declared;
    }
    if (!inventory.completeConfigs.has(config)) {
      throw new Error(
        `Scheduled coverage has no static file inventory for ${config}; add a CONFIG_FILE_OWNERS entry`,
      );
    }
    return filesByConfig.get(config) ?? [];
  };
  const selected = new Set<string>();
  const addGroups = (groups: readonly { configs: string[]; includePatterns?: string[] }[]) => {
    for (const group of groups) {
      // Validate even explicit envelopes: a newly introduced config must have
      // a static owner, never runtime discovery or an assumed broad fallback.
      const owned = group.configs.flatMap(configFiles);
      for (const file of group.includePatterns ?? owned) {
        selected.add(file);
      }
    }
  };
  const nodeGroups = (shards: readonly (NodeTestShard | CompactNodeTestShard)[]) =>
    shards.flatMap<Pick<NodeTestShardGroup, "configs" | "includePatterns">>((shard) =>
      "configs" in shard ? (shard.groups ?? [shard]) : shard.groups,
    );
  // ci-build-manifest.mjs:createFullNodeTestPlan, scheduled main validation.
  addGroups(
    nodeGroups(
      createNodeTestShardBundles({
        includeProofTests: true,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards: true,
        includeReleaseOnlyRuntimeTests: false,
        includePrExemptRuntimeTests: true,
        compact: true,
        compactMode: "pull-request",
        mainValidation: true,
        compactNodeJobCap: 75,
        runnerBackend: "github",
      }),
    ),
  );
  for (const file of NODE_WORKER_E2E_TEST_FILES) {
    selected.add(file);
  }
  const ui = createUiTestShardGroups({
    includeReleaseOnlyTests: false,
    includeReleaseOnlyE2eTests: true,
    includePrExemptRuntimeTests: true,
    changedPaths: [],
  });
  addGroups([...ui.ui, ...ui.e2e]);
  // The built-artifact producer runs this source config outside the Node matrix.
  addGroups([{ configs: ["test/vitest/vitest.channels.config.ts"] }]);
  // Full release rerun_group=all dispatches CI plus the independent plugin
  // phase with full_release_validation=true (including agentic-plugins).
  addGroups(
    nodeGroups(
      createNodeTestShards({
        includeProofTests: true,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards: true,
        includeReleaseOnlyRuntimeTests: true,
        includePrExemptRuntimeTests: true,
      }),
    ),
  );
  addGroups(
    nodeGroups(
      createNodeTestShards({ includeReleaseOnlyPluginShards: true }).filter(
        (shard) => shard.shardName === "agentic-plugins",
      ),
    ),
  );
  const releaseUi = createUiTestShardGroups();
  addGroups([...releaseUi.ui, ...releaseUi.e2e]);
  addGroups(
    [...createChannelContractTestShards(), ...createPluginContractTestShards()].map((shard) => ({
      configs: [],
      includePatterns: shard.includePatterns,
    })),
  );
  // Windows coverage follows the checkout's own package scripts.
  const packageJson: unknown = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const isScripts = (value: unknown): value is Record<string, string> =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((script) => typeof script === "string");
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    !("scripts" in packageJson) ||
    !isScripts(packageJson.scripts)
  ) {
    throw new Error("Scheduled Windows coverage requires package.json scripts");
  }
  for (const shard of createWindowsTestShards(packageJson.scripts, {
    includePrExemptRuntimeTests: true,
  })) {
    for (const file of shard.targets) {
      selected.add(file);
    }
  }
  // Hourly plugin-prerelease additionally includes manifest-only/root files.
  const extensionRoots = new Set(
    createExtensionTestShards({ shardCount: 8 }).flatMap((shard) =>
      shard.planGroups.flatMap((group) => group.roots),
    ),
  );
  extensionRoots.add("extensions");
  for (const file of listExtensionTestFilesForRoots([...extensionRoots])) {
    if (!/\.(?:e2e|live)\.test\./u.test(file)) {
      selected.add(file);
    }
  }
  // Daily repo/UI e2e and the actual named live-shard selection, not all files
  // accepted by vitest.live.config.ts (notably package-local live tests).
  addGroups([
    { configs: ["test/vitest/vitest.e2e.config.ts", "test/vitest/vitest.ui-e2e.config.ts"] },
  ]);
  const liveCandidates = tracked.filter(
    (file) =>
      /^(?:src|test|extensions)\//u.test(file) &&
      file.endsWith(".live.test.ts") &&
      file !== "src/gateway/gateway-thinking-probe.live.test.ts" &&
      !sharedVitestExcludePatterns.some(
        (pattern) => pattern !== vitestLiveTestGlob && matchesGlob(file, pattern),
      ),
  );
  for (const shard of RELEASE_LIVE_TEST_SHARDS) {
    for (const file of selectLiveShardFiles(shard, liveCandidates)) {
      selected.add(file);
    }
  }
  // These scheduled Vitest wrappers execute standalone Node/Python child tests.
  const delegated: Array<[string, (file: string) => boolean]> = [
    [
      "test/scripts/telegram-e2e-userbot-skill.test.ts",
      (file) =>
        file.startsWith(".agents/skills/telegram-e2e-userbot/scripts/") &&
        /\.test\.(?:mjs|py)$/u.test(file),
    ],
    [
      "test/scripts/pr-cache-lifetime-collection.test.ts",
      (file) => file === "test/scripts/pr-cache-lifetime-process.test.py",
    ],
    [
      "test/scripts/parallels-exec.test.ts",
      (file) => file === "test/scripts/parallels-exec.test.py",
    ],
  ];
  for (const [wrapper, owns] of delegated) {
    if (selected.has(wrapper)) {
      for (const file of tracked.filter(owns)) {
        selected.add(file);
      }
    }
  }
  scheduledTestFiles = tracked.filter((file) => selected.has(file));
  return scheduledTestFiles;
}

/** The secretless daily lane is the complement of scheduled selections and explicit exceptions. */
export function listUnscheduledTestFiles(): string[] {
  const scheduled = new Set(listScheduledTestFiles());
  return scheduledTrackedTestFiles().filter(
    (file) =>
      !scheduled.has(file) &&
      !SCHEDULED_COVERAGE_EXCEPTIONS.some(({ pattern }) => matchesGlob(file, pattern)),
  );
}
