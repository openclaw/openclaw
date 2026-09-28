import {
  getChangedPathFacts,
  isTestFileTarget,
  isTestSupportFileTarget,
  normalizeChangedPath,
} from "./changed-path-facts.mjs";

const CHECK_TASKS = ["guards", "npm-lock", "bundled-channel-config-metadata", "dependencies"];
const FAST_TASKS = ["startup-corpus", "coercion-helpers", "bundled-protocol", "bun-launcher"];
const ADDITIONAL_GROUPS = [
  "boundaries",
  "source-contracts",
  "extension-package-boundary",
  "runtime-topology-architecture",
];
const CODE_PATH_RE = /\.[cm]?[jt]sx?$/u;
const SOURCE_PATH_RE = /^(?:src|extensions|packages)\//u;
const PROTOCOL_OUTPUT_PATH_RE =
  /^(?:apps\/shared\/OpenClawKit\/Sources\/OpenClawProtocol\/GatewayModels\.swift|apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/(?:gateway\/GatewayProtocol|protocol\/OpenClawProtocolConstants)\.kt)$/u;

type CiCheckFamilyScope = {
  checkTasks: string[];
  fastTasks: string[];
  additionalGroups: string[];
  baselineRatchets: boolean;
  pluginContracts: boolean;
  channelContracts: boolean;
  lint: boolean;
  types: boolean;
};

/** Selects check families after the caller admits a complete, narrow PR diff. */
export function resolveCiCheckFamilyScope(changedPaths: readonly string[]): CiCheckFamilyScope {
  const facts = changedPaths.map((path) => getChangedPathFacts(normalizeChangedPath(path)));
  // Configuration and shared fixtures can change scanner inputs or arbitrary
  // consumers; path ownership alone cannot establish their import closure.
  const full =
    facts.length === 0 ||
    changedPaths.some((path) => path !== path.trim() || path.startsWith("/")) ||
    facts.some(
      ({ path, surface, isTestOnly }) =>
        !path ||
        /(?:^|\/)\.\.(?:\/|$)/u.test(path) ||
        ["rootGlobal", "rootTooling", "unknown"].includes(surface) ||
        /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/u.test(path) ||
        isTestSupportFileTarget(path) ||
        (isTestOnly && !isTestFileTarget(path)) ||
        surface === "testFixture",
    );
  if (full) {
    return {
      checkTasks: [...CHECK_TASKS],
      fastTasks: [...FAST_TASKS],
      additionalGroups: [...ADDITIONAL_GROUPS],
      baselineRatchets: true,
      pluginContracts: true,
      channelContracts: true,
      lint: true,
      types: true,
    };
  }

  const paths = facts.map(({ path }) => path);
  const matches = (pattern: RegExp) => paths.some((path) => pattern.test(path));
  const code = matches(CODE_PATH_RE);
  const source = facts.some(({ path, surface }) => surface !== "docs" && SOURCE_PATH_RE.test(path));
  const runtimeSource = facts.some(
    ({ path, surface }) =>
      surface !== "docs" && SOURCE_PATH_RE.test(path) && !isTestFileTarget(path),
  );
  const nativeSchema = paths.includes(
    "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
  );
  const toolDisplaySnapshot = paths.includes(
    "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
  );
  const nativeStorage = matches(/^apps\/macos\/Sources\/OpenClaw\/.*\.swift$/u);
  const schemaBaseline = paths.includes(
    "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
  );
  const inventoryDocs = matches(/^docs\/(?:channels|providers|plugins|\.generated)\//u);
  const bundledTests = matches(
    /^src\/(?:infra|plugins|plugin-sdk)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  );
  // Tests can be imported by contract suites. Keep these consumers even when
  // the changed file itself is outside the dedicated contract directories.
  const contracts = source || facts.some(({ surface }) => surface === "rootTest");
  // Plugin contract scanners also read SDK guides and manifest-declared skill assets.
  const pluginContractDocs = matches(/^docs\/plugins\/|^extensions\/.+\.md$/u);
  const types =
    code || (matches(/\.json$/u) && (source || facts.some(({ surface }) => surface === "ui")));

  return {
    // The required planner owns conflict markers and wall-clock deprecation checks on
    // narrow PRs; the remaining guard row follows its scanned source inputs.
    checkTasks: CHECK_TASKS.filter(
      (task) =>
        (task === "guards" &&
          (code || runtimeSource || matches(/\.swift$/u) || toolDisplaySnapshot)) ||
        (task === "npm-lock" && matches(/^packages\/normalization-core\//u)) ||
        (task === "bundled-channel-config-metadata" && runtimeSource) ||
        (task === "dependencies" && code),
    ),
    // The guard row already owns the same coercion scan for every narrow code diff.
    fastTasks: FAST_TASKS.filter(
      (task) =>
        (task === "startup-corpus" && (code || runtimeSource || inventoryDocs)) ||
        (task === "bundled-protocol" &&
          (runtimeSource || bundledTests || matches(PROTOCOL_OUTPUT_PATH_RE))) ||
        (task === "bun-launcher" &&
          (runtimeSource || bundledTests || paths.includes("test/openclaw-launcher.e2e.test.ts"))),
    ),
    additionalGroups: ADDITIONAL_GROUPS.filter(
      (group) =>
        (group === "boundaries" && (code || nativeSchema)) ||
        (group === "source-contracts" && (source || schemaBaseline)) ||
        (group === "extension-package-boundary" && runtimeSource) ||
        (group === "runtime-topology-architecture" && (source || code || nativeStorage)),
    ),
    baselineRatchets: code || runtimeSource || inventoryDocs,
    pluginContracts: contracts || pluginContractDocs,
    channelContracts: contracts,
    // The changed-lint row also owns formatting for YAML, JSON5, and other data.
    lint: true,
    types,
  };
}
