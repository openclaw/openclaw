import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { DISCORD_QA_ALL_SCENARIO_IDS } from "./profiles.js";
import * as scenarioRuntime from "./scenario-runtime.js";

describe("legacy Discord scenario migration", () => {
  it("keeps every retired runner id as a Discord module scenario", () => {
    expect(DISCORD_QA_ALL_SCENARIO_IDS).toHaveLength(6);
    for (const scenarioId of DISCORD_QA_ALL_SCENARIO_IDS) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.execution).toMatchObject({ kind: "flow", channel: "discord" });
      expect(JSON.stringify(scenario.execution.flow)).toContain(
        "./live-transports/discord/scenario-runtime.js",
      );
      const flowText = JSON.stringify(scenario.execution.flow);
      const callName = flowText.match(/scenarioModule\.([A-Za-z0-9]+)/u)?.[1];
      expect(typeof scenarioRuntime[callName as keyof typeof scenarioRuntime], scenarioId).toBe(
        "function",
      );
    }
  });
});
