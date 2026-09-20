import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { pluginContractPatterns } from "../../test/vitest/vitest.contracts-paths.mjs";
import { isDatabaseWorkerExtensionRoot } from "../../test/vitest/vitest.extension-database-workers-paths.mjs";
import {
  isPluginControlUiPath,
  isUiBrowserTestFile,
  isUiTestTarget,
} from "../../test/vitest/vitest.ui-paths.mjs";
import { isBoundaryTestFile } from "../../test/vitest/vitest.unit-paths.mjs";
import { detectChangedLanes } from "../changed-lanes.mts";
import {
  buildVitestRunPlans,
  CHANNEL_CONTRACT_CONFIG_PATTERNS,
  CONTRACTS_PLUGIN_VITEST_CONFIG,
  findUnmatchedExplicitTestTargets,
  hasImportGraphConsumers,
  hasImportGraphImpactOnTargets,
  isTestFileTarget,
  resolveChangedTestTargetPlan,
  UI_E2E_VITEST_CONFIG,
} from "../test-projects.test-support.mts";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { isTestOnlyPath } from "./changed-path-facts.mjs";
import {
  createNodeTestShards,
  createSelectedNodeTestShardBundles,
  isPolicyTestOwnedPath,
  packNodeTestGroups,
  resolvePolicyTestTargets,
  type NodeTestShardGroup,
} from "./ci-node-test-plan.mts";
import {
  NATIVE_DATABASE_WORKER_TEST_JOB_FILE_LIMIT,
  estimateExtensionTestCost,
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
  shouldSplitExtensionTestProcesses,
  splitExtensionTestJobTargets,
} from "./extension-test-plan.mts";
import { isExclusiveCiTestConfig } from "./local-check-runtime.mts";
import { buildPluginSdkEntrySources, publicPluginSdkEntrypoints } from "./plugin-sdk-entries.mts";
import {
  resolveVitestPretestBuildMode,
  type VitestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "./vitest-shard-metadata.mts";

// The trusted CI harness loads this export from the selected target revision.
export { resolveChangedDockerSeedLanes } from "./ci-docker-seed-plan.mts";

type ChangedNodeTestShard = {
  checkName: string;
  configs: string[];
  groups?: NodeTestShardGroup[];
  env?: Record<string, string>;
  includePatterns?: string[];
  planConcurrency?: number;
  predictedSeconds?: number;
  pretestBuildMode?: VitestPretestBuildMode;
  requiresDist: boolean;
  runner: string;
  shardName: string;
  targets?: string[];
  timeoutMinutes?: number;
};
type ChangedExtensionConfigShard = ChangedNodeTestShard & { predictedSeconds: number };
type CwdOptions = { cwd?: string };

/** Ordinary UI unit entries retain their unit owner; fixtures and their consumers retain E2E. */
export function hasUiE2eAffectingChange(changedPaths: string[], options: CwdOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some(
      (file) =>
        !file.startsWith("ui/src/") ||
        !isUiTestTarget(file) ||
        /\.(?:browser|node)\.test\.ts$/u.test(file) ||
        /(?:^|\/)(?:e2e|test-helpers|test-fixtures|fixtures|__fixtures__)(?:\/|$)/u.test(file) ||
        path.posix.normalize(file) !== file ||
        !existsSync(path.join(cwd, file)) ||
        !lstatSync(path.join(cwd, file)).isFile(),
    )
  ) {
    return true;
  }
  // Test entry names are not enough: a fixture or application may import one.
  // Reuse the canonical import graph rather than orphaning that consumer's proof.
  return hasImportGraphConsumers(changedPaths, cwd, { tooling: true });
}

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const MAX_CHANGED_NODE_TEST_TARGETS = 96;
// Each target runs in its own child process (isolation contract), so bound the
// serial tail per job; the shard runner overlaps two children at a time.
const CHANGED_NODE_TEST_TARGETS_PER_JOB = 12;
const CHANGED_EXTENSION_JOB_SECONDS = 240;
const MAX_CHANGED_EXTENSION_FALLBACK_JOBS = 50;
// Memory Core targets perform real SQLite/indexing work. Two concurrent Vitest
// processes starve each other on 4-vCPU runners and push otherwise healthy
// integration tests past the global timeout.
const SERIAL_CHANGED_TARGET_RE = /^extensions\/memory-core\//u;
const BOUNDARY_NODE_TEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const publicPluginSdkEntrySources = Object.values(
  buildPluginSdkEntrySources(publicPluginSdkEntrypoints),
);

