// Builds CI node/Vitest shard plans from the full suite configuration.
import { readFileSync, statSync } from "node:fs";
import { matchesGlob, relative } from "node:path";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../../test/vitest/vitest.agents-paths.mjs";
import { cliProcessTestFiles } from "../../test/vitest/vitest.cli-process-paths.mjs";
import {
  databaseWorkerCoreTestFiles,
  isDatabaseWorkerCoreTestFile,
} from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayPluginTestFiles,
  gatewayServerExcludedTestFiles,
  gatewayServerIsolatedTestFiles,
  gatewayServerSerialTestFiles,
  isGatewayServerBackedHttpTestFile,
  isGatewayServerTestFile,
} from "../../test/vitest/vitest.gateway-server-paths.mjs";
import { startupCorpusTestFiles } from "../../test/vitest/vitest.startup-corpus-paths.mjs";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { toolingIsolatedTestFiles } from "../../test/vitest/vitest.tooling-isolated-paths.mjs";
import { uiIsolatedTestFiles } from "../../test/vitest/vitest.ui-isolated-paths.mjs";
import {
  isPluginControlUiPath,
  isUiBrowserTestFile,
  uiTimingTestFiles,
} from "../../test/vitest/vitest.ui-paths.mjs";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTestFilesForIncludePatterns,
  getUnitFastTimerTestFiles,
} from "../../test/vitest/vitest.unit-fast-paths.mjs";
import {
  boundaryTestFiles,
  bundledPluginDependentUnitTestFiles,
  isUnitConfigTestFile,
} from "../../test/vitest/vitest.unit-paths.mjs";
import {
  buildVitestRunPlans,
  isTestFileTarget,
  isToolingTestOwnerPath,
} from "../test-projects.test-support.mts";
import {
  COMMANDS_PARALLEL_TIMING_SUFFIX,
  COMMANDS_RUNTIME_GROUP,
  estimateSerialCommandSeconds,
  estimateLegacyCommandStripeSeconds,
  commandFileSecondsFloor,
  createAgenticCommandSplitShards,
  isParallelCommandsGroup,
  estimateCommandWorkerSeconds,
} from "./ci-command-test-plan.mts";
import { isCiProofTestFile } from "./ci-proof-test-inventory.mts";
import { rebalanceRuntimeTestJobs } from "./ci-runtime-test-placement.mts";
import { isRuntimePlacementIncludePatterns } from "./ci-test-timings-schema.mts";
import {
  readCompactGroupTimings,
  readCompleteSplitGenerationSeconds,
  readRuntimePlacementTimings,
  resolveRuntimePlacementSeconds,
} from "./ci-test-timings.mts";
import { isStripeEligibleTestFile, listTrackedTestFiles } from "./list-test-files.mts";
import { isExclusiveCiTestConfig } from "./local-check-runtime.mts";
import {
  listVitestRuntimeConsumerFiles,
  mergeVitestPretestBuildModes,
  resolveVitestPretestBuildMode,
  type VitestPretestBuildMode as NodeTestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";
import {
  COMPACT_GITHUB_GROUP_SECONDS_SCALE,
  COMPACT_HYBRID_GROUP_SECONDS_SCALE,
  VITEST_PRETEST_BUILD_SECONDS,
  createCompactSplitTimingGeneration,
  estimateVitestTestFileSeconds as stripeFileWeight,
  estimateVitestToolingFileSeconds as toolingFileWeight,
  parseCompactSplitTimingKey,
} from "./vitest-shard-metadata.mts";

export { isToolingTestOwnerPath } from "../test-projects.test-support.mts";

export type NodeTestShardGroup = {
  shard_name: string;
  timing_key?: string;
  configs: string[];
  includePatterns?: string[];
  pretestBuildMode?: NodeTestPretestBuildMode;
  requiresDist: boolean;
  runner: string;
  env?: Record<string, string>;
  fallbackMaxWorkers?: number;
  minTotalMemoryBytes?: number;
};

function compactGroupTimingKey(group: NodeTestShardGroup): string {
  return group.timing_key ?? group.shard_name;
}

type NodeTestShard = {
  checkName: string;
  shardName: string;
  configs: string[];
  runner: string;
  requiresDist: boolean;
  pretestBuildMode?: NodeTestPretestBuildMode;
  includePatterns?: string[];
  env?: Record<string, string>;
  groups?: NodeTestShardGroup[];
  timeoutMinutes?: number;
  planConcurrency?: number;
  predictedSeconds?: number;
};

type NodeTestPlanOptions = {
  changedPaths?: readonly string[];
  includeReleaseOnlyPluginShards?: boolean;
  includeProofTests?: boolean;
  includeReleaseOnlyToolingShards?: boolean;
  compact?: boolean;
  compactMode?: CompactNodeTestPlanMode;
  compactGroupCount?: number;
  compactWholeGroupCount?: number;
  compactNodeJobCap?: number;
  runnerBackend?: string;
};

export function hasCompleteStartupCorpusCoverage(
  shards: readonly {
    requiresDist: boolean;
    targets?: readonly string[];
    groups?: readonly NodeTestShardGroup[];
  }[],
): boolean {
  // Only explicit, unfiltered file owners prove the corpus is complete. A
  // config name or native shard can still execute just part of the matrix.
  const groups = shards.flatMap((shard) =>
    !shard.requiresDist && !shard.targets?.length ? (shard.groups ?? []) : [],
  );
  return startupCorpusTestFiles.every((file) =>
    groups.some(
      (group) =>
        group.configs.length === 1 &&
        group.configs[0] === "test/vitest/vitest.runtime-config.config.ts" &&
        Object.keys(group.env ?? {}).every((key) => key === "OPENCLAW_VITEST_MAX_WORKERS") &&
        group.includePatterns?.includes(file),
    ),
  );
}

type CompactNodeTestPlanMode = "pull-request" | "push";

type PolicyTestWatch = {
  ownerGlobs?: readonly string[];
  testFile: string;
  watchGlobs: readonly string[];
};

// These tests read source trees instead of importing every file whose policy
// they enforce. Boundary and contract suites have dedicated always-on lanes;
// this inventory covers the remaining tests that changed targeting cannot
// discover from imports alone.
const policyTestWatches = [
  {
    testFile: "test/scripts/tsgo-core-test-shards.test.ts",
    watchGlobs: [
      "src/{auto-reply,infra/outbound}/**/*.test.{ts,tsx}",
      "tsconfig.json",
      "test/tsconfig/tsconfig.test.json",
      "test/tsconfig/tsconfig.core.test*.json",
      "test/tsconfig/tsconfig.test.packages.json",
    ],
  },
  {
    testFile: "src/infra/fs-safe-import-boundary.test.ts",
    watchGlobs: ["src/test-utils/**/*.ts"],
  },
  {
    testFile: "test/scripts/test-projects.test.ts",
    watchGlobs: ["test/scripts/**/*.test.ts"],
  },
  {
    testFile: "test/vitest-projects-config.test.ts",
    watchGlobs: ["extensions/codex/src/app-server/**/*.test.ts"],
  },
  {
    testFile: "test/scripts/pr-worktree-provision.test.ts",
    ownerGlobs: ["scripts/pr-lib/wrapper-components.txt"],
    watchGlobs: [
      "scripts/pr",
      "scripts/pr-lib/**",
      ...readFileSync(new URL("../pr-lib/wrapper-components.txt", import.meta.url), "utf8")
        .trim()
        .split("\n"),
    ],
  },
  {
    testFile: "ui/src/components/web-awesome-migration.node.test.ts",
    watchGlobs: ["ui/src/**/*.ts"],
  },
  {
    testFile: "ui/src/styles/base-theme-tokens.node.test.ts",
    ownerGlobs: ["ui/src/**/*.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/**/*.css", "ui/src/**/*.ts", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/base-theme-contrast.node.test.ts",
    ownerGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/cursor-policy.node.test.ts",
    ownerGlobs: ["ui/index.html", "ui/src/**/*.css"],
    watchGlobs: ["ui/index.html", "ui/src/**/*.css", "ui/src/**/*.ts"],
  },
  ...[
    "src/cron/service.stream-trigger.test.ts",
    "src/cron/service.stream-validation.test.ts",
    "src/cron/service/timer.timeout-watchdog.test.ts",
  ].map((testFile) => ({
    testFile,
    ownerGlobs: ["src/cron/failure-notification-text.ts"],
    watchGlobs: ["src/cron/failure-notification-text.ts"],
  })),
  {
    // Reads the bundled Anthropic manifest to pin the manifest-free alias table.
    testFile: "src/agents/model-ref-shared.test.ts",
    watchGlobs: ["extensions/anthropic/openclaw.plugin.json"],
  },
  {
    testFile: "src/gateway/gateway-ssh-upload-signal.test.ts",
    watchGlobs: [
      "src/agents/sandbox/remote-shell-transport.ts",
      "src/agents/sandbox/remote-shell-backend.ts",
      "src/agents/sandbox/ssh.ts",
      "src/agents/sandbox/ssh-backend.ts",
    ],
  },
] satisfies readonly PolicyTestWatch[];

/** Resolve policy tests whose scanned source surface intersects this diff. */
export function resolvePolicyTestTargets(changedPaths: readonly string[]): string[] {
  return policyTestWatches
    .filter(({ watchGlobs }) =>
      changedPaths.some((changedPath) =>
        watchGlobs.some((watchGlob) => matchesGlob(changedPath, watchGlob)),
      ),
    )
    .map(({ testFile }) => testFile);
}

/** True when the policy tests are the complete bounded owner for this path. */
export function isPolicyTestOwnedPath(changedPath: string): boolean {
  return policyTestWatches.some(({ ownerGlobs }) =>
    ownerGlobs?.some((ownerGlob) => matchesGlob(changedPath, ownerGlob)),
  );
}

function includesReleaseOnlyTooling(options: NodeTestPlanOptions): boolean {
  return (
    options.includeReleaseOnlyToolingShards !== false ||
    (options.changedPaths ?? []).some(isToolingTestOwnerPath)
  );
}

export type CompactNodeTestShard = Omit<NodeTestShard, "configs" | "groups"> & {
  groups: NodeTestShardGroup[];
};

type NodeTestSplitShard = Omit<NodeTestShard, "checkName" | "runner" | "pretestBuildMode"> & {
  includeExternalConfigs?: boolean;
  runner?: string;
};

const EXCLUDED_FULL_SUITE_SHARDS = new Set([
  "test/vitest/vitest.full-core-contracts.config.ts",
  "test/vitest/vitest.full-core-bundled.config.ts",
  "test/vitest/vitest.full-extensions.config.ts",
]);

const EXCLUDED_PROJECT_CONFIGS = new Set([
  "test/vitest/vitest.channels.config.ts",
  // checks-ui owns the Chromium project; Node stripes retain Node-driven Playwright tests.
  "test/vitest/vitest.ui-browser.config.ts",
]);
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
// Startup-core transforms the broad gateway graph before its assertions run.
// Keep enough CPU here to avoid spending minutes in Vitest imports on 4 vCPU.
const GATEWAY_STARTUP_CORE_RUNNER = DEFAULT_NODE_TEST_RUNNER;
// This cold gateway graph can stall after warming Vitest's module cache; its
// retry completes in seconds, so do not spend the global five-minute timeout.
const GATEWAY_STARTUP_HEALTH_RUNTIME_ENV = {
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000",
};
// The first embedded-agent file owns 157 serial tests and can stay quiet for
// more than five minutes on a cold GitHub-hosted fork runner. Keep the outer
// watchdog above the scoped 600-second hook budget so it cannot preempt Vitest.
const AGENTS_EMBEDDED_AGENT_ENV = {
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "660000",
};
const COMPACT_EMBEDDED_BASE_GROUP_NAME = "agentic-agents-embedded-base";
const COMPACT_EMBEDDED_GROUP_NAMES = [
  COMPACT_EMBEDDED_BASE_GROUP_NAME,
  "agentic-agents-embedded-incomplete-turn",
  "agentic-agents-embedded-overflow-compaction",
  "agentic-agents-embedded-run",
];
const MAX_BUNDLED_NODE_TEST_PATTERNS = 64;
// Compact bundles trade a little serial work for fewer ephemeral runner registrations.
// Keep runner classes and subprocess isolation intact while bounding each combined job.
// Settle the original 360s placement before compacting only its parallel rows.
// Serial jobs retain 200s/276s caps; expanded serial jobs retain 210s.
const COMPACT_LARGE_NODE_TEST_JOB_SECONDS = 200;
const COMPACT_SMALL_NODE_TEST_JOB_SECONDS = 276;
const COMPACT_PARALLEL_NODE_TEST_JOB_SECONDS = 360;
const COMPACT_FINAL_PARALLEL_NODE_TEST_JOB_SECONDS = 500;
const COMPACT_EXPANDED_NODE_TEST_JOB_SECONDS = 210;
// Includes the existing 100s runtime build; reserve 40s of the eight-minute
// objective for checkout/setup. This is admission, never a test deadline.
const COMPACT_HYBRID_RUNTIME_JOB_SECONDS = 440;
// Split groups above this hosted prediction before packing. Hybrid reuses the
// hosted-derived splits so retries cannot reunite an oversized hosted group.
const COMPACT_GITHUB_MAX_PREDICTED_SECONDS = 150;
// Hosted run 35477045216 timed out after an hour on a 203-file serial stripe;
// its 196-file sibling took 2867s. Bound admission independently of stale costs.
const COMPACT_HOSTED_STORAGE_STATE_MAX_FILES = 64;
// Trusted forks can use the GitHub profile on Blacksmith. Every compact
// profile must fit the same runner-registration allowance.
const COMPACT_NODE_TEST_JOB_CAP = 90;
const COMPACT_NODE_TEST_JOB_GROUPS = 10;
const COMPACT_TOOLING_NODE_TEST_GROUPS = 16;
const COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES = 120;
// Keep capacity with the workload when packing changes; hosted stripes follow
// their parent's profile policy without changing test or worker boundaries.
const COMPACT_NODE_TEST_OWNER_RUNNERS = new Map([
  [
    "blacksmith",
    new Map([
      ["agentic-agents-core-isolated", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-agents-support", EXTRA_LARGE_NODE_TEST_RUNNER],
      ["agentic-cli", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-sessions-cron", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-sessions-cron-memory", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-sessions-cron-sqlite", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-sessions-cron-sqlite-recovery", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-platform", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-status-tools", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-control-plane-auth-node", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-control-plane-http-plugin-ws", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-control-plane-runtime-ui-tools", DEFAULT_NODE_TEST_RUNNER],
      ["auto-reply-reply-agent-runner", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-infra-heartbeat-runner", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-infra-storage-state", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-infra-system-runtime", DEFAULT_NODE_TEST_RUNNER],
    ]),
  ],
  [
    "hybrid",
    new Map([
      ["agentic-commands-doctor-config-state", DEFAULT_NODE_TEST_RUNNER],
      [COMMANDS_RUNTIME_GROUP, DEFAULT_NODE_TEST_RUNNER],
      ["agentic-commands-doctor-platform", DEFAULT_NODE_TEST_RUNNER],
      ["agentic-control-plane-runtime-shared-token", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-cron-parallel-service", DEFAULT_NODE_TEST_RUNNER],
    ]),
  ],
  [
    "github",
    new Map([
      ["agentic-agents-tools", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-cron-parallel-service", DEFAULT_NODE_TEST_RUNNER],
      ["core-runtime-infra-storage-state", DEFAULT_NODE_TEST_RUNNER],
    ]),
  ],
]);
const AUTO_REPLY_COMMANDS_STRIPES = 3;
const AGENTS_CORE_RUNNER_CLI_STRIPES = 3;
const AGENTIC_GATEWAY_CORE_STRIPES = 3;
const CORE_RUNTIME_MEDIA_UI_STRIPES = 3;
const CORE_UNIT_SRC_SECURITY_STRIPES = 3;
const UNIT_FAST_NODE_TEST_STRIPES = 2;
// Preserve three balanced base stripes: the largest individual harness files
// remain indivisible even after files within each stripe run in parallel.
const EMBEDDED_BASE_NODE_TEST_STRIPES = 3;
// Cold-start fallback when committed CI measurements are missing. Refresh
// config/ci-test-timings.json with pnpm ci:timings:refit, not these literals.
const COMPACT_GROUP_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 30],
  ["agentic-agents-core-isolated", 18],
  ["agentic-agents-core-models", 41],
  ["agentic-agents-core-runner-cli-1", 6],
  ["agentic-agents-core-runner-cli-2", 13],
  ["agentic-agents-core-runner-cli-3", 7],
  ["agentic-agents-core-runner-commands", 28],
  ["agentic-agents-core-runner-embedded", 17],
  ["agentic-agents-core-runner-sessions", 14],
  ["agentic-agents-core-runtime", 106],
  ["agentic-agents-core-subagents", 20],
  ["agentic-agents-core-tools", 39],
  ["agentic-agents-embedded-base-1", 86],
  ["agentic-agents-embedded-base-2", 86],
  ["agentic-agents-embedded-base-3", 86],
  ["agentic-agents-embedded-incomplete-turn", 19],
  ["agentic-agents-embedded-overflow-compaction", 20],
  ["agentic-agents-embedded-run", 46],
  // Main runs 33537556582/33537739443/33543106647 totaled 478.25s/450.21s/418.13s
  // across the complete support inventory. Keep its upper bound as the fallback
  // when membership changes and exact generation timings no longer match.
  ["agentic-agents-support", 479],
  ["agentic-agents-tools", 69],
  // The measured 131s pair split per config; apportioned by the hosted
  // per-config walls (139s/67s) until direct Blacksmith samples exist.
  ["agentic-cli", 88],
  ["agentic-cli-process", 43],
  ["agentic-command-support", 49],
  ["agentic-commands-agent-channel", 76],
  ["agentic-commands-doctor", 23],
  ["agentic-commands-doctor-auth", 19],
  ["agentic-commands-doctor-config-state", 67],
  ["agentic-commands-doctor-device", 2],
  ["agentic-commands-doctor-gateway", 3],
  ["agentic-commands-doctor-platform", 5],
  ["agentic-commands-doctor-plugins-tools", 13],
  // Job 99770912022 measured 116.6s/112.3s of test bodies and 53.8s of
  // group overhead. Charge that full overhead to each new process until
  // the canonical refit has two main-run samples for the new owners.
  ["agentic-commands-doctor-sessions-cron", 31],
  ["agentic-commands-doctor-sessions-cron-memory", 167],
  ["agentic-commands-doctor-sessions-cron-sqlite", 171],
  // Job 106098306092 measured 11.27s including setup for both recovery files.
  ["agentic-commands-doctor-sessions-cron-sqlite-recovery", 15],
  ["agentic-commands-doctor-shared", 37],
  ["agentic-commands-doctor-whatsapp", 1],
  ["agentic-commands-doctor-workspace", 1],
  ["agentic-commands-models", 32],
  ["agentic-commands-onboard-config", 49],
  ["agentic-commands-status-tools", 35],
  ["agentic-control-plane-agent-chat", 167],
  ["agentic-control-plane-auth-node", 166],
  ["agentic-control-plane-http-models", 41],
  ["agentic-control-plane-http-plugin-ws", 52],
  ["agentic-control-plane-runtime", 19],
  ["agentic-control-plane-runtime-config", 20],
  ["agentic-control-plane-runtime-cron", 22],
  ["agentic-control-plane-runtime-server", 23],
  ["agentic-control-plane-runtime-shared-token", 9],
  ["agentic-control-plane-runtime-state", 33],
  ["agentic-control-plane-runtime-ui-tools", 9],
  ["agentic-control-plane-startup-config", 5],
  ["agentic-control-plane-startup-core", 31],
  ["agentic-control-plane-startup-health-runtime", 11],
  ["agentic-control-plane-startup-restart-close", 10],
  // Run 33364935118 measured 21s of tests; the build belongs to bin admission.
  ["agentic-gateway-core-runtime", 21],
  // Two-CPU Linux proof: 40s including preparation, 19s for the 13,000-file case.
  ["agentic-gateway-core-inventory", 40],
  ["agentic-gateway-core-1", 99],
  ["agentic-gateway-core-2", 99],
  ["agentic-gateway-core-3", 99],
  // One small file that pays a full cold module graph because it runs isolated.
  ["agentic-gateway-server-isolated", 30],
  ["agentic-gateway-methods", 157],
  ["agentic-plugin-sdk", 45],
  ["auto-reply-core-top-level", 27],
  ["auto-reply-reply-agent-runner", 60],
  ["auto-reply-reply-commands-1", 28],
  ["auto-reply-reply-commands-2", 9],
  ["auto-reply-reply-commands-3", 24],
  ["auto-reply-reply-dispatch", 15],
  ["auto-reply-reply-dispatch-core", 35],
  ["auto-reply-reply-dispatch-delivery", 32],
  ["auto-reply-reply-dispatch-lifecycle", 8],
  ["auto-reply-reply-session", 34],
  ["auto-reply-reply-state-routing", 63],
  // Apportioned from the split infra-process trio (see below).
  ["core-runtime-config", 113],
  ["core-runtime-cron-parallel-core", 13],
  ["core-runtime-cron-parallel-isolated-agent", 53],
  ["core-runtime-cron-parallel-service", 29],
  ["core-runtime-hooks", 19],
  ["core-runtime-infra-approval-exec", 28],
  ["core-runtime-infra-channel-plugin", 19],
  ["core-runtime-infra-cli-ui", 2],
  ["core-runtime-infra-core-utils", 3],
  ["core-runtime-infra-device", 8],
  ["core-runtime-infra-diagnostics-state", 24],
  ["core-runtime-infra-env-auth", 6],
  ["core-runtime-infra-events-runtime", 8],
  ["core-runtime-infra-file-safety", 2],
  ["core-runtime-infra-files-commands", 5],
  ["core-runtime-infra-gateway-lock-argv", 3],
  ["core-runtime-infra-gateway-processes", 1],
  ["core-runtime-infra-gateway-watch", 1],
  ["core-runtime-infra-heartbeat-core", 7],
  ["core-runtime-infra-heartbeat-runner", 59],
  ["core-runtime-infra-misc", 14],
  ["core-runtime-infra-misc-dedupe-disk", 1],
  ["core-runtime-infra-misc-os", 1],
  ["core-runtime-infra-misc-values", 2],
  ["core-runtime-infra-net-install", 11],
  ["core-runtime-infra-network-node", 3],
  ["core-runtime-infra-network-platform", 5],
  ["core-runtime-infra-outbound-actions", 37],
  ["core-runtime-infra-outbound-core", 59],
  // The measured 126s trio split; apportioned by the hosted per-config walls
  // (17s/157s) until direct Blacksmith samples exist.
  ["core-runtime-infra-process", 13],
  ["core-runtime-infra-provider-push", 13],
  ["core-runtime-infra-repo-tooling", 4],
  ["core-runtime-infra-storage-state", 104],
  ["core-runtime-infra-system-runtime", 36],
  ["core-runtime-media-ui-1", 93],
  ["core-runtime-media-ui-2", 93],
  ["core-runtime-media-ui-3", 93],
  ["core-runtime-media-ui-support", 100],
  ["core-runtime-secrets", 61],
  ["core-runtime-shared", 67],
  // This dist-only group is outside the sampled nondist logs and retains its
  // prior measured hint. The exclusive-bin cap keeps its lane lightly packed.
  ["core-runtime-tui-pty", 116],
  // This PR-only owner is excluded from sampled push plans. Retained exact runs
  // measured 108.79s/130.83s, so use the conservative wall until its owner can
  // supply canonical samples through another path.
  ["core-tooling-isolated", 131],
  ["core-unit-fast-1", 66],
  ["core-unit-fast-2", 64],
  // The measured 116s pair split per config; apportioned by the hosted
  // per-config walls (158s/32s) until direct Blacksmith samples exist.
  ["core-unit-fast-fake-timers", 20],
  ["core-unit-fast-isolated", 96],
  ["core-unit-src-security-1", 101],
  ["core-unit-src-security-2", 101],
  ["core-unit-src-security-3", 101],
  ["core-unit-src-security-support", 12],
  ["core-unit-support", 20],
]);

// Rounded mean of the same 8-vCPU groups across successful canonical-main
// compact runs 31684307744, 31683213137, 31682494259, 31682258389,
// 31681118857, 31680010311, 31678309660, 31678086868, and 31677305067.
// Means expose recurrent slow tails hidden by medians; resource ownership
// remains with resolveCiNodeTestRunner.
const COMPACT_LARGE_GROUP_STRIPE_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 33],
  ["agentic-agents-core-models", 41],
  ["agentic-agents-core-runner-cli-1", 7],
  ["agentic-agents-core-runner-cli-2", 14],
  ["agentic-agents-core-runner-cli-3", 7],
  ["agentic-agents-core-runner-commands", 28],
  ["agentic-agents-core-runner-embedded", 20],
  ["agentic-agents-core-runner-sessions", 16],
  ["agentic-agents-core-runtime", 119],
  ["agentic-agents-core-subagents", 21],
  ["agentic-agents-core-tools", 47],
  ["agentic-agents-embedded-base-1", 86],
  ["agentic-agents-embedded-base-2", 86],
  ["agentic-agents-embedded-base-3", 86],
  ["agentic-agents-embedded-incomplete-turn", 20],
  ["agentic-agents-embedded-overflow-compaction", 21],
  ["agentic-agents-embedded-run", 47],
  ["agentic-agents-support", 479],
  ["agentic-control-plane-startup-core", 33],
  // Run 31691151297 measured 296.68s for gateway-core and 303.93s for unit-src.
  // Run 31694057974 measured the two isolated UI envelopes at 159.50s and
  // 120.55s. Rebalance those walls over the three-way LPT weights: 457/455/455,
  // 633/634/633, and 393/393/393 respectively.
  ["agentic-gateway-core-1", 99],
  ["agentic-gateway-core-2", 99],
  ["agentic-gateway-core-3", 99],
  ["agentic-gateway-methods", 153],
  ["auto-reply-reply-commands-1", 34],
  ["auto-reply-reply-commands-2", 11],
  ["auto-reply-reply-commands-3", 28],
  ["auto-reply-reply-dispatch", 18],
  ["auto-reply-reply-dispatch-core", 42],
  ["auto-reply-reply-dispatch-delivery", 38],
  ["auto-reply-reply-dispatch-lifecycle", 10],
  ["core-runtime-media-ui-1", 93],
  ["core-runtime-media-ui-2", 93],
  ["core-runtime-media-ui-3", 93],
  ["core-runtime-media-ui-support", 100],
  ["core-unit-fast-1", 68],
  ["core-unit-fast-2", 67],
  ["core-unit-fast-fake-timers", 21],
  ["core-unit-fast-isolated", 96],
  ["core-unit-src-security-1", 101],
  ["core-unit-src-security-2", 101],
  ["core-unit-src-security-3", 101],
  ["core-unit-src-security-support", 12],
]);

// Rounded medians from standard 4-core GitHub-hosted runs 31737316152,
// 31742781948, 31749838728, 31754493208, 31776290645, 31784022043, and
// 31784883914. Exclude failed samples and reject media-ui-3's 444s compact
// retry sample because its log records a 300s no-output timeout; its three
// healthy samples are 52-63s. Unmeasured groups use the scale above.
const COMPACT_GITHUB_GROUP_SECONDS_HINTS = new Map<string, number>([
  ["agentic-agents-core-auth", 50],
  ["agentic-agents-core-isolated", 23],
  ["agentic-agents-core-models", 198],
  ["agentic-agents-core-runner-cli-1", 16],
  ["agentic-agents-core-runner-cli-2", 25],
  ["agentic-agents-core-runner-cli-3", 23],
  ["agentic-agents-core-runner-commands", 55],
  ["agentic-agents-core-runner-embedded", 30],
  ["agentic-agents-core-runner-sessions", 23],
  ["agentic-agents-core-runtime", 185],
  ["agentic-agents-core-subagents", 29],
  ["agentic-agents-core-tools", 83],
  ["agentic-agents-embedded-base-1", 138],
  ["agentic-agents-embedded-base-2", 138],
  ["agentic-agents-embedded-base-3", 138],
  ["agentic-agents-embedded-incomplete-turn", 3],
  ["agentic-agents-embedded-overflow-compaction", 31],
  ["agentic-agents-embedded-run", 62],
  ["agentic-agents-support", 253],
  ["agentic-agents-tools", 124],
  // Measured per config inside run 31814517685's combined 206s wall.
  ["agentic-cli", 139],
  ["agentic-cli-process", 67],
  ["agentic-command-support", 67],
  ["agentic-commands-agent-channel", 121],
  ["agentic-commands-doctor", 33],
  ["agentic-commands-doctor-auth", 32],
  ["agentic-commands-doctor-config-state", 124],
  ["agentic-commands-doctor-device", 5],
  ["agentic-commands-doctor-gateway", 8],
  ["agentic-commands-doctor-platform", 7],
  ["agentic-commands-doctor-plugins-tools", 21],
  // Conservative native fallbacks above, scaled by 1.6 until hosted samples exist.
  ["agentic-commands-doctor-sessions-cron", 87],
  ["agentic-commands-doctor-sessions-cron-memory", 268],
  ["agentic-commands-doctor-sessions-cron-sqlite", 274],
  ["agentic-commands-doctor-shared", 61],
  ["agentic-commands-doctor-whatsapp", 2],
  ["agentic-commands-doctor-workspace", 3],
  ["agentic-commands-models", 64],
  ["agentic-commands-onboard-config", 76],
  ["agentic-commands-status-tools", 57],
  ["agentic-control-plane-agent-chat", 232],
  ["agentic-control-plane-auth-node", 254],
  ["agentic-control-plane-http-models", 59],
  ["agentic-control-plane-http-plugin-ws", 86],
  ["agentic-control-plane-runtime", 31],
  ["agentic-control-plane-runtime-config", 31],
  ["agentic-control-plane-runtime-cron", 52],
  ["agentic-control-plane-runtime-server", 54],
  ["agentic-control-plane-runtime-shared-token", 28],
  ["agentic-control-plane-runtime-state", 55],
  ["agentic-control-plane-runtime-ui-tools", 31],
  ["agentic-control-plane-startup-config", 15],
  ["agentic-control-plane-startup-core", 51],
  ["agentic-control-plane-startup-health-runtime", 31],
  ["agentic-control-plane-startup-restart-close", 28],
  ["agentic-gateway-core-1", 176],
  ["agentic-gateway-core-2", 149],
  ["agentic-gateway-core-3", 141],
  ["agentic-gateway-core-inventory", 40],
  ["agentic-gateway-methods", 169],
  ["agentic-plugin-sdk", 70],
  ["auto-reply-core-top-level", 43],
  ["auto-reply-reply-agent-runner", 169],
  ["auto-reply-reply-commands-1", 53],
  ["auto-reply-reply-commands-2", 26],
  ["auto-reply-reply-commands-3", 48],
  ["auto-reply-reply-dispatch", 55],
  ["auto-reply-reply-dispatch-core", 75],
  ["auto-reply-reply-dispatch-delivery", 70],
  ["auto-reply-reply-dispatch-lifecycle", 20],
  ["auto-reply-reply-session", 79],
  ["auto-reply-reply-state-routing", 34],
  // Measured per config inside run 31814517685's combined 175s infra wall.
  ["core-runtime-config", 157],
  ["core-runtime-cron-parallel-core", 22],
  ["core-runtime-cron-parallel-isolated-agent", 77],
  ["core-runtime-cron-parallel-service", 66],
  ["core-runtime-hooks", 31],
  ["core-runtime-infra-approval-exec", 45],
  ["core-runtime-infra-channel-plugin", 30],
  ["core-runtime-infra-cli-ui", 3],
  ["core-runtime-infra-core-utils", 7],
  ["core-runtime-infra-device", 13],
  ["core-runtime-infra-diagnostics-state", 34],
  ["core-runtime-infra-env-auth", 10],
  ["core-runtime-infra-events-runtime", 11],
  ["core-runtime-infra-file-safety", 4],
  ["core-runtime-infra-files-commands", 7],
  ["core-runtime-infra-gateway-lock-argv", 3],
  ["core-runtime-infra-gateway-processes", 1],
  ["core-runtime-infra-gateway-watch", 1],
  ["core-runtime-infra-heartbeat-core", 10],
  ["core-runtime-infra-heartbeat-runner", 106],
  ["core-runtime-infra-misc", 33],
  ["core-runtime-infra-misc-dedupe-disk", 1],
  ["core-runtime-infra-misc-os", 1],
  ["core-runtime-infra-misc-values", 2],
  ["core-runtime-infra-net-install", 17],
  ["core-runtime-infra-network-node", 5],
  ["core-runtime-infra-network-platform", 8],
  ["core-runtime-infra-outbound-actions", 53],
  ["core-runtime-infra-outbound-core", 112],
  // Measured per config inside run 31814517685's combined 175s wall.
  ["core-runtime-infra-process", 17],
  ["core-runtime-infra-provider-push", 29],
  ["core-runtime-infra-repo-tooling", 6],
  ["core-runtime-infra-storage-state", 235],
  ["core-runtime-infra-system-runtime", 69],
  ["core-runtime-media-ui-1", 97],
  ["core-runtime-media-ui-2", 78],
  ["core-runtime-media-ui-3", 71],
  ["core-runtime-media-ui-support", 101],
  ["core-runtime-secrets", 73],
  ["core-runtime-shared", 92],
  ["core-tooling-isolated", 41],
  ["core-unit-fast-1", 85],
  ["core-unit-fast-2", 84],
  // Measured per config inside run 31814517685's combined 190s wall.
  ["core-unit-fast-fake-timers", 32],
  ["core-unit-fast-isolated", 158],
  ["core-unit-src-security-1", 132],
  ["core-unit-src-security-2", 131],
  ["core-unit-src-security-3", 132],
  ["core-unit-src-security-support", 20],
  ["core-unit-support", 32],
]);

// Hybrid-specific Blacksmith observations, plus the gateway-core-3 139.5s spike
// in 31938297538 that must stay singleton.
// Sum a shard's per-config Duration lines before taking a median; pooling them
// reads as a large over-prediction that is not there. Normalize each run by its
// own VM speed (median of every shard's duration over that shard's cross-run
// median) before comparing, or a slow draw looks like a hint miss.
// Values below are VM-normalized medians over runs 32316204633, 32317242374,
// 32318250756, and 32320063231 (2026-08-20). Across 100 groups the GitHub hints
// run 0.64x on Blacksmith, so only the ones that overshoot are pinned here:
// leaving these low packs partners onto the tallest bins, which set the wall.
const COMPACT_HYBRID_GROUP_SECONDS_HINTS = new Map<string, number>([
  // Preserve the observed support budget through inventory growth without
  // scaling the current Blacksmith evidence by an older whole-suite ratio.
  ["agentic-agents-support", 479],
  ["agentic-agents-core-models", 81],
  ["agentic-cli-process", 110],
  ["agentic-commands-doctor", 83],
  ["agentic-gateway-core-3", 140],
  ["core-runtime-cron-parallel-service", 54],
  ["core-runtime-infra-process", 35],
]);

const DEFAULT_WHOLE_GROUP_SECONDS = 25;
const DEFAULT_SECONDS_PER_TEST_FILE = 0.5;
const COMPACT_PUSH_EXCLUDED_SHARDS = new Set([
  "core-runtime-tui-pty",
  ...Array.from(
    { length: COMPACT_TOOLING_NODE_TEST_GROUPS },
    (_, index) => `core-tooling-${index + 1}`,
  ),
  "core-tooling-isolated",
]);
const COMPACT_BLACKSMITH_SPLIT_OWNERS = new Set([
  "agentic-control-plane-agent-chat",
  "agentic-gateway-core-1",
  "agentic-gateway-core-2",
  "agentic-gateway-core-3",
  "core-runtime-infra-storage-state",
]);
// Spawn/signal-timing suites (process-group waits, PTY smoke) flake when a
// concurrent sibling Vitest run competes for the 4 vCPU runner. Pack them
// into bins the shard runner executes at concurrency 1.
const EXCLUSIVE_COMPACT_GROUP_RE =
  /^core-tooling(?:-\d+(?:-hosted-\d+)?|-isolated)$|^core-runtime-tui-pty$|^agentic-gateway-core-(?:runtime|inventory)$|^agentic-cli(?:-process(?:-hosted-\d+)?)?$/u;
// Exclusive bins run serially, so their packed estimate is their wall clock.
// An indivisible file above this budget must not acquire additional work.
const COMPACT_EXCLUSIVE_JOB_SECONDS = 150;
const COMPACT_HYBRID_SERIAL_CLI_JOB_SECONDS = 250;

export function isExclusiveCompactShardName(shardName: string): boolean {
  return EXCLUSIVE_COMPACT_GROUP_RE.test(shardName);
}

function isExclusiveCompactGroup(group: NodeTestShardGroup): boolean {
  return isExclusiveCompactShardName(group.shard_name);
}

function isParallelCompactGroup(group: NodeTestShardGroup): boolean {
  return !isExclusiveCompactGroup(group) && !group.requiresDist && !group.pretestBuildMode;
}

// Spawn/signal/PTY-timing suites also flake under high in-process worker
// counts; pin them to the proven 2-worker budget while the job-level default
// scales with the runner class. infra-process spawns child processes per test
// and hit worker-startup timeouts under contention before serialization.
const PINNED_WORKER_COMPACT_GROUP_RE =
  /^core-tooling(?:-\d+(?:-hosted-\d+)?|-isolated)$|^core-runtime-tui-pty$|^core-runtime-infra-process$|^core-runtime-config$|^core-runtime-media-ui-(?:\d+|support)$|^agentic-cli(?:-process)?$|^agentic-gateway-(?:core-\d+|methods)$/u;
const PINNED_COMPACT_GROUP_ENV = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
const MEASURED_GATEWAY_ISOLATED_GROUP_RE = /^agentic-gateway-server-isolated(?:-hosted-\d+)?$/u;
const FILE_PARALLEL_AGENT_GROUP_RE = /^agentic-agents-(?:embedded-base-\d+|embedded-run|tools)$/u;
const FILE_PARALLEL_AGENT_MIN_WORKERS = 2;

// Existing samples describe serial file execution. Keep new parallel wall
// samples under a separate identity so refitting never discounts them twice.
function fileParallelAgentFallbackSeconds(
  group: NodeTestShardGroup,
  seconds: number | undefined,
): number | undefined {
  return seconds !== undefined && FILE_PARALLEL_AGENT_GROUP_RE.test(group.shard_name)
    ? Math.max(
        seconds / FILE_PARALLEL_AGENT_MIN_WORKERS,
        ...(group.includePatterns ?? []).map(stripeFileWeight),
      )
    : seconds;
}

function isAutoReplyReplyGroup(group: NodeTestShardGroup): boolean {
  return (
    group.configs.length === 1 &&
    group.configs[0] === "test/vitest/vitest.auto-reply-reply.config.ts"
  );
}

function compactEffectiveFileWorkers(group: NodeTestShardGroup, fileCount: number): number {
  return isAutoReplyReplyGroup(group) ? Math.max(1, Math.min(2, fileCount)) : 1;
}

function readSerialAutoReplySplitSeconds(
  group: NodeTestShardGroup,
  profile: "blacksmith" | "github",
): number | undefined {
  if (!isAutoReplyReplyGroup(group) || !group.includePatterns?.length) {
    return undefined;
  }
  const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...env } = group.env ?? {};
  const legacy = createCompactSplitTimingGeneration({
    configs: group.configs,
    env,
    parentShardName: group.shard_name,
    stripes: [group.includePatterns],
  });
  return readCompleteSplitGenerationSeconds(readCompactGroupTimings(profile), legacy.selectorKey);
}

