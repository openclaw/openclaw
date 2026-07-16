// Qa Lab tests cover canonical scenario lane matching behavior.
import { describe, expect, it } from "vitest";
import {
  describeQaProviderLaneMismatches,
  scenarioMatchesQaProviderLane,
} from "./scenario-lane.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("QA scenario lane matching", () => {
  it("reports every declared mismatch in one decision", () => {
    const scenario = makeQaSuiteTestScenario("strict-live-lane", {
      channel: "matrix",
      driver: "live",
      runtimeParityTier: "live-only",
      config: {
        requiredProviderMode: "live-frontier",
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
      "live provider mode",
      "providerMode=live-frontier",
      "channelDriver=live",
      "channel=matrix",
      "provider=claude-cli",
      "model=claude-sonnet-4-6",
      "authMode=subscription",
    ]);
  });

  it("accepts a mock lane only when its selected provider and model satisfy the contract", () => {
    const scenario = makeQaSuiteTestScenario("mock-anthropic", {
      config: {
        requiredProvider: "anthropic",
        requiredModel: "claude-opus-4-8",
      },
    });

    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "anthropic/claude-opus-4-8",
      }),
    ).toBe(true);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toBe(false);
  });
});
