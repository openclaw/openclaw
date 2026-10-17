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

const scenarios = [
  ...(
    [
      ["dm-chat-baseline", "DM baseline", "dm", "test DM", "reply"],
      ["thread-lifecycle", "Thread lifecycle", "thread", "test thread", "thread reply"],
    ] as const
  ).map(([id, title, surface, objective, criterion]) => ({
    id,
    title,
    surface,
    objective,
    successCriteria: [criterion],
    execution: { kind: "flow" as const },
  })),
  {
    id: "control-ui-chat-flow-playwright",
    title: "Control UI Playwright",
    surface: "control-ui",
    objective: "test Control UI",
    successCriteria: ["playwright pass"],
    execution: { kind: "playwright" as const, path: "ui/src/e2e/chat-flow.e2e.test.ts" },
  },
];

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
    selection: ReturnType<typeof normalizeQaRunSelection>,
    options: Omit<
      Parameters<typeof resolveQaLabRunPlan>[0],
      "selection" | "scenarios" | "scorecardReport"
    > = {},
  ) =>
    resolveQaLabRunPlan({ selection, scenarios: catalog.scenarios, scorecardReport, ...options });

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

  it("rejects removed provider compatibility names", () => {
    expect(() => select({ providerMode: "live-openai" })).toThrow(
      "unknown QA provider mode: live-openai",
    );
  });

  it("keeps implicit profile membership server-owned and rejects an explicit empty selection", () => {
    const snapshot = createIdleQaRunnerSnapshot(profiles);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toBeNull();
    expect(snapshot.plan).toBeNull();
    expect(() => select({ scenarioIds: [] })).toThrow("scenarioIds must be a non-empty array");
  });

  it("fails closed on unknown explicit scenario ids", () => {
    expect(() => select({ scenarioIds: ["thread-lifecycle", "missing"] })).toThrow(
      "unknown QA scenario id(s): missing",
    );
  });

  it("fails closed on malformed explicit profiles", () => {
    for (const profile of [false, ""] as const) {
      expect(() => select({ profile, scenarioIds: ["thread-lifecycle"] })).toThrow(
        "QA runner profile must be a non-empty string",
      );
    }
  });

  it("rejects a reversed runtime pair instead of silently changing its order", () => {
    expect(() => select({ runtimePair: ["codex", "openclaw"] })).toThrow(
      'runtimePair must be ["openclaw", "codex"]',
    );
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
    const mixedSelection = selectCatalog({
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
    });
    const mixedPlan = planFor(mixedSelection);
    expect(mixedPlan.status).toBe("ready");
    expect(mixedPlan.executionKinds).toEqual(["flow", "playwright"]);

    const pairSelection = selectCatalog({
      runtimePair: ["openclaw", "codex"],
      runtimePairLane: "core",
    });
    const pairPlan = planFor(pairSelection);
    expect(pairPlan.status).toBe("ready");
    expect(pairPlan.selectedScenarios.map((scenario) => scenario.id)).toContain(
      "runtime-first-hour-20-turn",
    );
    expect(pairPlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "codex-plugin-cold-install",
          reasons: ["runtimePair requires execution.kind=flow"],
        }),
      ]),
    );
  });

  it("validates explicit runtime-pair-lane selections without expanding them", () => {
    const selectedId = "runtime-first-hour-20-turn";
    const selection = selectCatalog({
      runtimePair: ["openclaw", "codex"],
      runtimePairLane: "core",
      scenarioIds: [selectedId],
    });

    const plan = planFor(selection);

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios.map((scenario) => scenario.id)).toEqual([selectedId]);

    const outsideLaneSelection = selectCatalog({
      runtimePairLane: "core",
      scenarioIds: ["dm-chat-baseline"],
    });
    const outsideLanePlan = planFor(outsideLaneSelection);
    expect(outsideLanePlan.status).toBe("invalid");
    expect(outsideLanePlan.selectedScenarios).toEqual([]);
    expect(outsideLanePlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "dm-chat-baseline",
          reasons: ["runtimePairLane=core"],
        }),
      ]),
    );
  });

  it("preserves canonical unresolved live dispatch and rejects unsupported driver channels", () => {
    const liveSelection = selectCatalog({
      channelDriver: "live",
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline"],
    });
    const unresolvedLivePlan = planFor(liveSelection, {
      supportsChannel: () => true,
    });
    expect(unresolvedLivePlan.status).toBe("ready");
    expect(unresolvedLivePlan.selectedScenarios).toEqual([
      expect.objectContaining({ id: "dm-chat-baseline", effectiveChannel: null }),
    ]);

    const crablineSelection = selectCatalog({
      channel: "qa-channel",
      channelDriver: "crabline",
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline"],
    });
    const unsupportedCrablinePlan = planFor(crablineSelection, {
      defaultChannel: "telegram",
      supportsChannel: (channel) => channel === "telegram",
    });
    expect(unsupportedCrablinePlan.status).toBe("invalid");
    expect(unsupportedCrablinePlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "dm-chat-baseline",
          reasons: ["unsupported crabline channel=qa-channel"],
        }),
      ]),
    );
  });

  it("fails closed when an explicit scenario conflicts with execution.channel", () => {
    const scenario = catalog.scenarios.find(
      (entry) => entry.execution.channel && entry.execution.channel !== "qa-channel",
    );
    expect(scenario).toBeDefined();
    const selection = selectCatalog({ providerMode: "live-frontier", scenarioIds: [scenario!.id] });

    const plan = planFor(selection);

    expect(plan.status).toBe("invalid");
    expect(plan.exclusions).toEqual(
      expect.arrayContaining([expect.objectContaining({ scenarioId: scenario!.id })]),
    );
    expect(plan.errors.join(" ")).toContain("Explicit QA scenario selection is not runnable");
  });

  it("returns an invalid resolved plan for a qa-channel execution override", () => {
    const selection = selectCatalog({ channel: "telegram", scenarioIds: ["dm-chat-baseline"] });

    const plan = planFor(selection, { defaultChannel: "qa-channel" });

    expect(plan.status).toBe("invalid");
    expect(plan.errors).toContain(
      "An execution channel requires channelDriver=crabline or channelDriver=live.",
    );
    expect(plan.selectedScenarios).toEqual([
      expect.objectContaining({ id: "dm-chat-baseline", effectiveChannel: "qa-channel" }),
    ]);
  });

  it("distinguishes declared constraints from the suite-resolved effective channel", () => {
    const selection = selectCatalog({
      channelDriver: "crabline",
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
    });

    const plan = planFor(selection, { defaultChannel: "telegram" });

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

  it("rejects malformed requests and unknown channel drivers", () => {
    expect(() => normalizeQaRunSelection(null, scenarios, profiles)).toThrow(
      "request must be a JSON object",
    );
    expect(() => select({ channelDriver: "renamed-cli-policy" })).toThrow(
      "unknown QA channel driver: renamed-cli-policy",
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
