import { describe, it, expect } from "vitest";
import { assembleCacheAwareContext } from "../src/tools/cache-aware-layout.js";
import type { Observation } from "../src/tools/observation-types.js";

function makeObs(overrides: Partial<Observation> & { id: string }): Observation {
  return {
    priority: "routine",
    content: "Test observation",
    observed_at: "2026-02-27T10:00:00Z",
    tags: [],
    created_at: "2026-02-27T10:00:00Z",
    ...overrides,
  };
}

describe("assembleCacheAwareContext", () => {
  it("places persona in stable block", () => {
    const { stableBlock, dynamicBlock } = assembleCacheAwareContext({
      persona: "I am a business analyst",
      observations: [],
    });
    expect(stableBlock).toContain("Agent Persona");
    expect(stableBlock).toContain("business analyst");
    expect(dynamicBlock).toBe("");
  });

  it("places observations in stable block", () => {
    const obs = [makeObs({ id: "1", content: "Found error in auth module" })];
    const { stableBlock } = assembleCacheAwareContext({
      observations: obs,
    });
    expect(stableBlock).toContain("Observation Log");
    expect(stableBlock).toContain("Found error");
  });

  it("places active goals in dynamic block", () => {
    const { stableBlock, dynamicBlock } = assembleCacheAwareContext({
      observations: [],
      activeGoals: "Complete quarterly report",
    });
    expect(dynamicBlock).toContain("Active Goals");
    expect(dynamicBlock).toContain("quarterly report");
    expect(stableBlock).toBe("");
  });

  it("places commitments in dynamic block", () => {
    const { dynamicBlock } = assembleCacheAwareContext({
      observations: [],
      commitments: "Deliver by Friday",
    });
    expect(dynamicBlock).toContain("Current Commitments");
    expect(dynamicBlock).toContain("Friday");
  });

  it("produces deterministic stable block output", () => {
    const obs = [
      makeObs({ id: "1", priority: "critical", content: "Error A" }),
      makeObs({ id: "2", priority: "routine", content: "Read file B" }),
    ];
    const params = {
      persona: "Analyst bot",
      observations: obs,
      longTermHighlights: "Key insight: revenue up 20%",
    };
    const result1 = assembleCacheAwareContext(params);
    const result2 = assembleCacheAwareContext(params);
    expect(result1.stableBlock).toBe(result2.stableBlock);
  });

  it("changing goals does not affect stable block", () => {
    const obs = [makeObs({ id: "1", content: "Observation 1" })];
    const base = {
      persona: "Analyst",
      observations: obs,
    };

    const r1 = assembleCacheAwareContext({ ...base, activeGoals: "Goal A" });
    const r2 = assembleCacheAwareContext({ ...base, activeGoals: "Goal B" });

    // Stable blocks should be identical
    expect(r1.stableBlock).toBe(r2.stableBlock);
    // Dynamic blocks should differ
    expect(r1.dynamicBlock).not.toBe(r2.dynamicBlock);
  });

  it("returns empty strings when no content", () => {
    const { stableBlock, dynamicBlock } = assembleCacheAwareContext({
      observations: [],
    });
    expect(stableBlock).toBe("");
    expect(dynamicBlock).toBe("");
  });

  it("includes long-term highlights in stable block", () => {
    const { stableBlock } = assembleCacheAwareContext({
      observations: [],
      longTermHighlights: "Key client: Acme Corp",
    });
    expect(stableBlock).toContain("Long-Term Memory Highlights");
    expect(stableBlock).toContain("Acme Corp");
  });

  it("handles all blocks populated", () => {
    const obs = [makeObs({ id: "1", content: "Observed something" })];
    const { stableBlock, dynamicBlock } = assembleCacheAwareContext({
      persona: "My persona",
      observations: obs,
      longTermHighlights: "Highlights",
      activeGoals: "My goals",
      commitments: "My commitments",
      autoRecallResults: "Recall results",
    });

    // Stable should have persona + observations + highlights
    expect(stableBlock).toContain("My persona");
    expect(stableBlock).toContain("Observation Log");
    expect(stableBlock).toContain("Highlights");

    // Dynamic should have goals + commitments + recall
    expect(dynamicBlock).toContain("My goals");
    expect(dynamicBlock).toContain("My commitments");
    expect(dynamicBlock).toContain("Recall results");

    // No cross-contamination
    expect(stableBlock).not.toContain("My goals");
    expect(dynamicBlock).not.toContain("My persona");
  });
});
