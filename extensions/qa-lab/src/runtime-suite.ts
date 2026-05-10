import type { QaRuntimeParityTier, QaSeedScenarioWithSource } from "./scenario-catalog.js";

export type QaRuntimeSuiteName = "first-hour" | "first-hour-20" | "tool-defaults" | "soak-100";

export const QA_RUNTIME_SUITE_NAMES: readonly QaRuntimeSuiteName[] = [
  "first-hour",
  "first-hour-20",
  "tool-defaults",
  "soak-100",
] as const;

export const QA_RUNTIME_FIRST_HOUR_SCENARIO_IDS = [
  "channel-chat-baseline",
  "approval-turn-tool-followthrough",
  "model-switch-tool-continuity",
  "source-docs-discovery-report",
  "memory-recall",
  "thread-memory-isolation",
  "subagent-handoff",
  "subagent-fanout-synthesis",
  "subagent-stale-child-links",
  "config-restart-capability-flip",
  "instruction-followthrough-repo-contract",
  "compaction-retry-mutating-tool",
  "auth-profile-codex-mixed-profiles",
  "auth-profile-doctor-migration-safety",
  "codex-plugin-cold-install",
  "codex-plugin-pinned-old",
  "codex-plugin-pinned-new",
] as const;

export const QA_RUNTIME_FIRST_HOUR_20_SCENARIO_IDS = [
  ...QA_RUNTIME_FIRST_HOUR_SCENARIO_IDS,
  "runtime-first-hour-20-turn",
] as const;

export const QA_RUNTIME_TOOL_DEFAULT_SCENARIO_IDS = [
  "runtime-tool-apply-patch",
  "runtime-tool-bash",
  "runtime-tool-edit",
  "runtime-tool-exec",
  "runtime-tool-fs-list",
  "runtime-tool-fs-read",
  "runtime-tool-fs-write",
  "runtime-tool-grep",
  "runtime-tool-image-generate",
  "runtime-tool-memory-add",
  "runtime-tool-memory-recall",
  "runtime-tool-message-tool",
  "runtime-tool-session-status",
  "runtime-tool-sessions-spawn",
  "runtime-tool-skill-invocation",
  "runtime-tool-tavily-extract",
  "runtime-tool-tavily-search",
  "runtime-tool-tts",
  "runtime-tool-web-fetch",
  "runtime-tool-web-search",
] as const;

export const QA_RUNTIME_SOAK_100_SCENARIO_IDS = ["runtime-soak-100-turn"] as const;

const RUNTIME_SUITE_SCENARIO_IDS: Record<QaRuntimeSuiteName, readonly string[]> = {
  "first-hour": QA_RUNTIME_FIRST_HOUR_SCENARIO_IDS,
  "first-hour-20": QA_RUNTIME_FIRST_HOUR_20_SCENARIO_IDS,
  "tool-defaults": QA_RUNTIME_TOOL_DEFAULT_SCENARIO_IDS,
  "soak-100": QA_RUNTIME_SOAK_100_SCENARIO_IDS,
};

const RUNTIME_SUITE_ALLOWED_TIERS: Record<QaRuntimeSuiteName, ReadonlySet<QaRuntimeParityTier>> = {
  "first-hour": new Set(["standard"]),
  "first-hour-20": new Set(["standard"]),
  "tool-defaults": new Set(["standard", "optional"]),
  "soak-100": new Set(["soak"]),
};

export function normalizeQaRuntimeSuiteName(input: string | undefined): QaRuntimeSuiteName | null {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (QA_RUNTIME_SUITE_NAMES.includes(normalized as QaRuntimeSuiteName)) {
    return normalized as QaRuntimeSuiteName;
  }
  throw new Error(`--runtime-suite must be one of ${QA_RUNTIME_SUITE_NAMES.join(", ")}.`);
}

export function resolveQaRuntimeSuiteScenarioIds(params: {
  runtimeSuite?: string;
  scenarioIds?: readonly string[];
}): string[] {
  const runtimeSuite = normalizeQaRuntimeSuiteName(params.runtimeSuite);
  const explicitScenarioIds = [...new Set(params.scenarioIds ?? [])];
  if (!runtimeSuite) {
    return explicitScenarioIds;
  }
  return [...new Set([...explicitScenarioIds, ...RUNTIME_SUITE_SCENARIO_IDS[runtimeSuite]])];
}

export function assertQaRuntimeSuiteScenarioMembership(params: {
  runtimeSuite?: string;
  scenarios: readonly QaSeedScenarioWithSource[];
}): void {
  const runtimeSuite = normalizeQaRuntimeSuiteName(params.runtimeSuite);
  if (!runtimeSuite) {
    return;
  }
  const byId = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
  const missing = RUNTIME_SUITE_SCENARIO_IDS[runtimeSuite].filter(
    (scenarioId) => !byId.has(scenarioId),
  );
  if (missing.length > 0) {
    throw new Error(
      `runtime suite ${runtimeSuite} references unknown scenario id(s): ${missing.join(", ")}`,
    );
  }
  const allowedTiers = RUNTIME_SUITE_ALLOWED_TIERS[runtimeSuite];
  const wrongTier = RUNTIME_SUITE_SCENARIO_IDS[runtimeSuite]
    .map((scenarioId) => byId.get(scenarioId))
    .filter((scenario): scenario is QaSeedScenarioWithSource => Boolean(scenario))
    .filter((scenario) => {
      const tier = scenario.runtimeParityTier;
      return !tier || !allowedTiers.has(tier);
    });
  if (wrongTier.length > 0) {
    throw new Error(
      `runtime suite ${runtimeSuite} has scenario(s) with missing or invalid runtimeParityTier: ${wrongTier
        .map((scenario) => `${scenario.id}=${scenario.runtimeParityTier ?? "missing"}`)
        .join(", ")}`,
    );
  }
}
