import { describe, expect, it } from "vitest";
import {
  classifyAgentLifecycleParentState,
  isAgentLifecycleYieldedWaiting,
} from "./agent-lifecycle-parent-state.js";

describe("agent lifecycle parent state", () => {
  it("treats yielded paused lifecycle terminals as waiting parent state", () => {
    const event = {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    };

    expect(classifyAgentLifecycleParentState(event)).toEqual({ kind: "yielded_waiting" });
    expect(isAgentLifecycleYieldedWaiting(event)).toBe(true);
  });

  it("treats yielded terminals without liveness detail as waiting parent state", () => {
    expect(classifyAgentLifecycleParentState({ phase: "end", yielded: true })).toEqual({
      kind: "yielded_waiting",
    });
  });

  it("keeps yielded lifecycle errors terminal", () => {
    const event = { phase: "error", yielded: true, livenessState: "paused" };

    expect(classifyAgentLifecycleParentState(event)).toEqual({ kind: "terminal" });
    expect(isAgentLifecycleYieldedWaiting(event)).toBe(false);
  });

  it("keeps non-yielded lifecycle end terminal", () => {
    expect(classifyAgentLifecycleParentState({ phase: "end", livenessState: "paused" })).toEqual({
      kind: "terminal",
    });
    expect(isAgentLifecycleYieldedWaiting({ phase: "end", livenessState: "paused" })).toBe(false);
  });
});
