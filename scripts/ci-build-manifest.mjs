import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path, { matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTestGitCommits } from "../.github/actions/git-owner/test-prerequisites.mjs";
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "./lib/ci-ios-smoke-plan.mjs";
import { resolveReleaseContextIdentity } from "./lib/release-context.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";

// The script belongs to the trusted harness; target modules belong to the cwd.
const fromTarget = (specifier) => pathToFileURL(path.resolve(process.cwd(), specifier)).href;
const escapeSummaryHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const workflowEventName = process.env.OPENCLAW_CI_EVENT_NAME ?? "";
// Dispatch fallbacks retain their existing scope even when they use PR planning.
const ordinaryPullRequest = workflowEventName === "pull_request";
const ciQualification =
  workflowEventName === "workflow_dispatch" &&
  process.env.OPENCLAW_CI_RELEASE_GATE === "true" &&
  (process.env.OPENCLAW_CI_QUALIFICATION === "true" ||
    process.env.OPENCLAW_CI_NODE_RUNNER_BACKEND === "runson");
const mainQualification = ciQualification && process.env.OPENCLAW_CI_SHAPE === "main";
const eventName = ciQualification
  ? mainQualification
    ? "push"
    : "pull_request"
  : workflowEventName;
const eventRef = mainQualification ? "refs/heads/main" : process.env.GITHUB_REF;
const checkoutRevision = process.env.OPENCLAW_CI_CHECKOUT_REVISION ?? "";
const workflowRevision = process.env.OPENCLAW_CI_WORKFLOW_REVISION ?? "";
const historicalTargetApproved = process.env.OPENCLAW_CI_HISTORICAL_TARGET === "true";
const historicalTarget =
  eventName === "workflow_dispatch" &&
  historicalTargetApproved &&
  checkoutRevision !== workflowRevision;
const releaseCandidateTarget =
  eventName === "workflow_dispatch" &&
  process.env.OPENCLAW_CI_RELEASE_CANDIDATE_TARGET === "true" &&
  checkoutRevision !== workflowRevision;
const targetContextTarget =
  eventName === "workflow_dispatch" &&
  process.env.OPENCLAW_CI_TARGET_CONTEXT_TARGET === "true" &&
  checkoutRevision !== workflowRevision;
const compatibilityTarget = historicalTarget || releaseCandidateTarget || targetContextTarget;
const frozenTarget = eventName === "workflow_dispatch" && checkoutRevision !== workflowRevision;

// Frozen releases use current trusted shard budgets while discovery
// and test execution keep the candidate checkout as their root.
const nodeTestPlanPath = frozenTarget
  ? "./lib/ci-node-test-plan.mts"
  : existsSync("./scripts/lib/ci-node-test-plan.mts")
    ? fromTarget("./scripts/lib/ci-node-test-plan.mts")
    : fromTarget("./scripts/lib/ci-node-test-plan.mjs");
const nodeTestPlan = await import(nodeTestPlanPath);
const createNodeTestPlan =
  typeof nodeTestPlan.createNodeTestShardBundles === "function"
    ? nodeTestPlan.createNodeTestShardBundles
    : compatibilityTarget
      ? nodeTestPlan.createNodeTestShards
      : undefined;
if (typeof createNodeTestPlan !== "function") {
  throw new Error("CI target does not export a supported Node test shard planner");
}
let sourceChannelTestEnv = nodeTestPlan.SOURCE_CHANNEL_TEST_POLICY?.env;
if (!sourceChannelTestEnv) {
  if (!frozenTarget || !compatibilityTarget) {
    throw new Error("Current CI target does not export SOURCE_CHANNEL_TEST_POLICY");
  }
  // Named frozen targets retain the channel policy that predates this export.
  sourceChannelTestEnv = {
    NODE_OPTIONS: "--max-old-space-size=8192",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
  };
}

const importTargetPlan = async (targetPath) => {
  if (existsSync(targetPath)) {
    return import(fromTarget(targetPath));
  }
  if (!compatibilityTarget) {
    throw new Error(`Current CI target does not provide ${targetPath}`);
  }
  return {};
};
const changedNodeTestPlan = await importTargetPlan(
  existsSync("./scripts/lib/ci-changed-node-test-plan.mts")
    ? "./scripts/lib/ci-changed-node-test-plan.mts"
    : "./scripts/lib/ci-changed-node-test-plan.mjs",
);
const dockerSeedPlan = existsSync("./scripts/lib/ci-docker-seed-plan.mts")
  ? await import(fromTarget("./scripts/lib/ci-docker-seed-plan.mts"))
  : {};
const publishedDriverUpdatePlan = existsSync("./scripts/lib/ci-published-driver-update-plan.mts")
  ? await import(fromTarget("./scripts/lib/ci-published-driver-update-plan.mts"))
  : {};
const channelContractPlan = await importTargetPlan(
  existsSync("./scripts/lib/channel-contract-test-plan.mts")
    ? "./scripts/lib/channel-contract-test-plan.mts"
    : "./scripts/lib/channel-contract-test-plan.mjs",
);
const windowsTestPlan = existsSync("./scripts/lib/ci-windows-test-plan.mts")
  ? await import(fromTarget("./scripts/lib/ci-windows-test-plan.mts"))
  : null;
const createChannelContractTestShards =
  typeof channelContractPlan.createChannelContractTestShards === "function"
    ? channelContractPlan.createChannelContractTestShards
    : () => [];

// The harness runs this file without workspace packages, so it keeps its own env-flag grammar.
const parseCiEnvFlag = (value, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false;
  }
  return fallback;
};

const pluginContractPlan = await importTargetPlan(
  existsSync("./scripts/lib/plugin-contract-test-plan.mts")
    ? "./scripts/lib/plugin-contract-test-plan.mts"
    : "./scripts/lib/plugin-contract-test-plan.mjs",
);
const createPluginContractTestShards =
  typeof pluginContractPlan.createPluginContractTestShards === "function"
    ? pluginContractPlan.createPluginContractTestShards
    : () => [
        {
          checkName: "checks-fast-contracts-plugins-legacy",
          includePatterns: ["src/plugins/contracts/**/*.test.ts"],
          runtime: "node",
          task: "contracts-plugins",
        },
      ];
const createMatrix = (include) => ({ include });
// Share setup without combining the target planner's process envelopes.
const createContractMatrix = (shards, task) =>
  createMatrix(
    frozenTarget
      ? shards.map((shard) => ({ ...shard, task, groups: [shard] }))
      : shards.length > 0
        ? [{ checkName: `checks-fast-${task}`, task, groups: shards }]
        : [],
  );
const outputPath = process.env.GITHUB_OUTPUT;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageScripts = packageJson.scripts ?? {};
const hasPackageScript = (name) => typeof packageScripts[name] === "string";
const isCanonicalRepository = process.env.OPENCLAW_CI_REPOSITORY === "openclaw/openclaw";
const changedPaths = (() => {
  try {
    const manifestPath = process.env.OPENCLAW_CI_CHANGED_PATHS_FILE;
    // Frozen target producers can predate the complete file transport.
    const value = JSON.parse(
      manifestPath
        ? readFileSync(manifestPath, "utf8")
        : (process.env.OPENCLAW_CI_CHANGED_PATHS_JSON ?? "null"),
    );
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  } catch {
    return null;
  }
})();
const docsOnly = parseCiEnvFlag(process.env.OPENCLAW_CI_DOCS_ONLY);
const docsChanged = parseCiEnvFlag(process.env.OPENCLAW_CI_DOCS_CHANGED);
const releaseGate = parseCiEnvFlag(process.env.OPENCLAW_CI_RELEASE_GATE) && !ciQualification;
const compactPullRequest = isCanonicalRepository && eventName === "pull_request";
const runtimePullRequest = isCanonicalRepository && (compactPullRequest || releaseGate);
// Exact-head release gates substitute for PR CI. Ordinary manual CI
// is Full Release Validation's owner for the complete process proofs.
const runProofTier = eventName !== "pull_request" && !releaseGate;
const releaseScope = process.env.OPENCLAW_CI_RELEASE_SCOPE ?? "full";
const validationTier = process.env.OPENCLAW_CI_VALIDATION_TIER ?? "full";
const mainValidation = validationTier === "main";
if (validationTier !== "full" && !mainValidation) {
  throw new Error("validation_tier must be full or main");
}
if (
  mainValidation &&
  (!["workflow_dispatch", "schedule"].includes(workflowEventName) ||
    !isCanonicalRepository ||
    frozenTarget ||
    compatibilityTarget ||
    ciQualification ||
    releaseGate ||
    releaseScope !== "full" ||
    process.env.OPENCLAW_CI_PULL_REQUEST_NUMBER)
) {
  throw new Error(
    "The main validation tier requires canonical same-revision manual or scheduled validation with full scope",
  );
}
const npmQualification = releaseScope === "npm-beta" || releaseScope === "npm-stable";
const fullNativeValidation =
  eventName === "workflow_dispatch" && !mainValidation && !releaseGate && releaseScope === "full";
if (releaseScope !== "full" && !npmQualification) {
  throw new Error("release_scope must be full, npm-beta, or npm-stable");
}
if (npmQualification) {
  const packageVersion = String(packageJson.version ?? "");
  const parsedVersion = parseReleaseVersion(packageVersion);
  const expectedTrain = releaseScope === "npm-beta" ? "beta" : "stable";
  const contextRef =
    process.env.OPENCLAW_CI_TARGET_CONTEXT_TARGET === "true"
      ? process.env.OPENCLAW_CI_TARGET_CONTEXT_REF
      : historicalTargetApproved
        ? process.env.OPENCLAW_CI_HISTORICAL_TARGET_TAG
        : "";
  if (
    eventName !== "workflow_dispatch" ||
    !isCanonicalRepository ||
    releaseGate ||
    process.env.OPENCLAW_CI_PULL_REQUEST_NUMBER ||
    !/^[0-9a-f]{40}$/u.test(process.env.OPENCLAW_CI_TARGET_REF ?? "") ||
    process.env.OPENCLAW_CI_TARGET_REF !== checkoutRevision ||
    !parsedVersion ||
    parsedVersion.version !== packageVersion ||
    classifyReleaseTrain(parsedVersion) !== expectedTrain
  ) {
    throw new Error(
      `release_scope ${releaseScope} requires an exact ${expectedTrain} target with validated matching release context and no PR release gate or pull_request_number`,
    );
  }
  let identity;
  try {
    identity = resolveReleaseContextIdentity(contextRef ?? "", packageVersion);
  } catch (error) {
    throw new Error(`release_scope ${releaseScope}: ${error.message}`, { cause: error });
  }
  if (!identity || identity.kind === "extended-stable branch") {
    throw new Error(
      `release_scope ${releaseScope} requires a matching regular release branch or tag`,
    );
  }
  if (identity.baseTag) {
    // Base-package corrections reuse the base tag's exact source; ancestry alone is insufficient.
    if (process.env.OPENCLAW_CI_CORRECTION_BASE_SHA !== checkoutRevision) {
      throw new Error(
        `release_scope ${releaseScope} correction base ${identity.baseTag} does not resolve to ${checkoutRevision}`,
      );
    }
  }
}
const toolingOwnerChange =
  eventName === "pull_request" &&
  isCanonicalRepository &&
  changedPaths !== null &&
  !docsOnly &&
  typeof nodeTestPlan.isToolingTestOwnerPath === "function" &&
  changedPaths.some(nodeTestPlan.isToolingTestOwnerPath);