const fullNodeTestShards = createNodeTestShards({
  includeReleaseOnlyPluginShards: false,
});
const configsRequiringCanonicalMetadata = new Set(
  fullNodeTestShards
    .filter(
      (shard) =>
        shard.env ||
        shard.shardName.startsWith("core-tooling") ||
        shard.configs.some(isExclusiveCiTestConfig),
    )
    .flatMap((shard) => shard.configs),
);
const splitNodeTestConfigs = new Set(
  fullNodeTestShards.filter((shard) => shard.includePatterns).flatMap((shard) => shard.configs),
);

// Inputs `build:ci-artifacts` consumes: runtime/plugin/package sources plus
// the build pipeline itself, including shared declaration publication and cache owners.
// Built-artifact test inputs below also require this lane even though they do
// not change the bytes under test.
const BUILD_INPUT_RE =
  /^(?:src|extensions|packages)\/|^(?:openclaw\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|^tsconfig[^/]*\.json$|^tsdown(?:\.[^/]+)?\.config\.ts$|^scripts\/(?:build-[^/]+|runtime-postbuild\.mts|tsdown-build\.mts|write-(?:plugin-sdk|unified)-entry-dts\.ts)$|^scripts\/lib\/(?:copy-assets\.ts|plugin-sdk-entries\.mts|(?:build-artifact-cache|compiler-input-snapshot|declaration-stage|tsdown-[^/]+)\.mts)$/u;
const BUILT_ARTIFACT_TEST_INPUTS = new Set([
  "extensions/browser/chrome-extension/relay-key.test-support.ts",
  "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
  "extensions/browser/src/browser/extension-install.test-support.ts",
]);

/**
 * True when a changed path can influence built dist/packaging bytes: a
 * non-test build-input source, build pipeline, or built-artifact test input.
 * Diffs entirely outside that set (ordinary tests, repo scripts, workflows) let the
 * manifest skip the build-artifacts lane.
 */
export function hasBuildArtifactAffectingChange(changedPaths: string[]) {
  return changedPaths.some(
    (changedPath) =>
      BUILT_ARTIFACT_TEST_INPUTS.has(changedPath) ||
      (BUILD_INPUT_RE.test(changedPath) && !isTestOnlyPath(changedPath)),
  );
}

// QA-owned surfaces that keep the smoke lane on PRs and main: the qa-lab
// harness and scenario data, the two channels the smoke profile drives
// (matrix, telegram), the packaged-CLI docker packaging scripts, and the QA
// lane's own orchestration (this planner, the CI workflow, composite
// actions) — changes to the gate must not be able to skip the gated lane.
const QA_SMOKE_SURFACE_RE =
  /^(?:extensions\/(?:matrix|qa-lab|telegram)|qa)\/|^scripts\/(?:build-all\.mts|package-openclaw-for-docker\.mts)$|^scripts\/lib\/ci-changed-node-test-plan\.mts$|^\.github\/(?:workflows\/ci\.yml$|actions\/)/u;

/**
 * Broad runtime changes deliberately wait for manual/release validation;
 * automatic PR and main runs select the same QA-owned surfaces.
 */
export function hasQaSmokeAffectingChange(changedPaths: string[]) {
  return changedPaths.some((changedPath) => QA_SMOKE_SURFACE_RE.test(changedPath));
}

// Workspace package specifiers and generated plugin browser entries are not
// relative graph edges, so retain those inputs explicitly.
const CONTROL_UI_PERFORMANCE_SURFACE_RE =
  /^(?:ui|packages|patches)\/|^extensions\/[^/]+\/browser(?:\/|$)|^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|node-version\.mjs|tsconfig[^/]*\.json)$|^scripts\/(?:check-control-ui-(?:performance(?:-base)?|precompressed-assets)\.mts|ui\.(?:mts|js)|tsx\.mjs|lib\/ci-changed-node-test-plan\.mts)$|^config\/control-ui-startup-budget-baseline\.json$|^\.github\/(?:workflows\/ci\.yml$|actions\/(?:setup-node-env|setup-pnpm-store-cache)\/)/u;

