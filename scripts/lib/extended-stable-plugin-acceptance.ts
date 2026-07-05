import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadExtendedStablePluginSupport } from "./extended-stable-plugin-support.js";

export const EXTENDED_STABLE_ACCEPTANCE_WORKFLOW_PATH =
  ".github/workflows/extended-stable-plugin-acceptance.yml";

export const COMMON_ACCEPTANCE_SCENARIOS = [
  "install",
  "production_loader",
  "plugin_discovery",
  "doctor",
] as const;

const PROFILE_SCENARIOS = {
  "codex-provider-v1": "codex_contracts",
  "discord-channel-v1": "discord_contracts",
  "slack-channel-v1": "slack_contracts",
} as const;

export type AcceptanceScenarioStatus = "passed" | "failed" | "not_run";

export type ExtendedStablePluginAcceptanceResult = {
  schemaVersion: 1;
  inputs: {
    releaseVersion: string;
    pluginPackageName: string;
  };
  resolved: {
    coreVersion: string;
    coreIntegrity: string;
    pluginIntegrity: string;
    acceptanceProfile: keyof typeof PROFILE_SCENARIOS;
  };
  workflow: {
    repository: string;
    path: typeof EXTENDED_STABLE_ACCEPTANCE_WORKFLOW_PATH;
    ref: "refs/heads/main";
    sha: string;
    runId: number;
    runAttempt: number;
    event: "workflow_dispatch";
  };
  scenarios: Array<{
    id: string;
    status: AcceptanceScenarioStatus;
  }>;
  conclusion: "succeeded" | "failed";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty, trimmed string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

export function assertExtendedStableReleaseVersion(value: string): string {
  if (!/^\d{4}\.[1-9]\d*\.[1-9]\d*$/u.test(value)) {
    throw new Error(`releaseVersion must be an exact final YYYY.M.P version; got ${value}.`);
  }
  const patch = Number(value.split(".")[2]);
  if (patch < 33) {
    throw new Error(`extended-stable releaseVersion patch must be 33 or above; got ${value}.`);
  }
  return value;
}

export function acceptanceScenarioIds(profile: string): string[] {
  const profileScenario = PROFILE_SCENARIOS[profile as keyof typeof PROFILE_SCENARIOS];
  if (!profileScenario) {
    throw new Error(`Unsupported extended-stable acceptance profile: ${profile}.`);
  }
  return [...COMMON_ACCEPTANCE_SCENARIOS, profileScenario];
}

export function resolveCoveredPlugin(rootDir: string, packageName: string) {
  const support = loadExtendedStablePluginSupport(rootDir);
  const plugin = support.plugins.find((entry) => entry.packageName === packageName);
  if (!plugin) {
    throw new Error(`${packageName} is not covered by extended-stable plugin support.`);
  }
  return plugin;
}

export function parseExtendedStablePluginAcceptanceResult(
  value: unknown,
): ExtendedStablePluginAcceptanceResult {
  const root = requireRecord(value, "extended-stable plugin acceptance result");
  assertExactKeys(
    root,
    ["schemaVersion", "inputs", "resolved", "workflow", "scenarios", "conclusion"],
    "extended-stable plugin acceptance result",
  );
  if (root.schemaVersion !== 1) {
    throw new Error("extended-stable plugin acceptance result schemaVersion must be 1.");
  }

  const inputs = requireRecord(root.inputs, "acceptance inputs");
  assertExactKeys(inputs, ["releaseVersion", "pluginPackageName"], "acceptance inputs");
  const releaseVersion = assertExtendedStableReleaseVersion(
    requireString(inputs.releaseVersion, "acceptance inputs.releaseVersion"),
  );
  const pluginPackageName = requireString(
    inputs.pluginPackageName,
    "acceptance inputs.pluginPackageName",
  );

  const resolved = requireRecord(root.resolved, "acceptance resolved");
  assertExactKeys(
    resolved,
    ["coreVersion", "coreIntegrity", "pluginIntegrity", "acceptanceProfile"],
    "acceptance resolved",
  );
  const coreVersion = requireString(resolved.coreVersion, "acceptance resolved.coreVersion");
  if (coreVersion !== releaseVersion) {
    throw new Error("acceptance resolved.coreVersion must equal inputs.releaseVersion.");
  }
  const coreIntegrity = requireString(resolved.coreIntegrity, "acceptance resolved.coreIntegrity");
  const pluginIntegrity = requireString(
    resolved.pluginIntegrity,
    "acceptance resolved.pluginIntegrity",
  );
  for (const [label, integrity] of [
    ["coreIntegrity", coreIntegrity],
    ["pluginIntegrity", pluginIntegrity],
  ] as const) {
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
      throw new Error(`acceptance resolved.${label} must be an npm sha512 integrity.`);
    }
  }
  const acceptanceProfile = requireString(
    resolved.acceptanceProfile,
    "acceptance resolved.acceptanceProfile",
  ) as keyof typeof PROFILE_SCENARIOS;
  const expectedScenarioIds = acceptanceScenarioIds(acceptanceProfile);

  const workflow = requireRecord(root.workflow, "acceptance workflow");
  assertExactKeys(
    workflow,
    ["repository", "path", "ref", "sha", "runId", "runAttempt", "event"],
    "acceptance workflow",
  );
  const repository = requireString(workflow.repository, "acceptance workflow.repository");
  const path = requireString(workflow.path, "acceptance workflow.path");
  const ref = requireString(workflow.ref, "acceptance workflow.ref");
  const sha = requireString(workflow.sha, "acceptance workflow.sha");
  const event = requireString(workflow.event, "acceptance workflow.event");
  if (path !== EXTENDED_STABLE_ACCEPTANCE_WORKFLOW_PATH) {
    throw new Error(
      `acceptance workflow.path must be ${EXTENDED_STABLE_ACCEPTANCE_WORKFLOW_PATH}.`,
    );
  }
  if (ref !== "refs/heads/main") {
    throw new Error("acceptance workflow.ref must be refs/heads/main.");
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("acceptance workflow.sha must be a full lowercase Git SHA.");
  }
  if (event !== "workflow_dispatch") {
    throw new Error("acceptance workflow.event must be workflow_dispatch.");
  }
  const runId = requirePositiveInteger(workflow.runId, "acceptance workflow.runId");
  const runAttempt = requirePositiveInteger(workflow.runAttempt, "acceptance workflow.runAttempt");

  if (!Array.isArray(root.scenarios)) {
    throw new Error("acceptance scenarios must be an array.");
  }
  const scenarios = root.scenarios.map((entry, index) => {
    const scenario = requireRecord(entry, `acceptance scenarios[${index}]`);
    assertExactKeys(scenario, ["id", "status"], `acceptance scenarios[${index}]`);
    const id = requireString(scenario.id, `acceptance scenarios[${index}].id`);
    const status = requireString(
      scenario.status,
      `acceptance scenarios[${index}].status`,
    ) as AcceptanceScenarioStatus;
    if (!(["passed", "failed", "not_run"] as const).includes(status)) {
      throw new Error(`acceptance scenarios[${index}].status is invalid.`);
    }
    return { id, status };
  });
  if (JSON.stringify(scenarios.map((entry) => entry.id)) !== JSON.stringify(expectedScenarioIds)) {
    throw new Error("acceptance scenarios must contain the profile scenarios in canonical order.");
  }
  const conclusion = requireString(root.conclusion, "acceptance conclusion");
  if (conclusion !== "succeeded" && conclusion !== "failed") {
    throw new Error("acceptance conclusion must be succeeded or failed.");
  }
  const allPassed = scenarios.every((scenario) => scenario.status === "passed");
  if ((conclusion === "succeeded") !== allPassed) {
    throw new Error("acceptance conclusion must be succeeded exactly when all scenarios passed.");
  }

  return {
    schemaVersion: 1,
    inputs: { releaseVersion, pluginPackageName },
    resolved: {
      coreVersion,
      coreIntegrity,
      pluginIntegrity,
      acceptanceProfile,
    },
    workflow: {
      repository,
      path: EXTENDED_STABLE_ACCEPTANCE_WORKFLOW_PATH,
      ref: "refs/heads/main",
      sha,
      runId,
      runAttempt,
      event: "workflow_dispatch",
    },
    scenarios,
    conclusion,
  };
}

export function readExtendedStablePluginAcceptanceResult(
  path: string,
): ExtendedStablePluginAcceptanceResult {
  return parseExtendedStablePluginAcceptanceResult(JSON.parse(readFileSync(path, "utf8")));
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
