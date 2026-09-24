import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { pluginContractPatterns } from "../../test/vitest/vitest.contracts-paths.mjs";
import {
  isControlUiSourcePath,
  isPluginControlUiPath,
  isUiBrowserTestFile,
  isUiTestTarget,
} from "../../test/vitest/vitest.ui-paths.mjs";
import { isBoundaryTestFile } from "../../test/vitest/vitest.unit-paths.mjs";
import { detectChangedLanes } from "../changed-lanes.mts";
import {
  detectChangedScope,
  isCiDocumentationPath as isDocumentationPath,
  isNodeTestDataOnlyPath,
} from "../ci-changed-scope.mjs";
import {
  buildVitestRunPlans,
  CHANNEL_CONTRACT_CONFIG_PATTERNS,
  CONTRACTS_PLUGIN_VITEST_CONFIG,
  E2E_VITEST_CONFIG,
  findUnmatchedExplicitTestTargets,
  hasImportGraphConsumers,
  hasImportGraphImpactOnTargets,
  isTestFileTarget,
  isWorkflowLintConfigPath,
  resolveControlUiTestConsumers,
  resolveAffectedTestsFromImportGraph,
  resolveDependencyTestConsumers,
  resolveChangedTestTargetPlan,
  UI_E2E_VITEST_CONFIG,
} from "../test-projects.test-support.mts";
import { resolveChangedDependencies } from "./changed-dependencies.mts";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { isTestOnlyPath } from "./changed-path-facts.mjs";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  isPolicyTestOwnedPath,
  nodeTestConfigRequiresCanonicalMetadata,
  resolveCanonicalNodeTestConfig,
  isCanonicalNodeTestConfig,
  isToolingTestOwnerPath,
  packNodeTestGroups,
  resolvePolicyTestTargets,
  RELEASE_ONLY_TOOLING_CONFIGS,
  isReleaseOnlyToolingTestFile,
  isRuntimeTestFileIncluded,
  type NodeTestShardGroup,
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
import { buildPluginSdkEntrySources, publicPluginSdkEntrypoints } from "./plugin-sdk-entries.mts";
import { isErasedTypeScriptFileChange } from "./test-selector-source-facts.mts";
import {
  mergeVitestPretestBuildModes,
  resolveVitestPretestBuildMode,
  type VitestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "./vitest-shard-metadata.mts";

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
type PlanDiagnostic = (reason: string) => void;
type ChangedTargetValidation = {
  baseRef?: string;
  dedicatedCoreTypeChecks?: boolean;
  dedicatedNativeChecks?: { macos: boolean; ios: boolean; android: boolean };
  onFallback?: PlanDiagnostic;
};

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
// Each target runs in its own child process (isolation contract), so bound the
// serial tail per job; the shard runner overlaps two children at a time.
const CHANGED_NODE_TEST_TARGETS_PER_JOB = 12;
// Share the 45–60s runner setup across more unchanged serial envelopes.
// Runtime preparation and native-worker file ceilings remain separate admission limits.
const CHANGED_EXTENSION_JOB_SECONDS = 300;
const MAX_CHANGED_EXTENSION_FALLBACK_JOBS = 50;
// Memory Core targets perform real SQLite/indexing work. Two concurrent Vitest
// processes starve each other on 4-vCPU runners and push otherwise healthy
// integration tests past the global timeout.
const SERIAL_CHANGED_TARGET_RE = /^extensions\/memory-core\//u;
const BOUNDARY_NODE_TEST_CONFIG = "test/vitest/vitest.boundary.config.ts";
const UI_NODE_TEST_CONFIGS = new Set([
  "test/vitest/vitest.ui.config.ts",
  "test/vitest/vitest.ui-isolated.config.ts",
  "test/vitest/vitest.ui-timing.config.ts",
]);
let automaticNodeTestConfigs: ReadonlySet<string> | undefined;
function resolveAutomaticNodeTestConfigs() {
  return (automaticNodeTestConfigs ??= new Set(
    createNodeTestShardBundles({
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: false,
      includeProofTests: false,
    }).flatMap((shard) => shard.groups.flatMap((group) => group.configs)),
  ));
}
const publicPluginSdkEntrySources = Object.values(
  buildPluginSdkEntrySources(publicPluginSdkEntrypoints),
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
      (BUILD_INPUT_RE.test(changedPath) &&
        !isTestOnlyPath(changedPath) &&
        !isDocumentationPath(changedPath)),
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
const GLOBAL_NODE_TEST_INPUT_RE =
  /^(?:pnpm-workspace\.yaml|\.npmrc|node-version\.mjs|tsconfig(?:\.[^/]+)?\.json|vitest\.config\.ts|test\/setup(?:\.shared|\.extensions|-openclaw-runtime)?\.ts|test\/vitest\/vitest\.(?:shared\.config|scoped-config|performance-config)\.ts|scripts\/run-vitest\.(?:mjs|mts)|scripts\/test-projects\.mts|scripts\/lib\/vitest-process-env\.mts|\.github\/actions\/(?:setup-node-env|setup-pnpm-store-cache)\/action\.yml)$|^patches\//u;

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
    !isNodeTestDataOnlyPath(changedPath)
  ) {
    return false;
  }
  // Docs/instruction routing owns these pages; packaged templates retain runtime proof.
  // Missing pages are deletions, but symlinks (including dangling ones) are not pages.
  const entry = lstatSync(path.join(cwd, changedPath), { throwIfNoEntry: false });
  return entry === undefined || entry.isFile();
}

