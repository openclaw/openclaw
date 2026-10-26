import { expect, it } from "vitest";
import { resolveQaRunProfileExecutionSelection } from "./profile-planning.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import {
  describeQaProviderLaneMismatches,
  scenarioMatchesQaProviderLane,
} from "./scenario-lane.js";
import { makeQaSuiteTestScenario as makeScenario } from "./suite-test-helpers.js";

const mockLane = { providerMode: "mock-openai", primaryModel: "mock-openai/gpt-5.6-luna" } as const;
const liveLane = { providerMode: "live-frontier", primaryModel: "openai/gpt-5.6-luna" } as const;
type Lane = Parameters<typeof describeQaProviderLaneMismatches>[0];
const mismatches = (scenario: Lane["scenario"], overrides: Partial<Lane> = {}) =>
  expect(describeQaProviderLaneMismatches({ ...mockLane, scenario, ...overrides }));

it("excludes a mock-pinned Matrix scenario from a live profile execution", () => {
  const scenario = readQaScenarioById("matrix-room-block-streaming");
  expect(
    resolveQaRunProfileExecutionSelection({
      scenarios: [scenario],
      ...liveLane,
      channelDriver: "live",
      channel: "matrix",
      resolveModuleFlowSupport: () => true,
    }),
  ).toEqual({
    selectedScenarios: [],
    excludedScenarios: [{ scenario, reasons: ["providerMode=mock-openai"] }],
  });
});

it("reports every declared mismatch in one decision", () => {
  mismatches(
    makeScenario("strict-live-lane", {
      channel: "matrix",
      flowKind: "module",
      runtimePairLane: "core",
      config: {
        requiredProviderMode: "live-frontier",
        requiredChannelDriver: "live",
        requiredProvider: "claude-cli",
        requiredModel: "claude-sonnet-4-6",
        authMode: "subscription",
      },
    }),
    { channelDriver: "crabline", channel: "telegram", claudeCliAuthMode: "api-key" },
  ).toEqual([
    "providerMode=live-frontier",
    "channelDriver=live",
    "channel=matrix",
    "module flow unsupported by implementation=crabline:telegram",
    "provider=claude-cli",
    "model=claude-sonnet-4-6",
    "authMode=subscription",
  ]);
});

it("keeps the built-in driver bound to the qa-channel channel", () => {
  expect(
    scenarioMatchesQaProviderLane({
      scenario: makeScenario("telegram-only", { channel: "telegram" }),
      ...mockLane,
      channelDriver: "qa-channel",
      channel: "telegram",
    }),
  ).toBe(false);
});