const nodeDataOnly =
  eventName === "pull_request" && parseCiEnvFlag(process.env.OPENCLAW_CI_NODE_TEST_DATA_ONLY);
const nativeGeneratedOnly =
  workflowEventName === "pull_request" &&
  isCanonicalRepository &&
  !parseCiEnvFlag(process.env.OPENCLAW_CI_FULL) &&
  process.env.OPENCLAW_CI_HEAD_REPOSITORY === process.env.OPENCLAW_CI_REPOSITORY &&
  process.env.OPENCLAW_CI_PR_AUTHOR_TYPE === "Bot" &&
  (
    await import(fromTarget("./scripts/lib/ci-native-generated-scope.mjs"))
  ).isNativeGeneratedOnlyChange(changedPaths);
const runNode =
  !nodeDataOnly &&
  !nativeGeneratedOnly &&
  ((parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE) && !docsOnly) || toolingOwnerChange);
const runNodeFastOnly =
  runNode &&
  !runtimePullRequest &&
  !toolingOwnerChange &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_ONLY);
const runNodeFull = runNode && !runNodeFastOnly;
// release-fast-lane: label-admitted narrow gate for release tooling PRs.
// Canonical PR CI only; declined runs keep every ordinary decision.
const releaseFastLaneLabel = parseCiEnvFlag(process.env.OPENCLAW_CI_RELEASE_FAST_LANE_LABEL);
const releaseFastLaneScope = !releaseFastLaneLabel
  ? null
  : !(
        eventName === "pull_request" &&
        isCanonicalRepository &&
        process.env.OPENCLAW_CI_HEAD_REPOSITORY === process.env.OPENCLAW_CI_REPOSITORY &&
        runNodeFull &&
        !frozenTarget &&
        !compatibilityTarget &&
        !releaseGate &&
        !docsOnly
      )
    ? {
        eligible: false,
        reason: "applies only to same-repository pull request CI with full Node routing",
      }
    : typeof changedNodeTestPlan.resolveReleaseFastLaneScope !== "function"
      ? { eligible: false, reason: "CI target lacks the release fast lane selector" }
      : changedNodeTestPlan.resolveReleaseFastLaneScope(changedPaths);
const releaseFastLane = releaseFastLaneScope?.eligible === true;
const runCheck =
  runNodeFull ||
  (!docsOnly &&
    nodeDataOnly &&
    (changedPaths === null ||
      changedPaths.some((changedPath) => /\.[cm]?tsx?$/u.test(changedPath))));
const runnerProfile = process.env.OPENCLAW_CI_RUNNER_PROFILE ?? "blacksmith";
// Eligible paths share the consumer selector; hosted rows intersect
// those consumers with their canonical stripes.
let changedCoreTestPaths;
if (
  eventName === "pull_request" &&
  runCheck &&
  !frozenTarget &&
  changedPaths &&
  existsSync("scripts/changed-lanes.mts") &&
  [
    ["scripts/run-tsgo-core-test-shards.mts", "--changed-paths-json"],
    ["scripts/run-additional-boundary-checks.mts", "--core-test-boundary-owner=test-types"],
  ].every(
    ([file, capability]) => existsSync(file) && readFileSync(file, "utf8").includes(capability),
  )
) {
  const lanes = await import(fromTarget("./scripts/changed-lanes.mts"));
  if (typeof lanes.getChangedCoreTestPaths === "function") {
    const coreTestPaths = lanes.getChangedCoreTestPaths(lanes.detectChangedLanes(changedPaths));
    // Deleted leaves need the full plan.
    if (coreTestPaths?.length && coreTestPaths.every((testPath) => existsSync(testPath))) {
      changedCoreTestPaths = coreTestPaths;
    }
  }
}

const runNodeFastPluginContracts =
  runNode && parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_PLUGIN_CONTRACTS);
const runNodeFastCiRouting =
  runNode && parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_CI_ROUTING);
const proposedCheckScope =
  runtimePullRequest &&
  (!frozenTarget || releaseGate) &&
  !compatibilityTarget &&
  changedPaths?.length &&
  existsSync("scripts/lib/ci-check-family-scope.mts")
    ? (
        await import(fromTarget("./scripts/lib/ci-check-family-scope.mts"))
      ).resolveCiCheckFamilyScope(changedPaths)
    : null;
const pluginContractShards =
  !runtimePullRequest && ((runNodeFull && !releaseFastLane) || runNodeFastPluginContracts)
    ? createPluginContractTestShards()
    : [];
const channelContractShards =
  !runtimePullRequest && runNodeFull && !releaseFastLane ? createChannelContractTestShards() : [];
const runMacos =
  !ordinaryPullRequest &&
  !nativeGeneratedOnly &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_MACOS) &&
  !docsOnly &&
  isCanonicalRepository &&
  !releaseFastLane;
// Older selected checkouts report only run_macos; retain their native Node coverage.
const runMacosNode =
  runMacos ||
  (!ordinaryPullRequest &&
    !nativeGeneratedOnly &&
    parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_MACOS_NODE) &&
    !docsOnly &&
    isCanonicalRepository &&
    !releaseFastLane);
const supportsCurrentMacosSwiftCi =
  existsSync("scripts/install-swift-tools.sh") &&
  existsSync("scripts/lint-swift.sh") &&
  existsSync("scripts/format-swift.sh");
const supportsIosBuild = hasPackageScript("ios:build");
const supportsCurrentIosCi = supportsIosBuild && supportsCurrentMacosSwiftCi;
const iosBuildScope =
  !nativeGeneratedOnly &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_IOS_BUILD) &&
  !releaseFastLane &&
  !npmQualification &&
  !docsOnly &&
  isCanonicalRepository &&
  (!frozenTarget || supportsCurrentIosCi || (releaseCandidateTarget && supportsIosBuild));
const runIosBuild = !ordinaryPullRequest && iosBuildScope;
const runAndroid =
  !nativeGeneratedOnly &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_ANDROID) &&
  !npmQualification &&
  !docsOnly &&
  isCanonicalRepository &&
  !releaseFastLane;
// Frozen targets may predate this class; current source must still fail
// native validation if the required test disappears.
const runAndroidAccessNative =
  runAndroid &&
  !compatibilityTarget &&
  (!frozenTarget ||
    existsSync(
      "apps/android/app/src/androidTest/java/ai/openclaw/app/gateway/CloudflareAccessNativeTest.kt",
    ));
let runWindows =
  !ordinaryPullRequest &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_WINDOWS) &&
  !releaseFastLane &&
  !docsOnly &&
  !runNodeFastOnly &&
  isCanonicalRepository;
const runSkillsPython =
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_SKILLS_PYTHON) && !docsOnly && !releaseFastLane;
const runControlUiI18n =
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_CONTROL_UI_I18N) && !docsOnly && !releaseFastLane;
let runUiTests =
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_UI_TESTS) &&
  !docsOnly &&
  !nodeDataOnly &&
  !releaseFastLane;
// The UI owner graph also covers protocol and Gateway-served inputs
// outside ui/. Ordinary UI test leaves retain their cheaper unit owner.
const selectUiE2eFamily = (family) =>
  !docsOnly &&
  !nodeDataOnly &&
  !releaseFastLane &&
  (runtimePullRequest &&
  (!frozenTarget || releaseGate) &&
  !compatibilityTarget &&
  changedPaths !== null &&
  typeof changedNodeTestPlan.hasUiE2eAffectingChange === "function"
    ? changedNodeTestPlan.hasUiE2eAffectingChange(changedPaths, { family })
    : runUiTests);
let runControlUiE2e = selectUiE2eFamily("control-ui");
let runBrowserExtensionE2e = selectUiE2eFamily("browser-extension");
let runUiRealGateway = !ordinaryPullRequest && selectUiE2eFamily("real-gateway");
let runUiE2e = runControlUiE2e || runBrowserExtensionE2e;
const nodeRunnerBackend = process.env.OPENCLAW_CI_NODE_RUNNER_BACKEND || runnerProfile;
const usesHostedRunnerProfile = runnerProfile === "github" || runnerProfile === "hybrid";
const supportsUiE2eProjects =
  existsSync("test/vitest/vitest.ui-e2e.config.ts") &&
  readFileSync("test/vitest/vitest.ui-e2e.config.ts", "utf8").includes(
    "ui-e2e-projects-contract-v1",
  );
const includeReleaseOnlyUiTests =
  !mainValidation &&
  ((eventName === "workflow_dispatch" && !releaseGate) ||
    !isCanonicalRepository ||
    compatibilityTarget ||
    changedPaths === null);
// Ordinary CI shares eight 16-class browser jobs; full inventories retain
// twelve. Private source-server projects keep their own one-worker limit.
const compactUiE2e = supportsUiE2eProjects && !includeReleaseOnlyUiTests;
let uiE2eJobCount = compactUiE2e
  ? 9
  : supportsUiE2eProjects
    ? 13
    : usesHostedRunnerProfile
      ? 14
      : 4;
// The logical profile already owns contributor routing. Reuse the
// four-part plan only for normal hybrid first attempts on Blacksmith.
const compactHybridQaSmoke =
  runnerProfile === "hybrid" &&
  isCanonicalRepository &&
  (eventName === "push" || eventName === "pull_request" || mainValidation) &&
  process.env.GITHUB_RUN_ATTEMPT === "1";
const qaSmokeCiPartCount = usesHostedRunnerProfile && !compactHybridQaSmoke ? 6 : 4;
const supportsNativeI18n =
  hasPackageScript("native:i18n:check") &&
  hasPackageScript("android:i18n:check") &&
  hasPackageScript("apple:i18n:check");
const runNativeI18n =
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NATIVE_I18N) &&
  !releaseFastLane &&
  !npmQualification &&
  !docsOnly &&
  (!frozenTarget || supportsNativeI18n);
const targetWorkflow = existsSync(".github/workflows/ci.yml")
  ? readFileSync(".github/workflows/ci.yml", "utf8")
  : "";
const supportsOpenClawKitTests = targetWorkflow.includes("openclawkit-tests-contract-v1");
const supportsCurrentAndroidCi = targetWorkflow.includes("android-ci-contract-v2");
const supportsDockerSeedE2e = targetWorkflow.includes("docker-seed-e2e-contract-v1");
const supportsPublishedDriverUpdate = targetWorkflow.includes(
  "published-driver-update-contract-v1",
);
const useCompatibleAndroidCi = compatibilityTarget && !supportsCurrentAndroidCi;
const androidTestTier = !fullNativeValidation && !useCompatibleAndroidCi;
// Unit tests do not compile the benchmark. Keep its build when inputs
// change, or when the existing changed-path manifest cannot narrow scope.
const androidBenchmarkChanged =
  !changedPaths?.length ||
  changedPaths.some(
    (changedPath) =>
      !changedPath.trim() ||
      matchesGlob(changedPath, "apps/android/{benchmark,buildSrc,build-logic,gradle,Config}/**") ||
      matchesGlob(changedPath, "apps/android/**/*.gradle{,.kts}") ||
      matchesGlob(changedPath, "apps/android/**/gradle.properties") ||
      matchesGlob(changedPath, "apps/android/gradlew{,.bat}"),
  );
