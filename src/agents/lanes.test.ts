// Documents nested-agent command lane resolution and session scoping.
import { describe, expect, it } from "vitest";
import {
  isNestedAgentLane,
  resolveCronAgentLane,
  resolveNestedAgentLaneForSession,
} from "./lanes.js";

const AGENT_LANE_CRON_NESTED = "cron-nested";
const AGENT_LANE_NESTED = "nested";

describe("resolveCronAgentLane", () => {
  it("moves cron lane callers onto the cron-nested lane", () => {
    expect(resolveCronAgentLane("cron")).toBe(AGENT_LANE_CRON_NESTED);
    expect(resolveCronAgentLane("  cron  ")).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("preserves non-cron lanes", () => {
    expect(resolveCronAgentLane("subagent")).toBe("subagent");
    expect(resolveCronAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});

describe("resolveNestedAgentLaneForSession (#67502)", () => {
  it("falls back to the unscoped nested lane when no session key is provided", () => {
    expect(resolveNestedAgentLaneForSession(undefined)).toBe(AGENT_LANE_NESTED);
    expect(resolveNestedAgentLaneForSession("")).toBe(AGENT_LANE_NESTED);
    expect(resolveNestedAgentLaneForSession("   ")).toBe(AGENT_LANE_NESTED);
  });

  it("produces distinct lanes for distinct target sessions", () => {
    const laneA = resolveNestedAgentLaneForSession("agent:ebao-next:discord:channel:1");
    const laneB = resolveNestedAgentLaneForSession("agent:ebao-vue:discord:channel:2");
    expect(laneA).not.toBe(laneB);
  });
});

describe("isNestedAgentLane", () => {
  it("returns true for per-session nested lanes", () => {
    expect(isNestedAgentLane(resolveNestedAgentLaneForSession("agent:a:main"))).toBe(true);
    expect(isNestedAgentLane(`${AGENT_LANE_NESTED}:agent:a:main`)).toBe(true);
  });

  it("returns false for empty or missing lane names", () => {
    expect(isNestedAgentLane(undefined)).toBe(false);
    expect(isNestedAgentLane("")).toBe(false);
  });
});
