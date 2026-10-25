import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
  resolveQaLabRunPlan,
} from "./run-config.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

describe("qa run config", () => {
  const catalog = readQaScenarioPack();
  const scenarios = catalog.scenarios;
  const scorecardReport = readQaScorecardTaxonomyReport(scenarios);
  const profiles = scorecardReport.profiles;
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
  const expectExcluded = (
    plan: ReturnType<typeof planFor>,
    scenarioId: string,
    reasons?: string[],
  ) =>
    expect(plan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenarioId, ...(reasons ? { reasons } : {}) }),
      ]),
    );

  it("normalizes live selections and deduplicates scenario ids", () => {
    expect(
      select({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "",
        fastMode: false,
        scenarioIds: ["thread-follow-up", "thread-follow-up"],
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
      scenarioIds: ["thread-follow-up"],
    });
  });

  it.each([
    [{ providerMode: "live-openai" }, "unknown QA provider mode: live-openai"],
    [{ scenarioIds: ["thread-follow-up", "missing"] }, "unknown QA scenario id(s): missing"],
    [
      { profile: false, scenarioIds: ["thread-follow-up"] },
      "QA runner profile must be a non-empty string",
    ],
    [
      { profile: "", scenarioIds: ["thread-follow-up"] },
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

  const excludes = (scenarioId: string, reason: string) =>
    expect.arrayContaining([expect.objectContaining({ scenarioId, reasons: [reason] })]);
  const dm = "dm-chat-baseline";
  const browser = "browser-talk-start-stop";
  const paired = "runtime-first-hour-20-turn";
  it.each<{
    name: string;
    input: Record<string, unknown>;
    options?: Parameters<typeof planFor>[1];
    expected: object;
  }>([
    {
      name: "mixed execution kinds",
      input: { providerMode: "live-frontier", scenarioIds: [dm, browser] },
      expected: { status: "ready", executionKinds: ["flow", "playwright"] },
    },
    {
      name: "implicit runtime-pair lane",
      input: { runtimePair: ["openclaw", "codex"], runtimePairLane: "core" },
      expected: {
        status: "ready",
        selectedScenarios: expect.arrayContaining([expect.objectContaining({ id: paired })]),
        exclusions: excludes(
          "codex-plugin-cold-install",
          "runtimePair requires execution.kind=flow",
        ),
      },
    },
    {
      name: "explicit runtime-pair lane without expansion",
      input: { runtimePair: ["openclaw", "codex"], runtimePairLane: "core", scenarioIds: [paired] },
      expected: { status: "ready", selectedScenarios: [expect.objectContaining({ id: paired })] },
    },
    {
      name: "explicit scenario outside the selected lane",
      input: { runtimePairLane: "core", scenarioIds: [dm] },
      expected: {
        status: "invalid",
        selectedScenarios: [],
        exclusions: excludes(dm, "runtimePairLane=core"),
      },
    },
    {
      name: "unresolved live dispatch",
      input: { channelDriver: "live", providerMode: "live-frontier", scenarioIds: [dm] },
      options: { supportsChannel: () => true },
      expected: { status: "ready", selectedScenarios: [{ id: dm, effectiveChannel: null }] },
    },
    {
      name: "unsupported driver channel",
      input: {
        channel: "qa-channel",
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: [dm],
      },
      options: { defaultChannel: "telegram", supportsChannel: (channel) => channel === "telegram" },
      expected: {
        status: "invalid",
        exclusions: excludes(dm, "unsupported crabline channel=qa-channel"),
      },
    },
    {
      name: "qa-channel execution override",
      input: { channel: "telegram", scenarioIds: [dm] },
      options: { defaultChannel: "qa-channel" },
      expected: {
        status: "invalid",
        selectedScenarios: [{ id: dm, effectiveChannel: "qa-channel" }],
        errors: expect.arrayContaining([
          "An execution channel requires channelDriver=crabline or channelDriver=live.",
        ]),
      },
    },
    {
      name: "declared constraints versus effective channels",
      input: {
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: [dm, browser],
      },
      options: { defaultChannel: "telegram" },
      expected: {
        selectedScenarios: expect.arrayContaining([
          expect.objectContaining({ id: dm, declaredChannel: null, effectiveChannel: "telegram" }),
          expect.objectContaining({ id: browser, declaredChannel: null, effectiveChannel: null }),
        ]),
      },
    },
  ])("resolves $name", ({ input, options, expected }) => {
    expect(planFor(input, options)).toMatchObject(expected);
  });

  it("fails closed when an explicit scenario conflicts with execution.channel", () => {
    const scenario = catalog.scenarios.find(
      (entry) => entry.execution.channel && entry.execution.channel !== "qa-channel",
    );
    expect(scenario).toBeDefined();
    const plan = planFor({ providerMode: "live-frontier", scenarioIds: [scenario!.id] });
    expect(plan.status).toBe("invalid");
    expectExcluded(plan, scenario!.id);
    expect(plan.errors.join(" ")).toContain("Explicit QA scenario selection is not runnable");
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
