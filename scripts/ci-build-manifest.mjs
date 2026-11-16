import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import path, { matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTestGitCommits } from "../.github/actions/git-owner/test-prerequisites.mjs";
import { isTestFileTarget } from "./lib/changed-path-facts.mjs";
import { blacksmithRunnerLabel } from "./lib/ci-blacksmith-capacity.mjs";
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "./lib/ci-ios-smoke-plan.mjs";
import { resolveBoatNodeTestCapacity } from "./lib/ci-node-test-capacity.mts";
import { resolveSkillsPythonTargets } from "./lib/ci-skills-python-plan.mjs";
import { resolveCiTestAuditConfig } from "./lib/ci-test-observations.mjs";
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
  (process.env.OPENCLAW_CI_QUALIFICATION === "true" ||
    (process.env.OPENCLAW_CI_RELEASE_GATE === "true" &&
      process.env.OPENCLAW_CI_NODE_RUNNER_BACKEND === "runson"));
const mainQualification = ciQualification && process.env.OPENCLAW_CI_SHAPE === "main";
const exactMainQualification =
  mainQualification && process.env.OPENCLAW_CI_RELEASE_GATE === "false";
// Admission owns identity. Project only coverage; the raw event still owns trust and provenance.
const eventName = exactMainQualification
  ? "schedule"
  : ciQualification
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
const fullUiPullRequest = ordinaryPullRequest && parseCiEnvFlag(process.env.OPENCLAW_CI_FULL);

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
const createMatrix = (include) => ({
  include: include.map((row) => {
    // Project before serialization so direct and late-planned matrices agree.
    const capacity =
      process.env.OPENCLAW_CI_EFFECTIVE_RUNNER_BACKEND === "boat"
        ? resolveBoatNodeTestCapacity(row.runner, row.check_name, undefined, [
            ...(row.includePatterns ?? []),
            ...(row.groups ?? []).flatMap((group) => group.includePatterns ?? []),
          ])
        : undefined;
    if (capacity) {
      return { ...row, runner: capacity.runner, runner_label: capacity.runner };
    }
    const label = row.runner_label ?? blacksmithRunnerLabel(row.runner);
    return label ? { ...row, runner_label: label } : row;
  }),
});
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
  if (exactMainQualification) {
    return null;
  }
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
const docsOnly = !exactMainQualification && parseCiEnvFlag(process.env.OPENCLAW_CI_DOCS_ONLY);
const docsChanged = exactMainQualification || parseCiEnvFlag(process.env.OPENCLAW_CI_DOCS_CHANGED);
const scopeEnabled = (value) => exactMainQualification || parseCiEnvFlag(value);
const rootProseOnly = parseCiEnvFlag(process.env.OPENCLAW_CI_DOCS_ROOT_PROSE_ONLY);
const releaseGate = parseCiEnvFlag(process.env.OPENCLAW_CI_RELEASE_GATE) && !ciQualification;
const compactPullRequest = isCanonicalRepository && eventName === "pull_request";
const runtimePullRequest = isCanonicalRepository && (compactPullRequest || releaseGate);
// Exact-head release gates substitute for PR CI. Ordinary manual CI
// is Full Release Validation's owner for the complete process proofs.
const runProofTier = eventName !== "pull_request" && !releaseGate;
const releaseScope = process.env.OPENCLAW_CI_RELEASE_SCOPE ?? "full";
const validationTier = process.env.OPENCLAW_CI_VALIDATION_TIER ?? "full";
const mainValidation = validationTier === "main";
if (exactMainQualification && !mainValidation) {
  throw new Error("Exact main qualification requires validation_tier=main");
}
if (validationTier !== "full" && !mainValidation) {
  throw new Error("validation_tier must be full or main");
}
if (
  mainValidation &&
  (!["workflow_dispatch", "schedule"].includes(workflowEventName) ||
    !isCanonicalRepository ||
    frozenTarget ||
    compatibilityTarget ||
    (ciQualification && !exactMainQualification) ||
    (exactMainQualification && checkoutRevision !== workflowRevision) ||
    releaseGate ||
    releaseScope !== "full" ||
    process.env.OPENCLAW_CI_PULL_REQUEST_NUMBER)
) {
  throw new Error(
    "The main validation tier requires canonical same-revision manual or scheduled validation with full scope",
  );
}
const npmQualification = releaseScope === "npm-beta" || releaseScope === "npm-stable";
// Stable tags also ship the macOS app, and its post-tag validation is too late
// to block the tag, so only beta defers macOS Swift proof.
const deferMacosSwift = releaseScope === "npm-beta";
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
  ((scopeEnabled(process.env.OPENCLAW_CI_RUN_NODE) && !docsOnly) || toolingOwnerChange);