const supportsFormatCheck = targetWorkflow.split("pnpm format:check").length - 1 >= 2;
const runFormatCheck = !frozenTarget || supportsFormatCheck;
let runBaselineRatchets = runNode && !frozenTarget && !releaseFastLane;
const checksFastCoreTasks = runBaselineRatchets
  ? ["startup-corpus", "coercion-helpers"].map((task) => ({
      check_name: `checks-fast-${task}`,
      runtime: "node",
      task,
    }))
  : [];
if (runNodeFull && !releaseFastLane) {
  checksFastCoreTasks.push(
    { check_name: "checks-fast-bundled-protocol", runtime: "node", task: "bundled-protocol" },
    { check_name: "checks-fast-bun-launcher", runtime: "bun", task: "bun-launcher" },
  );
} else if (runNodeFastCiRouting && !releaseFastLane) {
  checksFastCoreTasks.push({
    check_name: "checks-fast-ci-routing",
    runtime: "node",
    task: "ci-routing",
  });
}
if (releaseGate) {
  checksFastCoreTasks.push(
    ...Array.from({ length: 5 }, (_, index) => {
      const stripe = index + 1;
      return {
        check_name: `checks-fast-release-lint-core-${stripe}`,
        runtime: "node",
        stripe,
        task: `release-lint-core-${stripe}`,
      };
    }),
    {
      check_name: "checks-fast-release-lint-extensions",
      runtime: "node",
      task: "release-lint-extensions",
    },
  );
}

const includeReleaseOnlyRuntimeTests =
  !mainValidation && (!isCanonicalRepository || (!runtimePullRequest && eventName !== "push"));
const includePrExemptRuntimeTests = !runtimePullRequest;
const nodeSelectionMode = process.env.OPENCLAW_CI_NODE_SELECTION === "full" ? "full" : "aggressive";
const nodeSelectionReasons = [];
let selectedTestTargets;
if (runtimePullRequest && runNodeFull) {
  if (changedPaths === null) {
    throw new Error("Current PR CI requires complete changed paths for Node test planning");
  }
  if (typeof changedNodeTestPlan.resolveChangedNodeTestTargets !== "function") {
    throw new Error("Current PR CI requires a bounded changed-owner target selector");
  }
  selectedTestTargets = changedNodeTestPlan.resolveChangedNodeTestTargets(changedPaths, {
    baseRef: process.env.OPENCLAW_CI_CHANGED_BASE,
    includeReleaseOnlyRuntimeTests,
    includePrExemptRuntimeTests,
    selectionMode: nodeSelectionMode,
    onSelection: (selection) => nodeSelectionReasons.push(selection),
  });
}
const fullIosSimulatorPr = parseCiEnvFlag(process.env.OPENCLAW_CI_IOS_SIMULATOR_FULL);
const iosSimulatorSelection = resolveIosSimulatorTestSelection(changedPaths, {
  enabled: runIosBuild,
  forceFull: !runtimePullRequest || releaseGate || compatibilityTarget || fullIosSimulatorPr,
  fullReason: fullIosSimulatorPr
    ? "OPENCLAW_CI_IOS_SIMULATOR_FULL"
    : compatibilityTarget
      ? "compatibility target"
      : "scheduled, main, or release validation",
});
const uiOwnerScope = {
  unit: runUiTests,
  mocked: runControlUiE2e,
  browser: runBrowserExtensionE2e,
  realGateway: runUiRealGateway,
};
const forceFullUiE2e =
  !runtimePullRequest || releaseGate || parseCiEnvFlag(process.env.OPENCLAW_CI_UI_E2E_FULL);
const uiE2eSelection =
  runControlUiE2e &&
  !compatibilityTarget &&
  (!frozenTarget || releaseGate) &&
  typeof nodeTestPlan.resolveUiE2ePrTestSelection === "function"
    ? nodeTestPlan.resolveUiE2ePrTestSelection(changedPaths, { forceFull: forceFullUiE2e })
    : null;
let uiTestGroups =
  (runUiTests || runUiE2e || runUiRealGateway || selectedTestTargets) &&
  !compatibilityTarget &&
  (!frozenTarget || releaseGate) &&
  typeof nodeTestPlan.createUiTestShardGroups === "function"
    ? nodeTestPlan.createUiTestShardGroups({
        // Preserve the ordinary owner-family inventory. Protected or directly
        // selected files opt into the existing release-only UI tier below.
        includeReleaseOnlyTests: includeReleaseOnlyUiTests,
        ...(typeof nodeTestPlan.resolveUiE2ePrTestSelection === "function"
          ? { includeReleaseOnlyE2eTests: forceFullUiE2e }
          : {}),
        includePrExemptRuntimeTests: selectedTestTargets ? true : includePrExemptRuntimeTests,
        changedPaths: selectedTestTargets ?? changedPaths ?? [],
        ...(uiE2eSelection ? { uiE2eFiles: uiE2eSelection.files } : {}),
      })
    : null;
let uiTestShardCount = compatibilityTarget ? 1 : 3;
if (selectedTestTargets) {
  if (!uiTestGroups) {
    throw new Error("Current PR CI requires UI target groups");
  }
  const { controlUiE2eTestGlobs, isUiTestTarget, uiE2eRealGatewayTestFiles } = await import(
    fromTarget("./test/vitest/vitest.ui-paths.mjs")
  );
  const realGatewayTargets = new Set(uiE2eRealGatewayTestFiles);
  if (ordinaryPullRequest) {
    selectedTestTargets = selectedTestTargets.filter((file) => !realGatewayTargets.has(file));
  }
  const selected = new Set(selectedTestTargets);
  const selectedControlUiFiles = new Set(uiE2eSelection?.files);
  const narrowGroups = (groups, ownsFile, retainsFile) =>
    groups
      .map((group) => ({
        ...group,
        includePatterns: (group.includePatterns ?? selectedTestTargets.filter(ownsFile)).filter(
          retainsFile,
        ),
      }))
      .filter((group) => group.includePatterns.length > 0);
  uiTestGroups = {
    ui: narrowGroups(
      uiTestGroups.ui,
      isUiTestTarget,
      (file) => uiOwnerScope.unit || selected.has(file),
    ),
    e2e: narrowGroups(
      uiTestGroups.e2e,
      (file) =>
        realGatewayTargets.has(file) ||
        controlUiE2eTestGlobs.some((pattern) => matchesGlob(file, pattern)),
      (file) =>
        realGatewayTargets.has(file)
          ? !ordinaryPullRequest && (uiOwnerScope.realGateway || selected.has(file))
          : uiE2eSelection
            ? selectedControlUiFiles.has(file)
            : uiOwnerScope.mocked || selected.has(file),
    ),
  };
  const uiTargets = uiTestGroups.ui.flatMap((group) => group.includePatterns);
  const e2eTargets = uiTestGroups.e2e.flatMap((group) => group.includePatterns);
  const controlTargets = e2eTargets.filter((file) => !realGatewayTargets.has(file));
  runUiTests = uiTargets.length > 0;
  runControlUiE2e = controlTargets.length > 0;
  runBrowserExtensionE2e =
    uiOwnerScope.browser ||
    selected.has("extensions/browser/chrome-extension/bootstrap.chromium.test.ts");
  runUiRealGateway = e2eTargets.some((file) => realGatewayTargets.has(file));
  runUiE2e = runControlUiE2e || runBrowserExtensionE2e;
  uiTestShardCount = Math.min(3, uiTargets.length);
  // Keep the existing worker/row cap; omit empty file partitions.
  uiE2eJobCount = Math.min(uiE2eJobCount - 1, controlTargets.length) + 1;
}
if (uiE2eSelection) {
  // Selection also applies to UI-only plans without a Node target inventory.
  runControlUiE2e = uiE2eSelection.files.length > 0;
  runUiE2e = runControlUiE2e || runBrowserExtensionE2e;
  // Narrow PR selections share a runner instead of repeating setup across eight rows.
  const controlUiRows =
    uiE2eSelection.mode === "owners"
      ? Math.ceil(uiE2eSelection.files.length / 30)
      : uiE2eSelection.files.length;
  uiE2eJobCount = Math.min(uiE2eJobCount - 1, controlUiRows) + 1;
}
if (selectedTestTargets && runWindows && !windowsTestPlan) {
  throw new Error("Current PR CI requires a target-owned Windows planner");
}
const plannedWindowsShards =
  runWindows && windowsTestPlan
    ? windowsTestPlan.createWindowsTestShards(packageScripts, {
        includePrExemptRuntimeTests: selectedTestTargets ? true : includePrExemptRuntimeTests,
        ...(runtimePullRequest && changedPaths
          ? { changedPaths: selectedTestTargets ?? changedPaths }
          : {}),
      })
    : null;
const windowsShards =
  plannedWindowsShards
    ?.map((shard) => Object.assign(shard, { runtime: "node", task: "test" }))
    .filter((shard) => shard.targets.length > 0) ??
  (runWindows
    ? [1, 2].map((part) => ({
        check_name: `checks-windows-node-test-${part}`,
        runtime: "node",
        task: `test-${part}`,
      }))
    : []);
if (selectedTestTargets) {
  runWindows = windowsShards.length > 0;
}
const startupCorpusTestFiles =
  typeof nodeTestPlan.resolveStartupCorpusTestFiles === "function"
    ? nodeTestPlan
        .resolveStartupCorpusTestFiles({
          includeReleaseOnlyRuntimeTests: selectedTestTargets
            ? true
            : includeReleaseOnlyRuntimeTests,
          includePrExemptRuntimeTests: selectedTestTargets ? true : includePrExemptRuntimeTests,
          ...(runtimePullRequest && changedPaths ? { changedPaths } : {}),
        })
        .filter((file) => !selectedTestTargets || selectedTestTargets.includes(file))
    : undefined;
const ownerPathEvent =
  isCanonicalRepository && eventName === "push" && eventRef === "refs/heads/main";
if (
  runtimePullRequest &&
  supportsDockerSeedE2e &&
  typeof dockerSeedPlan.resolveChangedDockerSeedLanes !== "function"
) {
  throw new Error("Current PR CI requires the Docker owner selector");
}
const dockerSeedLanes =
  isCanonicalRepository && supportsDockerSeedE2e
    ? runtimePullRequest
      ? dockerSeedPlan.resolveChangedDockerSeedLanes(changedPaths ?? [])
      : runProofTier && (ownerPathEvent || eventName === "workflow_dispatch" || mainValidation)
        ? typeof dockerSeedPlan.resolveDockerSeedLanes === "function"
          ? dockerSeedPlan.resolveDockerSeedLanes({
              includeReleaseOnly: eventName === "workflow_dispatch" && !mainValidation,
            })
          : ["published-upgrade-survivor"]
        : []
    : [];