export function hasControlUiPerformanceAffectingChange(
  changedPaths: string[],
  options: CwdOptions = {},
) {
  const sources = changedPaths.filter((file) => !isTestOnlyPath(file));
  if (sources.some((file) => CONTROL_UI_PERFORMANCE_SURFACE_RE.test(file))) {
    return true;
  }
  return hasImportGraphImpactOnTargets(
    sources,
    (file) =>
      (file.startsWith("ui/") && !isTestOnlyPath(file)) ||
      /^scripts\/(?:check-control-ui-(?:performance(?:-base)?|precompressed-assets)\.mts|tsx\.mjs)$/u.test(
        file,
      ),
    options.cwd ?? process.cwd(),
    { tooling: true },
  );
}

// Surfaces the prompt-snapshot check exercises outside its generator's
// relative import graph: the snapshot fixtures and generator scripts, the
// codex extension (its test API loads through a dynamic bundled-plugin module
// id the graph walk cannot see), and the gate's own orchestration — changes
// to the gate must not be able to skip the gated lane.
const PROMPT_SNAPSHOT_SURFACE_RE =
  /^(?:test\/(?:helpers\/agents|fixtures\/agents\/prompt-snapshots)|extensions\/codex|packages)\/|^scripts\/(?:generate-prompt-snapshots\.ts|prompt-snapshot-files\.[cm]?[jt]s)$|^scripts\/lib\/ci-changed-node-test-plan\.mts$|^\.github\/(?:workflows\/ci\.yml$|actions\/)|^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;
// The generator renders real prompt-layer stacks, so its runtime blast radius
// is the snapshot helper's import graph (auto-reply prompts, channel typing,
// plugin-sdk agent harness, codex catalog fixtures).
const PROMPT_SNAPSHOT_ENTRY = "test/helpers/agents/happy-path-prompt-snapshots.ts";

// The fallback planner and chunk-policy owner are part of the gate surface; changes to the
// gate must not be able to skip the gated lane (#124412).
const CORE_EXTENSION_IMPACT_SURFACE_RE =
  /^scripts\/lib\/(?:changed-extensions|ci-changed-node-test-plan|extension-test-plan)\.mts$/u;

/**
 * True when a changed path can influence generated prompt snapshots: it
 * touches the snapshot surface directly, or the generator's import graph
 * reaches it. Diffs outside both cannot change generator output, so the
 * manifest may skip the check lane.
 */
export function hasPromptSnapshotAffectingChange(changedPaths: string[], options: CwdOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (changedPaths.some((changedPath) => PROMPT_SNAPSHOT_SURFACE_RE.test(changedPath))) {
    return true;
  }
  const sourcePaths = changedPaths.filter(
    (changedPath) => changedPath.startsWith("src/") && !isTestFileTarget(changedPath),
  );
  if (sourcePaths.length === 0) {
    return false;
  }
  // Deleted sources cannot be graphed; fail safe to running the check.
  if (sourcePaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
    return true;
  }
  return hasImportGraphImpactOnTargets(sourcePaths, [PROMPT_SNAPSHOT_ENTRY], cwd);
}

