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

it("excludes a mock-pinned Matrix scenario from a live profile execution", () => {
  const scenario = readQaScenarioById("matrix-room-block-streaming");
  const selection = resolveQaRunProfileExecutionSelection({
    scenarios: [scenario],
    ...liveLane,
    channelDriver: "live",
    channel: "matrix",
    resolveModuleFlowSupport: () => true,
  });
  expect(selection).toEqual({
    selectedScenarios: [],
    excludedScenarios: [{ scenario, reasons: ["providerMode=mock-openai"] }],
  });
});

it("reports every declared mismatch in one decision", () => {
  const reasons = describeQaProviderLaneMismatches({
    ...mockLane,
    scenario: makeScenario("strict-live-lane", {
      channel: "matrix",
      flowKind: "module",
      config: {
        requiredProviderMode: "live-frontier",
        requiredChannelDriver: "live",
        requiredProvider: "claude-cli",
        requiredModel: "claude-sonnet-4-6",
        authMode: "subscription",
      },
    }),
    channelDriver: "crabline",
    channel: "telegram",
    claudeCliAuthMode: "api-key",
  });
  expect(reasons).toEqual([
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
