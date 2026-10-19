// QA Lab tests cover canonical scenario lane matching behavior.
import { describe, expect, it } from "vitest";
import { resolveQaRunProfileExecutionSelection } from "./profile-planning.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import {
  describeQaProviderLaneMismatches,
  scenarioMatchesQaProviderLane,
} from "./scenario-lane.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("QA scenario lane matching", () => {
  it("excludes a mock-pinned Matrix scenario from a live profile execution", () => {
    const scenario = readQaScenarioById("matrix-room-block-streaming");

    expect(
      resolveQaRunProfileExecutionSelection({
        scenarios: [scenario],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
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
    const scenario = requireFlowScenario(
      makeQaSuiteTestScenario("conflicting-provider-modes", {
        config: { requiredProviderMode: "live-frontier" },
      }),
    );
    scenario.execution.providerMode = "mock-openai";

    expect(() =>
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "QA scenario conflicting-provider-modes declares conflicting provider modes: execution.providerMode=mock-openai, execution.config.requiredProviderMode=live-frontier",
    );
  });

  it("reports every declared mismatch in one decision", () => {
    const scenario = makeQaSuiteTestScenario("strict-live-lane", {
      channel: "matrix",
      runtimePairLane: "core",
      config: {
        requiredProviderMode: "live-frontier",
        requiredChannelDriver: "live",
        requiredProvider: "claude-cli",
        requiredModel: "claude-sonnet-4-6",
        authMode: "subscription",
      },
    });

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
        claudeCliAuthMode: "api-key",
      }),
    ).toEqual([
      "providerMode=live-frontier",
      "channelDriver=live",
      "channel=matrix",
      "provider=claude-cli",
      "model=claude-sonnet-4-6",
      "authMode=subscription",
    ]);
  });

  it("keeps module-flow support independent from driver and channel constraints", () => {
    const scenario = makeQaSuiteTestScenario("matrix-module", {
      channel: "matrix",
      flowKind: "module",
      config: { requiredChannelDriver: "live" },
    });

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
      }),
    ).toEqual([
      "channelDriver=live",
      "channel=matrix",
      "module flow unsupported by implementation=crabline:telegram",
    ]);
    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "matrix",
        supportsModuleFlows: true,
      }),
    ).toEqual([]);
  });

  it("keeps the built-in driver bound to the qa-channel channel", () => {
    const scenario = makeQaSuiteTestScenario("telegram-only", {
      channel: "telegram",
    });

    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "qa-channel",
        channel: "telegram",
      }),
    ).toBe(false);
  });
});