if (
  supportsPublishedDriverUpdate &&
  typeof publishedDriverUpdatePlan.shouldRunPublishedDriverUpdate !== "function"
) {
  throw new Error("Current CI target requires the published-driver update owner selector");
}
const publishedDriverUpdate =
  isCanonicalRepository &&
  supportsPublishedDriverUpdate &&
  !docsOnly &&
  (runtimePullRequest
    ? publishedDriverUpdatePlan.shouldRunPublishedDriverUpdate(changedPaths, workflowEventName)
    : runProofTier && (ownerPathEvent || eventName === "workflow_dispatch" || mainValidation));
// Canonical pushes also use compact bins: 80+ single-group jobs
// drain the runner pool for minutes, and per-shard check names on
// main have no branch-protection consumers. Dispatch (release
// validation) keeps the full named matrix.
const compactPlanMode = !isCanonicalRepository
  ? undefined
  : runtimePullRequest
    ? "pull-request"
    : eventName === "push" || mainValidation
      ? "push"
      : undefined;
const nodeMatrixLimit = mainValidation ? 77 : compactPlanMode === "pull-request" ? 130 : 70;
let changedNodeTestShards = null;
/** @type {string | undefined} */
let changedNodeTestFallbackReason;
if (runtimePullRequest && runNodeFull) {
  // PRs admit only concrete owner plans; missing selection is a planner failure.
  if (typeof changedNodeTestPlan.createChangedNodeTestShards !== "function") {
    throw new Error("Current PR CI target does not export createChangedNodeTestShards");
  }
  changedNodeTestShards = changedNodeTestPlan.createChangedNodeTestShards(changedPaths, {
    baseRef: process.env.OPENCLAW_CI_CHANGED_BASE,
    compactNodeJobCap: compactPlanMode ? nodeMatrixLimit : undefined,
    selectedTestTargets,
    // Changed compiler plans validate every consuming graph, with full fallback on ambiguity.
    dedicatedCoreTypeChecks: runNodeFull,
    dedicatedBuildArtifacts: false,
    dedicatedNativeChecks: { macos: runMacos, ios: runIosBuild, android: runAndroid },
    includeReleaseOnlyToolingShards: false,
    includeReleaseOnlyRuntimeTests,
    includePrExemptRuntimeTests,
    runnerBackend: nodeRunnerBackend,
    releaseFastLane,
    onFallback: (reason) => {
      changedNodeTestFallbackReason = reason;
      console.log(`Node test plan owner selection: ${reason}`);
    },
    dedicatedContractShards: [...pluginContractShards, ...channelContractShards],
    dedicatedUiE2e: (runUiE2e || runUiRealGateway) && !compatibilityTarget,
    dedicatedUiTests: runUiTests,
    dedicatedMaxLinesRatchet:
      runBaselineRatchets && (!proposedCheckScope || proposedCheckScope.baselineRatchets),
  });
  if (changedNodeTestShards === null) {
    throw new Error(
      `Current PR CI requires a bounded changed-owner Node plan: ${changedNodeTestFallbackReason ?? "selector returned no plan"}`,
    );
  }
  console.log(
    `Node test plan changed-set: ${changedNodeTestShards.filter((shard) => !shard.requiresDist).length} rows`,
  );
}
// A Node-targeting fallback does not invalidate independently resolved
// check families or their compiler/lint consumer graphs.
const narrowCheckScope = proposedCheckScope?.mode === "scoped" ? proposedCheckScope : null;
const extensionLintMode =
  workflowEventName === "pull_request" &&
  isCanonicalRepository &&
  !releaseGate &&
  !frozenTarget &&
  !compatibilityTarget &&
  changedPaths?.length &&
  existsSync("scripts/lib/ci-extension-lint-plan.mts")
    ? parseCiEnvFlag(process.env.OPENCLAW_CI_EXTENSION_LINT_FULL)
      ? "full"
      : "affected"
    : undefined;
const runCheckPlan = Boolean(runCheck && (narrowCheckScope || extensionLintMode));
let typeGraphBoundaryOwner = "";
if (runCheckPlan && proposedCheckScope?.types) {
  const { resolveChangedCiTsgoInputs } = await import(
    fromTarget("./scripts/lib/tsgo-core-test-shards.mts")
  );
  const compilerPaths = resolveChangedCiTsgoInputs(changedPaths, existsSync);
  typeGraphBoundaryOwner =
    runNodeFull &&
    !releaseFastLane &&
    proposedCheckScope.additionalGroups.includes("boundaries") &&
    (!narrowCheckScope ||
      !compilerPaths ||
      compilerPaths.every((file) => file.startsWith("extensions/")))
      ? "additional-checks"
      : "check-plan";
}
const fullCoreLintStripes =
  runnerProfile === "hybrid" &&
  !frozenTarget &&
  ((!releaseGate && ["push", "pull_request"].includes(eventName)) ||
    nodeRunnerBackend === "runson" ||
    ciQualification)
    ? [1, 2]
    : [1, 2, 3, 4, 5];
const coreLintRows = fullCoreLintStripes.map((stripe) => ({ stripe }));
const compactExtensionLint =
  isCanonicalRepository &&
  runnerProfile === "hybrid" &&
  !frozenTarget &&
  !compatibilityTarget &&
  !releaseGate &&
  !runCheckPlan;
const extensionLintRows = compactExtensionLint
  ? [1, 2, 3].map((stripe) => ({ stripe, stripe_count: 3 }))
  : [1, 2, 3, 4, 5, 6].map((stripe) => ({ stripe }));
const coreTypeRows = (frozenTarget ? [1, 2] : [1, 2, 3, 4, 5]).map((stripe) => ({ stripe }));
if (proposedCheckScope) {
  runBaselineRatchets &&= proposedCheckScope.baselineRatchets;
  for (let index = checksFastCoreTasks.length - 1; index >= 0; index--) {
    if (
      !proposedCheckScope.fastTasks.includes(checksFastCoreTasks[index].task) &&
      !checksFastCoreTasks[index].task.startsWith("release-lint-")
    ) {
      checksFastCoreTasks.splice(index, 1);
    }
  }
}
// Heavy packaging lanes run only when the diff touches surfaces they
// exist to prove: built-artifact tests need dist even on test-only diffs, and QA
// smoke only sees changes on its scenario surface or inside the
// packaged CLI's import graph. QA gating is diff-based, so it also
// applies when test targeting fell back to the full compact suite.
const selectedOwnerTest = (file) => selectedTestTargets?.includes(file) === true;
const selectedBuildOwner = [
  "test/scripts/build-all.test.ts",
  "test/scripts/tsdown-build.test.ts",
  "test/scripts/dist-artifact-ownership.test.ts",
  "test/scripts/write-plugin-sdk-entry-dts.test.ts",
  "test/scripts/write-unified-entry-dts.test.ts",
  "test/scripts/check-openclaw-package-tarball.test.ts",
].some(selectedOwnerTest);
const runBrowserNativeHost =
  runNodeFull &&
  (runProofTier ||
    selectedOwnerTest("extensions/browser/src/browser/extension-install.native-host.e2e.test.ts"));
const runDoctorPluginIndex =
  runNodeFull &&
  (runProofTier ||
    selectedOwnerTest("test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts"));
const runDiscordComponentProof =
  runNodeFull &&
  (runProofTier ||
    selectedOwnerTest(
      "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
    ));
const runGatewayWatch =
  runNodeFull &&
  ((runProofTier && !releaseFastLane) ||
    selectedOwnerTest("test/scripts/check-gateway-watch-regression.test.ts"));
const selectedTuiPty = selectedOwnerTest("src/tui/tui-pty-local.e2e.test.ts");
const changedScopeHasBuildImpact = runtimePullRequest
  ? selectedBuildOwner || changedNodeTestShards?.some((shard) => shard.requiresDist) === true
  : changedNodeTestShards === null ||
    changedNodeTestShards.some((shard) => shard.requiresDist) ||
    typeof changedNodeTestPlan.hasBuildArtifactAffectingChange !== "function" ||
    changedNodeTestPlan.hasBuildArtifactAffectingChange(changedPaths);
const changedScopeHasQaImpact =
  changedPaths === null ||
  (eventName === "workflow_dispatch" && !releaseGate) ||
  typeof changedNodeTestPlan.hasQaSmokeAffectingChange !== "function" ||
  changedNodeTestPlan.hasQaSmokeAffectingChange(changedPaths);
// Prompt snapshots only change when the generator's import graph or
// its fixtures do; unaffected PR diffs skip the regeneration lane.
const changedScopeHasPromptSnapshotImpact =
  changedPaths === null ||
  eventName !== "pull_request" ||
  typeof changedNodeTestPlan.hasPromptSnapshotAffectingChange !== "function" ||
  changedNodeTestPlan.hasPromptSnapshotAffectingChange(changedPaths);
const supportsSqliteSessionLifecycleProof = existsSync(
  "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
);
const changedScopeHasSqliteSessionLifecycleImpact =
  changedPaths === null ||
  (eventName === "workflow_dispatch" && !releaseGate) ||
  typeof changedNodeTestPlan.hasSqliteSessionLifecycleAffectingChange !== "function" ||
  changedNodeTestPlan.hasSqliteSessionLifecycleAffectingChange(changedPaths);
const runSqliteSessionLifecycle =
  runNodeFull &&
  supportsSqliteSessionLifecycleProof &&
  (changedScopeHasSqliteSessionLifecycleImpact ||
    selectedOwnerTest("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"));
const runBuildArtifacts =
  publishedDriverUpdate ||
  (runNodeFull &&
    (changedScopeHasBuildImpact ||
      runSqliteSessionLifecycle ||
      runBrowserNativeHost ||
      runDoctorPluginIndex ||
      runDiscordComponentProof ||
      runGatewayWatch ||
      selectedTuiPty));
const runControlUiPerformance =
  !releaseFastLane &&
  (runNodeFull || runUiTests) &&
  (eventName === "workflow_dispatch" ||
    changedPaths === null ||
    typeof changedNodeTestPlan.hasControlUiPerformanceAffectingChange !== "function" ||
    changedNodeTestPlan.hasControlUiPerformanceAffectingChange(changedPaths));
const runQaSmokeCi =
  runNodeFull &&
  changedScopeHasQaImpact &&
  (!frozenTarget || existsSync("extensions/qa-lab/src/ci-smoke-plan.ts"));
