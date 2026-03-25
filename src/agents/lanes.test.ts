import { describe, expect, it } from "vitest";
import { CommandLane } from "../process/lanes.js";
import {
  AGENT_LANE_CRON_NESTED,
  AGENT_LANE_NESTED,
  resolveCronAgentLane,
  resolveNestedAgentLane,
} from "./lanes.js";

describe("resolveNestedAgentLane", () => {
  it("defaults to the nested lane when no lane is provided", () => {
    expect(resolveNestedAgentLane()).toBe(AGENT_LANE_NESTED);
  });

  it("preserves explicit lanes", () => {
    expect(resolveNestedAgentLane("cron")).toBe(CommandLane.Cron);
    expect(resolveNestedAgentLane("  cron  ")).toBe(CommandLane.Cron);
    expect(resolveNestedAgentLane("subagent")).toBe("subagent");
    expect(resolveNestedAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});

describe("resolveCronAgentLane", () => {
  it("defaults cron-owned runs to the cron-nested lane", () => {
    expect(resolveCronAgentLane()).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("moves cron lane callers onto the cron-nested lane", () => {
    expect(resolveCronAgentLane("cron")).toBe(AGENT_LANE_CRON_NESTED);
    expect(resolveCronAgentLane("  cron  ")).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("preserves non-cron lanes", () => {
    expect(resolveCronAgentLane("subagent")).toBe("subagent");
    expect(resolveCronAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});