function parallelCompactFallbackSeconds(
  group: NodeTestShardGroup,
  seconds: number,
  profile: "blacksmith" | "github" = "blacksmith",
): number {
  // A complete legacy generation can be newer than its parent; partial or changed inventories cannot.
  return (
    Math.max(seconds, readSerialAutoReplySplitSeconds(group, profile) ?? 0) /
    compactEffectiveFileWorkers(group, group.includePatterns?.length ?? 1)
  );
}

function isParallelAgentsCoreGroup(group: NodeTestShardGroup): boolean {
  return group.configs.length === 1 && group.configs[0] === agentVitestProjectOwners.core.config;
}

function agentsCoreWorkFiles(group: NodeTestShardGroup): string[] {
  const files = group.includePatterns ?? [];
  const unitFastFiles = new Set(getUnitFastTestFilesForIncludePatterns(files));
  return files.filter((file) => isStripeEligibleTestFile(file, unitFastFiles));
}

function effectiveAgentsCoreWorkers(group: NodeTestShardGroup): number {
  if (!isParallelAgentsCoreGroup(group) || !group.includePatterns?.length) {
    return 1;
  }
  const weights = agentsCoreWorkFiles(group).map(stripeFileWeight);
  if (weights.length === 0) {
    return 1;
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Two workers share the file work; an indivisible file keeps its serial cost.
  return Math.min(2, weights.length, total / Math.max(...weights));
}

function readSerialAgentsCoreSeconds(
  group: NodeTestShardGroup,
  profile: "blacksmith" | "github",
): number | undefined {
  if (!isParallelAgentsCoreGroup(group)) {
    return undefined;
  }
  const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...env } = group.env ?? {};
  const complete = group.includePatterns?.length
    ? readCompleteSplitGenerationSeconds(
        readCompactGroupTimings(profile),
        createCompactSplitTimingGeneration({
          configs: group.configs,
          env,
          parentShardName: group.shard_name,
          stripes: [group.includePatterns],
        }).selectorKey,
      )
    : undefined;
  const parent = readCompactGroupTimings(profile)[group.shard_name];
  return parent === undefined && complete === undefined
    ? undefined
    : Math.max(parent ?? 0, complete ?? 0);
}

function usesMeasuredCompactWorkers(group: NodeTestShardGroup, runnerBackend: string | undefined) {
  return (
    (runnerBackend === undefined || runnerBackend === "blacksmith" || runnerBackend === "hybrid") &&
    (group.shard_name === "agentic-cli" ||
      isParallelCommandsGroup(group) ||
      /^agentic-gateway-core-2(?:-hosted-\d+)?$/u.test(group.shard_name) ||
      MEASURED_GATEWAY_ISOLATED_GROUP_RE.test(group.shard_name) ||
      FILE_PARALLEL_AGENT_GROUP_RE.test(group.shard_name.replace(/-hosted-\d+$/u, "")))
  );
}

function isParallelGatewayServerGroup(group: NodeTestShardGroup): boolean {
  return (
    group.configs.length === 1 && group.configs[0] === "test/vitest/vitest.gateway-server.config.ts"
  );
}

function gatewayServerEffectiveWorkers(group: NodeTestShardGroup): number {
  return Math.max(
    1,
    Math.min(
      2,
      group.includePatterns?.filter((file) => !gatewayServerSerialTestFiles.includes(file))
        .length ?? 2,
    ),
  );
}

