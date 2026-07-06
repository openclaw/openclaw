// Qa Lab tests cover bounded CI smoke shard planning.
import { describe, expect, it } from "vitest";
import { createQaSmokeCiMatrix } from "./ci-smoke-plan.js";

describe("createQaSmokeCiMatrix", () => {
  it("partitions every smoke scenario into bounded channel-compatible shards", () => {
    const first = createQaSmokeCiMatrix();
    const second = createQaSmokeCiMatrix();

    expect(second).toEqual(first);
    expect(first.include.map((shard) => shard.name)).toEqual([
      "matrix",
      "slack",
      "telegram 1/2",
      "telegram 2/2",
      "whatsapp",
    ]);
    expect(first.include).toHaveLength(5);

    const scenarioIds = first.include.flatMap((shard) => shard.scenario_ids);
    expect(scenarioIds).toHaveLength(92);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(first.include.every((shard) => shard.scenario_ids.length > 0)).toBe(true);

    const telegramShards = first.include.filter((shard) => shard.channel === "telegram");
    expect(telegramShards).toHaveLength(2);
    expect(
      Math.abs(telegramShards[0].scenario_ids.length - telegramShards[1].scenario_ids.length),
    ).toBeLessThanOrEqual(1);
  });
});