// The lifecycle proof crosses dynamic Gateway method registration, doctor
// migrations, shared session coordination, the public session SDK, and the
// built CLI. Keep those owners on the direct surface; use the import graph only
// inside the embedded-runner neighborhood, whose session reachability is not
// apparent from filenames.
const SQLITE_SESSION_LIFECYCLE_PREFIX_RE =
  /^(?:src\/(?:agents\/(?:sessions\/|[^/]*(?:session|transcript|compaction)[^/]*)|commands\/doctor-session-|config\/sessions\/|gateway\/(?:agent-turn\/agent-session-persist|server-chat\.(?:load-gateway-session-row|persist-session-lifecycle)|server-methods\/sessions|server\.sessions|session-|sessions-)|plugin-sdk\/session-|sessions\/|state\/openclaw-agent-(?:db|schema))|\.github\/actions\/setup-node-env\/)/u;
const SQLITE_SESSION_LIFECYCLE_EXACT_RE =
  /^(?:src\/config\/sessions\.ts|test\/helpers\/(?:openclaw-test-instance|sqlite-sessions-transcripts-flip-proof(?:-assertions)?)\.ts|test\/scripts\/(?:sqlite-sessions-transcripts-flip-proof(?:\.built-cli)?\.e2e\.test|vitest-e2e-global-setup\.test)\.ts|test\/vitest\/vitest\.e2e\.(?:config|global-setup)\.ts|scripts\/lib\/ci-changed-node-test-plan\.mts|\.github\/workflows\/ci\.yml|openclaw\.mjs|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;
const SQLITE_SESSION_LIFECYCLE_ENTRY =
  "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts";
const SQLITE_SESSION_LIFECYCLE_IMPORT_CANDIDATE_RE = /^src\/agents\/embedded-agent-runner\/run\//u;

/**
 * True when a changed path touches a SQLite session lifecycle owner or reaches
 * the proof from the embedded-runner neighborhood.
 */
export function hasSqliteSessionLifecycleAffectingChange(
  changedPaths: string[],
  options: CwdOptions = {},
) {
  const cwd = options.cwd ?? process.cwd();
  if (
    changedPaths.some(
      (changedPath) =>
        (!isTestFileTarget(changedPath) && SQLITE_SESSION_LIFECYCLE_PREFIX_RE.test(changedPath)) ||
        SQLITE_SESSION_LIFECYCLE_EXACT_RE.test(changedPath),
    )
  ) {
    return true;
  }
  const sourcePaths = changedPaths.filter(
    (changedPath) =>
      SQLITE_SESSION_LIFECYCLE_IMPORT_CANDIDATE_RE.test(changedPath) &&
      !isTestFileTarget(changedPath),
  );
  // Deleted sources cannot be graphed; fail safe to running the lifecycle proof.
  if (sourcePaths.some((changedPath) => !existsSync(path.join(cwd, changedPath)))) {
    return true;
  }
  if (sourcePaths.length === 0) {
    return false;
  }
  return hasImportGraphImpactOnTargets(sourcePaths, [SQLITE_SESSION_LIFECYCLE_ENTRY], cwd);
}

function createBoundaryShard() {
  // Boundary tests scan the source tree (including test files) and build
  // their own fixtures; they do not consume the built dist artifact. When the
  // build-artifacts lane is skipped, this shard keeps that coverage.
  return {
    checkName: "checks-node-changed-boundary",
    configs: [BOUNDARY_NODE_TEST_CONFIG],
    requiresDist: false,
    runner: DEFAULT_NODE_TEST_RUNNER,
    shardName: "changed-boundary",
  };
}

function isIndependentlyCheckedDocumentation(changedPath: string, cwd: string) {
  if (
    changedPath !== changedPath.trim() ||
    path.posix.normalize(changedPath) !== changedPath ||
    (changedPath !== "README.md" &&
      (!/^docs\/.+\.mdx?$/u.test(changedPath) ||
        changedPath.startsWith("docs/reference/templates/")))
  ) {
    return false;
  }
  // check:docs owns these pages; packaged workspace templates still need runtime proof.
  // Missing pages are deletions, but symlinks (including dangling ones) are not pages.
  const entry = lstatSync(path.join(cwd, changedPath), { throwIfNoEntry: false });
  return entry === undefined || entry.isFile();
}

function resolvePreciseChangedTargets(
  changedPaths: string[],
  cwd: string,
  documentationPaths: ReadonlySet<string>,
  additionalTargets: string[] = [],
) {
  const resolveTargetPlan = (paths: string[]) =>
    resolveChangedTestTargetPlan(paths, {
      broad: true,
      combineSiblingWithImportGraph: true,
      cwd,
      forceFullImportGraph: true,
      includeExtensionImpact: false,
    });
  const plan =
    changedPaths.length > 0
      ? resolveTargetPlan(changedPaths)
      : { mode: "targets" as const, targets: [] };
  // A precise aggregate must not hide an unowned path. Only independently
  // checked documentation may contribute no Node tests after owner resolution.
  if (
    changedPaths.some((changedPath) => {
      const changedPathPlan = resolveTargetPlan([changedPath]);
      return (
        changedPathPlan.mode !== "targets" ||
        (changedPathPlan.targets.length === 0 && !documentationPaths.has(changedPath))
      );
    }) ||
    plan.mode !== "targets"
  ) {
    return null;
  }
  const targets = [...new Set([...plan.targets, ...additionalTargets])];
  if (
    targets.length > MAX_CHANGED_NODE_TEST_TARGETS ||
    targets.some(
      (target) =>
        /^test\/vitest\/vitest\.full-.*\.config\.ts$/u.test(target) ||
        splitNodeTestConfigs.has(target),
    ) ||
    targets.some(
      (target) =>
        !isTestFileTarget(target) || findUnmatchedExplicitTestTargets([target], cwd).length > 0,
    )
  ) {
    return null;
  }

  const targetPlans = targets.map((target) => ({
    plans: buildVitestRunPlans([target], cwd),
    target,
  }));
  if (
    targetPlans.some(
      ({ plans }) => plans.length === 0 || plans.some((targetPlan) => !targetPlan.includePatterns),
    )
  ) {
    return null;
  }
  return targetPlans;
}

function createChangedTargetShards(
  targets: string[],
  names: { checkName: string; shardName: string },
) {
  const targetChunks: string[][] = [];
  for (let offset = 0; offset < targets.length; offset += CHANGED_NODE_TEST_TARGETS_PER_JOB) {
    targetChunks.push(targets.slice(offset, offset + CHANGED_NODE_TEST_TARGETS_PER_JOB));
  }
  return targetChunks.map((chunk, index) => {
    const suffix = targetChunks.length === 1 ? "" : `-${index + 1}`;
    const shard: ChangedNodeTestShard = {
      checkName: `${names.checkName}${suffix}`,
      configs: [],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: `${names.shardName}${suffix}`,
      targets: chunk,
    };
    const pretestBuildMode = resolveVitestPretestBuildMode([{ includePatterns: chunk }]);
    if (pretestBuildMode) {
      shard.pretestBuildMode = pretestBuildMode;
    }
    if (chunk.some((target) => SERIAL_CHANGED_TARGET_RE.test(target))) {
      shard.planConcurrency = 1;
    }
    return shard;
  });
}

function resolveChangedExtensionRoots(changedPaths: string[]) {
  return [
    ...new Set(
      changedPaths.flatMap((changedPath) => {
        const [, extensionId] = changedPath.split("/");
        return extensionId ? [`extensions/${extensionId}`] : [];
      }),
    ),
  ];
}

function createChangedExtensionConfigShards(
  extensionRoots: string[],
  options: { fullConfigInventory?: boolean } = {},
): ChangedExtensionConfigShard[] {
  const selectedRoots = new Set(extensionRoots);
  const rootsByConfig = new Map<string, string[]>();
  for (const root of extensionRoots) {
    const config = resolveExtensionTestConfig(root);
    rootsByConfig.set(config, [...(rootsByConfig.get(config) ?? []), root]);
  }
  const filesByConfig = new Map<string, string[]>();
  for (const file of rootsByConfig.size > 0 ? listExtensionTestFilesForRoots(["extensions"]) : []) {
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
    predictedSeconds: number;
  }> = [...rootsByConfig].flatMap(([config, roots]) => {
    const splitProcesses = shouldSplitExtensionTestProcesses(config);
    const testFiles = (filesByConfig.get(config) ?? []).filter(
      (file) =>
        !splitProcesses ||
        options.fullConfigInventory ||
        roots.some((root) => file.startsWith(`${root}/`)),
    );
    const chunks = testFiles.length > 0 ? splitExtensionTestJobTargets(config, testFiles) : [roots];
    const partitionSeconds = Math.ceil(
      estimateExtensionTestCost(config, testFiles.length) / chunks.length,
    );
    return chunks.map((includePatterns, index) =>
      Object.assign(
        {
          config,
          predictedSeconds: splitProcesses
            ? estimateExtensionTestCost(config, includePatterns.length)
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
      ),
    );
  });
  return plans.map(({ config, env, includePatterns, predictedSeconds }, index) => {
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
    const pretestBuildMode = resolveVitestPretestBuildMode([
      { configs: [config], includePatterns },
    ]);
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
  });
}

function createChangedExtensionConfigShardsForPaths(changedPaths: string[], cwd: string) {
  const relevantPaths = changedPaths.filter(
    (changedPath) =>
      changedPath.startsWith("extensions/") &&
      !isPluginControlUiPath(changedPath) &&
      (existsSync(path.join(cwd, changedPath)) || !isTestFileTarget(changedPath)),
  );
  return createChangedExtensionConfigShards(resolveChangedExtensionRoots(relevantPaths));
}

/**
 * True when core or fallback-gate changes can affect extension consumers beyond
 * the changed extension paths.
 */
export function hasCoreExtensionImpact(changedPaths: string[], options: CwdOptions = {}) {
  if (changedPaths.some((changedPath) => CORE_EXTENSION_IMPACT_SURFACE_RE.test(changedPath))) {
    return true;
  }
  const cwd = options.cwd ?? process.cwd();
  const regularLivePaths = changedPaths.filter(
    (changedPath) =>
      existsSync(path.join(cwd, changedPath)) &&
      !changedPath.startsWith("extensions/") &&
      !isPolicyTestOwnedPath(changedPath),
  );
  return (
    detectChangedLanes(changedPaths).extensionImpactFromCore ||
    (regularLivePaths.some((changedPath) => changedPath.startsWith("src/")) &&
      hasImportGraphImpactOnTargets(regularLivePaths, publicPluginSdkEntrySources, cwd))
  );
}

/**
 * Covers changed extensions plus the full core-impact blast radius when precise
 * planning falls back. See #124412.
 */
export function createChangedExtensionFallbackShards(
  changedPaths: string[],
  options: CwdOptions = {},
): ChangedNodeTestShard[] {
  const cwd = options.cwd ?? process.cwd();
  const shards = hasCoreExtensionImpact(changedPaths, { cwd })
    ? createChangedExtensionConfigShards(
        listAvailableExtensionIds().map((extensionId) => `extensions/${extensionId}`),
        { fullConfigInventory: true },
      )
    : createChangedExtensionConfigShardsForPaths(changedPaths, cwd);
  const jobs = packChangedExtensionConfigShards(shards);
  if (jobs.length > MAX_CHANGED_EXTENSION_FALLBACK_JOBS) {
    throw new Error(
      `changed plugin fallback exceeds ${MAX_CHANGED_EXTENSION_FALLBACK_JOBS} jobs (${jobs.length} planned)`,
    );
  }
  return jobs;
}

function packChangedExtensionConfigShards(
  shards: ChangedExtensionConfigShard[],
): ChangedNodeTestShard[] {
  const nativeWorkerFileCounts = new Map(
    shards.map((shard) => [
      shard,
      shard.includePatterns?.filter((file) =>
        isDatabaseWorkerExtensionRoot(file.split("/").slice(0, 2).join("/")),
      ).length ?? 0,
    ]),
  );
  const bins = packNodeTestGroups(
    shards.toSorted(
      (a, b) => b.predictedSeconds - a.predictedSeconds || a.shardName.localeCompare(b.shardName),
    ),
    // Each envelope retains its own child process. Share only the checkout;
    // runtime preparation stays separate from other configs' readers.
    (bin, shard) =>
      // Cost packing must not recreate the oversized native worker envelope.
      bin.reduce(
        (count, entry) => count + (nativeWorkerFileCounts.get(entry) ?? 0),
        nativeWorkerFileCounts.get(shard) ?? 0,
      ) <= NATIVE_DATABASE_WORKER_TEST_JOB_FILE_LIMIT &&
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

/**
 * Builds bounded PR jobs from precise changed-test targets.
 * Null means the caller must fail safe to the compact full-suite plan.
 */
export function createChangedNodeTestShards(
  changedPaths: string[],
  options: CwdOptions & {
    runnerBackend?: string;
    dedicatedContractShards?: readonly { task: string; includePatterns: readonly string[] }[];
    dedicatedUiE2e?: boolean;
    dedicatedMaxLinesRatchet?: boolean;
  } = {},
): ChangedNodeTestShard[] | null {
  const cwd = options.cwd ?? process.cwd();
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return null;
  }

  // Packing changes and their policy guard need the complete compact plan on
  // Blacksmith while preserving hosted targeting and its registration footprint.
  if (
    options.runnerBackend !== "github" &&
    changedPaths.some(
      (file) =>
        file === "config/ci-test-timings.json" ||
        file === "scripts/lib/ci-node-test-plan.mts" ||
        file === "test/scripts/ci-node-test-plan.test.ts",
    )
  ) {
    return null;
  }

  const livePaths: string[] = [];
  const resolutionPaths: string[] = [];
  const documentationPaths = new Set<string>();
  for (const changedPath of changedPaths) {
    const live = existsSync(path.join(cwd, changedPath));
    const documentation = isIndependentlyCheckedDocumentation(changedPath, cwd);
    if (documentation) {
      documentationPaths.add(changedPath);
    }
    if (live) {
      livePaths.push(changedPath);
    } else if (!isTestFileTarget(changedPath) && !documentation) {
      // Deleted source cannot be import-graphed; deleted tests retain boundary coverage.
      return null;
    }
    if (live || documentation) {
      // Preserve input order and resolve even deleted docs before crediting an empty plan.
      resolutionPaths.push(changedPath);
    }
  }

  // Policy watches can name extension-owned files (such as a bundled manifest)
  // that host suites scan without importing, so an extension path a watch names
  // stays eligible alongside the plugin control-UI paths.
  const policyTargetsByPath = new Map(
    resolutionPaths
      .map((changedPath) => [changedPath, resolvePolicyTestTargets([changedPath])] as const)
      .filter(
        ([changedPath, policyTargets]) =>
          !changedPath.startsWith("extensions/") ||
          isPluginControlUiPath(changedPath) ||
          policyTargets.length > 0,
      ),
  );
  const regularPaths = resolutionPaths.filter(
    (changedPath) =>
      (!changedPath.startsWith("extensions/") || isPluginControlUiPath(changedPath)) &&
      // The emitted ratchet checks this data against the exact tested merge tree.
      !(
        options.dedicatedMaxLinesRatchet === true && changedPath === "config/max-lines-baseline.txt"
      ) &&
      !isPolicyTestOwnedPath(changedPath),
  );

  // Workspace package consumers often use package specifiers, which the
  // relative import graph cannot connect back to the changed package source.
  if (changedPaths.some((changedPath) => changedPath.startsWith("packages/"))) {
    return null;
  }

  // Package-specifier consumers are invisible to the relative import graph.
  // Fail safe when a core change reaches a public SDK entrypoint indirectly.
  if (hasCoreExtensionImpact(changedPaths, { cwd })) {
    return null;
  }

  const targetPlans = resolvePreciseChangedTargets(regularPaths, cwd, documentationPaths, [
    ...[...policyTargetsByPath.values()].flat(),
    // Plugin changes normally select only extension suites. This host-owned
    // proof also exercises the real Copilot entrypoint and manifest discovery.
    ...(livePaths.some((changedPath) => changedPath.startsWith("extensions/copilot/"))
      ? ["src/agents/prepared-model-runtime.copilot.integration.test.ts"]
      : []),
  ]);
  if (targetPlans === null) {
    return null;
  }
  const canonicalTargets = targetPlans
    .filter(({ plans }) =>
      plans.some(({ config }) => configsRequiringCanonicalMetadata.has(config)),
    )
    .map(({ target }) => target);
  // Canonical shard inventories describe this checkout, never a caller's
  // synthetic or alternate source root with coincidentally matching paths.
  const canonicalShards = canonicalTargets.length
    ? path.resolve(cwd) === process.cwd()
      ? createSelectedNodeTestShardBundles(canonicalTargets, {
          runnerBackend: options.runnerBackend,
        })
      : null
    : [];
  if (canonicalShards === null) {
    return null;
  }
  const boundaryShards =
    hasBuildArtifactAffectingChange(changedPaths) ||
    canonicalShards.some((shard) => shard.requiresDist)
      ? []
      : [createBoundaryShard()];
  // CI supplies the suite owners it emits. Validate every changed path first,
  // then subtract covered plans; local runs and unselected owners keep their targets.
  const targets = targetPlans
    .filter(({ target }) => !canonicalTargets.includes(target))
    .filter(
      ({ plans }) =>
        !options.dedicatedUiE2e || !plans.every(({ config }) => config === UI_E2E_VITEST_CONFIG),
    )
    .filter(
      ({ target, plans }) =>
        !plans.every((plan) => {
          const plugin = plan.config === CONTRACTS_PLUGIN_VITEST_CONFIG;
          const patterns = plugin
            ? pluginContractPatterns
            : CHANNEL_CONTRACT_CONFIG_PATTERNS.get(plan.config);
          return (
            !plan.watchMode &&
            plan.forwardedArgs.length === 0 &&
            plan.includePatterns?.every((pattern) => pattern === target) &&
            // Only this plan's full boundary suite owns these targets; a build
            // elsewhere must not suppress their explicit execution here.
            ((boundaryShards.length > 0 &&
              plan.config === BOUNDARY_NODE_TEST_CONFIG &&
              plan.includePatterns.length > 0 &&
              isBoundaryTestFile(target)) ||
              (patterns?.some((pattern) => path.matchesGlob(target, pattern)) &&
                options.dedicatedContractShards?.some(
                  (shard) =>
                    shard.task === (plugin ? "contracts-plugins" : "contracts-channels") &&
                    shard.includePatterns.includes(target),
                )))
          );
        }),
    )
    .map(({ target }) => target);

  const shards = [
    ...canonicalShards.map((shard) => Object.assign({}, shard, { configs: [] })),
    ...packChangedExtensionConfigShards(createChangedExtensionConfigShardsForPaths(livePaths, cwd)),
    // Native browser files run in checks-ui, including precise changed-file plans.
    ...createChangedTargetShards(
      targets.filter((target) => !isUiBrowserTestFile(target)),
      {
        checkName: "checks-node-changed",
        shardName: "changed",
      },
    ),
    ...boundaryShards,
  ];
  // Covered source targets keep build-artifacts ownership even with no Node rows.
  return shards.length > 0 || targets.length < targetPlans.length ? shards : null;
}
