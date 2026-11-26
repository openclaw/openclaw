// Compose scheduled coverage outside the plan modules so they remain independent.
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "../../test/vitest/vitest.bundled-plugin-paths.ts";
import { coreChannelTestInclude } from "../../test/vitest/vitest.channel-paths.mjs";
import { cliProcessTestFiles } from "../../test/vitest/vitest.cli-process-paths.mjs";
import { commandsLightTestFiles } from "../../test/vitest/vitest.commands-light-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import {
  isSharedVitestExcludedPath,
  sharedVitestExcludePatterns,
  vitestE2eTestGlob,
  vitestLiveTestGlob,
} from "../../test/vitest/vitest.pattern-file.ts";
import { pluginSdkLightTestFiles } from "../../test/vitest/vitest.plugin-sdk-paths.mjs";
import { tuiPtyTestFiles } from "../../test/vitest/vitest.test-shards.mjs";
import { uiIsolatedTestFiles } from "../../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  controlUiE2eTestGlobs,
  isUiTestTarget,
  uiE2eRealGatewayTestFiles,
  uiTimingTestFiles,
} from "../../test/vitest/vitest.ui-paths.mjs";
import { getUnitFastTimerTestFiles } from "../../test/vitest/vitest.unit-fast-paths.mjs";
import { bundledPluginDependentUnitTestFiles } from "../../test/vitest/vitest.unit-paths.mjs";
import { RELEASE_LIVE_TEST_SHARDS, selectLiveShardFiles } from "../test-live-shard.mts";
import { createChannelContractTestShards } from "./channel-contract-test-plan.mts";
import {
  listNodeTestVolumeConfigFiles,
  listScopedOwnerTestFiles,
  SCHEDULED_COVERAGE_EXCEPTIONS,
  scheduledTrackedTestFiles,
} from "./ci-node-test-inventory.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  resolveCanonicalTargetInventory,
  type CompactNodeTestShard,
  type NodeTestShard,
  type NodeTestShardGroup,
} from "./ci-node-test-plan.mts";
import { NODE_WORKER_E2E_TEST_FILES } from "./ci-node-worker-e2e-inventory.mts";
import { createUiTestShardGroups } from "./ci-ui-test-plan.mts";
import { createWindowsTestShards } from "./ci-windows-test-plan.mts";
import {
  createExtensionTestShards,
  listExtensionTestFilesForRoots,
} from "./extension-test-plan.mts";
import { createPluginContractTestShards } from "./plugin-contract-test-plan.mts";

// These owners describe scheduled selections only. They must not make runtime
// configs complete or introduce tracked-file scans into PR planning.
const SCHEDULED_COVERAGE_CONFIG_OWNERS = new Map<
  string,
  Parameters<typeof listScopedOwnerTestFiles>[0] | (() => string[])
>([
  ...["media", "media-understanding", "wizard", "secrets", "logging", "process"].map(
    (area): [string, Parameters<typeof listScopedOwnerTestFiles>[0]] => [
      `test/vitest/vitest.${area}.config.ts`,
      {
        root: `src/${area}`,
        include: [`src/${area}/**/*.test.ts`],
        exclude: databaseWorkerCoreTestFiles,
      },
    ],
  ),
  [
    "test/vitest/vitest.commands-light.config.ts",
    { root: "src/commands", include: commandsLightTestFiles, exclude: databaseWorkerCoreTestFiles },
  ],
  [
    "test/vitest/vitest.daemon.config.ts",
    { root: "src/daemon", include: ["src/daemon/**/*.test.ts"], exclude: cliProcessTestFiles },
  ],
  [
    "test/vitest/vitest.plugin-sdk-light.config.ts",
    { root: "src/plugin-sdk", include: pluginSdkLightTestFiles, exclude: [] },
  ],
  [
    "test/vitest/vitest.plugin-sdk.config.ts",
    {
      root: "src/plugin-sdk",
      include: ["src/plugin-sdk/**/*.test.ts"],
      exclude: [
        ...pluginSdkLightTestFiles,
        ...bundledPluginDependentUnitTestFiles,
        ...databaseWorkerCoreTestFiles,
      ],
    },
  ],
  [
    "test/vitest/vitest.channels.config.ts",
    {
      root: "src/channels",
      include: coreChannelTestInclude,
      exclude: [
        "src/gateway/**",
        "src/channels/plugins/contracts/**",
        ...databaseWorkerCoreTestFiles,
      ],
    },
  ],
  [
    "test/vitest/vitest.unit-fast-fake-timers.config.ts",
    () => getUnitFastTimerTestFiles().filter((file) => !isSharedVitestExcludedPath(file)),
  ],
  ["test/vitest/vitest.ui-isolated.config.ts", () => uiIsolatedTestFiles],
  ["test/vitest/vitest.ui-timing.config.ts", () => uiTimingTestFiles],
  ["ui/vitest.config.ts", () => scheduledTrackedTestFiles().filter(isUiTestTarget)],
  [
    "test/vitest/vitest.ui-e2e.config.ts",
    () =>
      scheduledTrackedTestFiles().filter(
        (file) =>
          [...controlUiE2eTestGlobs, ...uiE2eRealGatewayTestFiles].some((pattern) =>
            matchesGlob(file, pattern),
          ) && !scheduledE2eExcludes().some((pattern) => matchesGlob(file, pattern)),
      ),
  ],
  [
    "test/vitest/vitest.e2e.config.ts",
    () =>
      scheduledTrackedTestFiles().filter(
        (file) =>
          [
            "test/**/*.e2e.test.ts",
            "src/**/*.e2e.test.ts",
            "packages/**/*.e2e.test.ts",
            "src/gateway/gateway.test.ts",
            BUNDLED_PLUGIN_E2E_TEST_GLOB,
          ].some((pattern) => matchesGlob(file, pattern)) &&
          ![
            ...scheduledE2eExcludes(),
            ...tuiPtyTestFiles,
            ...controlUiE2eTestGlobs,
            ...uiE2eRealGatewayTestFiles,
          ].some((pattern) => matchesGlob(file, pattern)),
      ),
  ],
]);
const scheduledCoverageConfigCache = new Map<string, string[]>();

function listScheduledCoverageConfigFiles(config: string): string[] | undefined {
  let files = scheduledCoverageConfigCache.get(config);
  if (files) {
    return files;
  }
  const declared = listNodeTestVolumeConfigFiles(config);
  if (declared) {
    scheduledCoverageConfigCache.set(config, declared);
    return declared;
  }
  const owner = SCHEDULED_COVERAGE_CONFIG_OWNERS.get(config);
  if (!owner) {
    return undefined;
  }
  files = typeof owner === "function" ? owner() : listScopedOwnerTestFiles(owner);
  scheduledCoverageConfigCache.set(config, files);
  return files;
}
function scheduledE2eExcludes(): string[] {
  return sharedVitestExcludePatterns.filter((pattern) => pattern !== vitestE2eTestGlob);
}

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
    (config) => !inventory.completeConfigs.has(config) && !listScheduledCoverageConfigFiles(config),
  );
  if (missingConfigs.length) {
    throw new Error(
      `Scheduled coverage needs SCHEDULED_COVERAGE_CONFIG_OWNERS entries for: ${missingConfigs.join(", ")}`,
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
    const declared = listScheduledCoverageConfigFiles(config);
    if (declared) {
      return declared;
    }
    if (!inventory.completeConfigs.has(config)) {
      throw new Error(
        `Scheduled coverage has no static file inventory for ${config}; add a SCHEDULED_COVERAGE_CONFIG_OWNERS entry`,
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