function resolvePreciseChangedTargets(
  changedPaths: string[],
  cwd: string,
  documentationPaths: ReadonlySet<string>,
  additionalTargets: string[] = [],
  validation: ChangedTargetValidation = {},
) {
  const resolveTargetPlan = (paths: string[]) => {
    const consumers = resolveAffectedTestsFromImportGraph(paths, cwd, {
      tooling: true,
      forceFull: true,
      resolveAliases: true,
      runtimeOnly: true,
    });
    const plan = resolveChangedTestTargetPlan(paths, {
      broad: true,
      combineSiblingWithImportGraph: true,
      cwd,
      forceFullImportGraph: true,
      includeExtensionImpact: false,
      resolveAliases: true,
      runtimeOnly: true,
    });
    // UI routing can return the source itself; instruction pages are not test targets.
    return {
      mode: consumers.length > 0 ? ("targets" as const) : plan.mode,
      targets: [...new Set([...plan.targets, ...consumers])].filter(
        (target) =>
          !documentationPaths.has(target) &&
          !(consumers.length > 0 && paths.includes(target) && !isTestFileTarget(target)),
      ),
    };
  };
  const plan =
    changedPaths.length > 0
      ? resolveTargetPlan(changedPaths)
      : { mode: "targets" as const, targets: [] };
  // Concrete consumers remain selected even when a separate check owns an input.
  const erasedPaths = new Set<string>();
  const unresolvedPath = changedPaths.find((changedPath) => {
    const changedPathPlan = resolveTargetPlan([changedPath]);
    if (
      validation.dedicatedCoreTypeChecks === true &&
      changedPath.startsWith("src/") &&
      !isTestFileTarget(changedPath) &&
      changedPathPlan.mode === "targets" &&
      changedPathPlan.targets.length === 1 &&
      changedPathPlan.targets[0] === changedPath &&
      isErasedTypeScriptFileChange(cwd, changedPath, validation.baseRef)
    ) {
      erasedPaths.add(changedPath);
      return false;
    }
    const native =
      changedPathPlan.targets.length === 0 &&
      validation.dedicatedNativeChecks &&
      !isToolingTestOwnerPath(changedPath)
        ? detectChangedScope([changedPath])
        : undefined;
    const checkedWithoutNodeTests =
      documentationPaths.has(changedPath) ||
      isWorkflowLintConfigPath(changedPath) ||
      (native &&
        !native.runNode &&
        (native.runMacos || native.runIosBuild || native.runAndroid) &&
        (!native.runMacos || validation.dedicatedNativeChecks?.macos === true) &&
        (!native.runIosBuild || validation.dedicatedNativeChecks?.ios === true) &&
        (!native.runAndroid || validation.dedicatedNativeChecks?.android === true));
    return (
      changedPathPlan.mode !== "targets" ||
      changedPathPlan.targets.some((target) => !isTestFileTarget(target)) ||
      (changedPathPlan.targets.length === 0 && !checkedWithoutNodeTests)
    );
  });
  if (unresolvedPath !== undefined || plan.mode !== "targets") {
    validation.onFallback?.(
      unresolvedPath === undefined
        ? "unresolved changed-path owner"
        : `unresolved changed-path owner: ${JSON.stringify(unresolvedPath)}`,
    );
    return null;
  }
  const targets = [
    ...new Set([
      ...plan.targets.filter((target) => !erasedPaths.has(target)),
      ...additionalTargets,
    ]),
  ];
  if (
    targets.some((target) => !isTestFileTarget(target)) ||
    findUnmatchedExplicitTestTargets(targets, cwd).length > 0
  ) {
    validation.onFallback?.("unresolved test target or whole-suite config");
    return null;
  }

  const targetPlans = targets.map((target) => ({
    plans: buildVitestRunPlans([target], cwd).map((targetPlan) => {
      const config =
        path.resolve(cwd) === process.cwd()
          ? resolveCanonicalNodeTestConfig(target, targetPlan.config)
          : undefined;
      return config && config !== targetPlan.config
        ? Object.assign({}, targetPlan, { config, includePatterns: [target], forwardedArgs: [] })
        : targetPlan;
    }),
    target,
  }));
  const unboundedTarget = targetPlans.find(
    ({ target, plans }) =>
      plans.length === 0 ||
      // E2E's canonical owner uses CLI filters instead of include files.
      // Named deferred proofs need resolution, but no PR execution envelope.
      (!isCiProofTestFile(target) &&
        plans.some(
          (targetPlan) => !targetPlan.includePatterns && !targetPlan.forwardedArgs.includes(target),
        )),
  );
  if (unboundedTarget) {
    validation.onFallback?.(
      `test target expands beyond a bounded file plan: ${unboundedTarget.target} (${unboundedTarget.plans.map((targetPlan) => targetPlan.config).join(", ")})`,
    );
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
  options: CwdOptions & { fullConfigInventory?: boolean; targets?: ReadonlySet<string> } = {},
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
    const testFiles = (filesByConfig.get(config) ?? []).filter(
      (file) =>
        !isCiProofTestFile(file) &&
        (!options.targets || options.targets.has(file)) &&
        (!splitProcesses ||
          options.fullConfigInventory ||
          roots.some((root) => file.startsWith(`${root}/`))),
    );
    if (options.targets && testFiles.length === 0) {
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

function createChangedExtensionConfigShardsForPaths(changedPaths: string[], cwd: string) {
  const relevantPaths = changedPaths.filter(
    (changedPath) =>
      changedPath.startsWith("extensions/") &&
      !isPluginControlUiPath(changedPath) &&
      (existsSync(path.join(cwd, changedPath)) || !isTestFileTarget(changedPath)),
  );
  const roots = resolveChangedExtensionRoots(relevantPaths);
  return createChangedExtensionConfigShards(roots, {
    cwd,
    targets: new Set(listExtensionTestFilesForRoots(roots, cwd)),
  });
}

/**
 * True when core or fallback-gate changes can affect extension consumers beyond
 * the changed extension paths.
 */
export function hasCoreExtensionImpact(changedPaths: string[], options: CwdOptions = {}) {
  if (
    changedPaths.some(
      (changedPath) =>
        CORE_EXTENSION_IMPACT_SURFACE_RE.test(changedPath) ||
        GLOBAL_NODE_TEST_INPUT_RE.test(changedPath),
    )
  ) {
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
      hasImportGraphImpactOnTargets(regularLivePaths, publicPluginSdkEntrySources, cwd, {
        resolveAliases: true,
      }))
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
        listAvailableExtensionIds(cwd).map((extensionId) => `extensions/${extensionId}`),
        { fullConfigInventory: true, cwd },
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

/**
 * Builds bounded PR jobs from precise changed-test targets.
 * Null means the caller must fail safe to the compact full-suite plan.
 */
export function createChangedNodeTestShards(
  changedPaths: string[],
  options: CwdOptions &
    ChangedTargetValidation & {
      runnerBackend?: string;
      includeReleaseOnlyToolingShards?: boolean;
      includeReleaseOnlyRuntimeTests?: boolean;
      dedicatedContractShards?: readonly { task: string; includePatterns: readonly string[] }[];
      dedicatedUiE2e?: boolean;
      dedicatedMaxLinesRatchet?: boolean;
    } = {},
): ChangedNodeTestShard[] | null {
  const cwd = options.cwd ?? process.cwd();
  const fallback = (reason: string) => {
    options.onFallback?.(reason);
    return null;
  };
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return fallback("missing changed paths");
  }

  // These inputs change execution or module resolution for every project.
  // Ordinary helpers, package sources, and tooling leaves use their consumers.
  const globalInput = changedPaths.find((file) => GLOBAL_NODE_TEST_INPUT_RE.test(file));
  if (globalInput) {
    return fallback(`global execution or resolution input: ${globalInput}`);
  }

  const dependencyPaths = new Set(
    changedPaths.filter(
      (file) =>
        file === "pnpm-lock.yaml" ||
        file === "package.json" ||
        /^(?:packages|extensions)\/[^/]+\/package\.json$|^ui\/package\.json$/u.test(file),
    ),
  );
  const dependencyChange =
    dependencyPaths.size > 0
      ? resolveChangedDependencies({ cwd, baseRef: options.baseRef, changedPaths })
      : { importers: [] };
  if (dependencyChange.globalReason) {
    return fallback(dependencyChange.globalReason);
  }
  const pluginMetadataPaths = new Set(dependencyChange.pluginMetadataPaths ?? []);
  const dependencyConsumers = resolveDependencyTestConsumers(dependencyChange.importers, cwd, {
    runtimeOnly: true,
    importerBindings: dependencyChange.importerBindings,
  });
  if (dependencyConsumers.unresolved.length > 0) {
    return fallback(
      `unresolved dependency usage: ${dependencyConsumers.unresolved
        .map(({ root, dependency }) => `${root}:${dependency}`)
        .join(", ")}`,
    );
  }

  // Packing changes and their policy guard need the complete compact plan on
  // Blacksmith while preserving hosted targeting and its registration footprint.
  if (
    options.runnerBackend !== "github" &&
    changedPaths.some(
      (file) =>
        file === "config/ci-test-timings.json" ||
        file === "scripts/lib/ci-node-test-plan.mts" ||
        file === "scripts/lib/ci-measured-compact-packing.mts" ||
        file === "scripts/lib/ci-test-timings.mts" ||
        file === "scripts/lib/vitest-shard-metadata.mts" ||
        file === "test/scripts/ci-node-test-plan.test.ts",
    )
  ) {
    return fallback("compact packing policy requires full-plan proof");
  }

  const livePaths: string[] = [];
  const resolutionPaths: string[] = [];
  const documentationPaths = new Set<string>();
  for (const changedPath of changedPaths) {
    const live = existsSync(path.join(cwd, changedPath));
    const documentation = isIndependentlyCheckedDocumentation(changedPath, cwd);
    if (
      documentation ||
      (dependencyPaths.has(changedPath) && !pluginMetadataPaths.has(changedPath))
    ) {
      documentationPaths.add(changedPath);
    }
    if (live) {
      livePaths.push(changedPath);
    } else if (!isTestFileTarget(changedPath) && !documentation) {
      // Deleted source cannot be import-graphed; deleted tests retain boundary coverage.
      return fallback(`deleted or missing source: ${changedPath}`);
    }
    if (live || documentation) {
      // Preserve input order and resolve even deleted docs before crediting an empty plan.
      resolutionPaths.push(changedPath);
    }
  }
  for (const source of dependencyConsumers.sources) {
    if (!resolutionPaths.includes(source)) {
      resolutionPaths.push(source);
    }
  }

  // A plugin manifest or opaque plugin entry can lack static importers. Its
  // package remains the bounded owner; it does not select unrelated plugins.
  const extensionFallbackPaths = resolutionPaths.filter(
    (file) =>
      file.startsWith("extensions/") &&
      !isPluginControlUiPath(file) &&
      !documentationPaths.has(file) &&
      !isTestFileTarget(file) &&
      (pluginMetadataPaths.has(file) ||
        file.endsWith("/openclaw.plugin.json") ||
        resolveAffectedTestsFromImportGraph([file], cwd, {
          tooling: true,
          forceFull: true,
          resolveAliases: true,
          runtimeOnly: true,
        }).length === 0),
  );
  const extensionFallbackRoots = resolveChangedExtensionRoots(extensionFallbackPaths);

  // Policy watches can name extension-owned files (such as a bundled manifest)
  // that host suites scan without importing, so an extension path a watch names
  // stays eligible alongside the plugin control-UI paths.
  const policyTargetsByPath = new Map(
    resolutionPaths
      .filter((changedPath) => !documentationPaths.has(changedPath))
      .map((changedPath) => [changedPath, resolvePolicyTestTargets([changedPath])] as const)
      .filter(
        ([changedPath, policyTargets]) =>
          !changedPath.startsWith("extensions/") ||
          isPluginControlUiPath(changedPath) ||
          policyTargets.length > 0,
      ),
  );
  const policyTargets = [...new Set([...policyTargetsByPath.values()].flat())];
  const completeOwnerTargets = new Set(
    [...policyTargetsByPath.keys()].flatMap((changedPath) =>
      resolvePolicyTestTargets([changedPath], { completeOwnersOnly: true }),
    ),
  );
  const regularPaths = resolutionPaths.filter(
    (changedPath) =>
      !documentationPaths.has(changedPath) &&
      !extensionFallbackPaths.includes(changedPath) &&
      // The emitted ratchet checks this data against the exact tested merge tree.
      !(
        options.dedicatedMaxLinesRatchet === true && changedPath === "config/max-lines-baseline.txt"
      ) &&
      !isPolicyTestOwnedPath(changedPath),
  );
  const directConfigPaths = regularPaths.filter((file) =>
    /^test\/vitest\/vitest\.[^/]+\.config\.ts$/u.test(file),
  );
  const configInputs = [
    ...new Set([
      ...resolutionPaths.filter((file) => !documentationPaths.has(file)),
      ...dependencyConsumers.sources,
    ]),
  ];
  const graphOptions = { tooling: true, resolveAliases: true, runtimeOnly: true };
  const inspectConfigConsumers =
    configInputs.length > 0 &&
    (!configInputs.every(isTestFileTarget) ||
      hasImportGraphConsumers(configInputs, cwd, graphOptions));
  const configCandidates = inspectConfigConsumers ? [...resolveAutomaticNodeTestConfigs()] : [];
  const affectedConfigs =
    configCandidates.length &&
    hasImportGraphImpactOnTargets(configInputs, configCandidates, cwd, graphOptions)
      ? configCandidates.filter((config) =>
          hasImportGraphImpactOnTargets(configInputs, [config], cwd, graphOptions),
        )
      : [];
  const configPaths = [...new Set([...directConfigPaths, ...affectedConfigs])];
  if (
    changedPaths.every((file) => documentationPaths.has(file)) &&
    dependencyConsumers.tests.length === 0 &&
    dependencyConsumers.sources.length === 0 &&
    configPaths.length === 0
  ) {
    return [];
  }
  const configOwnedInputs = configPaths.length
    ? configInputs.filter(
        (file) =>
          directConfigPaths.includes(file) ||
          hasImportGraphImpactOnTargets([file], configPaths, cwd, graphOptions),
      )
    : [];
  if (configPaths.length && path.resolve(cwd) !== process.cwd()) {
    return fallback("changed Vitest configs lack canonical checkout metadata");
  }
  const configCanonicalShards = configPaths.length
    ? createNodeTestShardBundles({
        changedPaths,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards: options.includeReleaseOnlyToolingShards,
        includeReleaseOnlyRuntimeTests: options.includeReleaseOnlyRuntimeTests,
        includeProofTests: false,
        compactMode: "pull-request",
        runnerBackend: options.runnerBackend,
      })
    : [];
  if (
    configPaths.some(
      (config) =>
        !configCanonicalShards.some((shard) =>
          shard.groups.some((group) => group.configs.includes(config)),
        ),
    )
  ) {
    return fallback("changed Vitest config lacks an automatic suite owner");
  }
  // Import graphs find config readers, while the canonical suite inventory owns
  // the implicit config-to-test edge and its process/runtime policy.
  const configGuardTargets = configPaths.length
    ? [
        ...new Set([
          ...resolveAffectedTestsFromImportGraph([...configPaths, ...configOwnedInputs], cwd, {
            tooling: true,
            resolveAliases: true,
            runtimeOnly: true,
            forceFull: true,
          }),
          ...resolveChangedTestTargetPlan([...configPaths, ...configOwnedInputs], {
            cwd,
            broad: false,
          }).targets.filter(isTestFileTarget),
        ]),
      ]
    : [];

  // UI source targets intentionally name an area rather than individual tests.
  // Keep that area's complete canonical rows, including their process policies;
  // browser and E2E coverage must already have their dedicated workflow owners.
  const uiPaths =
    options.dedicatedUiE2e &&
    path.resolve(cwd) === process.cwd() &&
    regularPaths.some(
      (file) =>
        isControlUiSourcePath(file) && !isTestFileTarget(file) && !documentationPaths.has(file),
    )
      ? regularPaths.filter((file) => isControlUiSourcePath(file) && !documentationPaths.has(file))
      : [];
  const uiCanonicalShards = uiPaths.length
    ? createNodeTestShardBundles({
        changedPaths,
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards: true,
        includeReleaseOnlyRuntimeTests: options.includeReleaseOnlyRuntimeTests,
        compactMode: "pull-request",
        runnerBackend: options.runnerBackend,
      })
    : [];
  const uiConsumerPlans = (uiPaths.length ? resolveControlUiTestConsumers(uiPaths, cwd) : []).map(
    (target) => ({ target, plans: buildVitestRunPlans([target], cwd) }),
  );
  if (
    uiConsumerPlans.some(({ plans }) => plans.length === 0) ||
    findUnmatchedExplicitTestTargets(
      uiConsumerPlans.map(({ target }) => target),
      cwd,
    ).length > 0
  ) {
    return fallback("unresolved UI host consumer");
  }
  // General E2E consumers retain their separate owners outside the Node matrix.
  const uiConsumers = new Set(
    uiConsumerPlans
      .filter(({ plans }) => !plans.every((plan) => plan.config === E2E_VITEST_CONFIG))
      .map(({ target }) => target),
  );
  const uiShards = uiCanonicalShards.flatMap((shard) => {
    const groups = shard.groups.filter((group) =>
      group.configs.some((config) => UI_NODE_TEST_CONFIGS.has(config)),
    );
    return groups.length
      ? [
          Object.assign({}, shard, {
            groups,
            configs: [],
            checkName: `checks-node-changed-ui-${shard.shardName}`,
            shardName: `changed-ui-${shard.shardName}`,
          }),
        ]
      : [];
  });
  const configShards = configCanonicalShards.flatMap((shard) => {
    const groups = shard.groups.flatMap((group) => {
      const configs = group.configs.filter(
        (config) =>
          configPaths.includes(config) &&
          !uiShards.some((uiShard) =>
            uiShard.groups.some((uiGroup) => uiGroup.configs.includes(config)),
          ),
      );
      return configs.length ? [{ ...group, configs }] : [];
    });
    return groups.length
      ? [
          {
            ...shard,
            groups,
            configs: [],
            requiresDist: groups.some((group) => group.requiresDist),
            pretestBuildMode: mergeVitestPretestBuildModes(
              groups.map((group) => group.pretestBuildMode),
            ),
            checkName: `checks-node-changed-config-${shard.shardName}`,
            shardName: `changed-config-${shard.shardName}`,
          },
        ]
      : [];
  });
  const wholeOwnerShards = [...uiShards, ...configShards];
  const resolvedTargetPlans = resolvePreciseChangedTargets(
    regularPaths.filter((file) => !uiPaths.includes(file) && !configOwnedInputs.includes(file)),
    cwd,
    documentationPaths,
    [
      ...policyTargets,
      ...dependencyConsumers.tests,
      ...resolveAffectedTestsFromImportGraph([...pluginMetadataPaths], cwd, {
        tooling: true,
        forceFull: true,
        resolveAliases: true,
        runtimeOnly: true,
      }),
      ...configGuardTargets,
      // Host consumers use the same exact-file owner as other precise targets;
      // a packed tooling neighbor is not part of the UI area contract.
      ...uiConsumers,
      // Plugin changes normally select only extension suites. This host-owned
      // proof also exercises the real Copilot entrypoint and manifest discovery.
      ...(resolutionPaths.some((changedPath) => changedPath.startsWith("extensions/copilot/"))
        ? ["src/agents/prepared-model-runtime.copilot.integration.test.ts"]
        : []),
    ],
    options,
  );
  if (resolvedTargetPlans === null) {
    return null;
  }
  if (
    resolvedTargetPlans.length === 0 &&
    wholeOwnerShards.length === 0 &&
    extensionFallbackRoots.length === 0 &&
    regularPaths.length > 0 &&
    changedPaths.every((file) => livePaths.includes(file) || documentationPaths.has(file))
  ) {
    return [];
  }
  const targetPlans = resolvedTargetPlans.filter(
    ({ target, plans }) =>
      (uiConsumers.has(target) ||
        changedPaths.includes(target) ||
        options.includeReleaseOnlyToolingShards !== false ||
        changedPaths.some(isToolingTestOwnerPath) ||
        completeOwnerTargets.has(target) ||
        (!isReleaseOnlyToolingTestFile(target) &&
          !plans.every((plan) => RELEASE_ONLY_TOOLING_CONFIGS.has(plan.config)))) &&
      !plans.every(({ config }) =>
        wholeOwnerShards.some((shard) =>
          shard.groups?.some(
            (group) =>
              group.configs.includes(config) &&
              (!group.includePatterns ||
                group.includePatterns.some((pattern) => path.matchesGlob(target, pattern))),
          ),
        ),
      ),
  );
  // Resolve every changed source first, then defer only named complete proofs.
  // Filtering inputs earlier would hide an unresolved companion or helper.
  const runtimeSelection = {
    changedPaths: livePaths,
    includeReleaseOnlyRuntimeTests: options.includeReleaseOnlyRuntimeTests,
  };
  const changedBuildArtifacts = hasBuildArtifactAffectingChange(changedPaths);
  const prTargetPlans: typeof targetPlans = [];
  for (const entry of targetPlans) {
    const { target, plans } = entry;
    if (isCiProofTestFile(target) || !isRuntimeTestFileIncluded(target, runtimeSelection, cwd)) {
      continue;
    }
    const separateExecution =
      plans.every(
        (plan) => plan.config === E2E_VITEST_CONFIG || plan.config === UI_E2E_VITEST_CONFIG,
      ) || isUiBrowserTestFile(target);
    if (!changedPaths.includes(target) && separateExecution) {
      continue;
    }
    const separateContract = plans.some(
      (plan) =>
        plan.config === CONTRACTS_PLUGIN_VITEST_CONFIG ||
        CHANNEL_CONTRACT_CONFIG_PATTERNS.has(plan.config),
    );
    const extensionOwner =
      target.startsWith("extensions/") &&
      plans.some((plan) => plan.config === resolveExtensionTestConfig(target));
    const uncoveredChannels =
      !changedBuildArtifacts &&
      plans.every((plan) => plan.config === "test/vitest/vitest.channels.config.ts");
    if (
      changedPaths.includes(target) ||
      path.resolve(cwd) !== process.cwd() ||
      separateContract ||
      extensionOwner ||
      uncoveredChannels ||
      plans.every((plan) => resolveCanonicalNodeTestConfig(target, plan.config))
    ) {
      prTargetPlans.push(entry);
      continue;
    }
    // Fully enumerated automatic suites exclude files outside their inventory.
    // General E2E and browser projects retain their separate execution owners.
    if (plans.every((plan) => resolveCanonicalNodeTestConfig(target, plan.config) === null)) {
      continue;
    }
    return fallback(
      `unresolved related test owner: ${target} (${plans.map((plan) => plan.config).join(", ")})`,
    );
  }
  const canonicalTargets = prTargetPlans
    .filter(({ target }) => !target.startsWith("extensions/"))
    .filter(
      ({ plans }) =>
        plans.every((plan) => plan.includePatterns) &&
        plans.every((plan) => isCanonicalNodeTestConfig(plan.config)) &&
        plans.every(
          (plan) =>
            plan.config !== BOUNDARY_NODE_TEST_CONFIG && plan.config !== "ui/vitest.config.ts",
        ) &&
        (prTargetPlans.length > 96 ||
          plans.some(({ config }) => nodeTestConfigRequiresCanonicalMetadata(config))),
    )
    .map(({ target }) => target);
  // Canonical shard inventories describe this checkout, never a caller's
  // synthetic or alternate source root with coincidentally matching paths.
  const canonicalShards = canonicalTargets.length
    ? path.resolve(cwd) === process.cwd()
      ? createSelectedNodeTestShardBundles(canonicalTargets, {
          runnerBackend: options.runnerBackend,
          onFallback: options.onFallback,
          ...runtimeSelection,
        })
      : null
    : [];
  if (canonicalShards === null) {
    return fallback("test targets lack canonical shard metadata");
  }
  const artifactBoundaryOwned =
    changedBuildArtifacts ||
    canonicalShards.some((shard) => shard.requiresDist) ||
    configShards.some((shard) => shard.requiresDist);
  const configBoundaryOwned = configShards.some((shard) =>
    shard.groups.some((group) => group.configs.includes(BOUNDARY_NODE_TEST_CONFIG)),
  );
  const boundaryShards =
    artifactBoundaryOwned || configBoundaryOwned ? [] : [createBoundaryShard()];
  // CI supplies the suite owners it emits. Validate every changed path first,
  // then subtract covered plans; local runs and unselected owners keep their targets.
  const targets = prTargetPlans
    .filter(({ target }) => !canonicalTargets.includes(target))
    .filter(
      ({ target, plans }) =>
        !target.startsWith("extensions/") ||
        isPluginControlUiPath(target) ||
        plans.some((plan) => !plan.includePatterns),
    )
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
            // Artifact plans and local boundary rows both execute the complete suite.
            (((artifactBoundaryOwned || boundaryShards.length > 0) &&
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
    ...uiShards,
    ...configShards,
    ...canonicalShards.map((shard) => Object.assign({}, shard, { configs: [] })),
    ...packChangedExtensionConfigShards(
      createChangedExtensionConfigShardsForPaths(extensionFallbackPaths, cwd),
    ),
    ...packChangedExtensionConfigShards(
      createChangedExtensionConfigShards(
        resolveChangedExtensionRoots(
          prTargetPlans
            .filter(
              ({ target, plans }) =>
                target.startsWith("extensions/") &&
                !isPluginControlUiPath(target) &&
                plans.every((plan) => plan.includePatterns) &&
                !extensionFallbackRoots.some((root) => target.startsWith(`${root}/`)),
            )
            .map(({ target }) => target),
        ),
        {
          cwd,
          targets: new Set(
            prTargetPlans
              .map(({ target }) => target)
              .filter(
                (target) => !extensionFallbackRoots.some((root) => target.startsWith(`${root}/`)),
              ),
          ),
        },
      ),
    ),
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
  return shards.length > 0 || targets.length < resolvedTargetPlans.length
    ? shards
    : fallback("no executable Node owner");
}