const runNodeFastOnly =
  runNode &&
  !runtimePullRequest &&
  !toolingOwnerChange &&
  !exactMainQualification &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_ONLY);
const runNodeFull = runNode && !runNodeFastOnly;
const runBuiltSourceVerifiers =
  runNodeFull &&
  !frozenTarget &&
  changedPaths?.includes("scripts/test-built-source-verifiers.mts") === true;
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
  runNode &&
  !exactMainQualification &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_PLUGIN_CONTRACTS);
const runNodeFastCiRouting =
  runNode &&
  !exactMainQualification &&
  parseCiEnvFlag(process.env.OPENCLAW_CI_RUN_NODE_FAST_CI_ROUTING);
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
// Reuse releaseGate's existing exact-SHA/PR admission; never acquire a backend
// or download models for ordinary PR, push, schedule, or unrelated dispatches.
const mlxNativeProofScope =
  workflowEventName === "workflow_dispatch" && releaseGate && !frozenTarget && !compatibilityTarget
    ? await importTargetPlan("./scripts/ci-changed-scope.mjs")
    : null;
const runMlxNativeProof =
  workflowEventName === "workflow_dispatch" &&
  releaseGate &&
  isCanonicalRepository &&
  !frozenTarget &&
  !compatibilityTarget &&
  releaseScope === "full" &&
  typeof mlxNativeProofScope?.hasMlxNativeProofInputs === "function" &&
  mlxNativeProofScope.hasMlxNativeProofInputs(changedPaths);
const runMacos =
  !ordinaryPullRequest &&
  !nativeGeneratedOnly &&
  scopeEnabled(process.env.OPENCLAW_CI_RUN_MACOS) &&
  !docsOnly &&
  isCanonicalRepository &&
  !releaseFastLane;
// Older selected checkouts report only run_macos; retain their native Node coverage.
const runMacosNode =
  runMacos ||
  (!ordinaryPullRequest &&
    !nativeGeneratedOnly &&
    scopeEnabled(process.env.OPENCLAW_CI_RUN_MACOS_NODE) &&
    !docsOnly &&
    isCanonicalRepository &&
    !releaseFastLane);
const supportsCurrentMacosSwiftCi =
  existsSync("scripts/install-swift-tools.sh") &&
  existsSync("scripts/lint-swift.sh") &&
  existsSync("scripts/format-swift.sh");
const runMacosSwift =
  (runMacos || runMlxNativeProof) &&
  !deferMacosSwift &&
  (!frozenTarget || compatibilityTarget || supportsCurrentMacosSwiftCi);
const supportsIosBuild = hasPackageScript("ios:build");
const supportsCurrentIosCi = supportsIosBuild && supportsCurrentMacosSwiftCi;
const iosBuildScope =
  !nativeGeneratedOnly &&
  scopeEnabled(process.env.OPENCLAW_CI_RUN_IOS_BUILD) &&
  !releaseFastLane &&
  !npmQualification &&
  !docsOnly &&
  isCanonicalRepository &&
  (!frozenTarget || supportsCurrentIosCi || (releaseCandidateTarget && supportsIosBuild));
const runIosBuild = !ordinaryPullRequest && iosBuildScope;
const runAndroid =
  !nativeGeneratedOnly &&
  scopeEnabled(process.env.OPENCLAW_CI_RUN_ANDROID) &&
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
  scopeEnabled(process.env.OPENCLAW_CI_RUN_WINDOWS) &&
  !releaseFastLane &&
  !docsOnly &&
  !runNodeFastOnly &&
  isCanonicalRepository;
const runSkillsPython =
  scopeEnabled(process.env.OPENCLAW_CI_RUN_SKILLS_PYTHON) && !docsOnly && !releaseFastLane;
const runControlUiI18n =
  scopeEnabled(process.env.OPENCLAW_CI_RUN_CONTROL_UI_I18N) && !docsOnly && !releaseFastLane;
