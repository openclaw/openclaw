import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";
import catalog from "./upgrade-survivor-scenarios.json" with { type: "json" };

const UPGRADE_SURVIVOR_SCENARIOS = Object.freeze(catalog.scenarios);
// Frozen Codex allowlist recipes retain their assertion-only scenario.
export const UPGRADE_SURVIVOR_ASSERTION_SCENARIOS = Object.freeze([
  ...UPGRADE_SURVIVOR_SCENARIOS,
  ...catalog.assertionOnlyScenarios,
]);

// Oldest release line supported by the operator-state upgrade regression gate.
export const OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE = "2026.6.34";
export const MINIMUM_UPGRADE_SURVIVOR_BASELINE = "2026.6.1";
export const CUSTOM_PLUGIN_SIBLINGS_BASELINE = "openclaw@2026.9.4";

const scenarioMinimumBaselines = new Map([
  ["custom-plugin-siblings", CUSTOM_PLUGIN_SIBLINGS_BASELINE],
  ["legacy-operator-state", `openclaw@${OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE}`],
  ["mobile-pairing-reconnect", "openclaw@2026.7.1"],
  ["watchos-direct-node", "openclaw@2026.8.1"],
]);

// These black-box scenarios are implemented entirely by the current trusted
// release harness and treat the selected tree only as the package under test.
const TRUSTED_HARNESS_OWNED_SCENARIOS = new Set([
  "mobile-pairing-reconnect",
  "abandoned-update",
  "projects-doctor",
  "channel-owner-policy",
  "projects-startup-migration",
  "workshop-doctor-recovery",
  "update-report-recovery",
  "dreaming-cron-doctor",
]);

export function isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario) {
  return TRUSTED_HARNESS_OWNED_SCENARIOS.has(scenario);
}

// Registry proof needs its artifact contract; versioned auth fixtures exercise
// legacy import rather than native state from every baseline in a broad sweep.
// Platform pairing probes run only through explicit or dedicated scheduled
// qualification until their runtime cost justifies aggregate release coverage.
const aggregateScenarios = UPGRADE_SURVIVOR_SCENARIOS.filter(
  (scenario) =>
    scenario !== "abandoned-update" &&
    scenario !== "missing-configured-plugin-migration" &&
    scenario !== "missing-load-path" &&
    scenario !== "projects-doctor" &&
    scenario !== "channel-owner-policy" &&
    scenario !== "projects-startup-migration" &&
    scenario !== "workshop-doctor-recovery" &&
    scenario !== "update-report-recovery" &&
    scenario !== "dreaming-cron-doctor" &&
    scenario !== "mobile-pairing-reconnect" &&
    scenario !== "watchos-direct-node" &&
    scenario !== "prerelease-plugin-registry" &&
    scenario !== "auth-profile-v2026-7-2-beta-5" &&
    scenario !== "recovery-cleanup",
);
const scenarioAliases = new Map([
  ["reported-issues", aggregateScenarios.filter((scenario) => scenario !== "sqlite-volume")],
  ["far-reaching", aggregateScenarios],
]);

export function normalizeUpgradeSurvivorBaselineSpec(raw) {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  const spec = value.startsWith("openclaw@") ? value : `openclaw@${value}`;
  if (
    !/^openclaw@(?:alpha|beta|latest|[0-9]{4}\.[0-9]+\.[0-9]+(?:-(?:[0-9]+|alpha\.[0-9]+|beta\.[0-9]+))?)$/u.test(
      spec,
    )
  ) {
    throw new Error(
      `invalid published upgrade survivor baseline: ${JSON.stringify(
        value,
      )}. Expected openclaw@latest, openclaw@beta, openclaw@alpha, or openclaw@YYYY.M.PATCH.`,
    );
  }
  return spec;
}

export function parseUpgradeSurvivorBaselineSpecs(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,\s]+/u)
        .map(normalizeUpgradeSurvivorBaselineSpec)
        .filter((spec) => spec !== undefined),
    ),
  ];
}

// Historical receipts retain syntax-only parsing; active harnesses enforce the floor.
export function assertSupportedUpgradeSurvivorBaselineSpec(spec) {
  if (!spec || /^openclaw@(alpha|beta|latest)$/u.test(spec)) {
    return;
  }
  const version = parseReleaseVersion(spec.replace(/^openclaw@/u, ""));
  if (!version) {
    throw new Error(`invalid published upgrade survivor baseline: ${spec}`);
  }
  if (compareReleaseVersions(version.baseVersion, MINIMUM_UPGRADE_SURVIVOR_BASELINE) === -1) {
    throw new Error(
      `Published upgrade survivor baselines must be ${MINIMUM_UPGRADE_SURVIVOR_BASELINE} or newer; got ${spec}. Upgrade pre-June installs through OpenClaw 2026.9.5 and run Doctor first.`,
    );
  }
}

function normalizeUpgradeSurvivorScenario(raw) {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  if (!UPGRADE_SURVIVOR_SCENARIOS.includes(value)) {
    throw new Error(
      `invalid published upgrade survivor scenario: ${JSON.stringify(
        value,
      )}. Expected one of: ${UPGRADE_SURVIVOR_SCENARIOS.join(", ")}, reported-issues, or far-reaching.`,
    );
  }
  return value;
}

export function parseUpgradeSurvivorScenarios(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .flatMap((token) => scenarioAliases.get(token) ?? [token])
        .map(normalizeUpgradeSurvivorScenario)
        .filter((scenario) => scenario !== undefined),
    ),
  ];
}

function parsePublishedReleaseVersion(spec) {
  const match = /^openclaw@([0-9]{4})\.([0-9]+)\.([0-9]+)/u.exec(spec ?? "");
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    patch: Number(match[3]),
  };
}

function comparePublishedReleaseVersion(a, b) {
  return a.year - b.year || a.month - b.month || a.patch - b.patch;
}

export function supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec) {
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (scenario === "dreaming-cron-doctor") {
    return baselineSpec === "openclaw@2026.9.6";
  }
  if (
    scenario === "projects-doctor" ||
    scenario === "channel-owner-policy" ||
    scenario === "projects-startup-migration"
  ) {
    return baselineSpec === "openclaw@2026.9.4";
  }
  if (scenario === "abandoned-update") {
    return baselineSpec === "openclaw@2026.9.4" || baselineSpec === "openclaw@2026.9.3";
  }
  if (scenario === "missing-configured-plugin-migration") {
    return baselineSpec === "openclaw@2026.9.2";
  }
  if (scenario === "workshop-doctor-recovery") {
    return baselineSpec === "openclaw@2026.9.4";
  }
  if (scenario === "update-report-recovery") {
    return baselineSpec === "openclaw@2026.9.6";
  }
  const minimumBaseline = scenarioMinimumBaselines.get(scenario);
  return (
    !minimumBaseline ||
    !version ||
    comparePublishedReleaseVersion(version, parsePublishedReleaseVersion(minimumBaseline)) >= 0
  );
}