const rawNodeTestShards = runNodeFull
  ? changedNodeTestShards
    ? changedNodeTestShards
    : [
        ...createNodeTestPlan({
          includeProofTests: runProofTier,
          includeReleaseOnlyPluginShards: false,
          includeReleaseOnlyToolingShards:
            mainValidation || eventName === "workflow_dispatch" || !isCanonicalRepository,
          includeReleaseOnlyRuntimeTests,
          includePrExemptRuntimeTests,
          ...(runtimePullRequest && changedPaths ? { changedPaths } : {}),
          // Keep the legacy boolean for historical targets. Hourly main uses
          // the complete compact inventory within its 77-row main-tier cap.
          compact: compactPlanMode !== undefined,
          compactMode: mainValidation ? "pull-request" : compactPlanMode,
          compactNodeJobCap: nodeMatrixLimit,
          runnerBackend: nodeRunnerBackend,
        }),
      ]
  : [];
if (
  ciQualification &&
  !mainQualification &&
  process.env.OPENCLAW_CI_NODE_RUNNER_BACKEND === "runson"
) {
  const cron = rawNodeTestShards.find((shard) => shard.runner === "runson-c8i-8xlarge");
  if (!cron) {
    throw new Error("RunsOn qualification requires selected cron tests");
  }
  // One dispatch compares the same child contracts and worker ceiling.
  for (const [provider, runner] of [
    ["blacksmith", "blacksmith-32vcpu-ubuntu-2404"],
    ["github", "ubuntu-24.04"],
  ]) {
    rawNodeTestShards.push({
      ...cron,
      checkName: `checks-node-runson-cron-${provider}-control`,
      shardName: `runson-cron-${provider}-control`,
      runner,
    });
  }
}
// The trusted planner may name owners added after a frozen checkout.
// Project them out here so the runner never receives impossible work.
const projectFrozenNodeTestPlan = (plan) => {
  const configs = plan.configs?.filter((config) => existsSync(config));
  if (plan.configs?.length && !configs?.length) {
    return null;
  }
  return { ...plan, configs };
};
const targetNodeTestShards = compatibilityTarget
  ? rawNodeTestShards.flatMap((shard) => {
      const groups = shard.groups?.map(projectFrozenNodeTestPlan).filter((group) => group !== null);
      if (shard.groups?.length && !groups?.length) {
        return [];
      }
      const projected = projectFrozenNodeTestPlan({ ...shard, groups });
      return projected ? [projected] : [];
    })
  : rawNodeTestShards;
// Node rows list every striped test file. Current targets pack the
// projected runner contract; older targets keep their flat fields or
// projected legacy groups because their shard runner predates the codec.
const nodeTestGroupsCodecPath = "./scripts/lib/ci-node-test-groups-codec.mts";
const nodeTestGroupsCodec =
  (targetNodeTestShards.length > 0 || uiTestGroups !== null) && existsSync(nodeTestGroupsCodecPath)
    ? await importTargetPlan(nodeTestGroupsCodecPath)
    : null;
const encodeNodeTestGroups = (groups) => {
  if (typeof nodeTestGroupsCodec?.encodeNodeTestGroups !== "function") {
    throw new Error(
      "CI target emits grouped Node test rows without scripts/lib/ci-node-test-groups-codec.mts",
    );
  }
  return nodeTestGroupsCodec.encodeNodeTestGroups(groups);
};
if (
  selectedTestTargets &&
  runUiRealGateway &&
  typeof nodeTestPlan.createUiRealGatewayTestShards !== "function"
) {
  throw new Error("Current PR CI requires target-owned real-Gateway groups");
}
const plannedUiRealGatewayShards =
  uiTestGroups &&
  (!frozenTarget || releaseGate) &&
  typeof nodeTestPlan.createUiRealGatewayTestShards === "function"
    ? nodeTestPlan.createUiRealGatewayTestShards(uiTestGroups.e2e)
    : selectedTestTargets
      ? []
      : [{ shard: 1, shard_count: 1, run_desktop: true, groups: uiTestGroups?.e2e }];
const uiRealGatewayShards = ordinaryPullRequest
  ? []
  : selectedTestTargets
    ? plannedUiRealGatewayShards
        .map((shard) => ({
          ...shard,
          groups: shard.groups?.filter((group) => group.includePatterns?.length > 0),
        }))
        .filter((shard) => shard.run_desktop || shard.groups?.length > 0)
    : plannedUiRealGatewayShards;
const projectNodeTestGroup = ({
  configs,
  env,
  fallbackMaxWorkers,
  includePatterns,
  minTotalMemoryBytes,
  shard_name,
  timing_key,
}) => ({
  configs,
  env,
  fallbackMaxWorkers,
  includePatterns,
  minTotalMemoryBytes,
  shard_name,
  timing_key,
});
const testRuntimePolicyPath = "./scripts/lib/ci-test-runtime.mts";
const testRuntimePolicy = existsSync(testRuntimePolicyPath)
  ? await importTargetPlan(testRuntimePolicyPath)
  : null;
const testRuntimeMode = testRuntimePolicy
  ? eventName === "pull_request" || releaseGate
    ? "bun-compatible"
    : eventName === "workflow_dispatch" && !mainValidation
      ? "dual"
      : "node"
  : "node";
const uiTestRuntimePolicy =
  !compatibilityTarget &&
  testRuntimePolicy?.ciTestShardRequiresBun(
    {
      configs: ["ui/vitest.config.ts"],
      vitestArgs: [
        "--maxWorkers",
        "3",
        "--reporter=verbose",
        "--reporter=github-actions",
        "--reporter=./scripts/lib/vitest-resource-reporter.mts",
        "--shard=1/3",
      ],
    },
    testRuntimeMode,
  )
    ? testRuntimeMode
    : "node";
const goToolingConfig = "test/vitest/vitest.tooling.config.ts";
const knownToolingConfigs = new Set([
  goToolingConfig,
  "test/vitest/vitest.tooling-isolated.config.ts",
  "test/vitest/vitest.tooling-docker.config.ts",
]);
// The same capped matrix owns compact and plugin work; admit its longest rows first.
const nodeTestShards = targetNodeTestShards
  .toSorted(
    (a, b) =>
      Number(b.runner === "runson-c8i-8xlarge") - Number(a.runner === "runson-c8i-8xlarge") ||
      (b.predictedSeconds ?? 0) - (a.predictedSeconds ?? 0),
  )
  .map((shard) => {
    const groups =
      shard.groups?.map(projectNodeTestGroup) ??
      (nodeTestGroupsCodec && shard.configs?.length && !shard.targets?.length
        ? [
            {
              configs: shard.configs,
              env: shard.env,
              includePatterns: shard.includePatterns,
              shard_name: shard.shardName,
              timing_key: shard.timing_key,
            },
          ]
        : undefined);
    const packedGroups =
      groups?.length && nodeTestGroupsCodec ? encodeNodeTestGroups(groups) : undefined;
    return {
      check_name: shard.checkName,
      test_runtime_policy: testRuntimeMode,
      requires_bun:
        !shard.requiresDist &&
        Boolean(testRuntimePolicy?.ciTestShardRequiresBun(shard, testRuntimeMode)),
      shard_name: shard.shardName,
      groups_gzip_base64: packedGroups,
      groups: groups && !nodeTestGroupsCodec ? groups : undefined,
      configs: packedGroups ? undefined : shard.configs,
      env: shard.env,
      includePatterns: packedGroups ? undefined : shard.includePatterns,
      pretest_build_mode: shard.pretestBuildMode,
      git_commits: resolveTestGitCommits(shard),
      requires_dist: shard.requiresDist,
      runner: shard.runner,
      timeout_minutes: shard.timeoutMinutes,
      plan_concurrency: shard.planConcurrency,
      predicted_seconds: shard.predictedTestSeconds ?? shard.predictedSeconds,
      targets: shard.targets,
      requires_go: (shard.groups ?? [shard]).some((plan) => {
        const patterns = plan.targets ?? plan.includePatterns;
        if (patterns) {
          return patterns.some((pattern) => matchesGlob("test/scripts/docs-i18n.test.ts", pattern));
        }
        if (
          plan.configs?.length &&
          plan.configs.every((config) => knownToolingConfigs.has(config))
        ) {
          return plan.configs.includes(goToolingConfig);
        }
        // Unknown historical configs retain their original Go setup;
        // current isolated and Docker catalogs exclude the Go owner.
        return (plan.shard_name ?? plan.shardName).startsWith("core-tooling");
      }),
      requires_ripgrep: (shard.groups ?? [shard]).some((plan) => {
        const patterns = plan.targets ?? plan.includePatterns;
        if (patterns) {
          return patterns.some((pattern) =>
            [
              "src/agents/sessions/agent-session-runtime-projection.test.ts",
              "src/agents/sessions/tools/index.test.ts",
              "src/agents/sessions/tools/grep.byte-path.test.ts",
              "src/agents/filesystem-tools-output-contract.test.ts",
              "test/scripts/check-database-worker-ratchet.test.ts",
            ].some((test) => matchesGlob(test, pattern)),
          );
        }
        return ["agentic-agents-support", "agentic-agents-core-runtime"].includes(
          plan.shard_name ?? plan.shardName,
        );
      }),
      requires_sandbox_image: (shard.groups ?? [shard]).some((plan) => {
        const patterns = plan.targets ?? plan.includePatterns;
        if (patterns) {
          return patterns.some((pattern) =>
            [
              "test/e2e/qa-lab/runtime/agent-sandboxed-exec-behavior.e2e.test.ts",
              "test/e2e/qa-lab/runtime/openclaw-sandbox-workspace-isolation.e2e.test.ts",
            ].some((test) => matchesGlob(test, pattern)),
          );
        }
        return plan.configs?.includes("test/vitest/vitest.e2e.config.ts") ?? false;
      }),
    };
  });
const nodeTestNonDistShards = nodeTestShards.filter((shard) => !shard.requires_dist);
// Bound the final matrix: precise plans and appended plugin rows can bypass compact caps.
if (compactPlanMode && nodeTestNonDistShards.length > nodeMatrixLimit) {
  throw new Error(
    `Canonical ${eventName} Node matrix has ${nodeTestNonDistShards.length} jobs, exceeding limit ${nodeMatrixLimit}`,
  );
}
const nodeTestDistShards = nodeTestShards.filter((shard) => shard.requires_dist);
// The required Node matrix can own the selected PR corpus on this
// exact tree; frozen/release targets retain their independent corpus step.
const startupCorpusNodeRevision =
  isCanonicalRepository &&
  eventName === "pull_request" &&
  runNodeFull &&
  !frozenTarget &&
  !compatibilityTarget &&
  !releaseGate &&
  /^[0-9a-f]{40}$/u.test(checkoutRevision) &&
  checkoutRevision === workflowRevision &&
  typeof nodeTestPlan.hasCompleteStartupCorpusCoverage === "function" &&
  nodeTestPlan.hasCompleteStartupCorpusCoverage(targetNodeTestShards, startupCorpusTestFiles)
    ? checkoutRevision
    : "";