function gatewayServerSerialSeconds(
  files: readonly string[] | undefined,
  runnerBackend: string | undefined,
): number {
  const scale =
    runnerBackend === "github"
      ? COMPACT_GITHUB_GROUP_SECONDS_SCALE
      : runnerBackend === "hybrid"
        ? COMPACT_HYBRID_GROUP_SECONDS_SCALE
        : 1;
  return (files ?? []).reduce(
    (seconds, file) =>
      seconds + (gatewayServerSerialTestFiles.includes(file) ? stripeFileWeight(file) * scale : 0),
    0,
  );
}

function estimateLegacyGatewayServerSeconds(
  group: NodeTestShardGroup,
  profile: "blacksmith" | "github",
  hint: number | undefined,
): number | undefined {
  const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...env } = group.env ?? {};
  const generation = createCompactSplitTimingGeneration({
    configs: group.configs,
    env,
    parentShardName: group.shard_name,
    stripes: [group.includePatterns ?? []],
  });
  const measured = readCompactGroupTimings(profile)[group.shard_name];
  const complete = readCompleteSplitGenerationSeconds(
    readCompactGroupTimings(profile),
    generation.selectorKey,
  );
  const seconds = measured ?? hint;
  const serialSeconds = gatewayServerSerialSeconds(group.includePatterns, profile);
  return seconds === undefined && complete === undefined
    ? undefined
    : serialSeconds +
        Math.max(0, Math.max(seconds ?? 0, complete ?? 0) - serialSeconds) /
          gatewayServerEffectiveWorkers(group);
}

function applyCompactGroupWorkerPins(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): NodeTestShardGroup {
  if (isAutoReplyReplyGroup(group)) {
    // Keep serial observations separate so refitted parallel walls are never divided again.
    return {
      ...group,
      env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV },
      timing_key: `${group.shard_name}-parallel-2`,
    };
  }
  if (isParallelGatewayServerGroup(group)) {
    // New measurements must not be divided again after serial files become parallel.
    return {
      ...group,
      timing_key: `${group.shard_name}-parallel${gatewayServerSerialSeconds(group.includePatterns, runnerBackend) > 0 ? "-native-serial" : ""}`,
      env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV },
    };
  }
  if (isParallelAgentsCoreGroup(group)) {
    // Parallel samples must not overwrite serial history and be divided again.
    return {
      ...group,
      env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV },
      timing_key: `${group.shard_name}-parallel`,
    };
  }
  if (isParallelCommandsGroup(group)) {
    return {
      ...group,
      fallbackMaxWorkers: 2,
      // Refit must not fold parallel spans back into the serial observations.
      timing_key: `${group.shard_name}${COMMANDS_PARALLEL_TIMING_SUFFIX}`,
    };
  }
  const timedGroup =
    FILE_PARALLEL_AGENT_GROUP_RE.test(group.shard_name) && group.timing_key === undefined
      ? { ...group, timing_key: `${group.shard_name}#file-parallel` }
      : group;
  if (usesMeasuredCompactWorkers(timedGroup, runnerBackend)) {
    return {
      ...timedGroup,
      ...(MEASURED_GATEWAY_ISOLATED_GROUP_RE.test(timedGroup.shard_name)
        ? {
            env: { ...timedGroup.env, OPENCLAW_VITEST_MAX_WORKERS: "8" },
            minTotalMemoryBytes: 28 * 1024 ** 3,
          }
        : {}),
      fallbackMaxWorkers: 2,
    };
  }
  if (!PINNED_WORKER_COMPACT_GROUP_RE.test(timedGroup.shard_name)) {
    return timedGroup;
  }
  return { ...timedGroup, env: { ...timedGroup.env, ...PINNED_COMPACT_GROUP_ENV } };
}

function readCompactGroupSeconds(
  group: NodeTestShardGroup,
  profile: "blacksmith" | "github",
): number | undefined {
  const timings = readCompactGroupTimings(profile);
  const measured = timings[compactGroupTimingKey(group)];
  if (measured !== undefined) {
    return measured;
  }
  if (FILE_PARALLEL_AGENT_GROUP_RE.test(group.shard_name)) {
    return fileParallelAgentFallbackSeconds(group, timings[group.shard_name]);
  }
  const cronOwner = /^core-runtime-cron-parallel-(core|isolated-agent|service)$/u.exec(
    compactGroupTimingKey(group),
  )?.[1];
  const serialSeconds =
    cronOwner === undefined ? undefined : timings[`core-runtime-cron-${cronOwner}`];
  // Compact overlap and inherited Gateway caps allow two workers; hosted serial
  // rows allow at least three. New names let parallel samples replace this
  // conservative serial-cost fallback without dividing those samples again.
  return serialSeconds === undefined ? undefined : serialSeconds / 2;
}

function isParallelToolingGroup(group: NodeTestShardGroup): boolean {
  return /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name);
}

function estimateParallelToolingSeconds(
  group: Pick<NodeTestShardGroup, "env">,
  files: readonly string[],
  runnerBackend: string | undefined,
): number {
  const workers = Math.min(
    files.length,
    Number(
      group.env?.OPENCLAW_VITEST_MAX_WORKERS ??
        PINNED_COMPACT_GROUP_ENV.OPENCLAW_VITEST_MAX_WORKERS,
    ),
  );
  const weights = files.map(toolingFileWeight);
  // File observations retain their elapsed cost under parallel execution. Old
  // numbered parent/child spans describe serial files and cannot price this lane.
  return (
    Math.max(
      0,
      ...weights,
      weights.reduce((sum, seconds) => sum + seconds, 0) / Math.max(1, workers),
    ) * (runnerBackend === "github" ? COMPACT_GITHUB_GROUP_SECONDS_SCALE : 1)
  );
}

function estimateDefaultCompactGroupSeconds(group: NodeTestShardGroup): number {
  if (isParallelToolingGroup(group) && group.includePatterns) {
    return estimateParallelToolingSeconds(group, group.includePatterns, "blacksmith");
  }
  const measured = readCompactGroupSeconds(group, "blacksmith");
  if (measured !== undefined) {
    return measured;
  }
  const hint = isParallelGatewayServerGroup(group)
    ? estimateLegacyGatewayServerSeconds(
        group,
        "blacksmith",
        COMPACT_GROUP_SECONDS_HINTS.get(group.shard_name),
      )
    : ((isAutoReplyReplyGroup(group)
        ? readCompactGroupTimings("blacksmith")[group.shard_name]
        : undefined) ??
      readSerialAgentsCoreSeconds(group, "blacksmith") ??
      (isParallelAgentsCoreGroup(group)
        ? COMPACT_LARGE_GROUP_STRIPE_SECONDS_HINTS.get(group.shard_name)
        : undefined) ??
      fileParallelAgentFallbackSeconds(group, COMPACT_GROUP_SECONDS_HINTS.get(group.shard_name)));
  if (hint !== undefined) {
    return parallelCompactFallbackSeconds(group, hint) / effectiveAgentsCoreWorkers(group);
  }
  if (Array.isArray(group.includePatterns)) {
    return (
      parallelCompactFallbackSeconds(
        group,
        Math.max(3, Math.round(group.includePatterns.length * DEFAULT_SECONDS_PER_TEST_FILE)),
      ) / effectiveAgentsCoreWorkers(group)
    );
  }
  return DEFAULT_WHOLE_GROUP_SECONDS;
}

function usesExpandedRunnerProfile(runnerBackend: string | undefined): boolean {
  return runnerBackend === "github" || runnerBackend === "hybrid";
}

// Hand-fitted tables stand in only until a group has direct Blacksmith samples,
// so a committed measurement owns the weight and the table covers the rest.
// Reading the tables first made every pinned group immune to the nightly refit:
// pins stale-low kept packing partners onto the tallest bins, and pins
// stale-high kept splitting groups that had since become cheap.
function readUnmeasuredCompactHint(
  group: NodeTestShardGroup,
  hints: ReadonlyMap<string, number>,
): number | undefined {
  const timings = readCompactGroupTimings("blacksmith");
  if (
    readCompactGroupSeconds(group, "blacksmith") !== undefined ||
    readSerialAgentsCoreSeconds(group, "blacksmith") !== undefined ||
    (isAutoReplyReplyGroup(group) && timings[group.shard_name] !== undefined) ||
    readSerialAutoReplySplitSeconds(group, "blacksmith") !== undefined
  ) {
    return undefined;
  }
  const hint = fileParallelAgentFallbackSeconds(group, hints.get(group.shard_name));
  return hint === undefined ? undefined : parallelCompactFallbackSeconds(group, hint);
}

function estimateHybridCompactGroupSeconds(group: NodeTestShardGroup, seconds: number): number {
  // The 4,723s Blacksmith push hint sum measured 3,742.046s/3,756.674s
  // (79.230%/79.540%) in runs 31945998653/31949756966. A 0.87 scale keeps
  // 9.379% headroom above the higher ratio. With direct outlier hints, it sits
  // one point above the 0.86 packing cliff.
  const hint = readUnmeasuredCompactHint(group, COMPACT_HYBRID_GROUP_SECONDS_HINTS);
  return hint === undefined
    ? Math.round(seconds * COMPACT_HYBRID_GROUP_SECONDS_SCALE)
    : hint / effectiveAgentsCoreWorkers(group);
}

function estimateCompactGroupSeconds(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): number {
  if (isParallelToolingGroup(group) && group.includePatterns) {
    return estimateParallelToolingSeconds(group, group.includePatterns, runnerBackend);
  }
  if (
    isParallelCommandsGroup(group) &&
    group.timing_key?.endsWith(COMMANDS_PARALLEL_TIMING_SUFFIX)
  ) {
    const profile = runnerBackend === "github" ? "github" : "blacksmith";
    const measured = readCompactGroupTimings(profile)[group.timing_key];
    if (measured !== undefined) {
      return runnerBackend === "hybrid"
        ? estimateHybridCompactGroupSeconds(group, measured)
        : measured;
    }
    return estimateSerialCommandSeconds(group, runnerBackend, (source) =>
      estimateCompactGroupSeconds({ ...group, ...source, timing_key: undefined }, runnerBackend),
    );
  }
  const defaultSeconds = estimateDefaultCompactGroupSeconds(group);
  // Hybrid attempt 1 runs on Blacksmith. It keeps the expanded topology for
  // hosted retries, but its packing weights must describe the runner that
  // normally executes the plan.
  if (runnerBackend === "hybrid") {
    return Math.max(
      isParallelGatewayServerGroup(group)
        ? gatewayServerSerialSeconds(group.includePatterns, runnerBackend)
        : 0,
      estimateHybridCompactGroupSeconds(group, defaultSeconds),
    );
  }
  if (runnerBackend !== "github") {
    return Math.max(
      defaultSeconds,
      isParallelGatewayServerGroup(group)
        ? gatewayServerSerialSeconds(group.includePatterns, runnerBackend)
        : 0,
    );
  }
  const serialFloor = isParallelGatewayServerGroup(group)
    ? gatewayServerSerialSeconds(group.includePatterns, runnerBackend)
    : 0;
  const measured = readCompactGroupSeconds(group, "github");
  if (measured !== undefined) {
    return Math.max(serialFloor, measured);
  }
  const hint = isParallelGatewayServerGroup(group)
    ? estimateLegacyGatewayServerSeconds(
        group,
        "github",
        COMPACT_GITHUB_GROUP_SECONDS_HINTS.get(group.shard_name),
      )
    : ((isAutoReplyReplyGroup(group)
        ? readCompactGroupTimings("github")[group.shard_name]
        : undefined) ??
      readSerialAgentsCoreSeconds(group, "github") ??
      fileParallelAgentFallbackSeconds(
        group,
        COMPACT_GITHUB_GROUP_SECONDS_HINTS.get(group.shard_name),
      ));
  return Math.max(
    serialFloor,
    hint === undefined
      ? Math.round(defaultSeconds * COMPACT_GITHUB_GROUP_SECONDS_SCALE)
      : parallelCompactFallbackSeconds(group, hint, "github") / effectiveAgentsCoreWorkers(group),
    parallelCompactFallbackSeconds(group, 0, "github"),
  );
}

function estimateCompactStripeSeconds(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): number {
  if (isParallelToolingGroup(group) && group.includePatterns) {
    return estimateParallelToolingSeconds(group, group.includePatterns, runnerBackend);
  }
  if (
    (isParallelAgentsCoreGroup(group) && group.timing_key === `${group.shard_name}-parallel`) ||
    group.timing_key?.endsWith(COMMANDS_PARALLEL_TIMING_SUFFIX)
  ) {
    return estimateCompactGroupSeconds(group, runnerBackend);
  }
  if (group.timing_key && parseCompactSplitTimingKey(group.timing_key)) {
    // The parent-derived floor owns a new split until its exact child has samples.
    // File-count fallbacks would price the same work again after partitioning.
    const seconds =
      readCompactGroupTimings(runnerBackend === "github" ? "github" : "blacksmith")[
        group.timing_key
      ] ?? 0;
    return runnerBackend === "hybrid" ? estimateHybridCompactGroupSeconds(group, seconds) : seconds;
  }
  if (
    runnerBackend === "github" ||
    isParallelGatewayServerGroup(group) ||
    isAutoReplyReplyGroup(group)
  ) {
    return estimateCompactGroupSeconds(group, runnerBackend);
  }
  const blacksmithSeconds =
    readUnmeasuredCompactHint(group, COMPACT_LARGE_GROUP_STRIPE_SECONDS_HINTS) ??
    estimateDefaultCompactGroupSeconds(group);
  return runnerBackend === "hybrid"
    ? estimateHybridCompactGroupSeconds(group, blacksmithSeconds)
    : blacksmithSeconds;
}

// Identify split siblings, including nested children of deliberately separated
// fixed stripes.
function compactStripeFamily(group: NodeTestShardGroup): string | undefined {
  if (
    /^agentic-commands-doctor-sessions-cron(?:-(?:memory|sqlite(?:-recovery)?))?(?:-hosted-\d+)?$/u.test(
      group.shard_name,
    )
  ) {
    return "agentic-commands-doctor-sessions-cron";
  }
  return (
    /^(agentic-agents-embedded-base|agentic-gateway-core|core-runtime-media-ui|core-unit-src-security)-\d+(?:-hosted-\d+)?$/u.exec(
      group.shard_name,
    )?.[1] ??
    (group.timing_key ? parseCompactSplitTimingKey(group.timing_key)?.selectorKey : undefined)
  );
}

function expandCompactGroup(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
): NodeTestShardGroup[] {
  if (group.shard_name !== "agentic-agents-embedded") {
    return [group];
  }
  if (group.configs.length !== COMPACT_EMBEDDED_GROUP_NAMES.length) {
    throw new Error("embedded compact group names must cover every config");
  }

  const expandedGroups: NodeTestShardGroup[] = [];
  for (const [index, config] of group.configs.entries()) {
    const shardName = COMPACT_EMBEDDED_GROUP_NAMES[index];
    if (!shardName) {
      throw new Error("embedded compact group name is missing");
    }
    if (shardName !== COMPACT_EMBEDDED_BASE_GROUP_NAME) {
      expandedGroups.push({ ...group, configs: [config], shard_name: shardName });
      continue;
    }
    const stripes = createStripedBatches(
      listWholeConfigSplitFiles(COMPACT_EMBEDDED_BASE_GROUP_NAME) ?? [],
      EMBEDDED_BASE_NODE_TEST_STRIPES,
      stripeFileWeight,
    );
    for (const [stripeIndex, includePatterns] of stripes.entries()) {
      // An empty include list makes the shard runner drop the include file and
      // run the whole config, so every stripe would replay the entire suite.
      if (includePatterns.length === 0) {
        throw new Error("embedded base stripe cannot be empty");
      }
      expandedGroups.push({
        ...group,
        configs: [config],
        includePatterns,
        shard_name: `${shardName}-${stripeIndex + 1}`,
      });
    }
  }
  return expandedGroups.map((expandedGroup) =>
    applyCompactGroupWorkerPins(expandedGroup, runnerBackend),
  );
}
const TOOLING_CONFIG = "test/vitest/vitest.tooling.config.ts";
const TOOLING_DOCKER_TEST_FILE = "test/scripts/docker-build-helper.test.ts";
const TOOLING_UNIFIED_DECLARATIONS_TEST_FILE = "test/scripts/write-unified-entry-dts.test.ts";
const TOOLING_DECLARATION_COMPILER_TEST_FILES = new Set([
  "test/scripts/write-unified-entry-dts.test.ts",
  "test/scripts/write-plugin-sdk-entry-dts.test.ts",
]);
const TOOLING_ISOLATED_CONFIG = "test/vitest/vitest.tooling-isolated.config.ts";
// The full matrix is capped at 28 jobs. Admit the consistently slow serial
// shards first so short alphabetical groups cannot leave them on the tail.
const FULL_NODE_TEST_ADMISSION_PRIORITY = new Map([
  // Admit the broad unit-fast graphs before short alphabetical groups.
  ["core-unit-fast-1", 0],
  ["core-unit-fast-2", 0],
  ...Array.from(
    { length: COMPACT_TOOLING_NODE_TEST_GROUPS },
    (_, index) => [`core-tooling-${index + 1}`, 1] as const,
  ),
]);
// Commands and cron run non-isolated, so keep their split shards as separate
// processes. Combining their include lists can retain test state across groups.
const BUNDLEABLE_NODE_TEST_CONFIGS = new Set(["test/vitest/vitest.infra.config.ts"]);
const KEEP_LARGE_NODE_TEST_RUNNER = new Set([
  "agentic-agents-core-auth",
  "agentic-agents-core-models",
  "agentic-agents-core-runtime",
  "agentic-agents-core-subagents",
  "agentic-agents-embedded",
  "agentic-agents-support",
  "agentic-agents-core-runner-cli-1",
  "agentic-agents-core-runner-cli-2",
  "agentic-agents-core-runner-cli-3",
  "agentic-agents-core-runner-commands",
  "agentic-agents-core-runner-embedded",
  "agentic-agents-core-runner-sessions",
  "agentic-agents-core-tools",
  "agentic-control-plane-startup-core",
  "agentic-gateway-core-1",
  "agentic-gateway-core-2",
  "agentic-gateway-core-3",
  "agentic-gateway-methods",
  "agentic-gateway-server-isolated",
  "auto-reply-reply-dispatch",
  "auto-reply-reply-dispatch-core",
  "auto-reply-reply-dispatch-delivery",
  "auto-reply-reply-dispatch-lifecycle",
  // The commands stripes and security suite are import-bound (30-45s of
  // module-graph import per file); the 8 vCPU class with a higher Vitest
  // worker budget cuts their wall clock roughly linearly.
  "auto-reply-reply-commands-1",
  "auto-reply-reply-commands-2",
  "auto-reply-reply-commands-3",
  "core-runtime-media-ui-1",
  "core-runtime-media-ui-2",
  "core-runtime-media-ui-3",
  "core-runtime-media-ui-support",
  "core-unit-fast-1",
  "core-unit-fast-2",
  "core-unit-fast-isolated",
  "core-unit-src-security-1",
  "core-unit-src-security-2",
  "core-unit-src-security-3",
  "core-unit-src-security-support",
]);
const RELEASE_ONLY_PLUGIN_SHARDS = new Set(["agentic-plugins"]);
const RELEASE_ONLY_TOOLING_SHARDS = new Set(["core-tooling"]);
export const RELEASE_ONLY_TOOLING_CONFIGS = new Set(
  fullSuiteVitestShards
    .filter((shard) => RELEASE_ONLY_TOOLING_SHARDS.has(shard.name))
    .flatMap((shard) => shard.projects),
);

export function isReleaseOnlyToolingTestFile(file: string): boolean {
  return (
    !file.endsWith(".e2e.test.ts") &&
    !file.endsWith(".live.test.ts") &&
    (file.startsWith("test/scripts/") || file.startsWith("src/scripts/"))
  );
}

function mixedToolingTestFiles(configs: readonly string[]): string[] | undefined {
  const files = [
    ...(configs.includes("test/vitest/vitest.unit-fast-isolated.config.ts")
      ? getUnitFastIsolatedTestFiles()
      : []),
    ...(configs.includes("test/vitest/vitest.unit-fast-fake-timers.config.ts")
      ? getUnitFastTimerTestFiles()
      : []),
  ];
  return files.length > 0 ? files : undefined;
}

function listTestFiles(rootDir: string): string[] {
  return listTrackedTestFiles(rootDir);
}

function resolveTestFilesBuildMode(files: readonly string[]): NodeTestPretestBuildMode | undefined {
  // Planner inventories contain resolved paths. Preserve their exact membership
  // instead of reparsing every file as a glob against the runtime consumers.
  const selectedFiles = new Set(files);
  return resolveVitestPretestBuildMode([{ matchesFile: (file) => selectedFiles.has(file) }]);
}