let runUiTests =
  fullUiPullRequest ||
  (scopeEnabled(process.env.OPENCLAW_CI_RUN_UI_TESTS) &&
    !docsOnly &&
    !nodeDataOnly &&
    !releaseFastLane);
// The UI owner graph also covers protocol and Gateway-served inputs
// outside ui/. Ordinary UI test leaves retain their cheaper unit owner.
const selectUiE2eFamily = (family) =>
  fullUiPullRequest ||
  (!docsOnly &&
    !nodeDataOnly &&
    !releaseFastLane &&
    (runtimePullRequest &&
    (!frozenTarget || releaseGate) &&
    !compatibilityTarget &&
    changedPaths !== null &&
    typeof changedNodeTestPlan.hasUiE2eAffectingChange === "function"
      ? changedNodeTestPlan.hasUiE2eAffectingChange(changedPaths, { family })
      : runUiTests));
let runControlUiE2e = selectUiE2eFamily("control-ui");
let runBrowserExtensionE2e = selectUiE2eFamily("browser-extension");
let runUiRealGateway =
  (fullUiPullRequest || !ordinaryPullRequest) && selectUiE2eFamily("real-gateway");
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
// Match four observed CPUs per 16-class job; nine Control UI shards fit slow hosted runners.
// Private source-server projects remain serial.
const compactUiE2e = supportsUiE2eProjects && !includeReleaseOnlyUiTests;
let uiE2eJobCount = compactUiE2e
  ? 10
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
  scopeEnabled(process.env.OPENCLAW_CI_RUN_NATIVE_I18N) &&
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
// Wear production strings feed the phone generator; only its test/debug inputs
// are independent. Shared modules, build inputs and missing paths keep all rows.
const narrowAndroidUnitTests =
  ordinaryPullRequest &&
  !frozenTarget &&
  !useCompatibleAndroidCi &&
  changedPaths !== null &&
  changedPaths.length > 0 &&
  changedPaths.every(
    (file) =>
      /^(?:apps\/android\/app\/src\/|apps\/android\/wear\/src\/(?:test|androidTest|debug)\/)/u.test(
        file,
      ) && lstatSync(file, { throwIfNoEntry: false })?.isFile(),
  );
const runAndroidPhoneTests =
  !narrowAndroidUnitTests || changedPaths?.some((file) => file.startsWith("apps/android/app/"));
const runAndroidWearTests =
  !narrowAndroidUnitTests || changedPaths?.some((file) => file.startsWith("apps/android/wear/"));
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
const testRuntimePolicyPath = "./scripts/lib/ci-test-runtime.mts";
const testRuntimePolicy = existsSync(testRuntimePolicyPath)
  ? await importTargetPlan(testRuntimePolicyPath)
  : null;
const dispatchRuntimePolicy =
  workflowEventName === "workflow_dispatch"
    ? process.env.OPENCLAW_CI_TEST_RUNTIME_POLICY?.trim()
    : "";
if (dispatchRuntimePolicy && !["node", "bun-all", "dual-all"].includes(dispatchRuntimePolicy)) {
  throw new Error("test_runtime_policy must be empty, node, bun-all, or dual-all");
}
if (dispatchRuntimePolicy && !testRuntimePolicy?.resolveCiTestRuntimePolicy) {
  throw new Error("The selected checkout does not support test_runtime_policy selection");
}
if (dispatchRuntimePolicy) {
  testRuntimePolicy.resolveCiTestRuntimePolicy({
    OPENCLAW_CI_TEST_RUNTIME_POLICY: dispatchRuntimePolicy,
  });
}
const testRuntimeMode = testRuntimePolicy
  ? dispatchRuntimePolicy ||
    (workflowEventName === "workflow_dispatch" && !mainValidation && !ciQualification
      ? "dual-all"
      : "bun-all")
  : "node";
// Preserve deliberate daily/PR colocation and capacity. Only full manual validation
// pays duplicate runtime setup for independent execution and retries.
const splitRuntimeJobs =
  eventName === "workflow_dispatch" &&
  !runtimePullRequest &&
  !mainValidation &&
  typeof testRuntimePolicy?.ciTestShardRuntimes === "function";
