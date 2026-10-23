import { describe, expect, it } from "vitest";
import { resolveQaRunProfileExecutionSelection } from "./profile-planning.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import {
  describeQaProviderLaneMismatches,
  scenarioMatchesQaProviderLane,
} from "./scenario-lane.js";
import { makeQaSuiteTestScenario as makeScenario } from "./suite-test-helpers.js";

const mockLane = { providerMode: "mock-openai", primaryModel: "mock-openai/gpt-5.6-luna" } as const;
const liveLane = { providerMode: "live-frontier", primaryModel: "openai/gpt-5.6-luna" } as const;
const liveConfig = { requiredProviderMode: "live-frontier" };
type Lane = Parameters<typeof describeQaProviderLaneMismatches>[0];
const mismatches = (scenario: Lane["scenario"], overrides: Partial<Lane> = {}) =>
  expect(describeQaProviderLaneMismatches({ ...mockLane, scenario, ...overrides }));

describe("QA scenario lane matching", () => {
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

  it("rejects conflicting execution and config provider pins before selecting a lane", () => {
    const scenario = requireFlowScenario(makeScenario("conflict", { config: liveConfig }));
    scenario.execution.providerMode = "mock-openai";

    expect(() => describeQaProviderLaneMismatches({ scenario, ...liveLane })).toThrow(
      "QA scenario conflict declares conflicting provider modes: execution.providerMode=mock-openai, execution.config.requiredProviderMode=live-frontier",
    );
  });

  it("reports every declared mismatch in one decision", () => {
    const scenario = makeScenario("strict-live-lane", {
      channel: "matrix",
      runtimePairLane: "core",
      config: {
        ...liveConfig,
        requiredChannelDriver: "live",
        requiredProvider: "claude-cli",
        requiredModel: "claude-sonnet-4-6",
        authMode: "subscription",
      },
    });

    mismatches(scenario, {
      channelDriver: "crabline",
      channel: "telegram",
      claudeCliAuthMode: "api-key",
    }).toEqual([
      "providerMode=live-frontier",
      "channelDriver=live",
      "channel=matrix",
      "provider=claude-cli",
      "model=claude-sonnet-4-6",
      "authMode=subscription",
    ]);
  });

  it("keeps module-flow support independent from driver and channel constraints", () => {
    const scenario = makeScenario("matrix-module", {
      channel: "matrix",
      flowKind: "module",
      config: { requiredChannelDriver: "live" },
    });

    mismatches(scenario, { channelDriver: "crabline", channel: "telegram" }).toEqual([
      "channelDriver=live",
      "channel=matrix",
      "module flow unsupported by implementation=crabline:telegram",
    ]);
    mismatches(scenario, {
      channelDriver: "live",
      channel: "matrix",
      supportsModuleFlows: true,
    }).toEqual([]);
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
});
