import { expect, it } from "vitest";
import { resolveLiveTransportQaScenarioIds as transportScenarios } from "./live-transports/shared/scenario-selection.js";
import {
  resolveQaProfileScenarios,
  resolveQaRunProfileExecutionSelection as executionSelection,
} from "./profile-planning.js";
import { readQaScenarioById, readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

function readProfile(id = "smoke-ci") {
  const catalog = readQaScenarioPack().scenarios;
  const report = readQaScorecardTaxonomyReport(catalog);
  const profile = report.profiles.find((candidate) => candidate.id === id);
  expect(profile).toBeDefined();
  return { catalog, report, profile };
}

it("resolves smoke membership from every primary coverage owner", () => {
  const { catalog, profile } = readProfile();
  const coverageIds = new Set(profile?.coverageIds ?? []);
  const scenarioRefs = new Set(profile?.scenarioRefs ?? []);
  const owners = catalog.filter(({ coverage }) =>
    coverage?.primary.some((id) => coverageIds.has(id)),
  );
  expect(scenarioRefs.size).toBeGreaterThan(0);
  expect(new Set(owners.map(({ sourcePath }) => sourcePath))).toEqual(scenarioRefs);
  for (const id of coverageIds) {
    expect(owners.some(({ coverage }) => coverage?.primary.includes(id))).toBe(true);
  }
});

it("does not pull unrelated scenarios from a selected coverage category", () => {
  const { report, profile } = readProfile();
  const scenarioRefs = new Set(profile?.scenarioRefs ?? []);
  const unrelatedRefs = report.categories
    .filter(({ profiles }) => profiles.includes("smoke-ci"))
    .flatMap((category) => category.scenarioRefs)
    .filter((ref) => !scenarioRefs.has(ref));
  expect(unrelatedRefs.length).toBeGreaterThan(0);
  expect(
    resolveQaProfileScenarios({ profile: "smoke-ci", providerMode: "mock-openai" }).scenarios,
  ).not.toContainEqual(expect.objectContaining({ sourcePath: unrelatedRefs[0] }));
});

it("selects the packaged first-run journey for release container setup", () => {
  const { catalog, report, profile } = readProfile("release");
  const onboarding = catalog.find(({ id }) => id === "docker-npm-onboard-channel-agent");
  const systemAgent = catalog.find(({ id }) => id === "docker-system-agent-first-run");
  const ref = "containers.first-run-onboarding";
  expect(onboarding?.coverage?.primary).toContain(ref);
  expect(systemAgent?.coverage?.primary).not.toContain(ref);
  expect(systemAgent?.coverage?.secondary).toContain(ref);
  expect(report.validationIssues).not.toContainEqual(
    expect.objectContaining({ code: "coverage-id-missing-primary-inventory", ref }),
  );
  expect(profile?.scenarioRefs).toContain(onboarding?.sourcePath);
});

it("derives channel defaults from catalog metadata and lane constraints", () => {
  const live = transportScenarios({ channelId: "telegram", providerMode: "live-frontier" });
  const mock = transportScenarios({ channelId: "telegram", providerMode: "mock-openai" });
  expect(live).toContain("telegram-help-command");
  expect(live).not.toContain("telegram-assistant-transcript-role-boundary");
  expect(mock).not.toContain("telegram-assistant-transcript-role-boundary");
  expect(mock).not.toContain("discord-canary");
});

it("lets flow-only consumers exclude a channel-declared script without changing membership", () => {
  const scenario = readQaScenarioById("telegram-startup-getme-live");
  const lane = {
    scenarios: [scenario],
    providerMode: "mock-openai" as const,
    primaryModel: "mock-openai/gpt-5.6-luna",
    channelDriver: "live" as const,
    channel: "telegram",
  };
  expect(executionSelection(lane).selectedScenarios).toEqual([scenario]);
  expect(executionSelection({ ...lane, executionKind: "flow" }).excludedScenarios).toEqual([
    { scenario, reasons: ["execution.kind=flow"] },
  ]);
});