// Timing readers and the executor must price the same runtime before planning.
process.env.OPENCLAW_CI_TEST_RUNTIME_POLICY = testRuntimeMode;
const nodeSelectionMode = process.env.OPENCLAW_CI_NODE_SELECTION === "full" ? "full" : "aggressive";
const nodeSelectionReasons = [];
let selectedTestTargets;
// Preserve the original policy independently of later execution opt-ins.
const nodeVolumeContext =
  runtimePullRequest && changedPaths !== null
    ? Object.freeze({
        revision: checkoutRevision,
        runtimePolicy: testRuntimeMode,
        fullPlan: () => createFullNodeTestPlan(),
        environment: Object.freeze({ ...process.env }),
        eligibility: Object.freeze({
          changedPaths: Object.freeze([...changedPaths]),
          includeReleaseOnlyRuntimeTests,
          includePrExemptRuntimeTests,
        }),
      })
    : undefined;
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
    adaptiveMarkdown:
      isCanonicalRepository &&
      compactPullRequest &&
      !releaseGate &&
      !frozenTarget &&
      !compatibilityTarget &&
      nodeSelectionMode === "aggressive",
    onSelection: (selection) => {
      nodeSelectionReasons.push(selection);
      console.log(`Node test selection provenance: ${JSON.stringify(selection)}`);
    },
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
  fullUiPullRequest ||
  !runtimePullRequest ||
  releaseGate ||
  parseCiEnvFlag(process.env.OPENCLAW_CI_UI_E2E_FULL);
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
        // Only edited test files opt into the release-only UI tier on automatic CI.
        includeReleaseOnlyTests: includeReleaseOnlyUiTests,
        ...(typeof nodeTestPlan.resolveUiE2ePrTestSelection === "function"
          ? { includeReleaseOnlyE2eTests: forceFullUiE2e }
          : {}),
        includePrExemptRuntimeTests:
          fullUiPullRequest || selectedTestTargets ? true : includePrExemptRuntimeTests,
        changedPaths: changedPaths ?? [],
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
          ? (fullUiPullRequest || !ordinaryPullRequest) &&
            (uiOwnerScope.realGateway || selected.has(file))
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
  // Small PR selections share the existing three-worker row instead of repeating setup.
  // Full UI owners and manual validation retain their established shard layout.
  uiTestShardCount = Math.min(
    3,
    ordinaryPullRequest && !uiOwnerScope.unit ? Math.ceil(uiTargets.length / 3) : uiTargets.length,
  );
  // Keep the existing worker/row cap; omit empty file partitions.
  uiE2eJobCount = Math.min(uiE2eJobCount - 1, controlTargets.length) + 1;
}
if (uiE2eSelection) {
  const includedFiles = new Set(
    uiTestGroups?.e2e.flatMap((group) => group.includePatterns ?? []) ?? uiE2eSelection.files,
  );
  uiE2eSelection.files = uiE2eSelection.files.filter((file) => includedFiles.has(file));
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
// WebKit shares the first UI row; it never adds a runner or matrix slot.
// Keep its browser-only contracts scoped to their interaction and style owners.
const uiWebkitOwners = [
  "ui/vitest.config.ts",
  "ui/src/components/{control-theme*,modal-dialog*,tooltip*,menu-*,overlay*,composer-menu*,dropdown-menu*,anchored-overlay*,textarea-token-anchor*,panel-tab-strip*,select-picker*,multi-select*,agent-select*,lobster-pet*,session-group-defaults-dialog*}.{ts,tsx}",
  "ui/src/components/{session-hovercard*,solid/session-hovercard*}.{ts,tsx,css}",
  "ui/src/components/solid/{menu*.{ts,tsx},overlay.css}",
  "ui/src/app/app-shell-chrome.ts",
  "ui/src/pages/{cron/view-jobs-filter,plugins/settings-editor,plugins/settings-view}.{ts,tsx,css}",
  "ui/src/pages/chat/chat-composer*.{ts,tsx}",
  "ui/src/pages/chat/components/chat-{composer*,picker-overlay*,model-picker*,effort-picker*}.{ts,tsx}",
  "ui/src/pages/chat/{chat-pane-header,components/chat-pane-header*}.{ts,tsx}",
  "ui/src/lib/solid-bridge.ts",
  "ui/src/lib/solid-bridge-view.tsx",
  "ui/src/lib/presentation.ts",
  "ui/src/pages/new-session/{composer*,draft-composer*}.{ts,tsx}",
  "ui/src/lib/native-overlay-occlusion.{ts,tsx}",
  "ui/src/styles/{base,layout,components,sidebar-menus,select-picker,multi-select,hub-tabs,*tooltip*,modal*,menu*,session-menu*}.css",
  "ui/src/styles/chat/{composer*,emoji-menu*,mention-menu*,model-picker*}.css",
];
const runUiWebkit =
  runUiTests &&
  !frozenTarget &&
  Boolean(changedPaths?.some((file) => uiWebkitOwners.some((owner) => matchesGlob(file, owner))));
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
// main have no branch-protection consumers. Dispatch keeps the complete
// inventory; runtime-capable full dispatches share the existing bounded packer.
const compactPlanMode = !isCanonicalRepository
  ? undefined
  : runtimePullRequest
    ? "pull-request"
    : eventName === "push" || mainValidation
      ? "push"
      : undefined;
const nodeMatrixLimit = mainValidation ? 77 : compactPlanMode === "pull-request" ? 130 : 70;
// Accounting and execution share the original unselected plan's inputs.
function createFullNodeTestPlan(workerShardCount = 0) {
  return createNodeTestPlan({
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
    compactMode: mainValidation
      ? "pull-request"
      : (compactPlanMode ??
        (splitRuntimeJobs && testRuntimeMode !== "node" ? "pull-request" : undefined)),
    mainValidation,
    compactNodeJobCap:
      splitRuntimeJobs && testRuntimeMode !== "node"
        ? undefined
        : nodeMatrixLimit - workerShardCount,
    runnerBackend: nodeRunnerBackend,
  });
}
let changedNodeTestShards = null;
/** @type {string | undefined} */
let changedNodeTestFallbackReason;
if (runtimePullRequest && runNodeFull) {
  // PRs admit only concrete owner plans; missing selection is a planner failure.
  if (typeof changedNodeTestPlan.createChangedNodeTestShards !== "function") {
    throw new Error("Current PR CI target does not export createChangedNodeTestShards");
  }
  changedNodeTestShards = changedNodeTestPlan.createChangedNodeTestShards(changedPaths, {
    volumeContext: nodeVolumeContext,
    baseRef: process.env.OPENCLAW_CI_CHANGED_BASE,
    compactNodeJobCap: compactPlanMode ? nodeMatrixLimit : undefined,
    selectedTestTargets,
    // Changed compiler plans validate every consuming graph, with full fallback on ambiguity.
    dedicatedCoreTypeChecks: runNodeFull,
    dedicatedBuildArtifacts: runBuiltSourceVerifiers,
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
let preserveFullChecks = !narrowCheckScope;
let typeGraphBoundaryOwner = "";
if (runCheckPlan && proposedCheckScope?.types) {
  const { resolveChangedCiTsgoInputs } = await import(
    fromTarget("./scripts/lib/tsgo-core-test-shards.mts")
  );
  const compilerPaths = resolveChangedCiTsgoInputs(changedPaths, existsSync);
  if (preserveFullChecks && extensionLintMode && !releaseFastLane && compilerPaths) {
    const { getChangedPathFacts, isTestLineAllocationPath } = await import(
      fromTarget("./scripts/lib/changed-path-facts.mjs")
    );
    const { resolveCiCheckFamilyScope } = await import(
      fromTarget("./scripts/lib/ci-check-family-scope.mts")
    );
    const budgetCompanions = changedPaths.filter((file) => !isTestLineAllocationPath(file));
    const budgetOnlyFallback =
      budgetCompanions.length < changedPaths.length &&
      resolveCiCheckFamilyScope(budgetCompanions).mode === "scoped";
    const sourceOnlyFallback = compilerPaths.every((file) => file.startsWith("src/"));
    // Shared tests and numeric allocations retain every guard family, including
    // allocation validation. A budget record does not widen otherwise scoped
    // companions. Ordinary source inputs can also use complete compiler/lint
    // consumer discovery even when a fixture requires all guard families.
    preserveFullChecks = !changedPaths.every((file) => {
      const facts = getChangedPathFacts(file);
      return (
        path.posix.normalize(file) === file &&
        !file.includes("\\") &&
        (isTestLineAllocationPath(file) ||
          (budgetOnlyFallback && facts.surface === "rootTest") ||
          ((budgetOnlyFallback || sourceOnlyFallback) && facts.surface === "docs") ||
          (["source", "package", "ui", "extension"].includes(facts.surface) &&
            (budgetOnlyFallback ||
              sourceOnlyFallback ||
              (facts.isTestOnly && facts.isChangedLaneTest))))
      );
    });
  }
  typeGraphBoundaryOwner =
    runNodeFull &&
    !releaseFastLane &&
    proposedCheckScope.additionalGroups.includes("boundaries") &&
    (preserveFullChecks ||
      !compilerPaths ||
      compilerPaths.every((file) => file.startsWith("extensions/")))
      ? "additional-checks"
      : "check-plan";
}
const fullCoreLintStripes =
  runnerProfile === "hybrid" &&
  nodeRunnerBackend !== "boat" &&
  !frozenTarget &&
  ((!releaseGate && ["push", "pull_request"].includes(eventName)) ||
    nodeRunnerBackend === "runson" ||
    (ciQualification && !exactMainQualification))
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
const postgresConformancePlan = existsSync("scripts/lib/postgres-conformance-shards.mts")
  ? await import(fromTarget("./scripts/lib/postgres-conformance-shards.mts"))
  : {};
if (
  "isPostgresConformanceTestTarget" in postgresConformancePlan &&
  typeof postgresConformancePlan.isPostgresConformanceTestTarget !== "function"
) {
  throw new Error("PostgreSQL conformance test ownership must be a function");
}
const { isPostgresConformanceTestTarget } = postgresConformancePlan;
const postgresConformancePaths = [
  "package.json",
  "pnpm-lock.yaml",
  ".github/actions/postgres-conformance/**",
  "**/*.postgres.test.ts",
  "src/state/openclaw-agent-*",
  "src/config/sessions/**",
  "src/agents/harness/context-engine-turn-outbox*",
  "src/gateway/server*.ts",
  "src/gateway/server-methods/cron.ts",
  "src/gateway/server-methods/cron-add.ts",
  "src/gateway/server-methods/cron-run.ts",
  "src/cli/gateway-cli/run.ts",
  "src/commands/*preflight*.ts",
  "src/commands/doctor-database-*.ts",
  "src/commands/doctor-schema-migrations.ts",
  "src/plugins/doctor-*.ts",
  "src/plugins/manifest-backup-resources.ts",
  "src/state/*worker*.ts",
  "src/state/openclaw-state-ownership.ts",
  "src/state/openclaw-agent-db-registry-listing.ts",
  "src/infra/sqlite-worker-*.ts",
  "src/state/openclaw-state-db*",
  "src/state/openclaw-state-feature-schema-ensure.ts",
  "src/state/user-profiles-schema.ts",
  "src/snapshot/**",
  "src/infra/backup-*.ts",
  "src/infra/update-database-*.ts",
  "src/infra/update-*.ts",
  "src/infra/state-migrations*.ts",
  "src/infra/database-port-recovery*.ts",
  "src/infra/restart-sentinel*.ts",
  "src/infra/device-identity*.ts",
  "src/infra/device-auth-store*.ts",
  "src/cli/update-cli/**",
  "src/commands/backup*.ts",
  "src/state/openclaw-state-snapshot-sanitizer.ts",
  "scripts/generate-postgres-schema.mts",
  "scripts/lib/postgres-schema-catalog.mts",
  "scripts/lib/postgres-schema-triggers.mts",
  "scripts/lib/postgres-agent-conformance.mts",
  "src/state/openclaw-agent-schema.sql",
  "test/scripts/generate-postgres-schema.test.ts",
  "src/state/*schema*",
  "src/state/openclaw-state-db-contract.ts",
  "src/state/postgres-schema.generated/**",
  "src/cron/store/runtime-authority-store.ts",
  "src/cron/store/row-codec.ts",
  "src/cron/store/runtime-rows.kernel.ts",
  "src/cron/store/run-finalization.worker.ts",
  "src/cron/store/run-queue.worker.ts",
  "src/cron/service.ts",
  "src/cron/service/ops-run.ts",
  "src/infra/database-engine/**",
  "src/infra/postgres-sync/**",
  "src/infra/sql-connection.ts",
  "src/infra/sql-query-compiler.ts",
  "src/infra/kysely-sync*.ts",
  "src/infra/sqlite-transaction.ts",
  "src/plugin-state/**",
  "src/transcripts/sqlite-schema.ts",
  "src/transcripts/store-read*.ts",
  "src/transcripts/store-sqlite-write*.ts",
  "extensions/workboard/**",
  "extensions/logbook/src/store*.ts",
  "extensions/logbook/src/postgres-store.test.ts",
  "extensions/logbook/src/logbook-postgres-schema.ts",
  "extensions/logbook/src/logbook-schema.postgres.sql",
  "extensions/team-reports/src/store*.ts",
  "extensions/team-reports/src/postgres-store.test.ts",
  "extensions/team-reports/src/team-reports-schema.postgres.sql",
  "extensions/matrix/doctor-contract-api.ts",
  "extensions/matrix/src/storage-paths.ts",
  "extensions/matrix/src/matrix/client/storage.ts",
  "extensions/matrix/src/matrix/client/storage-metadata.ts",
  "extensions/matrix/src/matrix/sqlite-state.ts",
  "extensions/matrix/src/matrix/crypto-state-store.ts",
  "extensions/matrix/src/matrix/chunked-state.ts",
  "extensions/matrix/src/matrix/sdk/idb-persistence.ts",
  "extensions/matrix/src/matrix/monitor/inbound-dedupe-migration.ts",
  "extensions/codex/doctor-contract-api.ts",
  "extensions/codex/src/migration/native-task-assignments.ts",
  "extensions/codex/src/migration/session-binding-orphans.ts",
  "extensions/memory-core/src/memory/**",
  "extensions/memory-core/src/memory-session-tombstones.ts",
  "extensions/memory-core/src/**",
  "extensions/memory-core/runtime-api.ts",
  "extensions/memory-core/cli.ts",
  "packages/memory-host-sdk/src/host/**",
  "packages/memory-host-sdk/src/engine-storage.ts",
  "packages/memory-host-sdk/src/memory-entry-origins.ts",
  "src/config/zod-schema.database.ts",
  "scripts/test-database-conformance*.mjs",
  "scripts/lib/postgres-conformance-shards.mts",
  "config/postgres-conformance-timings.json",
];
const runPostgresConformance =
  existsSync("scripts/test-database-conformance.mjs") &&
  (eventName === "schedule" ||
    (eventName === "workflow_dispatch" && !releaseGate) ||
    ((eventName === "pull_request" || releaseGate) &&
      !docsOnly &&
      (changedPaths === null ||
        changedPaths.some(
          (file) =>
            !changedNodeTestPlan.isCiDocumentationPath?.(file) &&
            (isPostgresConformanceTestTarget?.(file) ||
              postgresConformancePaths.some(
                (pattern) =>
                  matchesGlob(file, pattern) &&
                  // Older targets lack inventory ownership; retain their broad routing.
                  (!isPostgresConformanceTestTarget ||
                    !isTestFileTarget(file) ||
                    isTestFileTarget(pattern)),
              )),
        ))));
const runBuildArtifacts =
  runBuiltSourceVerifiers ||
  publishedDriverUpdate ||
  (runMacosSwift && existsSync("apps/macos/Sources/OpenClaw/NativeExecPolicyOwner.swift")) ||
  (runNodeFull &&
    (changedScopeHasBuildImpact ||
      runSqliteSessionLifecycle ||
      runBrowserNativeHost ||
      runDoctorPluginIndex ||
      runDiscordComponentProof ||
      runGatewayWatch ||
      selectedTuiPty));
// Reuse only an already-selected public build; frozen and standalone browser plans
// keep their local preparation without adding a serial build dependency.
const reuseBrowserExtensionBuild =
  runBrowserExtensionE2e && runBuildArtifacts && !frozenTarget && !compatibilityTarget;
// Keep dispatch/frozen locale jobs separate for release diagnostics and historical tooling.
const reuseControlUiI18nSetup =
  runControlUiI18n &&
  runBuildArtifacts &&
  ["pull_request", "push", "schedule"].includes(workflowEventName) &&
  !frozenTarget &&
  !compatibilityTarget;
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
const nodeWorkerE2eShards =
  runNodeFull &&
  !runtimePullRequest &&
  typeof changedNodeTestPlan.createNodeWorkerE2eTestShards === "function"
    ? changedNodeTestPlan.createNodeWorkerE2eTestShards()
    : [];
const rawNodeTestShards = runNodeFull
  ? changedNodeTestShards
    ? changedNodeTestShards
    : [...createFullNodeTestPlan(nodeWorkerE2eShards.length), ...nodeWorkerE2eShards]
