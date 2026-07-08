// Qa Lab tests cover bounded CI smoke lane planning.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { describe, expect, it } from "vitest";
import { createQaSmokeCiShard } from "./ci-smoke-plan.js";
import { readQaScenarioPack } from "./scenario-catalog.js";

describe("createQaSmokeCiShard", () => {
  it("partitions every smoke scenario into bounded channel-compatible lanes", () => {
    const matrix = createQaSmokeCiShard("matrix");
    const crablineShards = [
      createQaSmokeCiShard("crabline-1"),
      createQaSmokeCiShard("crabline-2"),
      createQaSmokeCiShard("crabline-3"),
    ];
    const repeatedCrabline = createQaSmokeCiShard("crabline-1");

    expect(repeatedCrabline).toEqual(crablineShards[0]);
    expect(matrix.channel).toBe("matrix");
    expect(
      crablineShards.every((shard) => shard.channel === OPENCLAW_CRABLINE_DEFAULT_CHANNEL),
    ).toBe(true);

    const crablineScenarioIds = crablineShards.flatMap((shard) => shard.scenario_ids);
    const scenarioIds = [...matrix.scenario_ids, ...crablineScenarioIds];
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));
    expect(scenarioIds).not.toContain("slack-restart-resume");
    expect(scenarioIds).not.toContain("whatsapp-restart-resume");
    expect(crablineScenarioIds).toContain("subagent-fanout-synthesis");
    expect(matrix.scenario_ids.length).toBeGreaterThan(0);
    const crablineShardSizes = crablineShards.map((shard) => shard.scenario_ids.length);
    expect(Math.max(...crablineShardSizes) - Math.min(...crablineShardSizes)).toBeLessThanOrEqual(
      1,
    );
  });

  it("rejects undeclared CI lanes", () => {
    expect(() => createQaSmokeCiShard("slack")).toThrow("unknown QA smoke CI lane: slack");
  });
});
