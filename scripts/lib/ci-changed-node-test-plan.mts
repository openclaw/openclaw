import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { pluginContractPatterns } from "../../test/vitest/vitest.contracts-paths.mjs";
import { tuiPtyTestFiles } from "../../test/vitest/vitest.test-shards.mjs";
import {
  controlUiE2eTestGlobs,
  isControlUiSourcePath,
  isPluginControlUiPath,
  isUiBrowserTestFile,
  isUiTestTarget,
  uiE2eRealGatewayTestFiles,
} from "../../test/vitest/vitest.ui-paths.mjs";
import { isBoundaryTestFile } from "../../test/vitest/vitest.unit-paths.mjs";
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
  hasImportGraphImpactOnTargets,
  isRoutableChangedTarget,
  isTestFileTarget,
  listRunnableVitestConfigTargets,
  resolveAffectedTestsFromImportGraph,
  resolveChangedTestTargetPlan,
  UI_E2E_VITEST_CONFIG,
} from "../test-projects.test-support.mts";
import { getChangedPathFacts, isTestOnlyPath } from "./changed-path-facts.mjs";
import {
  createChangedExtensionConfigShards,
  packChangedExtensionConfigShards,
  resolveChangedExtensionRoots,
} from "./ci-extension-test-shards.mts";
import {
  canSplitWholeConfigGroup,
  listNodeTestConfigFiles,
  listWholeConfigFiles,
} from "./ci-node-test-inventory.mts";
import {
  createUiRealGatewayTestShards,
  hasSharedUiE2eInput,
  createSelectedNodeTestShardBundles,
  packNodeTestGroups,
  nodeTestConfigRequiresCanonicalMetadata,
  resolveCanonicalNodeTestConfig,
  isCanonicalNodeTestConfig,
  isRuntimeTestFileIncluded,
  SOURCE_CHANNEL_TEST_POLICY,
  type NodeTestShard,
  type RuntimeTestSelection,
} from "./ci-node-test-plan.mts";
import { resolvePolicyTestTargets } from "./ci-policy-test-watch.mts";
import {
  isCiProofTestFile,
  isPrExemptRuntimeTestFile,
  isReleaseOnlyRuntimeTestFile,
  listPrExemptRuntimeTestFiles,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "./ci-proof-test-inventory.mts";
import {
  readCompactGroupTimings,
  readRepoE2eFileTimings,
  readToolingFileTimings,
} from "./ci-test-timings.mts";
import {
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
} from "./extension-test-plan.mts";
import {
  mergeVitestPretestBuildModes,
  resolveVitestPretestBuildMode,
} from "./vitest-build-prerequisites.mts";
import {
  createCompactSplitTimingGeneration,
  estimateVitestTestFileSeconds,
  estimateVitestToolingFileSeconds,
  VITEST_PRETEST_BUILD_SECONDS,
} from "./vitest-shard-metadata.mts";

type ChangedNodeTestShard = NodeTestShard & {
  targets?: string[];
};
type CwdOptions = { cwd?: string };
type PlanDiagnostic = (reason: string) => void;
type ChangedTargetValidation = {
  baseRef?: string;
  onFallback?: PlanDiagnostic;
  selectionMode?: "full" | "aggressive";
  onSelection?: (selection: { rule: string; input: string; targets: string[] }) => void;
};
const BROWSER_EXTENSION_E2E_TEST_FILE =
  "extensions/browser/chrome-extension/bootstrap.chromium.test.ts";

/** Ordinary UI unit entries retain their unit owner; fixtures and their consumers retain E2E. */
export function hasUiE2eAffectingChange(
  changedPaths: string[],
  options: CwdOptions & { family?: "control-ui" | "browser-extension" | "real-gateway" } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return true;
  }
  if (
    options.family !== "browser-extension" &&
    options.family !== "real-gateway" &&
    hasSharedUiE2eInput(changedPaths)
  ) {
    return true;
  }
  const relevantPaths = changedPaths.filter(
    (file) =>
      !isDocumentationPath(file) &&
      getChangedPathFacts(file).surface !== "rootGlobal" &&
      file !== "test/vitest/vitest.shared.config.ts" &&
      file !== "tsconfig.json",
  );
  if (relevantPaths.length === 0) {
    return false;
  }
  if (options.family === "browser-extension") {
    const workflowInputs = relevantPaths.filter((file) => file.startsWith(".github/"));
    return (
      relevantPaths.some((file) => file.startsWith("extensions/browser/chrome-extension/")) ||
      (workflowInputs.length > 0 && detectChangedScope(workflowInputs).runUiTests) ||
      hasImportGraphImpactOnTargets(
        relevantPaths,
        [
          BROWSER_EXTENSION_E2E_TEST_FILE,
          "test/vitest/vitest.e2e.config.ts",
          "scripts/ensure-playwright-chromium.mts",
        ],
        cwd,
        { tooling: true, resolveAliases: true },
      )
    );
  }
  if (options.family === "real-gateway") {
    return (
      relevantPaths.some(
        (file) =>
          !isTestOnlyPath(file) &&
          (file.startsWith("src/gateway/") || file.startsWith("packages/gateway-protocol/")),
      ) ||
      hasImportGraphImpactOnTargets(
        relevantPaths,
        [
          ...uiE2eRealGatewayTestFiles,
          ...new Set(
            createUiRealGatewayTestShards([]).flatMap((shard) =>
              shard.groups.flatMap((group) => group.configs),
            ),
          ),
        ],
        cwd,
        { tooling: true, resolveAliases: true },
      )
    );
  }
  // The extension bootstrap has a separate Chromium job; its source tree is
  // not a Control UI owner. Shared imports can still select either family.
  const controlUiPaths = relevantPaths.filter(
    (file) => !file.startsWith("extensions/browser/chrome-extension/"),
  );
  if (controlUiPaths.length === 0 || !detectChangedScope(controlUiPaths).runUiTests) {
    return hasImportGraphImpactOnTargets(
      controlUiPaths,
      (file) =>
        !isTestOnlyPath(file) &&
        (isControlUiSourcePath(file) ||
          file.startsWith("packages/gateway-protocol/") ||
          file === "src/gateway/control-ui.ts"),
      cwd,
      { tooling: true, resolveAliases: true },
    );
  }
  if (
    relevantPaths.some(
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
  return hasImportGraphImpactOnTargets(
    relevantPaths,
    (file) =>
      isUiBrowserTestFile(file) ||
      uiE2eRealGatewayTestFiles.includes(file) ||
      controlUiE2eTestGlobs.some((pattern) => path.matchesGlob(file, pattern)),
    cwd,
    { tooling: true, resolveAliases: true },
  );
}

const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
// Each target runs in its own child process (isolation contract), so bound the
// serial tail per job; the shard runner overlaps two children at a time.
const CHANGED_NODE_TEST_TARGETS_PER_JOB = 12;
const PR_NODE_TEST_SECONDS = 150;
// Memory Core targets perform real SQLite/indexing work. Two concurrent Vitest
// processes starve each other on 4-vCPU runners and push otherwise healthy
// integration tests past the global timeout.
const SERIAL_CHANGED_TARGET_RE = /^extensions\/memory-core\//u;
const BOUNDARY_NODE_TEST_CONFIG = "test/vitest/vitest.boundary.config.ts";

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

// UI artifacts and their own build/performance policy retain explicit ownership;
// workspace packages use their direct UI import edges instead of a global fallback.
const CONTROL_UI_PERFORMANCE_SURFACE_RE =
  /^ui\/|^extensions\/[^/]+\/browser(?:\/|$)|^tsconfig\.ui\.json$|^scripts\/(?:check-control-ui-(?:performance(?:-base)?|precompressed-assets)\.mts|ui\.(?:mts|js)|lib\/ci-changed-node-test-plan\.mts)$|^config\/control-ui-startup-budget-baseline\.json$|^\.github\/workflows\/ci\.yml$/u;

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
      (!isTestOnlyPath(file) &&
        (getChangedPathFacts(file).surface === "ui" || isPluginControlUiPath(file))) ||
      /^scripts\/check-control-ui-(?:performance(?:-base)?|precompressed-assets)\.mts$/u.test(file),
    options.cwd ?? process.cwd(),
    { tooling: true, resolveAliases: true, runtimeOnly: true },
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

export function resolveReleaseFastLaneScope(
  changedPaths: readonly string[] | null,
  options: CwdOptions = {},
): { eligible: true } | { eligible: false; reason: string } {
  if (!changedPaths?.length) {
    return { eligible: false, reason: "missing changed paths" };
  }
  const globalInput = changedPaths.find((file) => GLOBAL_NODE_TEST_INPUT_RE.test(file));
  if (globalInput) {
    return { eligible: false, reason: `global execution or resolution input: ${globalInput}` };
  }
  const cwd = options.cwd ?? process.cwd();
  const outsideScope = changedPaths.find(
    (file) =>
      !file.startsWith(".github/workflows/") &&
      !file.startsWith("scripts/") &&
      !file.startsWith("test/scripts/") &&
      !/^\.agents\/skills\/release-[^/]+\//u.test(file) &&
      file !== "docs/reference/RELEASING.md" &&
      !isIndependentlyCheckedDocumentation(file, cwd),
  );
  return outsideScope === undefined
    ? { eligible: true }
    : { eligible: false, reason: `outside the release tooling scope: ${outsideScope}` };
}

/** The fixed cross-area smoke travels through the same exact-file owners as changed tests. */
const PR_SMOKE_TEST_FILES = [
  "test/gateway-rpc-exporters.test.ts",
  "src/config/io.load-async.test.ts",
  "src/config/io.compat.test.ts",
  "src/config/utility-model-separation-migration.io.test.ts",
  "src/plugins/loader.runtime-registry.test.ts",
  "test/qa-channel-message-tool-delivery.test.ts",
];
const AGGRESSIVE_PR_SMOKE_TEST_FILES = [
  "src/config/io.load-async.test.ts",
  "src/plugins/loader.runtime-registry.test.ts",
];
const protectedRuntimeTestFiles = new Set(PR_PROTECTED_RUNTIME_TEST_FILES);

/** Resolve owner areas and transitive consumers once, before projecting platform jobs. */
export function resolveChangedNodeTestTargets(
  changedPaths: string[],
  options: CwdOptions & ChangedTargetValidation & RuntimeTestSelection = {},
): string[] {
  const cwd = options.cwd ?? process.cwd();
  const paths = changedPaths.filter((file) => !isIndependentlyCheckedDocumentation(file, cwd));
  const aggressive = options.selectionMode === "aggressive";
  const smoke = aggressive ? AGGRESSIVE_PR_SMOKE_TEST_FILES : PR_SMOKE_TEST_FILES;
  const selections: { rule: string; input: string; targets: string[] }[] = [];
  const recordSelection = (selection: (typeof selections)[number]) => selections.push(selection);
  const targetPlan = resolveChangedTestTargetPlan(paths, {
    cwd,
    broad: false,
    boundedOwners: true,
    baseRef: options.baseRef,
    aggressive: aggressive ? { maxDirectImporters: 20, maxDirectoryTests: 30 } : undefined,
    combineSiblingWithImportGraph: true,
    resolveAliases: true,
    runtimeOnly: true,
    includeExtensionImpact: false,
    onSelection: options.onSelection ? recordSelection : undefined,
  });
  if (paths.length > 0 && targetPlan.mode !== "targets") {
    throw new Error(`Unresolved changed-owner test plan: ${targetPlan.mode}`);
  }
  const ownsFile = (file: string) =>
    targetPlan.ownerAreas?.some((area) => file.startsWith(`${area}/`)) === true;
  // Dependency and global build inputs reach every runtime area. Keep the
  // observed regression inventory without restoring the whole runtime suite.
  const globalProtection = paths.some((file) => getChangedPathFacts(file).surface === "rootGlobal");
  const affectedProtectedTests =
    globalProtection || aggressive
      ? []
      : resolveAffectedTestsFromImportGraph(paths, cwd, {
          tooling: true,
          forceFull: true,
          resolveAliases: true,
          runtimeOnly: true,
        }).filter((file) => protectedRuntimeTestFiles.has(file));
  const ownerOptIns = aggressive
    ? []
    : [
        ...PR_PROTECTED_RUNTIME_TEST_FILES.filter((file) => globalProtection || ownsFile(file)),
        ...affectedProtectedTests,
        ...listPrExemptRuntimeTestFiles(cwd).filter(ownsFile),
      ];
  recordSelection({ rule: "protected-owner", input: paths.join(", "), targets: ownerOptIns });
  recordSelection({
    rule: "policy-watch",
    input: paths.join(", "),
    targets: resolvePolicyTestTargets(paths),
  });
  recordSelection({ rule: "fixed-smoke", input: "PR", targets: smoke });
  const owners = [
    ...new Set([
      ...targetPlan.targets,
      ...(aggressive
        ? paths.filter((file) => isTestFileTarget(file) && isRoutableChangedTarget(file))
        : []),
      ...ownerOptIns,
      ...(aggressive
        ? []
        : paths.filter(
            (file) =>
              listRunnableVitestConfigTargets().includes(file) && isCanonicalNodeTestConfig(file),
          )),
      ...(paths.some((file) => listRunnableVitestConfigTargets().includes(file))
        ? ["test/vitest-projects-config.test.ts"]
        : []),
      ...resolvePolicyTestTargets(paths),
    ]),
  ];
  let inventory: string[] | undefined;
  const allFiles = () =>
    (inventory ??= listExtensionTestFilesForRoots(
      ["src", "test", "extensions", "packages", "ui"],
      cwd,
    ));
  const optInTargets = new Set([...paths, ...smoke, ...ownerOptIns]);
  const expandTarget = (target: string): string[] => {
    if (isTestFileTarget(target)) {
      optInTargets.add(target);
      return [target];
    }
    if (listRunnableVitestConfigTargets().includes(target)) {
      // Explicit config owners retain their inventory, while shared config hubs
      // resolve to the selector/guard owners above rather than all config users.
      const ownedFiles =
        path.resolve(cwd) === process.cwd()
          ? (listNodeTestConfigFiles(target) ??
            allFiles().filter((file) =>
              buildVitestRunPlans([file], cwd).some(
                (plan) =>
                  resolveCanonicalNodeTestConfig(file, plan.config) === target ||
                  plan.config === target,
              ),
            ))
          : [];
      if (paths.includes(target)) {
        for (const file of ownedFiles) {
          optInTargets.add(file);
        }
      }
      return ownedFiles;
    }
    const entry = lstatSync(path.join(cwd, target), { throwIfNoEntry: false });
    if (entry?.isDirectory()) {
      return listExtensionTestFilesForRoots([target], cwd);
    }
    // Mapped globs are owner contracts; ordinary source names are not test globs.
    return target.includes("*") ? allFiles().filter((file) => path.matchesGlob(file, target)) : [];
  };
  const expanded = new Map(owners.map((target) => [target, expandTarget(target)]));
  const files = [...expanded.values()].flat();
  const selected = [...new Set([...files, ...smoke])]
    .filter(
      (file) =>
        isTestFileTarget(file) &&
        !file.endsWith(".live.test.ts") &&
        (optInTargets.has(file) ||
          ((options.includePrExemptRuntimeTests !== false || !isPrExemptRuntimeTestFile(file)) &&
            (options.includeReleaseOnlyRuntimeTests !== false ||
              !isReleaseOnlyRuntimeTestFile(file)))) &&
        lstatSync(path.join(cwd, file), { throwIfNoEntry: false })?.isFile(),
    )
    .toSorted();
  if (options.onSelection) {
    const selectedSet = new Set(selected);
    const explained = new Set<string>();
    for (const selection of selections) {
      const targets = [
        ...new Set(selection.targets.flatMap((target) => expanded.get(target) ?? [target])),
      ].filter((file) => selectedSet.has(file));
      targets.forEach((file) => explained.add(file));
      options.onSelection({ ...selection, targets });
    }
    options.onSelection({
      rule: "config-owner",
      input: paths.join(", "),
      targets: selected.filter((file) => !explained.has(file)),
    });
  }
  return selected;
}

function resolvePreciseChangedTargets(targets: readonly string[], cwd: string) {
  return targets.map((target) => {
    // Plugin opt-ins reuse source routing before canonical config remapping.
    const sourcePlans = buildVitestRunPlans([target], cwd);
    return {
      target,
      sourcePlans,
      plans: sourcePlans.map((targetPlan) => {
        const config =
          path.resolve(cwd) === process.cwd()
            ? resolveCanonicalNodeTestConfig(target, targetPlan.config)
            : undefined;
        return config && config !== targetPlan.config
          ? Object.assign({}, targetPlan, { config, includePatterns: [target], forwardedArgs: [] })
          : targetPlan;
      }),
    };
  });
}

function createChangedTargetShards(
  targets: NonNullable<ReturnType<typeof resolvePreciseChangedTargets>>,
  names: { checkName: string; shardName: string },
  rowBudget?: number,
) {
  const timings = { ...readRepoE2eFileTimings(), ...readToolingFileTimings("blacksmith") };
  // Target children use source routing, even when selection remaps their canonical owner.
  const buildModeOf = (chunk: typeof targets) =>
    chunk.some(({ sourcePlans }) => sourcePlans.some((plan) => plan.config === E2E_VITEST_CONFIG))
      ? "private-qa"
      : resolveVitestPretestBuildMode([{ includePatterns: chunk.map(({ target }) => target) }]);
  const targetChunks: (typeof targets)[] = [];
  if (rowBudget !== undefined) {
    const byPolicy = new Map<string, { targets: typeof targets; seconds: number; rows: number }>();
    for (const entry of targets) {
      const key = JSON.stringify([
        buildModeOf([entry]),
        SERIAL_CHANGED_TARGET_RE.test(entry.target),
      ]);
      const partition = byPolicy.get(key) ?? { targets: [], seconds: 0, rows: 1 };
      partition.targets.push(entry);
      partition.seconds += timings[entry.target] ?? 20;
      byPolicy.set(key, partition);
    }
    const partitions = [...byPolicy.values()];
    if (partitions.length > rowBudget) {
      throw new Error(
        `${partitions.length} execution policies exceed the changed-target row budget of ${rowBudget}`,
      );
    }
    // Highest-averages apportionment preserves at least one row per policy
    // without spreading build preparation or serial admission across other work.
    for (let remaining = rowBudget - partitions.length; remaining > 0; remaining -= 1) {
      const eligible = partitions.filter((partition) => partition.rows < partition.targets.length);
      if (eligible.length === 0) {
        break;
      }
      const next = eligible.reduce((best, partition) =>
        partition.seconds / (partition.rows + 1) > best.seconds / (best.rows + 1)
          ? partition
          : best,
      );
      next.rows += 1;
    }
    for (const partition of partitions) {
      const bins: { targets: typeof targets; seconds: number }[] = Array.from(
        { length: partition.rows },
        () => ({ targets: [], seconds: 0 }),
      );
      for (const entry of partition.targets.toSorted(
        (a, b) => (timings[b.target] ?? 20) - (timings[a.target] ?? 20),
      )) {
        const bin = bins.reduce((best, candidate) =>
          candidate.seconds < best.seconds ? candidate : best,
        );
        bin.targets.push(entry);
        bin.seconds += timings[entry.target] ?? 20;
      }
      targetChunks.push(...bins.map((bin) => bin.targets));
    }
  } else {
    let pendingChunk: typeof targets = [];
    let seconds = 0;
    for (const entry of targets) {
      const cost = timings[entry.target] ?? 20;
      if (
        pendingChunk.length &&
        (pendingChunk.length >= CHANGED_NODE_TEST_TARGETS_PER_JOB ||
          seconds + cost > PR_NODE_TEST_SECONDS)
      ) {
        targetChunks.push(pendingChunk);
        pendingChunk = [];
        seconds = 0;
      }
      pendingChunk.push(entry);
      seconds += cost;
    }
    if (pendingChunk.length) {
      targetChunks.push(pendingChunk);
    }
  }
  return targetChunks.map((chunk, index) => {
    const suffix = targetChunks.length === 1 ? "" : `-${index + 1}`;
    const shard: ChangedNodeTestShard = {
      checkName: `${names.checkName}${suffix}`,
      configs: [],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: `${names.shardName}${suffix}`,
      targets: chunk.map(({ target }) => target),
      predictedSeconds: Math.ceil(
        chunk.reduce((sum, { target }) => sum + (timings[target] ?? 20), 0),
      ),
    };
    const pretestBuildMode = buildModeOf(chunk);
    if (pretestBuildMode) {
      shard.pretestBuildMode = pretestBuildMode;
    }
    if (chunk.some(({ target }) => SERIAL_CHANGED_TARGET_RE.test(target))) {
      shard.planConcurrency = 1;
    }
    return shard;
  });
}

/** Narrow canonical envelopes without changing their workers, routing, or isolation. */
function boundChangedNodeRows(
  shards: ChangedNodeTestShard[],
  selectedTargets: readonly string[],
  runnerBackend?: string,
  cwd = process.cwd(),
): ChangedNodeTestShard[] {
  const profile = runnerBackend === "github" ? "github" : "blacksmith";
  const fileTimings = { ...readRepoE2eFileTimings(), ...readToolingFileTimings(profile) };
  const groupTimings = readCompactGroupTimings(profile);
  const selected = new Set(selectedTargets);
  return shards.flatMap((shard) => {
    if (!shard.groups) {
      const files = shard.includePatterns;
      const testSeconds = (row: ChangedNodeTestShard) =>
        row.predictedSeconds === undefined
          ? undefined
          : Math.max(
              0,
              row.predictedSeconds -
                (row.pretestBuildMode ? VITEST_PRETEST_BUILD_SECONDS[row.pretestBuildMode] : 0),
            );
      if (
        !shard.requiresDist &&
        (testSeconds(shard) ?? 0) > PR_NODE_TEST_SECONDS &&
        files &&
        files.length > 1 &&
        files.every((file) => getChangedPathFacts(file).surface === "extension")
      ) {
        const split = (targets: string[]): ReturnType<typeof createChangedExtensionConfigShards> =>
          createChangedExtensionConfigShards(resolveChangedExtensionRoots(targets), {
            cwd,
            targets: new Set(targets),
          }).flatMap((row) => {
            const selectedFiles = row.includePatterns;
            if (
              testSeconds(row)! <= PR_NODE_TEST_SECONDS ||
              !selectedFiles ||
              selectedFiles.length < 2
            ) {
              return [row];
            }
            const middle = Math.ceil(selectedFiles.length / 2);
            return split(selectedFiles.slice(0, middle)).concat(split(selectedFiles.slice(middle)));
          });
        return split(files).map((row, index) =>
          Object.assign({}, row, {
            checkName: `${shard.checkName}-${index + 1}`,
            shardName: `${shard.shardName}-${index + 1}`,
            predictedTestSeconds: testSeconds(row),
          }),
        );
      }
      return [shard];
    }
    const canonicalTestSeconds = shard.predictedTestSeconds ?? shard.predictedSeconds;
    if (canonicalTestSeconds === undefined || canonicalTestSeconds <= PR_NODE_TEST_SECONDS) {
      return [shard];
    }
    const pieces = shard.groups.flatMap((group) => {
      // Static boundary guards are fixed correctness gates, outside runtime selection.
      if (group.configs.includes(BOUNDARY_NODE_TEST_CONFIG)) {
        return [{ group, seconds: 0 }];
      }
      const estimatedGroup =
        groupTimings[group.timing_key ?? group.shard_name] ??
        groupTimings[group.shard_name] ??
        shard.predictedSeconds;
      const atomic =
        group.requiresDist ||
        group.configs.length > 1 ||
        !canSplitWholeConfigGroup(group.shard_name);
      const files =
        (atomic
          ? (group.includePatterns ??
            group.configs.flatMap((config) => listNodeTestConfigFiles(config) ?? []))
          : group.includePatterns?.filter((file) => selected.has(file))) ??
        selectedTargets.filter((file) =>
          buildVitestRunPlans([file]).some((plan) =>
            group.configs.includes(
              resolveCanonicalNodeTestConfig(file, plan.config) ?? plan.config,
            ),
          ),
        );
      if (files.length === 0) {
        return atomic ? [{ group, seconds: estimatedGroup ?? canonicalTestSeconds }] : [];
      }
      // Retain a conservative share of the original envelope when file timings
      // are absent. These are admission estimates; the replay reports cold wall separately.
      const originalCount =
        listWholeConfigFiles(group.shard_name)?.length ??
        group.configs.reduce(
          (count, config) => count + (listNodeTestConfigFiles(config)?.length ?? 0),
          0,
        );
      const groupFileSeconds = originalCount > 0 ? (estimatedGroup ?? 0) / originalCount : 0;
      const costOf = (file: string) =>
        Math.max(
          groupFileSeconds,
          fileTimings[file] ??
            (group.configs[0] === "test/vitest/vitest.tooling.config.ts"
              ? estimateVitestToolingFileSeconds(file)
              : estimateVitestTestFileSeconds(file)),
        );
      // An atomic group keeps its complete process owner, but does not make
      // unrelated groups in the same canonical row indivisible.
      if (atomic) {
        return [{ group, seconds: Math.ceil(files.reduce((sum, file) => sum + costOf(file), 0)) }];
      }
      const chunks: string[][] = [];
      let chunk: string[] = [];
      let seconds = 0;
      for (const file of files) {
        const cost = costOf(file);
        if (chunk.length && seconds + cost > PR_NODE_TEST_SECONDS) {
          chunks.push(chunk);
          chunk = [];
          seconds = 0;
        }
        chunk.push(file);
        seconds += cost;
      }
      if (chunk.length) {
        chunks.push(chunk);
      }
      const { timingKeys } = createCompactSplitTimingGeneration({
        configs: group.configs,
        env: group.env,
        parentShardName: `changed-${group.shard_name}`,
        stripes: chunks,
      });
      return chunks.map((includePatterns, index) => ({
        group: { ...group, includePatterns, timing_key: timingKeys[index] },
        seconds: Math.ceil(includePatterns.reduce((sum, file) => sum + costOf(file), 0)),
      }));
    });
    const testSeconds = (entries: readonly (typeof pieces)[number][]) => {
      const slots = Array.from({ length: shard.planConcurrency ?? 1 }, () => 0);
      for (const entry of entries) {
        const slot = slots.indexOf(Math.min(...slots));
        slots[slot]! += entry.seconds;
      }
      return Math.ceil(Math.max(...slots));
    };
    const bins = packNodeTestGroups(
      pieces,
      (bin, piece) =>
        ((shard.planConcurrency ?? 1) === 1 ||
          bin.every((entry) => entry.group.shard_name !== piece.group.shard_name)) &&
        testSeconds([...bin, piece]) <= PR_NODE_TEST_SECONDS,
      true,
    );
    return bins.map((bin, index) =>
      Object.assign({}, shard, {
        checkName: bins.length === 1 ? shard.checkName : `${shard.checkName}-${index + 1}`,
        shardName: bins.length === 1 ? shard.shardName : `${shard.shardName}-${index + 1}`,
        groups: bin.map(({ group }) => group),
        requiresDist: bin.some(({ group }) => group.requiresDist),
        pretestBuildMode: mergeVitestPretestBuildModes([
          shard.pretestBuildMode,
          ...bin.map(({ group }) => group.pretestBuildMode),
        ]),
        predictedSeconds: bin.reduce((seconds, piece) => seconds + piece.seconds, 0),
        predictedTestSeconds: testSeconds(bin),
      }),
    );
  });
}

/**
 * Builds bounded PR jobs from precise changed-test targets.
 * Missing input is an error for the caller; changed inputs never widen to a full suite.
 */
export function createChangedNodeTestShards(
  changedPaths: string[],
  options: CwdOptions &
    ChangedTargetValidation & {
      runnerBackend?: string;
      compactNodeJobCap?: number;
      includeReleaseOnlyRuntimeTests?: boolean;
      includePrExemptRuntimeTests?: boolean;
      dedicatedContractShards?: readonly { task: string; includePatterns: readonly string[] }[];
      dedicatedBuildArtifacts?: boolean;
      dedicatedUiE2e?: boolean;
      dedicatedUiTests?: boolean;
      selectedTestTargets?: readonly string[];
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

  if (
    changedPaths.some(
      (file) =>
        file !== file.trim() ||
        file.includes("\\") ||
        path.posix.normalize(file) !== file ||
        path.isAbsolute(file) ||
        file.startsWith("../"),
    )
  ) {
    return fallback("invalid changed path");
  }

  const selectedTargets =
    options.selectedTestTargets ?? resolveChangedNodeTestTargets(changedPaths, options);
  const livePaths = changedPaths.filter((file) => existsSync(path.join(cwd, file)));
  const policyTargets = new Set(resolvePolicyTestTargets(changedPaths));
  const resolvedTargetPlans = resolvePreciseChangedTargets(selectedTargets, cwd);
  if (resolvedTargetPlans.some(({ plans }) => plans.length === 0)) {
    return fallback("selected test lacks an executable owner");
  }
  const targetPlans = resolvedTargetPlans;
  // Resolve every changed source first, then defer only named complete proofs.
  // Filtering inputs earlier would hide an unresolved companion or helper.
  const runtimeSelection = {
    changedPaths: [...livePaths, ...selectedTargets],
    includeReleaseOnlyRuntimeTests: options.includeReleaseOnlyRuntimeTests,
    includePrExemptRuntimeTests: options.includePrExemptRuntimeTests,
  };
  const changedBuildArtifacts =
    options.dedicatedBuildArtifacts === true && hasBuildArtifactAffectingChange(changedPaths);
  const prTargetPlans: typeof targetPlans = [];
  for (const entry of targetPlans) {
    const { target, plans } = entry;
    if (
      isCiProofTestFile(target) ||
      (options.dedicatedBuildArtifacts === false && tuiPtyTestFiles.includes(target)) ||
      (!PR_SMOKE_TEST_FILES.includes(target) &&
        !policyTargets.has(target) &&
        !isRuntimeTestFileIncluded(target, runtimeSelection, cwd))
    ) {
      continue;
    }
    if (
      (options.dedicatedUiTests && isUiTestTarget(target)) ||
      (options.dedicatedUiE2e &&
        (target === BROWSER_EXTENSION_E2E_TEST_FILE ||
          plans.every((plan) => plan.config === UI_E2E_VITEST_CONFIG)))
    ) {
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
      plans.every((plan) => plan.config === SOURCE_CHANNEL_TEST_POLICY.config);
    if (
      changedPaths.includes(target) ||
      path.resolve(cwd) !== process.cwd() ||
      separateContract ||
      extensionOwner ||
      uncoveredChannels ||
      plans.every(
        (plan) =>
          !nodeTestConfigRequiresCanonicalMetadata(plan.config) &&
          ((plan.includePatterns?.length === 1 && plan.includePatterns[0] === target) ||
            (plan.forwardedArgs.length === 1 && plan.forwardedArgs[0] === target)),
      ) ||
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
        plans.every(
          (plan) =>
            plan.config !== BOUNDARY_NODE_TEST_CONFIG && plan.config !== "ui/vitest.config.ts",
        ) &&
        (prTargetPlans.length > 96 ||
          plans.some(({ config }) => nodeTestConfigRequiresCanonicalMetadata(config))) &&
        plans.every((plan) => isCanonicalNodeTestConfig(plan.config)),
    )
    .map(({ target }) => target);
  // Canonical shard inventories describe this checkout, never a caller's
  // synthetic or alternate source root with coincidentally matching paths.
  const canonicalShards = canonicalTargets.length
    ? path.resolve(cwd) === process.cwd()
      ? createSelectedNodeTestShardBundles(canonicalTargets, {
          runnerBackend: options.runnerBackend,
          onFallback: options.onFallback,
          preparedTestPlans: new Map(
            prTargetPlans.map(({ target, sourcePlans }) => [target, sourcePlans]),
          ),
          // These exact targets already passed deferral above, including explicit policy watches.
          includeReleaseOnlyRuntimeTests: true,
          includePrExemptRuntimeTests: true,
        })
      : null
    : [];
  if (canonicalShards === null) {
    return fallback("test targets lack canonical shard metadata");
  }
  const artifactBoundaryOwned =
    changedBuildArtifacts || canonicalShards.some((shard) => shard.requiresDist);
  const boundaryShards = artifactBoundaryOwned ? [] : [createBoundaryShard()];
  const channelTargets = new Set(
    options.dedicatedBuildArtifacts === false
      ? prTargetPlans
          .filter(({ plans }) =>
            plans.every((plan) => plan.config === SOURCE_CHANNEL_TEST_POLICY.config),
          )
          .map(({ target }) => target)
      : [],
  );
  const channelShards: ChangedNodeTestShard[] =
    !artifactBoundaryOwned && channelTargets.size > 0
      ? [
          {
            checkName: "checks-node-changed-channels",
            configs: [SOURCE_CHANNEL_TEST_POLICY.config],
            includePatterns: [...channelTargets],
            env: { ...SOURCE_CHANNEL_TEST_POLICY.env },
            requiresDist: false,
            runner: DEFAULT_NODE_TEST_RUNNER,
            shardName: "changed-channels",
          },
        ]
      : [];
  // CI supplies the suite owners it emits. Validate every changed path first,
  // then subtract covered plans; local runs and unselected owners keep their targets.
  const targets = prTargetPlans
    .filter(({ target }) => !canonicalTargets.includes(target))
    .filter(({ target }) => !channelTargets.has(target))
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
    );

  const otherShards = [
    ...channelShards,
    ...canonicalShards.map((shard) => Object.assign({}, shard, { configs: [] })),
    ...packChangedExtensionConfigShards(
      createChangedExtensionConfigShards(
        resolveChangedExtensionRoots(
          prTargetPlans
            .filter(
              ({ target, plans }) =>
                target.startsWith("extensions/") &&
                !isPluginControlUiPath(target) &&
                plans.every((plan) => plan.includePatterns),
            )
            .map(({ target }) => target),
        ),
        {
          cwd,
          targets: new Set(prTargetPlans.map(({ target }) => target)),
        },
      ),
    ),
  ];
  // Native browser files run in checks-ui, including precise changed-file plans.
  const changedTargets = targets.filter(({ target }) => !isUiBrowserTestFile(target));
  const names = { checkName: "checks-node-changed", shardName: "changed" };
  const shards = [
    ...otherShards,
    ...createChangedTargetShards(changedTargets, names),
    ...boundaryShards,
  ];
  // Covered source targets keep build-artifacts ownership even with no Node rows.
  const bounded = boundChangedNodeRows(shards, selectedTargets, options.runnerBackend, cwd);
  // Time-based splitting must not make an admitted owner plan exceed the matrix
  // budget. Retain its compact rows, including plugin work, without widening scope.
  const cap = options.compactNodeJobCap;
  if (cap === undefined || bounded.filter((shard) => !shard.requiresDist).length <= cap) {
    return bounded;
  }
  const otherNonDistRows = [...otherShards, ...boundaryShards].filter(
    (shard) => !shard.requiresDist,
  ).length;
  if (shards.filter((shard) => !shard.requiresDist).length <= cap || otherNonDistRows >= cap) {
    return shards;
  }
  // Only target chunks may grow to fit the remaining rows; all other owners
  // keep their compact execution envelopes and the workflow owns final admission.
  return [
    ...otherShards,
    ...createChangedTargetShards(changedTargets, names, cap - otherNonDistRows),
    ...boundaryShards,
  ];
}
