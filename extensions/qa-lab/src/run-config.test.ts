import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveQaRunProfileExecutionSelection } from "./profile-planning.js";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
  resolveQaLabRunPlan,
} from "./run-config.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  readQaScorecardTaxonomyReport,
  type QaScorecardTaxonomyReport,
} from "./scorecard-taxonomy.js";

const profiles: QaScorecardTaxonomyReport["profiles"] = (
  [
    { id: "smoke-ci", evidenceMode: "slim", channelDriver: "crabline" },
    { id: "release", evidenceMode: "full", channelDriver: "live" },
    { id: "all", evidenceMode: "full", channelDriver: "live" },
  ] as const
).map(({ id, evidenceMode, channelDriver }) => ({
  id,
  evidenceMode,
  channelDriver,
  categoryIds: [],
  coverageIds: [],
  scenarioRefs: [],
}));

const scenarios = ["dm-chat-baseline", "thread-lifecycle"].map((id) => ({
  id,
  title: id,
  surface: "test",
  objective: "test",
  successCriteria: ["pass"],
  execution: { kind: "flow" as const },
}));

describe("qa run config", () => {
  const catalog = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
  const select = (input: unknown) => normalizeQaRunSelection(input, scenarios, profiles);
  const selectCatalog = (input: Record<string, unknown>) =>
    normalizeQaRunSelection(
      { profile: "all", channelDriver: "qa-channel", providerMode: "mock-openai", ...input },
      catalog.scenarios,
      scorecardReport.profiles,
    );
  const planFor = (
    input: Record<string, unknown>,
    options: Omit<
      Parameters<typeof resolveQaLabRunPlan>[0],
      "selection" | "scenarios" | "scorecardReport"
    > = {},
  ) =>
    resolveQaLabRunPlan({
      selection: selectCatalog(input),
      scenarios: catalog.scenarios,
      scorecardReport,
      ...options,
    });
  const contains = (value: Record<string, unknown>) =>
    expect.arrayContaining([expect.objectContaining(value)]);

  it("normalizes live selections and deduplicates scenario ids", () => {
    expect(
      select({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "",
        fastMode: false,
        scenarioIds: ["thread-lifecycle", "thread-lifecycle"],
      }),
    ).toEqual({
      profile: "all",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
      fastMode: true,
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it.each([
    [{ providerMode: "live-openai" }, "unknown QA provider mode: live-openai"],
    [{ scenarioIds: ["thread-lifecycle", "missing"] }, "unknown QA scenario id(s): missing"],
    [
      { profile: false, scenarioIds: ["thread-lifecycle"] },
      "QA runner profile must be a non-empty string",
    ],
    [
      { profile: "", scenarioIds: ["thread-lifecycle"] },
      "QA runner profile must be a non-empty string",
    ],
    [{ runtimePair: ["codex", "openclaw"] }, 'runtimePair must be ["openclaw", "codex"]'],
    [null, "request must be a JSON object"],
    [{ channelDriver: "renamed-cli-policy" }, "unknown QA channel driver: renamed-cli-policy"],
  ] as const)("rejects invalid selection %j", (input, error) => {
    expect(() => select(input)).toThrow(error);
  });

  it("keeps implicit profile membership server-owned and rejects an explicit empty selection", () => {
    const snapshot = createIdleQaRunnerSnapshot(profiles);
    expect(snapshot).toMatchObject({
      status: "idle",
      selection: { scenarioIds: null },
      plan: null,
    });
    expect(() => select({ scenarioIds: [] })).toThrow("scenarioIds must be a non-empty array");
  });

  it("keeps portable threads but excludes module flows from Crabline plans", () => {
    const scenarioIds = new Set([
      "matrix-approval-channel-target-both",
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
      "matrix-mxid-prefixed-command-block",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
      "thread-follow-up",
      "thread-isolation",
    ]);
    const selected = catalog.scenarios.filter((scenario) => scenarioIds.has(scenario.id));

    const execution = resolveQaRunProfileExecutionSelection({
      scenarios: selected,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "crabline",
      defaultChannel: "telegram",
      supportsChannel: () => true,
    });

    expect(execution.selectedScenarios.map((scenario) => scenario.id).toSorted()).toEqual([
      "thread-follow-up",
      "thread-isolation",
    ]);
    expect(execution.excludedScenarios.map(({ scenario }) => scenario.id).toSorted()).toEqual(
      [...scenarioIds].filter((id) => !id.startsWith("thread-")).toSorted(),
    );
    for (const { scenario, reasons } of execution.excludedScenarios) {
      const channel = scenario.id.startsWith("matrix-") ? "matrix" : "slack";
      expect(reasons).toEqual([`module flow unsupported by implementation=crabline:${channel}`]);
    }
  });

  it("resolves mixed execution kinds and reports runtime-pair-lane exclusions", () => {
    const mixedPlan = planFor({
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
    });
    expect(mixedPlan).toMatchObject({ status: "ready", executionKinds: ["flow", "playwright"] });

    const pairPlan = planFor({
      runtimePair: ["openclaw", "codex"],
      runtimePairLane: "core",
    });
    expect(pairPlan.status).toBe("ready");
    expect(pairPlan.selectedScenarios.map((scenario) => scenario.id)).toContain(
      "runtime-first-hour-20-turn",
    );
    expect(pairPlan.exclusions).toEqual(
      contains({
        scenarioId: "codex-plugin-cold-install",
        reasons: ["runtimePair requires execution.kind=flow"],
      }),
    );
  });

  it("validates explicit runtime-pair-lane selections without expanding them", () => {
    const selectedId = "runtime-first-hour-20-turn";
    const plan = planFor({
      runtimePair: ["openclaw", "codex"],
      runtimePairLane: "core",
      scenarioIds: [selectedId],
    });

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios.map((scenario) => scenario.id)).toEqual([selectedId]);

    const outsideLanePlan = planFor({
      runtimePairLane: "core",
      scenarioIds: ["dm-chat-baseline"],
    });
    expect(outsideLanePlan).toMatchObject({ status: "invalid", selectedScenarios: [] });
    expect(outsideLanePlan.exclusions).toEqual(
      contains({
        scenarioId: "dm-chat-baseline",
        reasons: ["runtimePairLane=core"],
      }),
    );
  });

  it("preserves canonical unresolved live dispatch and rejects unsupported driver channels", () => {
    const unresolvedLivePlan = planFor(
      {
        channelDriver: "live",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline"],
      },
      {
        supportsChannel: () => true,
      },
    );
    expect(unresolvedLivePlan).toMatchObject({
      status: "ready",
      selectedScenarios: [{ id: "dm-chat-baseline", effectiveChannel: null }],
    });

    const unsupportedCrablinePlan = planFor(
      {
        channel: "qa-channel",
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline"],
      },
      {
        defaultChannel: "telegram",
        supportsChannel: (channel) => channel === "telegram",
      },
    );
    expect(unsupportedCrablinePlan.status).toBe("invalid");
    expect(unsupportedCrablinePlan.exclusions).toEqual(
      contains({
        scenarioId: "dm-chat-baseline",
        reasons: ["unsupported crabline channel=qa-channel"],
      }),
    );
  });

  it("fails closed when an explicit scenario conflicts with execution.channel", () => {
    const scenario = catalog.scenarios.find(
      (entry) => entry.execution.channel && entry.execution.channel !== "qa-channel",
    );
    expect(scenario).toBeDefined();
    const plan = planFor({ providerMode: "live-frontier", scenarioIds: [scenario!.id] });

    expect(plan.status).toBe("invalid");
    expect(plan.exclusions).toEqual(contains({ scenarioId: scenario!.id }));
    expect(plan.errors.join(" ")).toContain("Explicit QA scenario selection is not runnable");
  });

  it("returns an invalid resolved plan for a qa-channel execution override", () => {
    const plan = planFor(
      { channel: "telegram", scenarioIds: ["dm-chat-baseline"] },
      { defaultChannel: "qa-channel" },
    );

    expect(plan.status).toBe("invalid");
    expect(plan.errors).toContain(
      "An execution channel requires channelDriver=crabline or channelDriver=live.",
    );
    expect(plan.selectedScenarios).toEqual([
      expect.objectContaining({ id: "dm-chat-baseline", effectiveChannel: "qa-channel" }),
    ]);
  });

  it("distinguishes declared constraints from the suite-resolved effective channel", () => {
    const plan = planFor(
      {
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
      { defaultChannel: "telegram" },
    );

    expect(plan.selectedScenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dm-chat-baseline",
          declaredChannel: null,
          effectiveChannel: "telegram",
        }),
        expect.objectContaining({
          id: "browser-talk-start-stop",
          declaredChannel: null,
          effectiveChannel: null,
        }),
      ]),
    );
  });

  it("fails closed when required canonical profiles are missing", () => {
    const profilesWithoutSmoke = profiles.filter((profile) => profile.id !== "smoke-ci");
    const profilesWithoutAll = profiles.filter((profile) => profile.id !== "all");

    expect(() => createIdleQaRunnerSnapshot(profilesWithoutSmoke)).toThrow(
      "profile table does not define required profile: smoke-ci",
    );
    expect(() => normalizeQaRunSelection({}, scenarios, profilesWithoutSmoke)).toThrow(
      "profile table does not define required profile: smoke-ci",
    );
    expect(() =>
      normalizeQaRunSelection({ scenarioIds: ["dm-chat-baseline"] }, scenarios, profilesWithoutAll),
    ).toThrow("unknown QA run profile: all");
  });

  it("keeps generated run output dirs unique within the same millisecond", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-23T07:30:00.000Z"));
      const repoRoot = path.resolve("/tmp/openclaw-repo");
      const first = createQaRunOutputDir(repoRoot);
      const second = createQaRunOutputDir(repoRoot);

      expect(first).not.toBe(second);
      expect(path.basename(first)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
      expect(path.basename(second)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
    } finally {
      vi.useRealTimers();
    }
  });
});
