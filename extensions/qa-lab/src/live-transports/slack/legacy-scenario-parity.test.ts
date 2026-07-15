import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { SLACK_QA_ALL_SCENARIO_IDS } from "./profiles.js";
import * as scenarioRuntime from "./scenario-runtime.js";

describe("legacy Slack scenario migration", () => {
  it("keeps every retired runner id as a Slack module scenario", () => {
    expect(SLACK_QA_ALL_SCENARIO_IDS).toHaveLength(17);
    for (const scenarioId of SLACK_QA_ALL_SCENARIO_IDS) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.execution).toMatchObject({ kind: "flow", channel: "slack" });
      expect(JSON.stringify(scenario.execution.flow)).toContain(
        "./live-transports/slack/scenario-runtime.js",
      );
      const flowText = JSON.stringify(scenario.execution.flow);
      const callName = flowText.match(/scenarioModule\.([A-Za-z0-9]+)/u)?.[1];
      expect(typeof scenarioRuntime[callName as keyof typeof scenarioRuntime], scenarioId).toBe(
        "function",
      );
    }
  });
});
