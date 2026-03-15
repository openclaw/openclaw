import { describe, expect, it } from "vitest";
import {
  AGENT_LANE_CRON_NESTED,
  AGENT_LANE_NESTED,
  resolveCronEmbeddedAgentLane,
  resolveNestedAgentLane,
} from "./lanes.js";

describe("resolveCronEmbeddedAgentLane", () => {
  it("defaults to the dedicated cron nested lane when no lane is provided", () => {
    expect(resolveCronEmbeddedAgentLane()).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("moves cron lane callers onto the dedicated cron nested lane", () => {
    expect(resolveCronEmbeddedAgentLane("cron")).toBe(AGENT_LANE_CRON_NESTED);
    expect(resolveCronEmbeddedAgentLane("  cron  ")).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("preserves non-cron lanes", () => {
    expect(resolveCronEmbeddedAgentLane("subagent")).toBe("subagent");
    expect(resolveCronEmbeddedAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});

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