if (startupCorpusNodeRevision) {
  // The exact-tree Node receipt makes this row's only test step a no-op.
  const startupTask = checksFastCoreTasks.findIndex(({ task }) => task === "startup-corpus");
  if (startupTask >= 0) {
    checksFastCoreTasks.splice(startupTask, 1);
  }
}
// Targeted PRs keep source boundary guards in their Node plan. Only
// an actual dist descriptor transfers that owner to build-artifacts.
const runNodeCoreDist = nodeTestDistShards.length > 0;
const runTuiPty = runNodeFull && ((runProofTier && runNodeCoreDist) || selectedTuiPty);
const protocolCoverageRequested = runNode || iosBuildScope || runAndroid;
const runProtocolEventCoverage =
  protocolCoverageRequested &&
  (!frozenTarget || existsSync("scripts/check-protocol-event-coverage.mjs"));

const additionalChecks = [
  {
    check_name: "check-additional-boundaries",
    group: "boundaries",
    runner: "blacksmith-8vcpu-ubuntu-2404",
  },
  // Prompt regeneration loads the full tool/prompt import graph independently.
  {
    check_name: "check-prompt-snapshots",
    group: "prompt-snapshots",
    runner: "blacksmith-8vcpu-ubuntu-2404",
  },
  // Frozen targets retain their original rows and command boundaries.
  ...(frozenTarget
    ? ["export-name-collisions", "session-accessor-boundary", "sqlite-session-schema-baseline"]
    : ["source-contracts"]
  ).map((group) => ({
    check_name: `check-${group}`,
    group,
    runner: "blacksmith-4vcpu-ubuntu-2404",
  })),
  // Only dispatches execute this report; scheduled tips have no change range.
  ...(eventName === "workflow_dispatch"
    ? [
        // Diff generation took 209–246s on smaller hosts; keep its 8GiB heap isolated.
        {
          check_name: "report-plugin-sdk-api-diff",
          group: "plugin-sdk-api-diff",
          runner: "blacksmith-8vcpu-ubuntu-2404",
        },
      ]
    : []),
  // Keep these scans on available capacity; their resource guards remain authoritative.
  {
    check_name: "check-additional-extension-package-boundary",
    group: "extension-package-boundary",
    runner: "blacksmith-32vcpu-ubuntu-2404",
  },
  {
    check_name: "check-additional-runtime-topology-architecture",
    group: "runtime-topology-architecture",
    runner: "blacksmith-16vcpu-ubuntu-2404",
  },
].filter(
  ({ group }) =>
    !(ordinaryPullRequest && group === "runtime-topology-architecture") &&
    (!narrowCheckScope ||
      (group === "prompt-snapshots"
        ? changedScopeHasPromptSnapshotImpact
        : narrowCheckScope.additionalGroups.includes(group))),
);
// Move an already-selected boundary row; sharing must never add another CI job.
const sharedSdkDeclarations =
  workflowEventName === "pull_request" &&
  isCanonicalRepository &&
  runnerProfile === "hybrid" &&
  runCheckPlan &&
  runNodeFull &&
  !releaseFastLane &&
  !releaseGate &&
  !frozenTarget &&
  !compatibilityTarget &&
  existsSync("scripts/ci-sdk-declarations.mts") &&
  additionalChecks.some(({ group }) => group === "extension-package-boundary");
if (sharedSdkDeclarations) {
  additionalChecks.splice(
    additionalChecks.findIndex(({ group }) => group === "extension-package-boundary"),
    1,
  );
}
const runPrMadgeImportCycles =
  runCheck && ordinaryPullRequest && (proposedCheckScope?.madgeImportCycles ?? true);
const runPrKyselyGuardrails =
  runCheck && ordinaryPullRequest && (proposedCheckScope?.kyselyGuardrails ?? true);
const checkTasks = [
  ...["guards", "npm-lock", "bundled-channel-config-metadata", "prod-types"].map((task) => ({
    check_name: `check-${task}`,
    task,
    runner: "blacksmith-4vcpu-ubuntu-2404",
  })),
  ...["lint", "dependencies", "test-types"].map((task) => ({
    check_name: `check-${task}`,
    task,
    runner: "blacksmith-16vcpu-ubuntu-2404",
  })),
].filter((row) => {
  if (ordinaryPullRequest && row.task === "dependencies") {
    return false;
  }
  if (!narrowCheckScope) {
    return true;
  }
  if (row.task === "prod-types" || row.task === "test-types") {
    return narrowCheckScope.types;
  }
  return row.task === "lint"
    ? narrowCheckScope.lint
    : narrowCheckScope.checkTasks.includes(row.task);
});

// Keep the selected source scans independent of the other PR guards.
const guardRow = checkTasks.find(({ task }) => task === "guards");
const splitPrGuards = guardRow !== undefined && (runPrMadgeImportCycles || runPrKyselyGuardrails);
if (splitPrGuards) {
  checkTasks.push({
    check_name: "check-guards-architecture",
    task: "guards-architecture",
    runner: guardRow.runner,
  });
}

// The selected guards row owns the same coercion scan; fast-only plans retain its row.
if (
  !frozenTarget &&
  !compatibilityTarget &&
  runCheck &&
  checkTasks.some(({ task }) => task === "guards")
) {
  const coercionTask = checksFastCoreTasks.findIndex(({ task }) => task === "coercion-helpers");
  if (coercionTask >= 0) {
    checksFastCoreTasks.splice(coercionTask, 1);
  }
}

// These rows need no compiler plan; retain their existing full-check placement.
if (runCheckPlan && runNodeFull && !releaseFastLane) {
  for (const task of ["guards", "guards-architecture", "dependencies"]) {
    const index = checkTasks.findIndex((row) => row.task === task);
    if (index >= 0) {
      const { task: group, ...row } = checkTasks.splice(index, 1)[0];
      additionalChecks.push({ ...row, group });
    }
  }
}

const manifest = {
  release_scope: releaseScope,
  release_fast_lane: releaseFastLane,
  validation_tier: validationTier,
  docs_only: docsOnly,
  docs_changed: docsChanged,
  run_node: runNode,
  run_docker_seed_e2e: dockerSeedLanes.length > 0,
  docker_seed_lanes: dockerSeedLanes.join(" "),
  run_published_driver_update: publishedDriverUpdate,
  run_macos: runMacos,
  run_android: runAndroid,
  run_android_screenshots:
    !ordinaryPullRequest && parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_ANDROID_SCREENSHOTS),
  run_skills_python: runSkillsPython,
  run_windows: runWindows,
  run_build_artifacts: runBuildArtifacts,
  run_proof_tier: runProofTier,
  run_browser_native_host: runBrowserNativeHost,
  run_doctor_plugin_index: runDoctorPluginIndex,
  run_discord_component_proof: runDiscordComponentProof,
  run_gateway_watch: runGatewayWatch,
  run_tui_pty: runTuiPty,
  run_baseline_ratchets: runBaselineRatchets,
  run_checks_fast_core: checksFastCoreTasks.length > 0,
  run_checks_fast: runNodeFull,
  historical_target: historicalTarget,
  frozen_target: frozenTarget,
  compatibility_target: compatibilityTarget,
  run_qa_smoke_ci: runQaSmokeCi,
  qa_smoke_ci_matrix: createMatrix(
    Array.from({ length: qaSmokeCiPartCount }, (_, index) => {
      const part = index + 1;
      return {
        name: `profile ${part}/${qaSmokeCiPartCount}`,
        lane: `profile-${part}`,
        slug: `profile-${part}-of-${qaSmokeCiPartCount}`,
        part_count: qaSmokeCiPartCount,
      };
    }),
  ),
  run_prompt_snapshots: runNodeFull && !releaseFastLane && changedScopeHasPromptSnapshotImpact,
  run_sqlite_session_lifecycle: runSqliteSessionLifecycle,
  checks_fast_core_matrix: createMatrix(checksFastCoreTasks),
  run_plugin_contracts_shards: pluginContractShards.length > 0,
  plugin_contracts_matrix: createContractMatrix(pluginContractShards, "contracts-plugins"),
  run_channel_contracts_shards: channelContractShards.length > 0,
  channel_contracts_matrix: createContractMatrix(channelContractShards, "contracts-channels"),
  run_checks: runNodeFull,
  source_channel_test_env_json: JSON.stringify(sourceChannelTestEnv),
  run_checks_node_core_nondist: nodeTestNonDistShards.length > 0,
  checks_node_core_nondist_matrix: createMatrix(nodeTestNonDistShards),
  run_checks_node_core_dist: runNodeCoreDist,
  run_check: runCheck,
  // Older scope owners retain these guards rather than silently dropping coverage.
  run_pr_madge_import_cycles: runPrMadgeImportCycles,
  run_pr_kysely_guardrails: runPrKyselyGuardrails,
  split_pr_guards: splitPrGuards,
  narrow_check_paths_json: runCheckPlan ? JSON.stringify(changedPaths) : "",
  run_check_plan: runCheckPlan,
  check_plan_input_json: runCheckPlan
    ? JSON.stringify({
        ...(extensionLintMode
          ? {
              extensionLintMode,
              preserveFullChecks: !narrowCheckScope,
              ...(process.env.OPENCLAW_CI_CHANGED_BASE
                ? { changedBaseRef: process.env.OPENCLAW_CI_CHANGED_BASE }
                : {}),
            }
          : {}),
        typeGraphBoundaryOwner,
        changedPaths,
        changedCoreTestPaths: changedCoreTestPaths ?? null,
        runnerProfile,
        checkMatrix: createMatrix(checkTasks),
        coreTypeMatrix: createMatrix(coreTypeRows),
        lintCoreMatrix: createMatrix(coreLintRows),
        lintExtensionMatrix: createMatrix(extensionLintRows),
      })
    : "",
  check_matrix: createMatrix(runCheck ? checkTasks : []),
  core_type_matrix: createMatrix(coreTypeRows),
  lint_core_matrix: createMatrix(coreLintRows),
  lint_extension_matrix: createMatrix(extensionLintRows),
  central_lint_selection_json: "",
  run_lint_core: runCheck && coreLintRows.length > 0,
  run_lint_extensions: runCheck && extensionLintRows.length > 0,
  run_changed_core_type_stripes: Boolean(narrowCheckScope?.types && usesHostedRunnerProfile),
  type_graph_boundary_owner: typeGraphBoundaryOwner,
  startup_corpus_node_revision: startupCorpusNodeRevision,
  startup_corpus_test_files_json: startupCorpusTestFiles
    ? JSON.stringify(startupCorpusTestFiles)
    : "",
  changed_core_test_paths_json: changedCoreTestPaths ? JSON.stringify(changedCoreTestPaths) : "",
  run_check_additional: runNodeFull && !releaseFastLane && additionalChecks.length > 0,
  shared_sdk_declarations: sharedSdkDeclarations,
  check_additional_matrix: createMatrix(runNodeFull && !releaseFastLane ? additionalChecks : []),
  run_check_docs: docsChanged && eventName !== "push",
  run_format_check: runFormatCheck,
  run_control_ui_i18n: runControlUiI18n,
  run_ui_tests: runUiTests,
  ui_test_runtime_policy: uiTestRuntimePolicy,
  ui_test_shard_count: uiTestShardCount,
  ui_test_matrix: createMatrix(
    Array.from({ length: runUiTests ? uiTestShardCount : 0 }, (_, index) => ({ shard: index + 1 })),
  ),
  ui_test_groups_gzip_base64: uiTestGroups ? encodeNodeTestGroups(uiTestGroups.ui) : "",
  ui_e2e_test_groups_gzip_base64: uiTestGroups ? encodeNodeTestGroups(uiTestGroups.e2e) : "",
  ui_real_gateway_matrix: createMatrix(
    uiRealGatewayShards.map(({ groups, ...row }) => ({
      ...row,
      run_tests:
        !groups ||
        groups.some(
          (group) => group.includePatterns === undefined || group.includePatterns.length > 0,
        ),
      test_groups_gzip_base64: groups ? encodeNodeTestGroups(groups) : "",
    })),
  ),
  run_control_ui_performance: runControlUiPerformance,
  run_ui_e2e: runUiE2e,
  run_ui_real_gateway: runUiRealGateway,
  ui_e2e_matrix: createMatrix(
    Array.from({ length: uiE2eJobCount }, (_, index) => {
      const shard = index + 1;
      return {
        shard,
        shard_count: uiE2eJobCount,
        task: shard === uiE2eJobCount ? "browser-extension" : "control-ui",
        vitest_shard_count: uiE2eJobCount - 1,
        vitest_max_workers: compactUiE2e ? 3 : 2,
      };
    }).filter((row) =>
      row.task === "browser-extension" ? runBrowserExtensionE2e : runControlUiE2e,
    ),
  ),
  run_native_i18n: runNativeI18n,
  run_skills_python_job: runSkillsPython,
  run_checks_windows: runWindows,
  // Current targets balance the complete Windows inventory by measured
  // file cost; historical targets retain their original package commands.
  checks_windows_matrix: createMatrix(windowsShards),
  run_macos_node: runMacosNode,
  macos_node_matrix: createMatrix(
    runMacosNode
      ? [1, 2, 3].every((part) => hasPackageScript(`test:macos:ci:${part}`))
        ? [1, 2, 3].map((part) => ({
            check_name: `macos-node-${part}`,
            runtime: "node",
            task: `test-${part}`,
          }))
        : // Historical targets keep their complete native suite in one job.
          [{ check_name: "macos-node", runtime: "node", task: "test" }]
      : [],
  ),
  run_macos_swift:
    runMacos &&
    !npmQualification &&
    (!frozenTarget || compatibilityTarget || supportsCurrentMacosSwiftCi),
  run_openclawkit_tests: runMacos && !npmQualification && supportsOpenClawKitTests,
  run_ios_build: runIosBuild,
  run_ios_voice_cleanup_tests: iosSimulatorSelection.voice.selected,
  run_ios_lifecycle_tests: iosSimulatorSelection.lifecycle.selected,
  ios_simulator_selection: iosSimulatorSelection,
  run_android_job: runAndroid,
  run_android_access_native: runAndroidAccessNative,
  use_compatible_android_ci: useCompatibleAndroidCi,
  run_protocol_event_coverage: runProtocolEventCoverage,
  android_matrix: createMatrix(
    runAndroid
      ? [
          // android-ci-contract-v3: phone variants, Wear modules, Android lint, benchmark, and ktlint.
          {
            check_name: "android-test-play",
            task: useCompatibleAndroidCi ? "test-play-compat" : "test-play",
          },
          {
            check_name: "android-test-third-party",
            task: "test-third-party",
          },
          ...(!useCompatibleAndroidCi
            ? [
                {
                  check_name: "android-test-wear",
                  task: "test-wear",
                  ...(androidTestTier ? { lint: true, app_lint: "third-party" } : {}),
                },
              ]
            : []),
          ...(!androidTestTier
            ? [
                {
                  check_name: "android-build-play",
                  task: useCompatibleAndroidCi ? "build-play-compat" : "build-play",
                },
              ]
            : []),
          ...(!useCompatibleAndroidCi
            ? [
                ...(!androidTestTier
                  ? [{ check_name: "android-build-wear", task: "build-wear" }]
                  : []),
                {
                  check_name: "android-ktlint",
                  task: "ktlint",
                  ...(androidTestTier ? { app_lint: "play" } : {}),
                  ...(androidTestTier && androidBenchmarkChanged ? { build_benchmark: true } : {}),
                },
              ]
            : []),
        ]
      : [],
  ),
};

