// Qa Lab tests cover bounded CI smoke lane planning.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { describe, expect, it } from "vitest";
import { createQaSmokeCiShard } from "./ci-smoke-plan.js";
import { readQaScenarioPack } from "./scenario-catalog.js";

describe("createQaSmokeCiShard", () => {
  it("partitions every smoke scenario into two channel-compatible lanes", () => {
    const matrix = createQaSmokeCiShard("matrix");
    const crabline = createQaSmokeCiShard("crabline");
    const repeatedCrabline = createQaSmokeCiShard("crabline");

    expect(repeatedCrabline).toEqual(crabline);
    expect(matrix.channel).toBe("matrix");
    expect(crabline.channel).toBe(OPENCLAW_CRABLINE_DEFAULT_CHANNEL);

    const scenarioIds = [...matrix.scenario_ids, ...crabline.scenario_ids];
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));
    expect(scenarioIds).not.toContain("slack-restart-resume");
    expect(scenarioIds).not.toContain("whatsapp-restart-resume");
    expect(crabline.scenario_ids).toContain("subagent-fanout-synthesis");
    expect(matrix.scenario_ids.length).toBeGreaterThan(0);
    expect(crabline.scenario_ids.length).toBeGreaterThan(0);
  });

  it("rejects undeclared CI lanes", () => {
    expect(() => createQaSmokeCiShard("slack")).toThrow("unknown QA smoke CI lane: slack");
  });
});
