import { describe, expect, it } from "vitest";
import { AGENT_LANE_NESTED, resolveNestedAgentLane } from "./lanes.js";

describe("resolveNestedAgentLane", () => {
  it("defaults to the nested lane when no lane is provided", () => {
    expect(resolveNestedAgentLane()).toBe(AGENT_LANE_NESTED);
  });

  it("moves cron lane callers onto the nested lane", () => {
    expect(resolveNestedAgentLane("cron")).toBe(AGENT_LANE_NESTED);
    expect(resolveNestedAgentLane("  cron  ")).toBe(AGENT_LANE_NESTED);
  });

  it("preserves non-cron lanes", () => {
    expect(resolveNestedAgentLane("subagent")).toBe("subagent");
    expect(resolveNestedAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});
