import catalog from "./upgrade-survivor-scenarios.json" with { type: "json" };

const UPGRADE_SURVIVOR_SCENARIOS = Object.freeze(catalog.scenarios);
// Frozen Codex allowlist recipes retain their assertion-only scenario.
export const UPGRADE_SURVIVOR_ASSERTION_SCENARIOS = Object.freeze([
  ...UPGRADE_SURVIVOR_SCENARIOS,
  ...catalog.assertionOnlyScenarios,
]);

// Oldest release line supported by the operator-state upgrade regression gate.
export const OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE = "2026.6.34";
export const CUSTOM_PLUGIN_SIBLINGS_BASELINE = "openclaw@2026.9.4";

const scenarioMinimumBaselines = new Map([
  ["custom-plugin-siblings", CUSTOM_PLUGIN_SIBLINGS_BASELINE],
  ["legacy-operator-state", `openclaw@${OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE}`],
  ["plugin-deps-cleanup", "openclaw@2026.4.23"],
  ["acpx-openclaw-tools-bridge", "openclaw@2026.4.22"],
  ["mobile-pairing-reconnect", "openclaw@2026.7.1"],
  ["watchos-direct-node", "openclaw@2026.8.1"],
]);

// These black-box scenarios are implemented entirely by the current trusted
// release harness and treat the selected tree only as the package under test.
const TRUSTED_HARNESS_OWNED_SCENARIOS = new Set([
  "mobile-pairing-reconnect",
  "abandoned-update",
  "projects-doctor",
  "projects-startup-migration",
  "taskflow-restoration",
  "workshop-doctor-recovery",
]);

export function isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario) {
  return TRUSTED_HARNESS_OWNED_SCENARIOS.has(scenario);
}

// Registry proof needs its artifact contract; versioned auth fixtures exercise
// legacy import rather than native state from every baseline in a broad sweep.
// Teams poll migration requires its own published companion install and remains opt-in.
// Platform pairing probes run only through explicit or dedicated scheduled
// qualification until their runtime cost justifies aggregate release coverage.
const aggregateScenarios = UPGRADE_SURVIVOR_SCENARIOS.filter(
  (scenario) =>
    scenario !== "msteams-polls" &&
    scenario !== "abandoned-update" &&
    scenario !== "missing-configured-plugin-migration" &&
    scenario !== "missing-load-path" &&
    scenario !== "projects-doctor" &&
    scenario !== "projects-startup-migration" &&
    scenario !== "taskflow-restoration" &&
    scenario !== "workshop-doctor-recovery" &&
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
  if (
    scenario === "projects-doctor" ||
    scenario === "projects-startup-migration" ||
    scenario === "taskflow-restoration"
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
  const minimumBaseline = scenarioMinimumBaselines.get(scenario);
  return (
    !minimumBaseline ||
    !version ||
    comparePublishedReleaseVersion(version, parsePublishedReleaseVersion(minimumBaseline)) >= 0
  );
}