// Routing belongs to this workflow, not the frozen target's test planners.
// Only automatic hybrid first attempts can add optional hosted rows.
const HYBRID_HOSTED_ROW_LIMIT = 45;
const HYBRID_HOSTED_BASE_ROW_LIMIT = 40;
const hybridHostedEligible =
  !frozenTarget &&
  isCanonicalRepository &&
  ["hybrid", "runson"].includes(process.env.OPENCLAW_CI_RUNNER_BACKEND ?? "") &&
  process.env.GITHUB_RUN_ATTEMPT === "1" &&
  (eventName === "push" || ciQualification || eventName === "pull_request");
let hybridHostedBaseRows = 0;
let hybridHostedOffloadRows = 0;
if (hybridHostedEligible) {
  const count = (selected, rows = 1) => (selected ? rows : 0);
  const hostedNodeRows = manifest.checks_node_core_nondist_matrix.include.filter(
    (row) => row.runner === "ubuntu-24.04",
  ).length;
  const hostedAdditionalRows = manifest.check_additional_matrix.include.filter(
    (row) =>
      ![
        "extension-package-boundary",
        "runtime-topology-architecture",
        "plugin-sdk-api-diff",
        "dependencies",
      ].includes(row.group) || !row.runner.startsWith("blacksmith-"),
  ).length;
  const hostedPlanner =
    process.env.OPENCLAW_CI_RUNNER_BACKEND === "runson" || nodeRunnerBackend === "runson";
  const hostedRatchets =
    hostedPlanner ||
    (workflowEventName === "pull_request" &&
      process.env.OPENCLAW_CI_HEAD_REPOSITORY !== process.env.OPENCLAW_CI_REPOSITORY);
  // Include control jobs, every emitted matrix row and native hosted jobs.
  // Narrow PRs reserve full lint/type templates; only hybrid moves critical controls.
  // The guard independently expands the workflow to catch inventory drift.
  // Qualification authenticates on hosted preflight before paid admission.
  hybridHostedBaseRows = Object.values({
    preflight: count(ciQualification),
    "check-plan": count(hostedPlanner && runCheckPlan),
    "pr-fail-fast": count(
      workflowEventName === "pull_request" &&
        manifest.run_checks_node_core_nondist &&
        process.env.OPENCLAW_CI_HEAD_REPOSITORY !== process.env.OPENCLAW_CI_REPOSITORY,
    ),
    "control-ui-performance": count(manifest.run_control_ui_performance),
    "published-driver-update": count(manifest.run_published_driver_update),
    "native-i18n": count(manifest.run_native_i18n),
    "control-ui-i18n": count(manifest.run_control_ui_i18n),
    "checks-baseline-ratchets": count(hostedRatchets && manifest.run_baseline_ratchets),
    "checks-fast-core": count(
      manifest.run_checks_fast_core,
      manifest.checks_fast_core_matrix.include.length,
    ),
    "checks-fast-plugin-contracts-shard": count(
      manifest.run_plugin_contracts_shards,
      manifest.plugin_contracts_matrix.include.length,
    ),
    "checks-fast-channel-contracts-shard": count(
      manifest.run_channel_contracts_shards,
      manifest.channel_contracts_matrix.include.length,
    ),
    "checks-node-core-test-nondist-shard": count(
      manifest.run_checks_node_core_nondist,
      hostedNodeRows,
    ),
    "check-shard": count(
      manifest.run_check,
      checkTasks.filter(({ task }) => !["lint", "test-types", "dependencies"].includes(task))
        .length,
    ),
    "check-lint-hosted-extension-shard": count(
      manifest.run_check && runnerProfile === "hybrid" && !releaseGate,
      extensionLintRows.length,
    ),
    "check-additional-shard": count(manifest.run_check_additional, hostedAdditionalRows),
    "check-docs": count(manifest.run_check_docs),
    "skills-python": count(manifest.run_skills_python_job),
    "macos-node": count(manifest.run_macos_node, manifest.macos_node_matrix.include.length),
    "macos-swift": count(manifest.run_macos_swift, 2),
    "ios-build": count(manifest.run_ios_build),
    "ios-screenshot-shard": count(parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_IOS_SCREENSHOTS), 2),
    "ios-screenshot-evidence": count(parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_IOS_SCREENSHOTS)),
    "android-screenshots": count(manifest.run_android_screenshots),
    "android-access-native": count(manifest.run_android_access_native, 2),
    "docker-seed-e2e": count(
      manifest.run_docker_seed_e2e &&
        workflowEventName === "pull_request" &&
        process.env.OPENCLAW_CI_HEAD_REPOSITORY !== process.env.OPENCLAW_CI_REPOSITORY,
    ),
  }).reduce((total, rows) => total + rows, 0);
  hybridHostedOffloadRows =
    1 +
    count(manifest.run_ui_tests, 3) +
    count(
      manifest.run_ui_e2e && !compatibilityTarget,
      manifest.ui_e2e_matrix.include.filter((row) => row.task === "browser-extension").length,
    );
}
if (hybridHostedEligible && hybridHostedBaseRows > HYBRID_HOSTED_ROW_LIMIT) {
  console.warn(
    `::warning::Hybrid base manifest has ${hybridHostedBaseRows} hosted jobs, above the ${HYBRID_HOSTED_ROW_LIMIT}-row offload budget; keeping optional offloads on Blacksmith.`,
  );
}
const hybridHostedOffload =
  hybridHostedEligible &&
  hybridHostedBaseRows <= HYBRID_HOSTED_BASE_ROW_LIMIT &&
  hybridHostedBaseRows + hybridHostedOffloadRows <= HYBRID_HOSTED_ROW_LIMIT;
// Reserve the previous check-row budget so retaining the boundary on Blacksmith
// does not expand admission for other hosted checks. Report only actual rows below.
const hybridHostedCheckRows =
  Number(sharedSdkDeclarations) +
  (manifest.run_check && checkTasks.some(({ task }) => task === "dependencies") ? 1 : 0) +
  (manifest.run_check &&
  checkTasks.some(({ task }) => task === "test-types") &&
  usesHostedRunnerProfile
    ? coreTypeRows.length
    : 0) +
  (manifest.run_check_additional
    ? manifest.check_additional_matrix.include.filter((row) =>
        ["extension-package-boundary", "runtime-topology-architecture", "dependencies"].includes(
          row.group,
        ),
      ).length
    : 0);
const retainedBoundaryRows =
  Number(sharedSdkDeclarations) +
  (manifest.run_check_additional
    ? manifest.check_additional_matrix.include.filter(
        (row) => row.group === "extension-package-boundary",
      ).length
    : 0);
const hybridHostedExistingRows =
  hybridHostedBaseRows + (hybridHostedOffload ? hybridHostedOffloadRows : 0);