function createAutoReplyReplySplitShards(): NodeTestSplitShard[] {
  const files = listTestFiles("src/auto-reply/reply");
  const groups = {
    "auto-reply-reply-agent-runner": [] as string[],
    "auto-reply-reply-commands": [] as string[],
    "auto-reply-reply-dispatch": [] as string[],
    "auto-reply-reply-dispatch-core": [] as string[],
    "auto-reply-reply-dispatch-delivery": [] as string[],
    "auto-reply-reply-dispatch-lifecycle": [] as string[],
    "auto-reply-reply-session": [] as string[],
    "auto-reply-reply-state-routing": [] as string[],
  };
  const dispatchEntrypoints = new Map<string, keyof typeof groups>([
    ["dispatch-from-config.test.ts", "auto-reply-reply-dispatch-core"],
    ["dispatch-from-config.delivery.test.ts", "auto-reply-reply-dispatch-delivery"],
    ["dispatch-from-config.lifecycle.test.ts", "auto-reply-reply-dispatch-lifecycle"],
  ]);

  for (const file of files) {
    const name = relative("src/auto-reply/reply", file).replaceAll("\\", "/");
    const dispatchEntrypointGroup = dispatchEntrypoints.get(name);
    if (dispatchEntrypointGroup) {
      groups[dispatchEntrypointGroup].push(file);
      continue;
    }
    if (
      name.startsWith("agent-runner") ||
      name.startsWith("acp-") ||
      name === "abort.test.ts" ||
      name === "bash-command.stop.test.ts" ||
      name.startsWith("block-")
    ) {
      groups["auto-reply-reply-agent-runner"].push(file);
    } else if (name.startsWith("commands")) {
      groups["auto-reply-reply-commands"].push(file);
    } else if (
      name.startsWith("directive-") ||
      name.startsWith("dispatch") ||
      name.startsWith("followup-") ||
      name.startsWith("get-reply")
    ) {
      groups["auto-reply-reply-dispatch"].push(file);
    } else if (name.startsWith("session")) {
      groups["auto-reply-reply-session"].push(file);
    } else {
      groups["auto-reply-reply-state-routing"].push(file);
    }
  }

  return Object.entries(groups)
    .flatMap(([groupName, includePatterns]) => {
      // Retain separate command stripes so packing can spread their import cost across jobs.
      if (groupName === "auto-reply-reply-commands") {
        return createStripedBatches(
          includePatterns,
          AUTO_REPLY_COMMANDS_STRIPES,
          stripeFileWeight,
        ).map((batch, index) => ({
          configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
          includePatterns: batch,
          requiresDist: false,
          shardName: `${groupName}-${index + 1}`,
        }));
      }
      return [
        {
          configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
          includePatterns,
          requiresDist: false,
          shardName: groupName,
        },
      ];
    })
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveAgentCoreShardName(file: string): string {
  const name = relative("src/agents", file).replaceAll("\\", "/");
  if (
    name.startsWith("auth") ||
    name.includes("auth") ||
    name.includes("oauth") ||
    name.includes("credential") ||
    name.includes("api-key") ||
    name.includes("token")
  ) {
    return "agentic-agents-core-auth";
  }
  if (
    name.startsWith("model") ||
    name.includes("provider") ||
    name.includes("openai") ||
    name.includes("anthropic") ||
    name.includes("gemini") ||
    name.includes("moonshot") ||
    name.includes("minimax") ||
    name.includes("xai") ||
    name.includes("zai") ||
    name.includes("chutes") ||
    name.includes("catalog")
  ) {
    return "agentic-agents-core-models";
  }
  if (
    name.startsWith("agent-tools") ||
    name.startsWith("openclaw-tools") ||
    name.startsWith("bash-tools") ||
    name.startsWith("tool") ||
    name.startsWith("apply-patch") ||
    name.startsWith("exec") ||
    name.startsWith("sandbox")
  ) {
    return "agentic-agents-core-tools";
  }
  if (
    name.startsWith("subagent") ||
    name.startsWith("spawn") ||
    name.startsWith("embedded-agent-subscribe")
  ) {
    return "agentic-agents-core-subagents";
  }
  // The former single "core-runner" bucket serialized ~3 minutes of tests in
  // one group; keep these three slices separate so packing can balance them.
  if (name.startsWith("embedded-agent-runner")) {
    return "agentic-agents-core-runner-embedded";
  }
  if (
    name.startsWith("agent-command") ||
    name.startsWith("command") ||
    name.includes("compaction")
  ) {
    return "agentic-agents-core-runner-commands";
  }
  if (name.startsWith("cli-runner")) {
    return "agentic-agents-core-runner-cli";
  }
  if (name.includes("session")) {
    return "agentic-agents-core-runner-sessions";
  }
  return "agentic-agents-core-runtime";
}

function createAgentCoreSplitShards(): NodeTestSplitShard[] {
  const excludedTests = new Set(agentVitestProjectOwners.core.exclude);
  const groups = new Map<string, string[]>();
  for (const file of listTestFiles("src/agents")) {
    const name = relative("src/agents", file).replaceAll("\\", "/");
    if (name.includes("/") || excludedTests.has(file)) {
      continue;
    }
    const shardName = resolveAgentCoreShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  const sharedShards = [
    "agentic-agents-core-auth",
    "agentic-agents-core-models",
    "agentic-agents-core-tools",
    "agentic-agents-core-subagents",
    "agentic-agents-core-runner-cli",
    "agentic-agents-core-runner-commands",
    "agentic-agents-core-runner-embedded",
    "agentic-agents-core-runner-sessions",
    "agentic-agents-core-runtime",
  ]
    .flatMap((shardName) => {
      const includePatterns = groups.get(shardName) ?? [];
      // Retain the import-heavy CLI stripes; their files also share the bounded
      // worker pool, while timing estimates account for the effective file workers.
      if (shardName === "agentic-agents-core-runner-cli") {
        return createStripedBatches(
          includePatterns,
          AGENTS_CORE_RUNNER_CLI_STRIPES,
          stripeFileWeight,
        ).map((batch, index) => ({
          configs: [agentVitestProjectOwners.core.config],
          includePatterns: batch,
          requiresDist: false,
          shardName: `${shardName}-${index + 1}`,
        }));
      }
      return [
        {
          configs: [agentVitestProjectOwners.core.config],
          includePatterns,
          requiresDist: false,
          shardName,
        },
      ];
    })
    .filter((shard) => shard.includePatterns.length > 0);

  return [
    ...sharedShards,
    {
      configs: [agentVitestProjectOwners.spawnProductionBoundary.config],
      includePatterns: agentVitestProjectOwners.spawnProductionBoundary.include,
      requiresDist: false,
      shardName: "agentic-agents-core-spawn-production-boundary",
    },
    {
      configs: [agentVitestProjectOwners.coreIsolated.config],
      includePatterns: agentVitestProjectOwners.coreIsolated.include,
      requiresDist: false,
      shardName: "agentic-agents-core-isolated",
    },
  ];
}

function resolveGatewayStartupShardName(file: string): string {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (name.startsWith("server-startup-config") || name.startsWith("server-startup-early")) {
    return "agentic-control-plane-startup-config";
  }
  if (
    name.startsWith("server-runtime") ||
    name.startsWith("server.health") ||
    name.startsWith("server.lazy")
  ) {
    return "agentic-control-plane-startup-health-runtime";
  }
  if (name.startsWith("server-restart") || name === "server-close.test.ts") {
    return "agentic-control-plane-startup-restart-close";
  }
  return "agentic-control-plane-startup-core";
}

function resolveGatewayServerShardName(file: string): string {
  const name = relative("src/gateway", file).replaceAll("\\", "/");
  if (
    isGatewayServerBackedHttpTestFile(file) ||
    name.startsWith("server.models") ||
    name.startsWith("server.talk")
  ) {
    return "agentic-control-plane-http-models";
  }
  if (
    name.startsWith("server.agent") ||
    name.startsWith("server.chat") ||
    name.startsWith("server.sessions")
  ) {
    return "agentic-control-plane-agent-chat";
  }
  if (
    name.includes("auth") ||
    name.includes("device") ||
    name.includes("node") ||
    name.includes("roles") ||
    name.includes("silent") ||
    name.includes("preauth") ||
    name.includes("control-plane-rate-limit")
  ) {
    return "agentic-control-plane-auth-node";
  }
  if (
    name.startsWith("server-startup") ||
    name.startsWith("server-restart") ||
    name.startsWith("server-runtime") ||
    name.startsWith("server.lazy") ||
    name.startsWith("server.health") ||
    name === "server-close.test.ts"
  ) {
    return resolveGatewayStartupShardName(file);
  }
  if (name.includes("cron")) {
    return "agentic-control-plane-runtime-cron";
  }
  if (
    name.includes("plugin") ||
    name.includes("hooks") ||
    name.includes("http") ||
    name.includes("ws-connection")
  ) {
    return "agentic-control-plane-http-plugin-ws";
  }
  if (name.startsWith("server-")) {
    return "agentic-control-plane-runtime-server";
  }
  if (name.startsWith("server.config-patch")) {
    return "agentic-control-plane-runtime-config";
  }
  if (name.startsWith("server.shared-token")) {
    return "agentic-control-plane-runtime-shared-token";
  }
  if (
    name.startsWith("server.control-ui-root") ||
    name.startsWith("server.ios-client-id") ||
    name.startsWith("server.tools-catalog")
  ) {
    return "agentic-control-plane-runtime-ui-tools";
  }
  if (name.startsWith("server.")) {
    return "agentic-control-plane-runtime-state";
  }
  return "agentic-control-plane-runtime";
}

function createGatewayServerSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
  for (const file of listTestFiles("src/gateway").filter(isGatewayServerTestFile)) {
    const shardName = resolveGatewayServerShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }
  return [
    "agentic-control-plane-agent-chat",
    "agentic-control-plane-auth-node",
    "agentic-control-plane-http-models",
    "agentic-control-plane-http-plugin-ws",
    "agentic-control-plane-runtime",
    "agentic-control-plane-runtime-config",
    "agentic-control-plane-runtime-cron",
    "agentic-control-plane-runtime-server",
    "agentic-control-plane-runtime-shared-token",
    "agentic-control-plane-runtime-state",
    "agentic-control-plane-runtime-ui-tools",
    "agentic-control-plane-startup-config",
    "agentic-control-plane-startup-core",
    "agentic-control-plane-startup-health-runtime",
    "agentic-control-plane-startup-restart-close",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      env:
        shardName === "agentic-control-plane-startup-health-runtime"
          ? GATEWAY_STARTUP_HEALTH_RUNTIME_ENV
          : undefined,
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      runner:
        shardName === "agentic-control-plane-startup-core"
          ? GATEWAY_STARTUP_CORE_RUNNER
          : BUNDLED_NODE_TEST_RUNNER,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveCronShardName(file: string): string {
  const name = relative("src/cron", file).replaceAll("\\", "/");
  if (name.startsWith("isolated-agent")) {
    return "core-runtime-cron-parallel-isolated-agent";
  }
  if (name.startsWith("service")) {
    return "core-runtime-cron-parallel-service";
  }
  return "core-runtime-cron-parallel-core";
}

function createCronSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
  for (const file of listTestFiles("src/cron")) {
    const shardName = resolveCronShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }

  return [
    "core-runtime-cron-parallel-core",
    "core-runtime-cron-parallel-isolated-agent",
    "core-runtime-cron-parallel-service",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.cron.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

function resolveInfraShardName(file: string): string {
  const name = relative("src/infra", file).replaceAll("\\", "/");
  if (name.startsWith("approval") || name.startsWith("exec")) {
    return "core-runtime-infra-approval-exec";
  }
  if (name.startsWith("heartbeat-runner")) {
    return "core-runtime-infra-heartbeat-runner";
  }
  if (name.startsWith("heartbeat")) {
    return "core-runtime-infra-heartbeat-core";
  }
  if (name.startsWith("outbound/message-action")) {
    return "core-runtime-infra-outbound-actions";
  }
  if (name.startsWith("outbound/")) {
    return "core-runtime-infra-outbound-core";
  }
  if (
    name.startsWith("net/") ||
    name.startsWith("install") ||
    name.startsWith("npm") ||
    name.startsWith("brew") ||
    name.startsWith("binaries")
  ) {
    return "core-runtime-infra-net-install";
  }
  if (name.startsWith("device")) {
    return "core-runtime-infra-device";
  }
  if (name.startsWith("gateway-lock") || name.startsWith("gateway-process-argv")) {
    return "core-runtime-infra-gateway-lock-argv";
  }
  if (name.startsWith("gateway-processes")) {
    return "core-runtime-infra-gateway-processes";
  }
  if (name.startsWith("gateway-watch")) {
    return "core-runtime-infra-gateway-watch";
  }
  if (name.startsWith("node") || name.startsWith("bonjour") || name.startsWith("network")) {
    return "core-runtime-infra-network-node";
  }
  if (
    name.startsWith("archive") ||
    name.startsWith("backup") ||
    name.startsWith("diagnostic") ||
    name.startsWith("diagnostics")
  ) {
    return "core-runtime-infra-diagnostics-state";
  }
  if (
    name.startsWith("command-analysis/") ||
    name.startsWith("command-explainer/") ||
    name.startsWith("file-") ||
    name.startsWith("fs-") ||
    name.startsWith("json") ||
    name.startsWith("path") ||
    name.startsWith("shell") ||
    name.startsWith("tmp-openclaw-dir")
  ) {
    return "core-runtime-infra-files-commands";
  }
  if (name.startsWith("provider-usage") || name.startsWith("push-")) {
    return "core-runtime-infra-provider-push";
  }
  if (
    name.startsWith("kysely") ||
    name.startsWith("session") ||
    name.startsWith("sqlite") ||
    name.startsWith("stale-lock") ||
    name.startsWith("state-migrations")
  ) {
    return "core-runtime-infra-storage-state";
  }
  if (
    name.startsWith("channel") ||
    name.startsWith("plugin") ||
    name.startsWith("pairing") ||
    name.startsWith("voicewake")
  ) {
    return "core-runtime-infra-channel-plugin";
  }
  if (
    name.startsWith("package") ||
    name.startsWith("ports") ||
    name.startsWith("process") ||
    name.startsWith("restart") ||
    name.startsWith("runtime") ||
    name.startsWith("run-node") ||
    name.startsWith("system") ||
    name.startsWith("update")
  ) {
    return "core-runtime-infra-system-runtime";
  }
  if (
    name.startsWith("dotenv") ||
    name.startsWith("env") ||
    name.startsWith("gemini-auth") ||
    name.startsWith("google-api") ||
    name.startsWith("home-dir") ||
    name.startsWith("host-env") ||
    name.startsWith("openclaw-exec-env") ||
    name.startsWith("secret") ||
    name.startsWith("secure-random")
  ) {
    return "core-runtime-infra-env-auth";
  }
  if (
    name.startsWith("build-stamp") ||
    name.startsWith("changelog") ||
    name.startsWith("clawhub") ||
    name.startsWith("detect-package-manager") ||
    name.startsWith("git-") ||
    name.startsWith("openclaw-root") ||
    name.startsWith("tsdown") ||
    name.startsWith("vitest")
  ) {
    return "core-runtime-infra-repo-tooling";
  }
  if (
    name.startsWith("scp") ||
    name.startsWith("ssh") ||
    name.startsWith("tailnet") ||
    name.startsWith("tailscale") ||
    name.startsWith("tcp") ||
    name.startsWith("tls/") ||
    name.startsWith("transport") ||
    name.startsWith("widearea") ||
    name.startsWith("windows") ||
    name.startsWith("ws") ||
    name.startsWith("wsl")
  ) {
    return "core-runtime-infra-network-platform";
  }
  if (
    name.startsWith("abort") ||
    name.startsWith("backoff") ||
    name.startsWith("errors") ||
    name.startsWith("fatal-error") ||
    name.startsWith("fetch") ||
    name.startsWith("fixed-window") ||
    name.startsWith("format-time/") ||
    name.startsWith("http-body") ||
    name.startsWith("plain-object") ||
    name.startsWith("prototype-keys") ||
    name.startsWith("retry") ||
    name.startsWith("warning-filter")
  ) {
    return "core-runtime-infra-core-utils";
  }
  if (
    name.startsWith("browser") ||
    name.startsWith("cli-") ||
    name.startsWith("clipboard") ||
    name.startsWith("control-ui") ||
    name.startsWith("embedded") ||
    name.startsWith("is-main")
  ) {
    return "core-runtime-infra-cli-ui";
  }
  if (
    name.startsWith("agent-events") ||
    name.startsWith("event-session") ||
    name.startsWith("infra-") ||
    name.startsWith("non-fatal") ||
    name.startsWith("supervisor") ||
    name.startsWith("unhandled")
  ) {
    return "core-runtime-infra-events-runtime";
  }
  if (
    name.startsWith("boundary") ||
    name.startsWith("hardlink") ||
    name.startsWith("replace-file") ||
    name.startsWith("resolve-system-bin") ||
    name.startsWith("safe-package-install") ||
    name.startsWith("stable-node-path") ||
    name.startsWith("watch-node")
  ) {
    return "core-runtime-infra-file-safety";
  }
  if (name.startsWith("dedupe") || name.startsWith("disk-space")) {
    return "core-runtime-infra-misc-dedupe-disk";
  }
  if (
    name.startsWith("inline-option-token") ||
    name.startsWith("map-size") ||
    name.startsWith("machine-name")
  ) {
    return "core-runtime-infra-misc-values";
  }
  if (name.startsWith("os-summary")) {
    return "core-runtime-infra-misc-os";
  }
  return "core-runtime-infra-misc";
}

function createInfraSplitShards(): NodeTestSplitShard[] {
  const groups = new Map<string, string[]>();
  for (const file of listTestFiles("src/infra")) {
    if (isDatabaseWorkerCoreTestFile(file)) {
      continue;
    }
    const shardName = resolveInfraShardName(file);
    groups.set(shardName, [...(groups.get(shardName) ?? []), file]);
  }
  groups.set("core-runtime-infra-storage-state", [
    ...(groups.get("core-runtime-infra-storage-state") ?? []),
    ...databaseWorkerCoreTestFiles,
  ]);

  return [
    "core-runtime-infra-approval-exec",
    "core-runtime-infra-channel-plugin",
    "core-runtime-infra-cli-ui",
    "core-runtime-infra-device",
    "core-runtime-infra-diagnostics-state",
    "core-runtime-infra-core-utils",
    "core-runtime-infra-env-auth",
    "core-runtime-infra-events-runtime",
    "core-runtime-infra-file-safety",
    "core-runtime-infra-files-commands",
    "core-runtime-infra-gateway-lock-argv",
    "core-runtime-infra-gateway-processes",
    "core-runtime-infra-gateway-watch",
    "core-runtime-infra-heartbeat-core",
    "core-runtime-infra-heartbeat-runner",
    "core-runtime-infra-misc",
    "core-runtime-infra-misc-dedupe-disk",
    "core-runtime-infra-misc-os",
    "core-runtime-infra-misc-values",
    "core-runtime-infra-net-install",
    "core-runtime-infra-network-node",
    "core-runtime-infra-network-platform",
    "core-runtime-infra-outbound-actions",
    "core-runtime-infra-outbound-core",
    "core-runtime-infra-provider-push",
    "core-runtime-infra-repo-tooling",
    "core-runtime-infra-storage-state",
    "core-runtime-infra-system-runtime",
  ]
    .map((shardName) => ({
      configs: ["test/vitest/vitest.infra.config.ts"],
      includePatterns: groups.get(shardName) ?? [],
      requiresDist: false,
      runner: "blacksmith-4vcpu-ubuntu-2404",
      shardName,
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}

// The broad unit-fast graph is import-bound (~180s of module evaluation on an
// 8 vCPU runner as one job); striping the file list halves the wall clock.
// Isolated and fake-timer projects stay whole: they are small and own
// worker-isolation semantics that include lists must not slice.
function createUnitFastSplitShards(): NodeTestSplitShard[] {
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  const isolatedTestFiles = new Set(getUnitFastIsolatedTestFiles());
  const stripeFiles = getUnitFastTestFiles().filter(
    (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
  );
  return [
    ...createStripedBatches(stripeFiles, UNIT_FAST_NODE_TEST_STRIPES, stripeFileWeight).map(
      (includePatterns, index) => ({
        shardName: `core-unit-fast-${index + 1}`,
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        includePatterns,
        requiresDist: false,
      }),
    ),
    // Split per config: the combined pair owned a ~190s hosted wall that no
    // bin packing could shorten, while the halves fit normal lanes.
    {
      shardName: "core-unit-fast-isolated",
      configs: ["test/vitest/vitest.unit-fast-isolated.config.ts"],
      requiresDist: false,
    },
    {
      shardName: "core-unit-fast-fake-timers",
      configs: ["test/vitest/vitest.unit-fast-fake-timers.config.ts"],
      requiresDist: false,
    },
  ];
}

// Price the sixteen parent stripes with the same file workers as their compact
// children, so a long file can share spare worker capacity with shorter files.
// Push compacts omit tooling; retained compact groups stay exclusive.
function createToolingSplitShards(): NodeTestSplitShard[] {
  const files = listCompactToolingTestFiles();
  // Resolve file ownership once; batch scoring reuses those prepared facts.
  const buildModes = new Map(files.map((file) => [file, resolveTestFilesBuildMode([file])]));
  const toolingBatchWeight = (batch: string[]) => {
    const mode = mergeVitestPretestBuildModes(batch.map((file) => buildModes.get(file)));
    return (
      estimateParallelToolingSeconds({ env: PINNED_COMPACT_GROUP_ENV }, batch, "blacksmith") +
      (mode ? VITEST_PRETEST_BUILD_SECONDS[mode] : 0)
    );
  };
  return [
    ...createStripedBatches(
      files,
      COMPACT_TOOLING_NODE_TEST_GROUPS,
      (file) => toolingBatchWeight([file]),
      toolingBatchWeight,
    ).map((includePatterns, index) => ({
      shardName: `core-tooling-${index + 1}`,
      configs: [TOOLING_CONFIG],
      includePatterns,
      requiresDist: false,
    })),
    {
      shardName: "core-tooling-isolated",
      configs: ["test/vitest/vitest.tooling-docker.config.ts", TOOLING_ISOLATED_CONFIG],
      requiresDist: false,
    },
  ];
}

function createStripedSplitShards(params: {
  configs: string[];
  files: string[];
  includeExternalConfigs?: boolean;
  shardName: string;
  stripeCount: number;
}): NodeTestSplitShard[] {
  return createStripedBatches(params.files, params.stripeCount, stripeFileWeight).map(
    (includePatterns, index) => ({
      configs: params.configs,
      includeExternalConfigs: params.includeExternalConfigs,
      includePatterns,
      requiresDist: false,
      shardName: `${params.shardName}-${index + 1}`,
    }),
  );
}

function createCoreUnitSrcSecuritySplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const files = listTestFiles("src").filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      !file.startsWith("src/acp/") &&
      !file.startsWith("src/security/") &&
      isUnitConfigTestFile(file),
  );
  return [
    ...createStripedSplitShards({
      configs: ["test/vitest/vitest.unit-src.config.ts"],
      files,
      shardName: "core-unit-src-security",
      stripeCount: CORE_UNIT_SRC_SECURITY_STRIPES,
    }),
    {
      configs: ["test/vitest/vitest.unit-security.config.ts"],
      includeExternalConfigs: true,
      requiresDist: false,
      shardName: "core-unit-src-security-support",
    },
  ];
}

function createCoreRuntimeMediaUiSplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const separateUiFiles = new Set([...uiIsolatedTestFiles, ...uiTimingTestFiles]);
  const files = [
    ...listTestFiles("ui/src"),
    ...listTestFiles("extensions").filter(isPluginControlUiPath),
  ].filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      !separateUiFiles.has(file) &&
      !isUiBrowserTestFile(file),
  );
  return [
    ...createStripedSplitShards({
      configs: ["test/vitest/vitest.ui.config.ts"],
      files,
      shardName: "core-runtime-media-ui",
      stripeCount: CORE_RUNTIME_MEDIA_UI_STRIPES,
    }),
    {
      configs: [
        "test/vitest/vitest.media.config.ts",
        "test/vitest/vitest.media-understanding.config.ts",
        "test/vitest/vitest.tui.config.ts",
        "test/vitest/vitest.ui-isolated.config.ts",
        "test/vitest/vitest.ui-timing.config.ts",
        "test/vitest/vitest.wizard.config.ts",
      ],
      requiresDist: false,
      shardName: "core-runtime-media-ui-support",
    },
  ];
}

function partitionRuntimeTestFiles(configs: string[], files: string[]) {
  const runtimeFiles = new Set(listVitestRuntimeConsumerFiles(configs));
  return {
    runtimeFiles: files.filter((file) => runtimeFiles.has(file)),
    otherFiles: files.filter((file) => !runtimeFiles.has(file)),
  };
}

function createAgenticGatewayCoreSplitShards(): NodeTestSplitShard[] {
  const unitFastFiles = new Set(getUnitFastTestFiles());
  const excludedGatewayFiles = new Set([
    ...gatewayDatabaseWorkerTestFiles,
    ...gatewayServerExcludedTestFiles,
    ...gatewayServerIsolatedTestFiles,
  ]);
  const gatewayFiles = listTestFiles("src/gateway").filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      !file.startsWith("src/gateway/server-methods/") &&
      !isGatewayServerTestFile(file) &&
      !excludedGatewayFiles.has(file),
  );
  const packageFiles = ["packages/gateway-client/src", "packages/gateway-protocol/src"]
    .flatMap((rootDir) => listTestFiles(rootDir))
    .filter((file) => isStripeEligibleTestFile(file, unitFastFiles));
  const configs = [
    "test/vitest/vitest.gateway-core.config.ts",
    "test/vitest/vitest.gateway-client.config.ts",
  ];
  // The pretest runtime build is charged per job, so a stripe holding one of
  // these files pays it for the whole stripe. Striping spreads them, which made
  // every gateway-core job pay a 275s build to run ~120s of tests. Keep them in
  // one shard so exactly one job builds.
  const { runtimeFiles, otherFiles } = partitionRuntimeTestFiles(configs, [
    ...gatewayFiles,
    ...packageFiles,
  ]);
  const inventoryFile = "src/gateway/worker-environments/workspace-large-inventory.test.ts";
  return [
    ...createStripedSplitShards({
      configs,
      files: otherFiles.filter((file) => file !== inventoryFile),
      shardName: "agentic-gateway-core",
      stripeCount: AGENTIC_GATEWAY_CORE_STRIPES,
    }),
    // Keep the full journal/apply/recovery proof off the shared Vitest worker pool.
    {
      configs: ["test/vitest/vitest.gateway-core.config.ts"],
      includePatterns: [inventoryFile],
      requiresDist: false,
      shardName: "agentic-gateway-core-inventory",
    },
    ...(runtimeFiles.length > 0
      ? [
          {
            configs,
            includePatterns: runtimeFiles,
            requiresDist: false,
            shardName: "agentic-gateway-core-runtime",
          },
        ]
      : []),
  ];
}

const TUI_PTY_NODE_TEST_SHARD: NodeTestSplitShard = {
  shardName: "core-runtime-tui-pty",
  configs: ["test/vitest/vitest.tui-pty.config.ts"],
  env: {
    OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
    OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
  },
  requiresDist: true,
  runner: "blacksmith-4vcpu-ubuntu-2404",
};

const SPLIT_NODE_SHARDS = new Map<string, NodeTestSplitShard[] | (() => NodeTestSplitShard[])>([
  ["core-unit-fast", createUnitFastSplitShards],
  ["core-tooling", createToolingSplitShards],
  ["core-unit-src", createCoreUnitSrcSecuritySplitShards],
  ["core-unit-security", []],
  [
    "core-unit-support",
    [
      {
        shardName: "core-unit-support",
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
      },
    ],
  ],
  [
    "core-runtime",
    () => [
      {
        shardName: "core-runtime-hooks",
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      ...createInfraSplitShards(),
      {
        shardName: "core-runtime-secrets",
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      // runtime-config owns ~90% of the former three-config wall; keeping it
      // separate lets the hosted splitter stripe it while logging/process
      // stay a cheap pair.
      {
        shardName: "core-runtime-infra-process",
        configs: ["test/vitest/vitest.logging.config.ts", "test/vitest/vitest.process.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      {
        shardName: "core-runtime-config",
        configs: ["test/vitest/vitest.runtime-config.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
      },
      TUI_PTY_NODE_TEST_SHARD,
      ...createCoreRuntimeMediaUiSplitShards(),
      {
        shardName: "core-runtime-shared",
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
      },
      ...createCronSplitShards(),
    ],
  ],
  [
    "auto-reply",
    () => [
      {
        shardName: "auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
      },
      ...createAutoReplyReplySplitShards(),
    ],
  ],
  [
    "agentic",
    () => [
      ...createGatewayServerSplitShards(),
      {
        shardName: "agentic-gateway-server-isolated",
        configs: [
          "test/vitest/vitest.gateway-server-isolated.config.ts",
          "test/vitest/vitest.gateway-database-workers.config.ts",
        ],
        requiresDist: false,
      },
      // Split per config: the combined pair owned a ~206s hosted wall that no
      // bin packing could shorten, while the halves fit normal lanes.
      {
        shardName: "agentic-cli",
        configs: ["test/vitest/vitest.cli.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-cli-process",
        configs: ["test/vitest/vitest.cli-process.config.ts"],
        requiresDist: false,
      },
      {
        shardName: "agentic-command-support",
        configs: [
          "test/vitest/vitest.commands-light.config.ts",
          "test/vitest/vitest.daemon.config.ts",
        ],
        requiresDist: false,
      },
      ...createAgenticCommandSplitShards(resolveTestFilesBuildMode),
      ...createAgentCoreSplitShards(),
      {
        shardName: "agentic-agents-embedded",
        configs: embeddedAgentVitestProjectOwners.map((owner) => owner.config),
        env: AGENTS_EMBEDDED_AGENT_ENV,
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-support",
        configs: [agentVitestProjectOwners.support.config],
        requiresDist: false,
      },
      {
        shardName: "agentic-agents-tools",
        configs: [agentVitestProjectOwners.tools.config],
        requiresDist: false,
      },
      ...createAgenticGatewayCoreSplitShards(),
      {
        shardName: "agentic-gateway-methods",
        configs: [
          "test/vitest/vitest.gateway-methods.config.ts",
          "test/vitest/vitest.gateway-methods-isolated.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugin-sdk",
        configs: [
          "test/vitest/vitest.plugin-sdk-light.config.ts",
          "test/vitest/vitest.plugin-sdk.config.ts",
        ],
        requiresDist: false,
      },
      {
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        requiresDist: false,
      },
    ],
  ],
]);
const DIST_DEPENDENT_NODE_SHARD_NAMES = new Set(["core-support-boundary"]);
// Definitions are immutable for a planner process; defer file discovery until an
// owner is requested while retaining the original canonical metadata snapshot.
const canonicalNodeTestOwners = fullSuiteVitestShards.map((shard) => ({
  ...shard,
  projects: [...shard.projects],
}));
let canonicalMetadataConfigs: ReadonlySet<string> | undefined;

function resolveSplitNodeShards(name: string): NodeTestSplitShard[] | undefined {
  const entry = SPLIT_NODE_SHARDS.get(name);
  if (typeof entry !== "function") {
    return entry;
  }
  const shards = entry();
  SPLIT_NODE_SHARDS.set(name, shards);
  return shards;
}

export function nodeTestConfigRequiresCanonicalMetadata(config: string): boolean {
  if (config === TOOLING_CONFIG) {
    return canonicalNodeTestOwners.some(
      (owner) => owner.name === "core-tooling" && owner.projects.includes(config),
    );
  }
  canonicalMetadataConfigs ??= new Set(
    createNodeTestShardsForOwners(canonicalNodeTestOwners, {
      includeReleaseOnlyPluginShards: false,
    })
      .filter(
        (shard) =>
          shard.env ||
          shard.shardName.startsWith("core-tooling") ||
          shard.configs.some(isExclusiveCiTestConfig),
      )
      .flatMap((shard) => shard.configs),
  );
  return canonicalMetadataConfigs.has(config);
}

function formatNodeTestShardCheckName(shardName: string): string {
  const normalizedShardName = shardName.startsWith("core-unit-")
    ? `core-${shardName.slice("core-unit-".length)}`
    : shardName;
  return `checks-node-${normalizedShardName}`;
}

/** Create node test shard descriptors for CI with explicit release-tier selection. */
export function createNodeTestShards(options: NodeTestPlanOptions = {}): NodeTestShard[] {
  return createNodeTestShardsForOwners(fullSuiteVitestShards, options);
}

function createNodeTestShardsForOwners(
  owners: readonly (typeof fullSuiteVitestShards)[number][],
  options: NodeTestPlanOptions,
  toolingOnly = false,
): NodeTestShard[] {
  const includeReleaseOnlyPluginShards = options.includeReleaseOnlyPluginShards ?? true;
  const includeProofTests =
    options.includeProofTests ??
    (options.compactMode ?? (options.compact ? "pull-request" : undefined)) !== "pull-request";
  const includeTooling = includesReleaseOnlyTooling(options);
  const changedTestPlans = includeReleaseOnlyPluginShards
    ? []
    : (options.changedPaths ?? [])
        .filter(
          (file) =>
            isTestFileTarget(file) &&
            !file.endsWith(".live.test.ts") &&
            statSync(file, { throwIfNoEntry: false })?.isFile(),
        )
        .flatMap((file) => buildVitestRunPlans([file]));

  return owners.flatMap((shard) => {
    if (
      EXCLUDED_FULL_SUITE_SHARDS.has(shard.config) ||
      (!includeTooling && RELEASE_ONLY_TOOLING_SHARDS.has(shard.name)) ||
      (toolingOnly &&
        shard.name !== "core-tooling" &&
        shard.name !== "core-runtime" &&
        !DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name))
    ) {
      return [];
    }

    const configs = shard.projects.filter((config) => !EXCLUDED_PROJECT_CONFIGS.has(config));
    if (configs.length === 0) {
      return [];
    }

    const splitShards =
      toolingOnly && shard.name === "core-runtime"
        ? [TUI_PTY_NODE_TEST_SHARD]
        : resolveSplitNodeShards(shard.name);
    if (splitShards) {
      return splitShards.flatMap((splitShard) => {
        const splitConfigs = splitShard.includeExternalConfigs
          ? splitShard.configs
          : splitShard.configs.filter((config) => configs.includes(config));
        if (splitConfigs.length === 0) {
          return [];
        }

        let includePatterns =
          splitShard.includePatterns ??
          (!includeTooling ? mixedToolingTestFiles(splitConfigs) : undefined);
        if (!includeProofTests) {
          const files = includePatterns ?? listWholeConfigSplitFiles(splitShard.shardName);
          if (files?.some(isCiProofTestFile)) {
            includePatterns = files.filter((file) => !isCiProofTestFile(file));
            if (includePatterns.length === 0) {
              return [];
            }
          }
        }
        if (includePatterns && !includeTooling) {
          includePatterns = includePatterns.filter((file) => !isReleaseOnlyToolingTestFile(file));
          if (includePatterns.length === 0) {
            return [];
          }
        }
        if (
          RELEASE_ONLY_PLUGIN_SHARDS.has(splitShard.shardName) &&
          !includeReleaseOnlyPluginShards
        ) {
          // PR fallback must retain directly edited tests without enabling the
          // release sweep or stealing files from their canonical Vitest owners.
          includePatterns = [
            ...new Set(
              changedTestPlans
                .filter((plan) => splitConfigs.includes(plan.config))
                .flatMap((plan) => plan.includePatterns ?? []),
            ),
          ]
            .filter((file) => includeProofTests || !isCiProofTestFile(file))
            .toSorted();
          if (includePatterns.length === 0) {
            return [];
          }
        }

        const pretestBuildMode = includePatterns
          ? resolveTestFilesBuildMode(includePatterns)
          : resolveVitestPretestBuildMode([{ configs: splitConfigs }]);

        return [
          {
            checkName: formatNodeTestShardCheckName(splitShard.shardName),
            shardName: splitShard.shardName,
            configs: splitConfigs,
            ...(splitShard.env ? { env: splitShard.env } : {}),
            ...(includePatterns ? { includePatterns } : {}),
            ...(pretestBuildMode ? { pretestBuildMode } : {}),
            runner: splitShard.runner ?? DEFAULT_NODE_TEST_RUNNER,
            requiresDist: splitShard.requiresDist,
          },
        ];
      });
    }

    const pretestBuildMode = resolveVitestPretestBuildMode([{ configs }]);
    return [
      {
        checkName: formatNodeTestShardCheckName(shard.name),
        shardName: shard.name,
        configs,
        ...(pretestBuildMode ? { pretestBuildMode } : {}),
        runner: DEFAULT_NODE_TEST_RUNNER,
        requiresDist: DIST_DEPENDENT_NODE_SHARD_NAMES.has(shard.name),
      },
    ];
  });
}

/** Select planner envelopes that produce the protected Vitest transform-cache seed. */
export function createVitestCacheWarmGroups(profile: "full" | "hybrid-hosted" = "full"): Array<{
  configs: string[];
  env?: Record<string, string>;
  includePatterns?: string[];
  shard_name: string;
}> {
  // Preserve the package root and aliases used by checks-ui in either backend.
  const uiGroup = {
    configs: ["ui/vitest.config.ts"],
    env: { OPENCLAW_VITEST_MAX_WORKERS: "1" },
    includePatterns: [
      "ui/src/components/app-sidebar.test.ts",
      "ui/src/pages/chat/chat-view.test.ts",
      "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
      "ui/src/pages/usage/metrics.node.test.ts",
    ],
    shard_name: "cache-warm:ui-package",
  };
  if (profile === "hybrid-hosted") {
    // Seed the hosted CI-routing and contract closures without collecting all
    // tooling tests or building the runtime. Ordinary CI still runs every test.
    return [
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts", "test/vitest/vitest.tooling.config.ts"],
        includePatterns: [
          "src/commands/status.scan-result.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/ci-workflow-planning.test.ts",
          "test/scripts/ci-workflow-evidence.test.ts",
          "test/scripts/ci-run-node-test-shard.test.ts",
        ],
        shard_name: "cache-warm:hosted-tooling",
      },
      ...(
        [
          ["plugin", "src/plugins/contracts/registry.contract.test.ts"],
          ["channel-surface", "src/channels/plugins/contracts/channel-catalog.contract.test.ts"],
          [
            "channel-config",
            "src/channels/plugins/contracts/gateway-auth-artifact.contract.test.ts",
          ],
          [
            "channel-registry",
            "src/channels/plugins/contracts/plugins-core.registry.contract.test.ts",
          ],
          [
            "channel-session",
            "src/channels/plugins/contracts/session-key-artifact.contract.test.ts",
          ],
        ] as const
      ).map(([name, file]) => ({
        configs: [`test/vitest/vitest.contracts-${name}.config.ts`],
        includePatterns: [file],
        shard_name: `cache-warm:hosted-contracts-${name}`,
      })),
      uiGroup,
    ];
  }
  const additionalShardNames = new Set([
    "agentic-agents-embedded",
    "agentic-gateway-methods",
    "auto-reply-reply-commands-3",
  ]);
  const allShards = createNodeTestShards();
  const coreShards = allShards.filter((candidate) =>
    candidate.shardName.startsWith("core-unit-fast"),
  );
  if (coreShards.length === 0) {
    throw new Error("core-unit-fast cache seed shards are missing");
  }
  const additionalShards = allShards.filter((candidate) =>
    additionalShardNames.has(candidate.shardName),
  );
  const foundAdditionalShardNames = new Set(additionalShards.map((shard) => shard.shardName));
  const missingShardNames = [...additionalShardNames].filter(
    (name) => !foundAdditionalShardNames.has(name),
  );
  if (missingShardNames.length > 0) {
    throw new Error(`cache seed shards are missing: ${missingShardNames.join(", ")}`);
  }
  return [
    ...[...coreShards, ...additionalShards].flatMap((shard) =>
      shard.configs.map((config) => ({
        configs: [config],
        ...(shard.env ? { env: shard.env } : {}),
        ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
        shard_name: `cache-warm:${shard.shardName}:${config}`,
      })),
    ),
    uiGroup,
  ];
}

function resolveCiNodeTestRunner(shard: NodeTestShard, compactProfile?: string): string {
  const ownerRunner = COMPACT_NODE_TEST_OWNER_RUNNERS.get(compactProfile ?? "")?.get(
    shard.shardName,
  );
  if (ownerRunner) {
    return ownerRunner;
  }
  if (
    (compactProfile === "blacksmith" &&
      shard.includePatterns?.includes("src/cli/update-dry-run-state.process.test.ts")) ||
    (compactProfile === "hybrid" &&
      (shard.includePatterns?.includes("src/cli/gateway-backed-exit.process.test.ts") ||
        shard.includePatterns?.includes("src/cli/gateway-backed-exit-health.process.test.ts")))
  ) {
    return DEFAULT_NODE_TEST_RUNNER;
  }
  if (shard.runner !== DEFAULT_NODE_TEST_RUNNER) {
    return shard.runner;
  }
  // The full-build compiler fixture must pass the real 4352MB heap guard even
  // after earlier tooling tests have retained their module graphs.
  return KEEP_LARGE_NODE_TEST_RUNNER.has(shard.shardName) ||
    shard.includePatterns?.includes(TOOLING_UNIFIED_DECLARATIONS_TEST_FILE)
    ? DEFAULT_NODE_TEST_RUNNER
    : BUNDLED_NODE_TEST_RUNNER;
}

function resolveCiNodeTestRunnerClass(runner: string) {
  const name =
    runner === EXTRA_LARGE_NODE_TEST_RUNNER
      ? "large32"
      : runner.includes("-8vcpu-")
        ? "large"
        : "small";
  // Each runner bucket starts numbering at one; distinct classes need distinct
  // names while larger requests retain the conservative large-job budget.
  return {
    name,
    secondsCap:
      name === "small" ? COMPACT_SMALL_NODE_TEST_JOB_SECONDS : COMPACT_LARGE_NODE_TEST_JOB_SECONDS,
  };
}

function bundleNameForConfigs(configs: string[]): string {
  const config = configs[0] ?? "node";
  return config
    .replace(/^test\/vitest\/vitest\./u, "")
    .replace(/\.config\.ts$/u, "")
    .replace(/[^a-z0-9-]+/giu, "-");
}

function compareFullNodeTestAdmissionOrder(a: NodeTestShard, b: NodeTestShard): number {
  const fallbackPriority = FULL_NODE_TEST_ADMISSION_PRIORITY.size;
  return (
    (FULL_NODE_TEST_ADMISSION_PRIORITY.get(a.shardName) ?? fallbackPriority) -
      (FULL_NODE_TEST_ADMISSION_PRIORITY.get(b.shardName) ?? fallbackPriority) ||
    a.checkName.localeCompare(b.checkName)
  );
}

// Deterministic cost-aware batching (greedy LPT): heaviest values first, each
// into the currently lightest batch. Round-robin by discovery order can pack
// one whale next to another and leave sibling batches much lighter.
function createStripedBatches<T>(
  values: T[],
  batchCount: number,
  weightForValue: (value: T) => number,
  weightForBatch?: (values: T[]) => number,
): T[][] {
  if (batchCount < 1) {
    throw new Error("striped batch count must be positive");
  }
  const entries = values.map((value, index) => ({
    index,
    value,
    weight: weightForValue(value),
  }));
  entries.sort((a, b) => b.weight - a.weight || a.index - b.index);
  const batches: Array<{
    totalWeight: number;
    entries: Array<{ index: number; value: T; weight: number }>;
  }> = Array.from({ length: batchCount }, () => ({ totalWeight: 0, entries: [] }));
  const firstBatch = batches[0];
  if (!firstBatch) {
    throw new Error("striped batch allocation failed");
  }
  for (const entry of entries) {
    const nextWeight = (batch: (typeof batches)[number]) =>
      weightForBatch
        ? weightForBatch([...batch.entries.map(({ value }) => value), entry.value])
        : batch.totalWeight + entry.weight;
    let target = firstBatch;
    for (const batch of batches) {
      if (nextWeight(batch) < nextWeight(target)) {
        target = batch;
      }
    }
    target.totalWeight = nextWeight(target);
    target.entries.push(entry);
  }
  // Keep discovery order inside each batch so include lists stay stable.
  return batches.map((batch) =>
    batch.entries.toSorted((a, b) => a.index - b.index).map((entry) => entry.value),
  );
}

function listCompactToolingTestFiles(): string[] {
  const unitFastFiles = getUnitFastTestFilesForIncludePatterns([
    "test/**/*.test.ts",
    "src/scripts/**/*.test.ts",
  ]);
  const excludedFiles = new Set([
    ...boundaryTestFiles,
    ...gatewayPluginTestFiles,
    ...gatewayDatabaseWorkerTestFiles,
    ...unitFastFiles,
    TOOLING_DOCKER_TEST_FILE,
    ...toolingIsolatedTestFiles,
    ...databaseWorkerCoreTestFiles,
  ]);
  return [...listTestFiles("test"), ...listTestFiles("src/scripts")].filter(
    (file) =>
      !file.startsWith("test/fixtures/") &&
      !file.endsWith(".e2e.test.ts") &&
      !file.endsWith(".live.test.ts") &&
      !excludedFiles.has(file),
  );
}

/**
 * Collapse split include-pattern shards into bounded jobs for normal CI.
 * The base plan remains unchanged for release and coverage consumers.
 */
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions & { compactMode: CompactNodeTestPlanMode },
): CompactNodeTestShard[];
/** @deprecated Use compactMode so push and pull-request coverage stay explicit. */
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions & { compact: true },
): CompactNodeTestShard[];
export function createNodeTestShardBundles(options?: NodeTestPlanOptions): NodeTestShard[];
export function createNodeTestShardBundles(
  options: NodeTestPlanOptions = {},
): NodeTestShard[] | CompactNodeTestShard[] {
  const compactMode =
    options.compactMode ?? (options.compact === true ? "pull-request" : undefined);
  if (compactMode !== undefined) {
    return createCompactNodeTestShardBundles(
      // Keep complete owners for cost admission; compact projection below gives
      // a reduced tooling selection its own timing identity.
      createNodeTestShards({ ...options, includeReleaseOnlyToolingShards: true }),
      { ...options, compactMode },
      compactMode,
    );
  }

  const shards = createNodeTestShards(options);
  const unbundled: NodeTestShard[] = [];
  const groups = new Map<
    string,
    {
      configs: string[];
      pretestBuildMode?: NodeTestPretestBuildMode;
      requiresDist: boolean;
      runner: string;
      shards: NodeTestShard[];
    }
  >();

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    const [config] = shard.configs;
    if (
      shard.requiresDist ||
      shard.configs.length !== 1 ||
      config === undefined ||
      !BUNDLEABLE_NODE_TEST_CONFIGS.has(config) ||
      !Array.isArray(shard.includePatterns) ||
      shard.includePatterns.length === 0
    ) {
      unbundled.push({ ...shard, runner });
      continue;
    }

    const key = JSON.stringify([shard.configs, shard.pretestBuildMode, shard.requiresDist, runner]);
    const group = groups.get(key) ?? {
      configs: shard.configs,
      ...(shard.pretestBuildMode ? { pretestBuildMode: shard.pretestBuildMode } : {}),
      requiresDist: shard.requiresDist,
      runner,
      shards: [],
    };
    group.shards.push(shard);
    groups.set(key, group);
  }

  const bundled: NodeTestShard[] = [];
  for (const group of groups.values()) {
    const bins: Array<{ includePatterns: string[] }> = [];
    const sortedShards = group.shards.toSorted(
      (a, b) =>
        (b.includePatterns?.length ?? 0) - (a.includePatterns?.length ?? 0) ||
        a.shardName.localeCompare(b.shardName),
    );
    for (const shard of sortedShards) {
      const patterns = shard.includePatterns ?? [];
      for (let offset = 0; offset < patterns.length; offset += MAX_BUNDLED_NODE_TEST_PATTERNS) {
        const chunk = patterns.slice(offset, offset + MAX_BUNDLED_NODE_TEST_PATTERNS);
        const bin = bins.find(
          (candidate) =>
            candidate.includePatterns.length + chunk.length <= MAX_BUNDLED_NODE_TEST_PATTERNS,
        );
        if (bin) {
          bin.includePatterns.push(...chunk);
        } else {
          bins.push({ includePatterns: [...chunk] });
        }
      }
    }

    const { name: runnerClass } = resolveCiNodeTestRunnerClass(group.runner);
    const buildModeSuffix = group.pretestBuildMode ? `-${group.pretestBuildMode}` : "";
    const bundleName = `${bundleNameForConfigs(group.configs)}-${runnerClass}${buildModeSuffix}`;
    for (const [index, bin] of bins.entries()) {
      const shardName = `bundle-${bundleName}-${index + 1}`;
      bundled.push({
        checkName: formatNodeTestShardCheckName(shardName),
        shardName,
        configs: group.configs,
        includePatterns: bin.includePatterns.toSorted((a, b) => a.localeCompare(b)),
        ...(group.pretestBuildMode ? { pretestBuildMode: group.pretestBuildMode } : {}),
        runner: group.runner,
        requiresDist: group.requiresDist,
      });
    }
  }

  return [...unbundled, ...bundled].toSorted(compareFullNodeTestAdmissionOrder);
}

function listScopedOwnerTestFiles(owner: {
  root: string;
  include: string[];
  exclude: string[];
}): string[] {
  // Scoped configs drop unit-fast files, so a lister that keeps them prices
  // stripes on files the shard never runs and hands Vitest inert patterns.
  const unitFastFiles = new Set(getUnitFastTestFiles());
  return listTestFiles(owner.root).filter(
    (file) =>
      isStripeEligibleTestFile(file, unitFastFiles) &&
      owner.include.some((pattern) => matchesGlob(file, pattern)) &&
      !owner.exclude.some((pattern) => matchesGlob(file, pattern)),
  );
}

function listAgentSupportTestFiles(): string[] {
  return listScopedOwnerTestFiles(agentVitestProjectOwners.support);
}

// Whole-config groups the hosted splitter may stripe by file: each lister
// must enumerate exactly its config's include set so a stripe union stays a
// complete, non-overlapping partition of the suite.
const WHOLE_CONFIG_SPLIT_FILE_LISTERS = new Map<string, () => string[]>([
  [
    "agentic-gateway-server-isolated",
    () => [...gatewayServerIsolatedTestFiles, ...gatewayDatabaseWorkerTestFiles],
  ],
  ["agentic-cli-process", () => cliProcessTestFiles],
  ["agentic-agents-support", listAgentSupportTestFiles],
  [
    COMPACT_EMBEDDED_BASE_GROUP_NAME,
    () => listScopedOwnerTestFiles(agentVitestProjectOwners.embedded),
  ],
  [
    "agentic-plugins",
    () =>
      listScopedOwnerTestFiles({
        root: "src/plugins",
        include: ["src/plugins/**/*.test.ts"],
        exclude: [
          "src/plugins/contracts/**",
          "src/plugins/loader.test.ts",
          ...databaseWorkerCoreTestFiles,
        ],
      }),
  ],
  [
    "agentic-plugin-sdk",
    () =>
      listScopedOwnerTestFiles({
        root: "src/plugin-sdk",
        include: ["src/plugin-sdk/**/*.test.ts"],
        exclude: [...bundledPluginDependentUnitTestFiles, ...databaseWorkerCoreTestFiles],
      }),
  ],
  [
    "agentic-gateway-methods",
    () => [
      ...listScopedOwnerTestFiles({
        root: "src/gateway/server-methods",
        include: ["src/gateway/server-methods/**/*.test.ts"],
        exclude: [...databaseWorkerCoreTestFiles, ...gatewayDatabaseWorkerTestFiles],
      }),
      ...gatewayPluginTestFiles.filter((file) => !gatewayDatabaseWorkerTestFiles.includes(file)),
    ],
  ],
  [
    "core-runtime-config",
    () => listTestFiles("src/config").filter((file) => !isDatabaseWorkerCoreTestFile(file)),
  ],
  // isolate:true gives every file a fresh module graph, so file stripes
  // cannot change behavior.
  ["core-unit-fast-isolated", getUnitFastIsolatedTestFiles],
]);

const wholeConfigSplitFileCache = new Map<string, string[]>();

function listWholeConfigSplitFiles(shardName: string): string[] | undefined {
  const listFiles = WHOLE_CONFIG_SPLIT_FILE_LISTERS.get(shardName);
  if (!listFiles) {
    return undefined;
  }
  // Test fixtures deliberately replace the CLI process inventory. The other
  // owner inventories are immutable for the process lifetime and expensive to
  // rediscover (git walks plus glob matching) on every candidate plan.
  if (shardName === "agentic-cli-process") {
    return listFiles();
  }
  let files = wholeConfigSplitFileCache.get(shardName);
  if (!files) {
    files = listFiles();
    wholeConfigSplitFileCache.set(shardName, files);
  }
  return files;
}

type HostedToolingTailDonation = {
  parentShardName: string;
  file: string;
  freedSeconds: number;
};

function selectHostedToolingTailDonation(
  stripes: readonly string[][],
  secondsForFiles: (files: readonly string[]) => number,
  selectedFile?: string,
  selectedToolingFiles?: ReadonlySet<string>,
): { file: string; donorIndex: number; freedSeconds: number } | undefined {
  const tail = stripes.at(-1);
  if (!tail) {
    return undefined;
  }
  let best: { file: string; donorIndex: number; freedSeconds: number } | undefined;
  for (const [donorIndex, donor] of stripes.slice(0, -1).entries()) {
    const donorSeconds = secondsForFiles(donor);
    if (donor.length < 2 || donorSeconds <= COMPACT_EXCLUSIVE_JOB_SECONDS / 2) {
      continue;
    }
    for (const file of donor) {
      const freedSeconds = donorSeconds - secondsForFiles(donor.filter((entry) => entry !== file));
      if (
        (selectedFile !== undefined && file !== selectedFile) ||
        (selectedToolingFiles !== undefined && !selectedToolingFiles.has(file)) ||
        freedSeconds <= 0 ||
        secondsForFiles([...tail, file]) > COMPACT_EXCLUSIVE_JOB_SECONDS / 2
      ) {
        continue;
      }
      if (
        !best ||
        freedSeconds > best.freedSeconds ||
        (freedSeconds === best.freedSeconds && file.localeCompare(best.file) < 0)
      ) {
        best = { file, donorIndex, freedSeconds };
      }
    }
  }
  return best;
}

function splitOversizedCompactGroup(
  group: NodeTestShardGroup,
  runnerBackend: string | undefined,
  runtimePartition?: ReturnType<typeof partitionRuntimeTestFiles>,
  splitHostedToolingTails = false,
  hostedToolingTailBudgets?: ReadonlyMap<string, number>,
  hostedToolingTailDonation?: HostedToolingTailDonation,
  onHostedToolingTailDonation?: (donation: HostedToolingTailDonation) => void,
  selectedToolingFiles?: ReadonlySet<string>,
): Array<{ group: NodeTestShardGroup; seconds: number }> {
  // Hybrid groups must fit both the first-attempt runner and hosted retries;
  // a faster retry estimate must not leave a slow first attempt unsplit.
  const isCliProcess = group.shard_name === "agentic-cli-process";
  const isTooling = isParallelToolingGroup(group);
  const storageStateFileLimit =
    runnerBackend === "github" && group.shard_name === "core-runtime-infra-storage-state"
      ? COMPACT_HOSTED_STORAGE_STATE_MAX_FILES
      : undefined;
  const exceedsStorageStateFileLimit =
    storageStateFileLimit !== undefined &&
    (group.includePatterns?.length ?? 0) > storageStateFileLimit;
  const measuredProfileSeconds = estimateCompactGroupSeconds(group, runnerBackend);
  const measuredHostedSeconds = estimateCompactGroupSeconds(group, "github");
  // These consumers share one prepared runtime; admission retains the retry budget.
  if (group.shard_name === COMMANDS_RUNTIME_GROUP && isParallelCommandsGroup(group)) {
    return [{ group, seconds: measuredProfileSeconds }];
  }
  const parallelCommands = isParallelCommandsGroup(group);
  const parallelGateway = isParallelGatewayServerGroup(group);
  const parentWorkers = isAutoReplyReplyGroup(group)
    ? compactEffectiveFileWorkers(group, group.includePatterns?.length ?? 1)
    : effectiveAgentsCoreWorkers(group);
  // Whole parallel walls and sums of split invocations have different worker costs.
  const splitTimingParent = `${compactGroupTimingKey(group)}${parallelGateway ? "-stripes" : ""}`;
  const splitTimingPrefixes = [
    splitTimingParent,
    ...(parallelCommands ? [group.shard_name] : []),
  ].map((key) => `${key}#selector-`);
  const splitParentSeconds = {
    blacksmith: parallelGateway
      ? (readCompactGroupTimings("blacksmith")[splitTimingParent] ?? 0)
      : 0,
    github: parallelGateway ? (readCompactGroupTimings("github")[splitTimingParent] ?? 0) : 0,
  };
  const hasSplitTimingHistory =
    !isTooling &&
    (["blacksmith", "github"] as const).some(
      (profile) =>
        splitParentSeconds[profile] > 0 ||
        Object.keys(readCompactGroupTimings(profile)).some((key) =>
          splitTimingPrefixes.some((prefix) => key.startsWith(prefix)),
        ),
    );
  if (
    !isCliProcess &&
    !exceedsStorageStateFileLimit &&
    !runtimePartition &&
    !hasSplitTimingHistory &&
    Math.max(measuredProfileSeconds, measuredHostedSeconds) <= COMPACT_GITHUB_MAX_PREDICTED_SECONDS
  ) {
    return [{ group, seconds: measuredProfileSeconds }];
  }
  const includePatterns = group.includePatterns ?? listWholeConfigSplitFiles(group.shard_name);
  const buildModes = new Map(
    includePatterns?.map((file) => [file, resolveTestFilesBuildMode([file])]) ?? [],
  );
  const packTooling = isTooling && runnerBackend === "github";
  const agentsCoreFiles = isParallelAgentsCoreGroup(group)
    ? new Set(agentsCoreWorkFiles(group))
    : undefined;
  const weightForFile = isTooling
    ? toolingFileWeight
    : (file: string) =>
        !agentsCoreFiles || agentsCoreFiles.has(file) ? stripeFileWeight(file) : 0;
  const totalWeight =
    includePatterns?.reduce((seconds, file) => seconds + weightForFile(file), 0) ?? 0;
  // A measured whole-config parent can lag newly cataloged files. Its old
  // aggregate must not hide the complete process owner's file costs.
  const profileSeconds = Math.max(measuredProfileSeconds, isCliProcess ? totalWeight : 0);
  const splitBuildMode =
    isCliProcess && !runtimePartition
      ? mergeVitestPretestBuildModes([...buildModes.values()])
      : undefined;
  const splitBuildSeconds = splitBuildMode ? VITEST_PRETEST_BUILD_SECONDS[splitBuildMode] : 0;
  const hostedProfileSeconds = Math.max(measuredHostedSeconds, isCliProcess ? totalWeight : 0);
  const splitSeconds = Math.max(
    profileSeconds + splitBuildSeconds,
    hostedProfileSeconds + Math.round(splitBuildSeconds * COMPACT_GITHUB_GROUP_SECONDS_SCALE),
  );
  if (!includePatterns || includePatterns.length < 2 || totalWeight === 0) {
    return [{ group, seconds: profileSeconds }];
  }

  // The prerequisite is charged once per emitted job. Include it in placement
  // so a balanced test stripe still leaves room for its runtime build.
  let tailDonation: HostedToolingTailDonation | undefined;
  const createStripes = (seconds: number) => {
    tailDonation = undefined;
    const files = runtimePartition?.otherFiles ?? includePatterns;
    const batchWeight = (patterns: readonly string[]) => {
      const mode = mergeVitestPretestBuildModes(patterns.map((file) => buildModes.get(file)));
      const weight = patterns.reduce((sum, file) => sum + weightForFile(file), 0);
      return (
        (isTooling
          ? estimateParallelToolingSeconds(group, patterns, packTooling ? "github" : runnerBackend)
          : weight) +
        Math.round(
          (mode ? VITEST_PRETEST_BUILD_SECONDS[mode] : 0) *
            (packTooling ? COMPACT_GITHUB_GROUP_SECONDS_SCALE : 1),
        )
      );
    };
    const weightForValue =
      isCliProcess || isTooling ? (file: string) => batchWeight([file]) : weightForFile;
    let stripes: string[][];
    if (packTooling) {
      // Balanced thirds of a ~301s parent each consume a 150s job. Fill the
      // budget first so unrelated families can share the small remainder.
      // Hybrid retains balanced children for its faster Blacksmith admission.
      const discoveryOrder = (a: string, b: string) => files.indexOf(a) - files.indexOf(b);
      const packFiles = (patterns: string[], secondsCap: number) =>
        packNodeTestGroups(
          patterns.toSorted(
            (a, b) => weightForValue(b) - weightForValue(a) || discoveryOrder(a, b),
          ),
          (bin, file) => batchWeight([...bin, file]) <= secondsCap,
        ).map((batch) => batch.toSorted(discoveryOrder));
      stripes = packFiles(files, COMPACT_EXCLUSIVE_JOB_SECONDS);
      const tail = stripes.at(-1);
      if (
        splitHostedToolingTails &&
        tail &&
        tail.length > 1 &&
        batchWeight(tail) <= COMPACT_EXCLUSIVE_JOB_SECONDS
      ) {
        // Keep runtime generations whole; ordinary tails use available capacity
        // only after half-budget packing failed. Indivisible files keep their cost.
        const tailBudget =
          runtimePartition === undefined &&
          group.pretestBuildMode === undefined &&
          !group.requiresDist
            ? hostedToolingTailBudgets?.get(group.shard_name)
            : undefined;
        stripes.splice(-1, 1, ...packFiles(tail, tailBudget ?? COMPACT_EXCLUSIVE_JOB_SECONDS / 2));
      }
      const selectedDonation =
        hostedToolingTailDonation?.parentShardName === group.shard_name
          ? hostedToolingTailDonation
          : undefined;
      if (
        (onHostedToolingTailDonation || selectedDonation) &&
        runtimePartition === undefined &&
        group.pretestBuildMode === undefined &&
        !group.requiresDist
      ) {
        const donation = selectHostedToolingTailDonation(
          stripes,
          batchWeight,
          selectedDonation?.file,
          selectedToolingFiles,
        );
        if (donation) {
          if (selectedDonation) {
            stripes[donation.donorIndex] = stripes[donation.donorIndex]!.filter(
              (file) => file !== donation.file,
            );
            stripes[stripes.length - 1] = [...stripes.at(-1)!, donation.file].toSorted(
              discoveryOrder,
            );
          } else {
            tailDonation = {
              parentShardName: group.shard_name,
              file: donation.file,
              freedSeconds: donation.freedSeconds,
            };
          }
        }
      }
    } else {
      // The fixed build stays with its runtime child; only remaining test
      // work benefits from more stripes. Empty include lists run the whole config.
      const remainingSeconds = isTooling
        ? estimateParallelToolingSeconds(group, files, "github")
        : runtimePartition
          ? (seconds * files.reduce((sum, file) => sum + weightForFile(file), 0)) / totalWeight
          : seconds;
      stripes = createStripedBatches(
        files,
        Math.min(
          agentsCoreFiles
            ? Math.max(1, files.filter((file) => agentsCoreFiles.has(file)).length)
            : files.length,
          Math.max(1, Math.ceil(remainingSeconds / COMPACT_GITHUB_MAX_PREDICTED_SECONDS)),
        ),
        weightForValue,
        isCliProcess || isTooling ? batchWeight : undefined,
      );
    }
    const partitioned = runtimePartition ? [runtimePartition.runtimeFiles, ...stripes] : stripes;
    // Preserve prerequisite ownership and the existing weighted stripes. The
    // family guard prevents cost packing from joining these serial chunks again.
    return storageStateFileLimit === undefined
      ? partitioned
      : partitioned.flatMap((stripeFiles) =>
          Array.from(
            { length: Math.ceil(stripeFiles.length / storageStateFileLimit) },
            (_, index) =>
              stripeFiles.slice(index * storageStateFileLimit, (index + 1) * storageStateFileLimit),
          ),
        );
  };
  const timingEnv = parallelCommands ? { ...group.env, ...PINNED_COMPACT_GROUP_ENV } : group.env;
  let stripes = createStripes(splitSeconds);
  let timingGeneration = createCompactSplitTimingGeneration({
    configs: group.configs,
    env: timingEnv,
    parentShardName: splitTimingParent,
    stripes,
  });
  // The measured worker cutover changes timing identity, not admission budgets.
  // Retain the previous two-worker observations as floors until timing refits retire them.
  const previousWorkerEnv: Record<string, string> | undefined =
    !parallelCommands && usesMeasuredCompactWorkers(group, runnerBackend)
      ? { ...group.env, ...PINNED_COMPACT_GROUP_ENV }
      : undefined;
  // The isolated cohort inherited its old two-worker cap from the job, not its descriptor.
  if (previousWorkerEnv && MEASURED_GATEWAY_ISOLATED_GROUP_RE.test(group.shard_name)) {
    delete previousWorkerEnv.OPENCLAW_VITEST_MAX_WORKERS;
  }
  const previousWorkerGeneration = previousWorkerEnv
    ? createCompactSplitTimingGeneration({
        configs: group.configs,
        env: previousWorkerEnv,
        parentShardName: splitTimingParent,
        stripes,
      })
    : undefined;
  const selectors = (
    isTooling ? [] : [timingGeneration.selectorKey, previousWorkerGeneration?.selectorKey]
  ).filter((selector): selector is string => selector !== undefined);
  const completeBlacksmithSeconds = Math.max(
    splitParentSeconds.blacksmith,
    ...selectors.map(
      (selector) =>
        readCompleteSplitGenerationSeconds(readCompactGroupTimings("blacksmith"), selector) ?? 0,
    ),
  );
  const completeHostedSeconds = Math.max(
    splitParentSeconds.github,
    ...selectors.map(
      (selector) =>
        readCompleteSplitGenerationSeconds(readCompactGroupTimings("github"), selector) ?? 0,
    ),
  );
  const completeMeasuredSeconds =
    runnerBackend === "github"
      ? completeHostedSeconds
      : runnerBackend === "hybrid"
        ? Math.max(completeBlacksmithSeconds, completeHostedSeconds)
        : completeBlacksmithSeconds;
  if (
    !runtimePartition &&
    !exceedsStorageStateFileLimit &&
    (!parallelGateway || completeMeasuredSeconds === 0) &&
    Math.max(splitSeconds, completeMeasuredSeconds) <= COMPACT_GITHUB_MAX_PREDICTED_SECONDS
  ) {
    return [
      {
        group,
        seconds: parallelCommands
          ? Math.max(
              profileSeconds,
              runnerBackend === "github" ? completeHostedSeconds : completeBlacksmithSeconds,
            )
          : profileSeconds,
      },
    ];
  }
  if (completeMeasuredSeconds > splitSeconds) {
    stripes = createStripes(completeMeasuredSeconds);
    timingGeneration = createCompactSplitTimingGeneration({
      configs: group.configs,
      env: timingEnv,
      parentShardName: splitTimingParent,
      stripes,
    });
  }
  const completeProfileSeconds =
    runnerBackend === "github" ? completeHostedSeconds : completeBlacksmithSeconds;
  const distributedProfileSeconds = Math.max(profileSeconds, completeProfileSeconds);
  if (tailDonation) {
    onHostedToolingTailDonation?.(tailDonation);
  }
  const legacyCommandTimingKeys = parallelCommands
    ? createCompactSplitTimingGeneration({
        configs: group.configs,
        parentShardName: group.shard_name,
        stripes,
      }).timingKeys
    : [];
  const previousWorkerTimingKeys = previousWorkerGeneration
    ? createCompactSplitTimingGeneration({
        configs: group.configs,
        env: previousWorkerEnv,
        parentShardName: splitTimingParent,
        stripes,
      }).timingKeys
    : [];
  const gatewaySingletonWorkers = parallelGateway ? gatewayServerEffectiveWorkers(group) : 1;
  const serialSeconds = parallelGateway
    ? gatewayServerSerialSeconds(includePatterns, runnerBackend)
    : 0;
  const parallelWeight = includePatterns.reduce(
    (sum, file) => sum + (gatewayServerSerialTestFiles.includes(file) ? 0 : weightForFile(file)),
    0,
  );
  const mixedPhaseSeconds = (patterns: string[]) => {
    const childSerialSeconds = gatewayServerSerialSeconds(patterns, runnerBackend);
    const childParallelWeight = patterns.reduce(
      (sum, file) => sum + (gatewayServerSerialTestFiles.includes(file) ? 0 : weightForFile(file)),
      0,
    );
    if (parallelWeight === 0) {
      return (
        (Math.max(profileSeconds, distributedProfileSeconds) * childSerialSeconds) / serialSeconds
      );
    }
    const fraction = childParallelWeight / parallelWeight;
    const childWorkers = gatewayServerEffectiveWorkers({ ...group, includePatterns: patterns });
    return (
      childSerialSeconds +
      Math.max(
        (Math.max(0, profileSeconds - serialSeconds) * gatewaySingletonWorkers) / childWorkers,
        Math.max(0, distributedProfileSeconds - serialSeconds),
      ) *
        fraction
    );
  };
  const serialChildSeconds = new Map<string, number>();
  const childTimings = readCompactGroupTimings(
    runnerBackend === "github" ? "github" : "blacksmith",
  );
  if (isParallelAgentsCoreGroup(group)) {
    const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...env } = group.env ?? {};
    const legacy = createCompactSplitTimingGeneration({
      configs: group.configs,
      env,
      parentShardName: group.shard_name,
      stripes,
    });
    for (const [key, seconds] of Object.entries(childTimings)) {
      if (parseCompactSplitTimingKey(key)?.selectorKey !== legacy.selectorKey) {
        continue;
      }
      // Unchanged child membership retains its sample when sibling stripes merge.
      const membership = key.slice(key.lastIndexOf("#include-"));
      serialChildSeconds.set(
        membership,
        Math.max(serialChildSeconds.get(membership) ?? 0, seconds),
      );
    }
  }
  return stripes.map((patterns, index) => {
    const timingKey = timingGeneration.timingKeys[index]!;
    const child: NodeTestShardGroup = {
      ...group,
      includePatterns: patterns,
      pretestBuildMode: mergeVitestPretestBuildModes(patterns.map((file) => buildModes.get(file))),
      shard_name: `${group.shard_name}-hosted-${index + 1}`,
      timing_key: timingKey,
    };
    if (isTooling) {
      return {
        group: child,
        seconds: estimateParallelToolingSeconds(child, patterns, runnerBackend),
      };
    }
    if (isParallelAgentsCoreGroup(group) && childTimings[timingKey] !== undefined) {
      return { group: child, seconds: estimateCompactStripeSeconds(child, runnerBackend) };
    }
    const childWorkers = isAutoReplyReplyGroup(child)
      ? compactEffectiveFileWorkers(child, patterns.length)
      : effectiveAgentsCoreWorkers(child);
    const weight = patterns.reduce((seconds, file) => seconds + weightForFile(file), 0);
    const projectedSeconds = parallelGateway
      ? serialSeconds > 0
        ? mixedPhaseSeconds(patterns)
        : (Math.max(
            distributedProfileSeconds,
            patterns.length === 1 ? profileSeconds * gatewaySingletonWorkers : 0,
          ) *
            weight) /
          totalWeight
      : Math.max(
          // Convert parent wall back to work before projecting a child's worker budget.
          // Complete-generation totals already sum child walls and must not be multiplied.
          ((profileSeconds * weight) / totalWeight) * (parentWorkers / childWorkers),
          (completeProfileSeconds * weight) / totalWeight,
          ((serialChildSeconds.get(timingKey.slice(timingKey.lastIndexOf("#include-"))) ?? 0) *
            (runnerBackend === "hybrid" ? COMPACT_HYBRID_GROUP_SECONDS_SCALE : 1)) /
            childWorkers,
        );
    return {
      group: child,
      // Round once at the job boundary; per-child rounding can duplicate a build
      // when many small consumers together still fit one preparation budget.
      seconds: Math.max(
        parallelCommands ? commandFileSecondsFloor(patterns, runnerBackend) : 0,
        legacyCommandTimingKeys[index]
          ? estimateLegacyCommandStripeSeconds(
              patterns,
              legacyCommandTimingKeys[index],
              runnerBackend,
            )
          : 0,
        projectedSeconds,
        previousWorkerTimingKeys[index]
          ? estimateCompactStripeSeconds(
              { ...group, timing_key: previousWorkerTimingKeys[index] },
              runnerBackend,
            )
          : 0,
      ),
    };
  });
}

// Owners supply admission order and compatibility; placement retains the original
// descriptors and never emits an empty job.
export function packNodeTestGroups<Group>(
  orderedGroups: readonly Group[],
  canShareJob: (bin: readonly [Group, ...Group[]], group: Group) => boolean,
  allowGroupExchange = false,
): Array<[Group, ...Group[]]> {
  const bins: Array<[Group, ...Group[]]> = [];
  const admits = ([first, ...rest]: [Group, ...Group[]]) => {
    const admitted: [Group, ...Group[]] = [first];
    for (const entry of rest) {
      if (!canShareJob(admitted, entry)) {
        return false;
      }
      admitted.push(entry);
    }
    return true;
  };
  // A single exchange can free both time and group slots without adding a job.
  // Validate complete replacement bins before changing either existing bin.
  const exchange = (group: Group) => {
    for (const [leftIndex, left] of bins.entries()) {
      for (const right of bins.slice(leftIndex + 1)) {
        for (const [leftSlot, leftGroup] of left.entries()) {
          for (const [rightSlot, rightGroup] of right.entries()) {
            const nextLeft: [Group, ...Group[]] = [...left];
            const nextRight: [Group, ...Group[]] = [...right];
            nextLeft[leftSlot] = rightGroup;
            nextRight[rightSlot] = leftGroup;
            if (!admits(nextLeft) || !admits(nextRight)) {
              continue;
            }
            const target = canShareJob(nextLeft, group)
              ? nextLeft
              : canShareJob(nextRight, group)
                ? nextRight
                : undefined;
            if (target) {
              target.push(group);
              left.splice(0, left.length, ...nextLeft);
              right.splice(0, right.length, ...nextRight);
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  for (const group of orderedGroups) {
    const bin = bins.find((candidate) => canShareJob(candidate, group));
    if (bin) {
      bin.push(group);
    } else if (!allowGroupExchange || !exchange(group)) {
      bins.push([group]);
    }
  }
  return bins;
}

/** Select exact files without losing their canonical process and artifact owners. */
export function createSelectedNodeTestShardBundles(
  targets: readonly string[],
  options: Pick<NodeTestPlanOptions, "runnerBackend"> = {},
): CompactNodeTestShard[] | null {
  const selected = new Set(targets.filter((file) => !isCiProofTestFile(file)));
  const configs = new Map<string, string>();
  for (const target of selected) {
    const plans = buildVitestRunPlans([target]);
    if (
      !isTestFileTarget(target) ||
      !statSync(target, { throwIfNoEntry: false })?.isFile() ||
      plans.length !== 1 ||
      plans[0]!.watchMode ||
      plans[0]!.forwardedArgs.length > 0 ||
      plans[0]!.includePatterns?.length !== 1 ||
      plans[0]!.includePatterns[0] !== target
    ) {
      return null;
    }
    configs.set(target, plans[0]!.config);
  }
  if (selected.size === 0) {
    return targets.length > 0 ? [] : null;
  }
  const tooling = new Set([...selected].filter((target) => configs.get(target) === TOOLING_CONFIG));
  const shards = createNodeTestShardsForOwners(
    fullSuiteVitestShards,
    { includeReleaseOnlyPluginShards: false, includeProofTests: false },
    tooling.size === selected.size,
  );
  const owners = new Set<NodeTestShard>();
  for (const target of tooling) {
    const matches = shards.filter(
      (shard) =>
        shard.configs.length === 1 &&
        shard.configs[0] === TOOLING_CONFIG &&
        shard.includePatterns?.includes(target),
    );
    if (matches.length !== 1) {
      return null;
    }
    owners.add(matches[0]!);
  }
  // Expansion owns multi-config families and fixed stripes. Project its final
  // jobs so narrowing cannot increase workers through serial-job resource scaling.
  const full =
    selected.size > tooling.size
      ? createCompactNodeTestShardBundles(shards, options, "pull-request")
      : [];
  const canonicalGroups = full.flatMap((shard) => shard.groups);
  const isWholeToolingPair = (group: NodeTestShardGroup) =>
    group.shard_name === "core-tooling-isolated" &&
    group.configs.length === 2 &&
    group.configs[0] === "test/vitest/vitest.tooling-docker.config.ts" &&
    group.configs[1] === TOOLING_ISOLATED_CONFIG;
  const selectedGroups = new Map<NodeTestShardGroup, string[]>();
  for (const target of selected) {
    if (tooling.has(target)) {
      continue;
    }
    const matches = canonicalGroups.filter(
      (group) =>
        !group.requiresDist &&
        ((group.configs.includes(configs.get(target)!) &&
          group.configs.some(isExclusiveCiTestConfig)) ||
          (group.configs.length === 1 && group.configs[0] === configs.get(target)) ||
          (isWholeToolingPair(group) && group.configs.includes(configs.get(target)!))) &&
        group.env?.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON === undefined &&
        (!group.includePatterns || group.includePatterns.includes(target)),
    );
    if (matches.length !== 1) {
      return null;
    }
    const owner = matches[0]!;
    selectedGroups.set(owner, [...(selectedGroups.get(owner) ?? []), target]);
  }
  return [
    ...(tooling.size
      ? createCompactNodeTestShardBundles(
          shards.filter((shard) => owners.has(shard) || shard.requiresDist),
          options,
          "pull-request",
          tooling,
        )
      : []),
    ...full.flatMap((shard) => {
      const groups = shard.groups.flatMap((group) => {
        const files = selectedGroups.get(group);
        if (!files?.length) {
          return [];
        }
        // The paired configs share one canonical isolation and timing owner.
        if (isWholeToolingPair(group)) {
          return [group];
        }
        const includePatterns =
          group.includePatterns?.filter((file) => files.includes(file)) ?? files;
        // Refit folds complete selector generations into their parent. Keep that
        // parent separate: a complete subset is not a full-suite observation.
        const { timingKeys } = createCompactSplitTimingGeneration({
          configs: group.configs,
          env: group.env,
          parentShardName: `changed-${group.shard_name}`,
          stripes: [includePatterns],
        });
        return [{ ...group, includePatterns, timing_key: timingKeys[0]! }];
      });
      // Retain the original admission floor and preparation until subset costs
      // have independent measurements; fewer files alone do not price cold imports.
      return groups.length
        ? [
            {
              ...shard,
              checkName: `checks-node-changed-${shard.shardName}`,
              shardName: `changed-${shard.shardName}`,
              groups,
            },
          ]
        : [];
    }),
  ];
}

function createCompactNodeTestShardBundles(
  sourceShards: readonly NodeTestShard[],
  options: NodeTestPlanOptions,
  compactMode: CompactNodeTestPlanMode,
  selectedToolingFiles?: ReadonlySet<string>,
  splitHostedToolingTails = false,
  hostedToolingTailBudgets?: ReadonlyMap<string, number>,
  hostedToolingTailDonation?: HostedToolingTailDonation,
): CompactNodeTestShard[] {
  const compactNodeJobCap = options.compactNodeJobCap ?? COMPACT_NODE_TEST_JOB_CAP;
  if (!Number.isSafeInteger(compactNodeJobCap) || compactNodeJobCap < 1) {
    throw new Error("compact Node job cap must be a positive integer");
  }
  const effectiveJobCap = (bins: readonly (readonly NodeTestShardGroup[])[]) =>
    Math.min(
      COMPACT_NODE_TEST_JOB_CAP,
      compactNodeJobCap + bins.filter((bin) => bin[0]?.requiresDist).length,
    );
  const includeTooling = compactMode !== "push" && includesReleaseOnlyTooling(options);
  const isBlacksmithProfile = (options.runnerBackend ?? "blacksmith") === "blacksmith";
  const packsHostedTooling = compactMode === "pull-request" && options.runnerBackend === "github";
  let bestTailDonation: HostedToolingTailDonation | undefined;
  const collectTailDonation =
    packsHostedTooling && splitHostedToolingTails && !hostedToolingTailDonation
      ? (donation: HostedToolingTailDonation) => {
          if (
            !bestTailDonation ||
            donation.freedSeconds > bestTailDonation.freedSeconds ||
            (donation.freedSeconds === bestTailDonation.freedSeconds &&
              `${donation.parentShardName}/${donation.file}`.localeCompare(
                `${bestTailDonation.parentShardName}/${bestTailDonation.file}`,
              ) < 0)
          ) {
            bestTailDonation = donation;
          }
        }
      : undefined;
  const shards = sourceShards.filter(
    (shard) =>
      (compactMode !== "push" || !COMPACT_PUSH_EXCLUDED_SHARDS.has(shard.shardName)) &&
      (includeTooling ||
        !shard.configs.every((config) => RELEASE_ONLY_TOOLING_CONFIGS.has(config))),
  );
  const groupsByRunner = new Map<string, [NodeTestShardGroup, ...NodeTestShardGroup[]]>();
  const synthesizedSplitSeconds = new Map<string, number>();
  const runnerRank = (group: Pick<NodeTestShardGroup, "runner">) =>
    [BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER, EXTRA_LARGE_NODE_TEST_RUNNER].indexOf(
      group.runner,
    );

  for (const shard of shards) {
    const runner = resolveCiNodeTestRunner(shard);
    const group = applyCompactGroupWorkerPins(
      {
        configs: shard.configs,
        ...(shard.env ? { env: shard.env } : {}),
        ...(shard.includePatterns ? { includePatterns: shard.includePatterns } : {}),
        ...(shard.pretestBuildMode ? { pretestBuildMode: shard.pretestBuildMode } : {}),
        requiresDist: shard.requiresDist,
        runner,
        shard_name: shard.shardName,
      },
      options.runnerBackend,
    );
    const partitionFiles = group.pretestBuildMode
      ? (group.includePatterns ?? listWholeConfigSplitFiles(group.shard_name))
      : undefined;
    const partition = partitionFiles
      ? partitionRuntimeTestFiles(group.configs, partitionFiles)
      : undefined;
    const runtimePartition =
      partition?.runtimeFiles.length && partition.otherFiles.length ? partition : undefined;
    // Resolve whole-config ownership before splitting so ordinary files do not
    // inherit a runtime build. Keep consumers together and split the remaining work.
    let plannedGroups =
      usesExpandedRunnerProfile(options.runnerBackend) ||
      COMPACT_BLACKSMITH_SPLIT_OWNERS.has(group.shard_name) ||
      isParallelGatewayServerGroup(group) ||
      isParallelCommandsGroup(group) ||
      runtimePartition !== undefined ||
      (group.pretestBuildMode !== undefined && group.includePatterns === undefined)
        ? splitOversizedCompactGroup(
            group,
            options.runnerBackend,
            runtimePartition,
            splitHostedToolingTails,
            hostedToolingTailBudgets,
            hostedToolingTailDonation,
            collectTailDonation,
            selectedToolingFiles,
          )
        : [{ group, seconds: estimateCompactGroupSeconds(group, options.runnerBackend) }];
    const reducedToolingTier =
      !includeTooling &&
      plannedGroups.some((planned) =>
        (planned.group.includePatterns ?? mixedToolingTestFiles(planned.group.configs))?.some(
          isReleaseOnlyToolingTestFile,
        ),
      );
    const selectedTooling =
      (selectedToolingFiles && group.configs.includes(TOOLING_CONFIG)) || reducedToolingTier;
    if (selectedTooling) {
      // Keep the parent's admission cost and partition policy, but never report
      // a precise subset as a sample of the complete canonical stripe.
      plannedGroups = plannedGroups.flatMap((planned) => {
        const includePatterns = (
          planned.group.includePatterns ?? mixedToolingTestFiles(planned.group.configs)
        )?.filter(
          (file) =>
            (!selectedToolingFiles || selectedToolingFiles.has(file)) &&
            (includeTooling || !isReleaseOnlyToolingTestFile(file)),
        );
        return includePatterns?.length
          ? [{ ...planned, group: { ...planned.group, includePatterns } }]
          : [];
      });
      const generation = createCompactSplitTimingGeneration({
        configs: group.configs,
        env: group.env,
        parentShardName: reducedToolingTier ? `changed-${group.shard_name}` : group.shard_name,
        stripes: plannedGroups.map((planned) => planned.group.includePatterns!),
      });
      plannedGroups.forEach((planned, index) => {
        planned.group.timing_key = generation.timingKeys[index]!;
      });
    }
    for (const planned of plannedGroups) {
      planned.group.runner = resolveCiNodeTestRunner(
        {
          ...shard,
          includePatterns: planned.group.includePatterns,
        },
        options.runnerBackend ?? "blacksmith",
      );
      // Hosted jobs keep the strongest declared owner; smaller ordinary groups
      // can fill that capacity without changing their process or worker policy.
      const sharesHostedCapacity =
        options.runnerBackend === "github" &&
        !planned.group.requiresDist &&
        !isExclusiveCompactGroup(planned.group) &&
        runnerRank(planned.group) >= 0;
      const key = JSON.stringify([
        sharesHostedCapacity ? "hosted-ordinary" : planned.group.runner,
        shard.requiresDist,
      ]);
      const groups = groupsByRunner.get(key);
      if (groups) {
        groups.push(planned.group);
      } else {
        groupsByRunner.set(key, [planned.group]);
      }
      // The splitter retains parent floors unless an agents-core child has its
      // own parallel measurement. Membership changes cannot reuse that sample.
      if (
        selectedTooling ||
        isParallelCommandsGroup(group) ||
        planned.group.shard_name !== group.shard_name
      ) {
        synthesizedSplitSeconds.set(compactGroupTimingKey(planned.group), planned.seconds);
      }
    }
  }

  // Packing revisits immutable groups; prepare their cost and family once.
  // Keep facts within this plan's timing inputs and partitions.
  const stripeFacts = new Map<
    NodeTestShardGroup,
    { seconds: number; family: string | undefined }
  >();
  const prepareStripe = (group: NodeTestShardGroup) => {
    let facts = stripeFacts.get(group);
    if (!facts) {
      facts = {
        seconds: Math.max(
          synthesizedSplitSeconds.get(compactGroupTimingKey(group)) ?? 0,
          estimateCompactStripeSeconds(group, options.runnerBackend),
        ),
        family: compactStripeFamily(group),
      };
      stripeFacts.set(group, facts);
    }
    return facts;
  };
  const estimateStripeSeconds = (group: NodeTestShardGroup) => prepareStripe(group).seconds;
  const estimateBinSeconds = (groups: NodeTestShardGroup[]) => {
    const mode = mergeVitestPretestBuildModes(groups.map((group) => group.pretestBuildMode));
    const buildSeconds = mode ? VITEST_PRETEST_BUILD_SECONDS[mode] : 0;
    return (
      groups.reduce((seconds, group) => seconds + estimateStripeSeconds(group), 0) +
      Math.round(
        buildSeconds *
          (options.runnerBackend === "github" ? COMPACT_GITHUB_GROUP_SECONDS_SCALE : 1),
      )
    );
  };
  const isHostedToolingGroup = (group: NodeTestShardGroup) =>
    !group.requiresDist &&
    group.pretestBuildMode === undefined &&
    /^core-tooling-\d+-hosted-\d+$/u.test(group.shard_name) &&
    group.configs.includes(TOOLING_CONFIG) &&
    runnerRank(group) >= 0;
  const hasDistinctStripeFamilies = (groups: NodeTestShardGroup[]) => {
    const families = groups
      .map((group) => prepareStripe(group).family)
      .filter((family): family is string => family !== undefined);
    return new Set(families).size === families.length;
  };
  const admitsCompactBin = (
    groups: NodeTestShardGroup[],
    secondsCap: number,
    seconds = estimateBinSeconds,
    { sharedFamily = false, parallel = false } = {},
  ) =>
    groups.length > 0 &&
    (sharedFamily || hasDistinctStripeFamilies(groups)) &&
    (parallel || groups.length <= COMPACT_NODE_TEST_JOB_GROUPS) &&
    seconds(groups) <= secondsCap;
  const usesBlacksmithCapacity = (runner: string) =>
    isBlacksmithProfile ||
    (options.runnerBackend === "hybrid" &&
      [DEFAULT_NODE_TEST_RUNNER, BUNDLED_NODE_TEST_RUNNER, EXTRA_LARGE_NODE_TEST_RUNNER].includes(
        runner,
      ));
  const hostedToolingGroups: NodeTestShardGroup[] = [];
  let packedBins = [...groupsByRunner.values()].flatMap((groups) => {
    const usesBlacksmithRunner = usesBlacksmithCapacity(groups[0].runner);
    // Admit the final groups with their shared prerequisite. Rebalancing after
    // this check can break build sharing and exceed a bin's admitted cap.
    const sortedGroups = groups
      .flatMap((group) => expandCompactGroup(group, options.runnerBackend))
      .toSorted(
        (a, b) =>
          estimateBinSeconds([b]) - estimateBinSeconds([a]) ||
          runnerRank(b) - runnerRank(a) ||
          a.shard_name.localeCompare(b.shard_name),
      );
    // Hosted inventory must not influence non-hosted anchor membership.
    const anchorGroups = packsHostedTooling
      ? sortedGroups.filter((group) => !isHostedToolingGroup(group))
      : sortedGroups;
    if (packsHostedTooling) {
      hostedToolingGroups.push(...sortedGroups.filter(isHostedToolingGroup));
    }
    const canShareCompactJob = (
      candidate: readonly [NodeTestShardGroup, ...NodeTestShardGroup[]],
      group: NodeTestShardGroup,
    ) => {
      const exclusive = isExclusiveCompactGroup(group);
      // Keep ordinary work off serial runtime hosts. Hybrid exclusive/dist bins
      // retain their existing prerequisite sharing and admission policy.
      if (
        (isBlacksmithProfile || (usesBlacksmithRunner && !exclusive && !group.requiresDist)) &&
        Boolean(candidate[0].pretestBuildMode) !== Boolean(group.pretestBuildMode)
      ) {
        return false;
      }
      const combined = [...candidate, group];
      // Spend the larger budget only on a complete no-build CLI bin. Each child
      // keeps its 150s admission limit, worker budget and separate process.
      const sharesSerialCliBudget =
        options.runnerBackend === "hybrid" &&
        combined.every(
          (entry) =>
            !entry.requiresDist &&
            !entry.pretestBuildMode &&
            /^agentic-cli(?:-process-hosted-\d+)?$/u.test(entry.shard_name) &&
            estimateBinSeconds([entry]) <= COMPACT_EXCLUSIVE_JOB_SECONDS,
        );
      // Hosted preparation exceeds the exclusive test budget by itself. Share
      // that build within the normal serial budget while keeping no-build work separate.
      const sharesHostedBuild =
        options.runnerBackend === "github" &&
        combined.every((entry) => entry.pretestBuildMode !== undefined && !entry.requiresDist);
      const serialSecondsCap = sharesSerialCliBudget
        ? COMPACT_HYBRID_SERIAL_CLI_JOB_SECONDS
        : exclusive && !sharesHostedBuild
          ? COMPACT_EXCLUSIVE_JOB_SECONDS
          : usesExpandedRunnerProfile(options.runnerBackend)
            ? COMPACT_EXPANDED_NODE_TEST_JOB_SECONDS
            : resolveCiNodeTestRunnerClass(group.runner).secondsCap;
      const parallel =
        usesBlacksmithRunner &&
        combined.every(isParallelCompactGroup) &&
        combined.every((entry) => estimateBinSeconds([entry]) <= serialSecondsCap);
      const secondsCap = parallel ? COMPACT_PARALLEL_NODE_TEST_JOB_SECONDS : serialSecondsCap;
      return (
        isExclusiveCompactGroup(candidate[0]) === exclusive &&
        admitsCompactBin(combined, secondsCap, estimateBinSeconds, {
          sharedFamily: sharesSerialCliBudget,
          parallel,
        })
      );
    };
    const bins = packNodeTestGroups(anchorGroups, canShareCompactJob, packsHostedTooling);
    if (options.runnerBackend === "github") {
      for (const bin of bins) {
        bin.sort((a, b) => runnerRank(b) - runnerRank(a));
      }
    }
    bins.sort(
      (a, b) => Number(isExclusiveCompactGroup(a[0])) - Number(isExclusiveCompactGroup(b[0])),
    );
    return bins;
  });
  const canShareHostedGroup = (candidate: NodeTestShardGroup[], group: NodeTestShardGroup) => {
    const owner = candidate[0];
    const combined = [...candidate, group];
    return (
      owner !== undefined &&
      ((owner.runner === group.runner && owner.requiresDist === group.requiresDist) ||
        (combined.every(isHostedToolingGroup) && runnerRank(owner) > runnerRank(group))) &&
      isExclusiveCompactGroup(owner) === isExclusiveCompactGroup(group) &&
      candidate.length < COMPACT_NODE_TEST_JOB_GROUPS &&
      hasDistinctStripeFamilies(combined)
    );
  };
  if (packsHostedTooling) {
    const anchors = packedBins;
    const hostedGroups = hostedToolingGroups.toSorted(
      (a, b) =>
        runnerRank(b) - runnerRank(a) ||
        estimateBinSeconds([b]) - estimateBinSeconds([a]) ||
        a.shard_name.localeCompare(b.shard_name),
    );
    const strongestGroupCount =
      hostedGroups.findLastIndex((group) => group.runner === hostedGroups[0]!.runner) + 1;
    type HostedUnit = [NodeTestShardGroup, ...NodeTestShardGroup[]];
    const units = [
      ...hostedGroups.slice(0, strongestGroupCount).map((group) => [group]),
      ...anchors,
      ...hostedGroups.slice(strongestGroupCount).map((group) => [group]),
    ] as HostedUnit[];
    const canShareHostedUnit = (
      candidate: readonly [HostedUnit, ...HostedUnit[]],
      unit: HostedUnit,
    ) =>
      isHostedToolingGroup(unit[0]) &&
      canShareHostedGroup(candidate.flat(), unit[0]) &&
      estimateBinSeconds([...candidate.flat(), unit[0]]) <= COMPACT_EXCLUSIVE_JOB_SECONDS;
    packedBins = packNodeTestGroups(units, canShareHostedUnit).map(
      (bin) => bin.flat() as HostedUnit,
    );
    // Preserve successful plans; compare one alternate only after tail splitting still overflows.
    if (splitHostedToolingTails && packedBins.length > effectiveJobCap(packedBins)) {
      const alternateUnits = [
        ...anchors,
        ...hostedGroups
          .toSorted(
            (a, b) =>
              estimateBinSeconds([b]) - estimateBinSeconds([a]) ||
              runnerRank(b) - runnerRank(a) ||
              a.shard_name.localeCompare(b.shard_name),
          )
          .map((group) => [group]),
      ] as HostedUnit[];
      const alternateBins = packNodeTestGroups(alternateUnits, canShareHostedUnit).map(
        (bin) => bin.flat() as HostedUnit,
      );
      if (alternateBins.length < packedBins.length) {
        packedBins = alternateBins;
      }
    }
  }

  const compactJobs: CompactNodeTestShard[] = [];
  const nextJobIndexByClass = new Map<string, number>();
  for (const bin of packedBins) {
    const [firstGroup] = bin;
    const { name: runnerClass } = resolveCiNodeTestRunnerClass(firstGroup.runner);
    const distSuffix = firstGroup.requiresDist ? "-dist" : "";
    const jobClass = `${runnerClass}${distSuffix}`;
    const jobIndex = (nextJobIndexByClass.get(jobClass) ?? 0) + 1;
    nextJobIndexByClass.set(jobClass, jobIndex);
    const checkName = `checks-node-compact-${jobClass}-${jobIndex}`;
    const runner = firstGroup.runner;
    const pretestBuildMode = mergeVitestPretestBuildModes(
      bin.map((group) => group.pretestBuildMode),
    );
    // The runner admits overlap only after measuring capacity; exclusive and
    // runtime-building jobs stay serial regardless of the requested class.
    const planConcurrency =
      usesBlacksmithCapacity(firstGroup.runner) &&
      bin.length > 1 &&
      bin.every(isParallelCompactGroup)
        ? 2
        : 1;
    // Tooling and the full CLI need host capacity while keeping serial isolation.
    // Promote only the emitted runner so packing, names and timing keys stay stable.
    const capacityRunner =
      runner === EXTRA_LARGE_NODE_TEST_RUNNER ||
      planConcurrency === 2 ||
      (isBlacksmithProfile && bin.some((group) => group.configs.includes(TOOLING_CONFIG))) ||
      (options.runnerBackend === "hybrid" &&
        usesBlacksmithCapacity(runner) &&
        bin.some((group) =>
          group.includePatterns?.some((file) => TOOLING_DECLARATION_COMPILER_TEST_FILES.has(file)),
        )) ||
      (usesBlacksmithCapacity(runner) && bin.some((group) => group.shard_name === "agentic-cli"))
        ? EXTRA_LARGE_NODE_TEST_RUNNER
        : runner;
    compactJobs.push({
      checkName,
      groups: bin,
      ...(pretestBuildMode ? { pretestBuildMode } : {}),
      requiresDist: firstGroup.requiresDist,
      runner: capacityRunner,
      shardName: `compact-${jobClass}-${jobIndex}`,
      // Whole-config groups run entire suites; keep their generous timeout.
      ...(bin.some((group) => !group.includePatterns)
        ? { timeoutMinutes: COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES }
        : {}),
      planConcurrency,
      predictedSeconds: Math.ceil(estimateBinSeconds(bin)),
    });
  }

  const compactJobCap = effectiveJobCap(packedBins);
  if (packsHostedTooling && compactJobs.length > compactJobCap) {
    if (!splitHostedToolingTails) {
      // Repartition once at the file owner so timing identities and build costs
      // describe the smaller tails before the same admission checks pack them.
      return createCompactNodeTestShardBundles(
        sourceShards,
        options,
        compactMode,
        selectedToolingFiles,
        true,
      );
    }
    if (hostedToolingTailBudgets === undefined && hostedToolingTailDonation === undefined) {
      // Repartition only stranded tails to fit capacity left by compatible owners.
      // File ownership and timing identities are rebuilt before normal admission.
      const tailBudgets = new Map<string, number>();
      for (const group of packedBins.slice(compactJobCap).flat()) {
        if (!isHostedToolingGroup(group) || (group.includePatterns?.length ?? 0) < 2) {
          continue;
        }
        const available = Math.max(
          0,
          ...packedBins
            .filter((candidate) => canShareHostedGroup(candidate, group))
            .map((candidate) => COMPACT_EXCLUSIVE_JOB_SECONDS - estimateBinSeconds(candidate)),
        );
        if (available > 0) {
          tailBudgets.set(group.shard_name.replace(/-hosted-\d+$/u, ""), available);
        }
      }
      if (tailBudgets.size > 0) {
        return createCompactNodeTestShardBundles(
          sourceShards,
          options,
          compactMode,
          selectedToolingFiles,
          true,
          tailBudgets,
        );
      }
    }
    if (bestTailDonation) {
      // One largest safe donation opens donor capacity without changing the family selector.
      return createCompactNodeTestShardBundles(
        sourceShards,
        options,
        compactMode,
        selectedToolingFiles,
        true,
        hostedToolingTailBudgets,
        bestTailDonation,
      );
    }
  }

  // Settle Gateway admission before runtime placement reads the recipient's policy.
  for (const job of compactJobs) {
    if (
      job.planConcurrency !== 2 ||
      !job.groups.some((group) => group.configs.some(isExclusiveCiTestConfig))
    ) {
      continue;
    }
    // Keep packed jobs and their summed time budgets; Gateway boots own the host
    // serially. Preserve the previous two-worker ceiling during runtime placement.
    job.planConcurrency = 1;
    job.env = { ...job.env, ...PINNED_COMPACT_GROUP_ENV };
  }

  // Only the public complete-plan entry normalizes this option. Precise plans
  // retain their original template capacity before projecting selected files.
  if (options.runnerBackend === "hybrid" && options.compactMode !== undefined) {
    const timings = readRuntimePlacementTimings("blacksmith");
    const placementJobs = compactJobs.filter(
      (job) =>
        job.pretestBuildMode !== "private-qa" &&
        !job.requiresDist &&
        runnerRank(job) >= 0 &&
        job.groups.every(
          (group) => group.pretestBuildMode !== "private-qa" && !isExclusiveCompactGroup(group),
        ),
    );
    const measured = (group: NodeTestShardGroup) => resolveRuntimePlacementSeconds(group, timings);
    if (placementJobs.some((job) => job.groups.some((group) => measured(group) !== undefined))) {
      // Observe complete existing envelopes only after splitting/packing. These
      // floors cannot feed a runtime cost back into ordinary stripe generation.
      const cost = (groups: NodeTestShardGroup[]) =>
        VITEST_PRETEST_BUILD_SECONDS.runtime +
        groups.reduce(
          (total, group) =>
            total +
            Math.max(
              estimateStripeSeconds(group),
              isParallelCommandsGroup(group) || measured(group) === undefined
                ? estimateCompactGroupSeconds(group, "hybrid")
                : Math.round(measured(group)! * COMPACT_HYBRID_GROUP_SECONDS_SCALE),
            ),
          0,
        );
      const admits = (groups: NodeTestShardGroup[]) =>
        admitsCompactBin(groups, COMPACT_HYBRID_RUNTIME_JOB_SECONDS, cost);
      const prepareRecipient = (job: CompactNodeTestShard) => {
        if (job.planConcurrency !== 2) {
          return job.groups;
        }
        if (
          job.groups.some(
            (group) =>
              group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined &&
              !isParallelCommandsGroup(group) &&
              !isRuntimePlacementIncludePatterns(group.includePatterns),
          )
        ) {
          return undefined;
        }
        // Preserve the executed allowance and its prepared timing identity.
        // Re-keying an equivalent cap would break a complete parent generation.
        return job.groups.map((group) =>
          group.env?.OPENCLAW_VITEST_MAX_WORKERS !== undefined || isParallelCommandsGroup(group)
            ? group
            : Object.assign({}, group, { env: { ...group.env, ...PINNED_COMPACT_GROUP_ENV } }),
        );
      };
      rebalanceRuntimeTestJobs(placementJobs, { cost, admits, runnerRank, prepareRecipient });
    }
  }

  for (const job of compactJobs) {
    if (
      job.env?.OPENCLAW_VITEST_MAX_WORKERS !== "2" ||
      !job.groups.some((group) => usesMeasuredCompactWorkers(group, options.runnerBackend))
    ) {
      continue;
    }
    // Finish placement before moving the job cap onto every unproven sibling,
    // including donated runtime groups. Measured groups retain their own worker limits.
    const { OPENCLAW_VITEST_MAX_WORKERS: _workers, ...env } = job.env;
    job.env = Object.keys(env).length > 0 ? env : undefined;
    job.groups = job.groups.map((group) =>
      usesMeasuredCompactWorkers(group, options.runnerBackend)
        ? group
        : Object.assign({}, group, {
            env: {
              ...group.env,
              OPENCLAW_VITEST_MAX_WORKERS: String(
                Math.min(2, Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 2)),
              ),
            },
          }),
    );
  }

  // Larger initial bins change which groups reach serial Gateway/runtime rows.
  // Freeze those settled rows; only already-overlapping jobs can share more work.
  const parallelJobs: CompactNodeTestShard[] = [];
  for (const job of compactJobs) {
    if (
      job.planConcurrency !== 2 ||
      job.runner !== EXTRA_LARGE_NODE_TEST_RUNNER ||
      !usesBlacksmithCapacity(job.runner) ||
      job.pretestBuildMode ||
      job.requiresDist ||
      !job.groups.every(isParallelCompactGroup) ||
      job.groups.some((group) => group.configs.some(isExclusiveCiTestConfig))
    ) {
      continue;
    }
    parallelJobs.push(job);
  }
  const retiredJobs = new Set<CompactNodeTestShard>();
  if (parallelJobs.length > 1) {
    const groups = parallelJobs
      .flatMap((job) => job.groups)
      .toSorted(
        (a, b) =>
          estimateStripeSeconds(b) - estimateStripeSeconds(a) ||
          a.shard_name.localeCompare(b.shard_name),
      );
    const bins = packNodeTestGroups(groups, (candidate, group) =>
      admitsCompactBin(
        [...candidate, group],
        COMPACT_FINAL_PARALLEL_NODE_TEST_JOB_SECONDS,
        estimateBinSeconds,
        { parallel: true },
      ),
    );
    if (bins.length < parallelJobs.length) {
      parallelJobs.forEach((job, index) => {
        const bin = bins[index];
        if (!bin) {
          retiredJobs.add(job);
          return;
        }
        job.groups = bin;
        job.predictedSeconds = Math.ceil(estimateBinSeconds(bin));
        job.planConcurrency = bin.length > 1 ? 2 : 1;
        job.timeoutMinutes = bin.some((group) => !group.includePatterns)
          ? COMPACT_WHOLE_NODE_TEST_TIMEOUT_MINUTES
          : undefined;
        if (bin.length === 1) {
          // Losing a sibling must not increase this child's previous worker allowance.
          job.env = { ...job.env, ...PINNED_COMPACT_GROUP_ENV };
        }
      });
    }
  }
  const finalJobs = compactJobs.filter((job) => !retiredJobs.has(job));
  if (finalJobs.length > compactJobCap) {
    throw new Error(
      `compact ${options.runnerBackend ?? "blacksmith"} node test plan exceeds ${compactJobCap} jobs (${finalJobs.length} planned)`,
    );
  }
  for (const job of finalJobs) {
    // The 4/8 classes both deliver two CPUs. Routing must not alter placement anchors.
    if (usesBlacksmithCapacity(job.runner) && job.runner === BUNDLED_NODE_TEST_RUNNER) {
      job.runner = DEFAULT_NODE_TEST_RUNNER;
    }
  }

  // Split/packing admission retains the two-worker retry budget. Once placement
  // settles, price commands at the allocation that the executor can actually use.
  // The observed 32-class supplies 8 CPUs / 30.95 GiB; smaller classes and
  // overlapping plans take H2's two-worker fallback. Live pressure can reduce it.
  for (const job of finalJobs) {
    const workers =
      job.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
      job.planConcurrency === 1 &&
      job.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined &&
      options.runnerBackend !== "github"
        ? 8
        : 2;
    let savedSeconds = 0;
    job.groups = job.groups.map((group) => {
      if (!isParallelCommandsGroup(group)) {
        return group;
      }
      const previousSeconds = estimateStripeSeconds(group);
      const adjusted = estimateCommandWorkerSeconds(
        group,
        previousSeconds,
        workers,
        options.runnerBackend,
      );
      savedSeconds += previousSeconds - adjusted.seconds;
      return { ...group, timing_key: adjusted.timingKey };
    });
    job.predictedSeconds = Math.ceil(job.predictedSeconds! - savedSeconds);
  }

  return finalJobs.toSorted((a, b) => a.checkName.localeCompare(b.checkName));
}