// R1's slowest admitted hosted check took 496s including setup. A full
// compact plan must retain at least 500s of serial Node work plus setup;
// aggregate two-slot estimates and the shortened Windows shards are not a floor.
const hybridHostedPullRequestHasSlack =
  changedNodeTestShards === null &&
  rawNodeTestShards.some(
    (shard) =>
      !shard.requiresDist && shard.planConcurrency === 1 && (shard.predictedSeconds ?? 0) >= 500,
  );
const hybridHostedChecks =
  hybridHostedEligible &&
  ((eventName === "push" && eventRef === "refs/heads/main") ||
    (eventName === "pull_request" &&
      manifest.run_checks_windows &&
      hybridHostedPullRequestHasSlack)) &&
  process.env.OPENCLAW_CI_HOSTED_HEALTHY === "true" &&
  hybridHostedExistingRows + hybridHostedCheckRows <= HYBRID_HOSTED_ROW_LIMIT;
const hybridHostedRowsWithChecks =
  hybridHostedExistingRows + (hybridHostedChecks ? hybridHostedCheckRows : 0);
// Main can spend remaining hosted capacity on independent four-CPU checks.
// PRs retain their Blacksmith placement regardless of spare row capacity.
const hybridHostedMainCheckRows = manifest.run_check ? 2 : 0;
const hybridHostedMainChecks =
  hybridHostedChecks &&
  eventName === "push" &&
  eventRef === "refs/heads/main" &&
  hybridHostedRowsWithChecks + hybridHostedMainCheckRows <= HYBRID_HOSTED_ROW_LIMIT;
Object.assign(manifest, {
  hybrid_hosted_offload: hybridHostedOffload,
  hybrid_hosted_checks: hybridHostedChecks,
  hybrid_hosted_main_checks: hybridHostedMainChecks,
  hybrid_hosted_base_rows: hybridHostedBaseRows,
  hybrid_hosted_total_rows:
    hybridHostedRowsWithChecks -
    (hybridHostedChecks ? retainedBoundaryRows : 0) +
    (hybridHostedMainChecks ? hybridHostedMainCheckRows : 0),
});
if (runCheckPlan) {
  console.log(
    "Hosted admission reserves full lint/type template bounds and any hosted check-plan job; late selection cannot expand that inventory.",
  );
}
if (hybridHostedEligible) {
  console.log(
    `Hybrid hosted rows: ${manifest.hybrid_hosted_base_rows} base, ${manifest.hybrid_hosted_total_rows} total; optional offload ${hybridHostedOffload ? "admitted" : "retained on Blacksmith"}; measured checks ${hybridHostedChecks ? "admitted" : "retained on Blacksmith"}; main checks ${hybridHostedMainChecks ? "admitted" : "retained on Blacksmith"}`,
  );
}

// The PR monitor must see the whole selected graph before declaring it
// complete; an early jobs response can omit not-yet-expanded matrices.
const countPrJobs = (selected, rows = 1) => (selected ? rows : 0);
manifest.pr_check_job_count =
  workflowEventName !== "pull_request"
    ? 0
    : countPrJobs(manifest.run_check, manifest.check_matrix.include.length) +
      countPrJobs(
        manifest.run_check && manifest.run_lint_core && usesHostedRunnerProfile,
        manifest.lint_core_matrix.include.length,
      ) +
      countPrJobs(
        manifest.run_check && manifest.run_lint_extensions && runnerProfile === "hybrid",
        manifest.lint_extension_matrix.include.length,
      ) +
      countPrJobs(
        manifest.run_check &&
          usesHostedRunnerProfile &&
          (!manifest.narrow_check_paths_json || manifest.run_changed_core_type_stripes),
        manifest.core_type_matrix.include.length,
      );
manifest.pr_job_count =
  workflowEventName !== "pull_request"
    ? 0
    : 2 +
      countPrJobs(sharedSdkDeclarations) +
      countPrJobs(manifest.run_check_plan) +
      manifest.pr_check_job_count +
      [
        "run_build_artifacts",
        "run_control_ui_performance",
        "run_native_i18n",
        "run_control_ui_i18n",
        "run_baseline_ratchets",
        "run_check_docs",
        "run_skills_python_job",
        "run_docker_seed_e2e",
        "run_published_driver_update",
      ].reduce((sum, key) => sum + countPrJobs(manifest[key]), 0) +
      [
        ["run_checks_fast_core", "checks_fast_core_matrix"],
        ["run_plugin_contracts_shards", "plugin_contracts_matrix"],
        ["run_channel_contracts_shards", "channel_contracts_matrix"],
        ["run_checks_node_core_nondist", "checks_node_core_nondist_matrix"],
        ["run_check_additional", "check_additional_matrix"],
        ["run_checks_windows", "checks_windows_matrix"],
        ["run_macos_node", "macos_node_matrix"],
        ["run_android_job", "android_matrix"],
        ["run_qa_smoke_ci", "qa_smoke_ci_matrix"],
        ["run_ui_e2e", "ui_e2e_matrix"],
      ].reduce(
        (sum, [selected, matrix]) =>
          sum + countPrJobs(manifest[selected], manifest[matrix].include.length),
        0,
      ) +
      countPrJobs(manifest.run_ui_tests, uiTestShardCount) +
      countPrJobs(manifest.run_macos_swift, 2) +
      countPrJobs(manifest.run_ios_build) +
      (manifest.run_ui_real_gateway ? uiRealGatewayShards.length : 0) +
      countPrJobs(manifest.run_android_access_native, 2) +
      countPrJobs(parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_IOS_SCREENSHOTS), 3) +
      countPrJobs(manifest.run_android_screenshots);

for (const [key, value] of Object.entries(manifest)) {
  appendFileSync(
    outputPath,
    `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    "utf8",
  );
}
console.log(`CI release scope: ${releaseScope}`);
if (releaseFastLane) {
  const running = `security-fast, check-shard (lint, prod/test types, guards, dependencies), check-docs when docs changed, and ${nodeTestShards.length} changed Node rows${runBuildArtifacts ? ", build-artifacts for selected owners" : ""}${dockerSeedLanes.length ? ", owner-selected Docker seed" : ""}${runQaSmokeCi ? ", owner-selected QA Smoke" : ""}`;
  console.log(
    `::notice title=Release fast lane::Admitted by label release-fast-lane for release tooling paths. Running: ${running}.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "### Release fast lane\n\n" +
        "- Admitted by label `release-fast-lane` for release tooling paths.\n" +
        `- Running: ${running}.\n` +
        "- Skipped: contracts, baseline ratchets, bundled protocol, Bun launcher, additional checks, Control UI, Windows, macOS, iOS, Android, native and Control UI i18n, skills-python.\n" +
        (changedNodeTestFallbackReason
          ? `- Node plan: bounded owner selection (${changedNodeTestFallbackReason}).\n`
          : "") +
        "\n",
    );
  }
} else if (releaseFastLaneLabel) {
  const reason = releaseFastLaneScope.reason;
  console.warn(`::warning title=Release fast lane declined::${reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release fast lane\n\n- Declined: ${reason}. Ordinary CI selection applies.\n\n`,
    );
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  if (runIosBuild) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      formatIosSimulatorSelectionSummary(iosSimulatorSelection),
    );
  }
  if (uiE2eSelection) {
    const escapeSummaryCell = (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/[\\`*_{}[\]()#+.!|]/gu, "\\$&")
        .replace(/[\r\n]/gu, " ");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "### Control UI E2E selection\n\n" +
        `- Mode: ${uiE2eSelection.mode}.\n` +
        `- Selected files: ${uiE2eSelection.files.length}.\n` +
        (parseCiEnvFlag(process.env.OPENCLAW_CI_UI_E2E_FULL)
          ? "- Full PR coverage requested by `OPENCLAW_CI_UI_E2E_FULL`.\n"
          : "") +
        "\n| File | Reasons |\n| --- | --- |\n" +
        uiE2eSelection.files
          .map(
            (file) =>
              `| ${escapeSummaryCell(file)} | ${(uiE2eSelection.reasons[file] ?? [])
                .map(escapeSummaryCell)
                .join("; ")} |\n`,
          )
          .join("") +
        "\n",
    );
  }
  if (selectedTestTargets) {
    /** @type {Map<string, Set<string>>} */
    const reasons = new Map();
    for (const { rule, targets } of nodeSelectionReasons) {
      for (const file of targets) {
        const rules = reasons.get(file) ?? new Set();
        rules.add(rule);
        reasons.set(file, rules);
      }
    }
    // Paths are diff-controlled; render them as escaped HTML text, never Markdown.
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### PR Node test selection (${nodeSelectionMode})\n\n` +
        `Selected ${selectedTestTargets.length} files; ${changedNodeTestShards?.filter((shard) => !shard.requiresDist).length ?? 0} Node rows. ` +
        "Set repository variable `OPENCLAW_CI_NODE_SELECTION=full` to restore the previous selection.\n\n" +
        "<details><summary>Selected files and selection rules</summary>\n<pre>" +
        selectedTestTargets
          .map((file) =>
            escapeSummaryHtml(
              `${file}\t${[...(reasons.get(file) ?? [])].toSorted((left, right) => left.localeCompare(right)).join(", ")}`,
            ),
          )
          .join("\n") +
        "</pre>\n</details>\n\n",
    );
  }
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### CI release qualification\n\n- Scope: \`${releaseScope}\`\n- Target: \`${checkoutRevision}\`\n` +
      (npmQualification
        ? "- Native app qualification: deferred; Linux, macOS, and Windows Node coverage retained.\n"
        : ""),
  );
}

// Preflight runs once per workflow attempt; shard selection stays silent.
if (
  process.env.GITHUB_ACTIONS === "true" &&
  typeof testRuntimePolicy?.inspectNativeBunQualifications === "function"
) {
  try {
    const { staleEntries, changedInputs } = testRuntimePolicy.inspectNativeBunQualifications(
      process.cwd(),
    );
    if (staleEntries.length > 0) {
      let detail = "Detailed job summary unavailable.";
      if (process.env.GITHUB_STEP_SUMMARY) {
        try {
          appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            "### Native Bun qualification staleness\n\n" +
              `${staleEntries.length} recorded native qualifications are stale. Existing Vitest coverage is retained.\n\n` +
              "Changed or unreadable inputs:\n\n<pre>" +
              changedInputs
                .map(({ file, reason }) => escapeSummaryHtml(`${file}\t${reason}`))
                .join("\n") +
              "</pre>\n\n<details><summary>Stale entries</summary>\n<pre>" +
              staleEntries.map(escapeSummaryHtml).join("\n") +
              "</pre>\n</details>\n\n",
          );
          detail = "See the job summary for stale entries and changed inputs.";
        } catch {
          // Reporting is advisory even when the summary cannot be written.
        }
      }
      console.warn(
        `::notice title=Native Bun qualification staleness::${staleEntries.length} recorded entries have ${changedInputs.length} changed or unreadable inputs; existing Vitest coverage is retained. ${detail}`,
      );
    }
  } catch {
    console.warn(
      "::notice title=Native Bun qualification staleness::Could not inspect native qualification fingerprints. Runtime selection is unchanged.",
    );
  }
}
