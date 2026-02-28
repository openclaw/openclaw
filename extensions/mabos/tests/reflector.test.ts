import { describe, it, expect } from "vitest";
import type { Observation } from "../src/tools/observation-types.js";
import { reflectObservations } from "../src/tools/reflector.js";

function makeObs(overrides: Partial<Observation> & { id: string }): Observation {
  return {
    priority: "routine",
    content: "Test observation",
    observed_at: new Date().toISOString(),
    tags: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("reflectObservations", () => {
  it("removes already-superseded observations", () => {
    const obs: Observation[] = [
      makeObs({ id: "1", superseded_by: "2", content: "old" }),
      makeObs({ id: "2", content: "new" }),
    ];
    const result = reflectObservations(obs);
    expect(result.find((o) => o.id === "1")).toBeUndefined();
    expect(result.find((o) => o.id === "2")).toBeDefined();
  });

  it("preserves all critical observations", () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const obs: Observation[] = [
      makeObs({ id: "1", priority: "critical", content: "Critical error", created_at: oldDate }),
      makeObs({ id: "2", priority: "routine", content: "Routine item", created_at: oldDate }),
    ];
    const result = reflectObservations(obs);
    expect(result.find((o) => o.id === "1")).toBeDefined(); // Critical kept
    expect(result.find((o) => o.id === "2")).toBeUndefined(); // Old routine dropped
  });

  it("drops routine observations older than 7 days", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const obs: Observation[] = [
      makeObs({ id: "old", priority: "routine", created_at: eightDaysAgo }),
      makeObs({ id: "new", priority: "routine", created_at: twoDaysAgo }),
    ];
    const result = reflectObservations(obs);
    expect(result.find((o) => o.id === "old")).toBeUndefined();
    expect(result.find((o) => o.id === "new")).toBeDefined();
  });

  it("merges routine observations from same date when >3 exist", () => {
    const now = new Date().toISOString();
    const obs: Observation[] = Array.from({ length: 5 }, (_, i) =>
      makeObs({
        id: `r${i}`,
        priority: "routine",
        content: `Routine item ${i}`,
        observed_at: now,
        created_at: now,
      }),
    );
    const result = reflectObservations(obs);
    // Should have merged into a single summary
    const routines = result.filter((o) => o.priority === "routine");
    expect(routines.length).toBeLessThan(5);
    // The summary should mention the count
    expect(routines.some((r) => r.content.includes("[5 routine items]"))).toBe(true);
  });

  it("keeps <=3 routine observations from same date individually", () => {
    const now = new Date().toISOString();
    const obs: Observation[] = [
      makeObs({
        id: "r1",
        priority: "routine",
        content: "Item 1",
        observed_at: now,
        created_at: now,
      }),
      makeObs({
        id: "r2",
        priority: "routine",
        content: "Item 2",
        observed_at: now,
        created_at: now,
      }),
      makeObs({
        id: "r3",
        priority: "routine",
        content: "Item 3",
        observed_at: now,
        created_at: now,
      }),
    ];
    const result = reflectObservations(obs);
    expect(result.filter((o) => o.priority === "routine")).toHaveLength(3);
  });

  it("marks superseded observations with same tags", () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3600000).toISOString();
    const later = now.toISOString();
    const obs: Observation[] = [
      makeObs({
        id: "1",
        priority: "important",
        content: "First version",
        tags: ["file:foo.ts"],
        created_at: earlier,
      }),
      makeObs({
        id: "2",
        priority: "important",
        content: "Updated version",
        tags: ["file:foo.ts"],
        created_at: later,
      }),
    ];
    const result = reflectObservations(obs);
    // The older one should be superseded and removed
    expect(result.find((o) => o.id === "1")).toBeUndefined();
    expect(result.find((o) => o.id === "2")).toBeDefined();
  });

  it("does not supersede critical observations", () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3600000).toISOString();
    const later = now.toISOString();
    const obs: Observation[] = [
      makeObs({
        id: "1",
        priority: "critical",
        content: "Critical error",
        tags: ["file:foo.ts"],
        created_at: earlier,
      }),
      makeObs({
        id: "2",
        priority: "critical",
        content: "Another critical",
        tags: ["file:foo.ts"],
        created_at: later,
      }),
    ];
    const result = reflectObservations(obs);
    expect(result).toHaveLength(2); // Both preserved
  });

  it("reduces token count when over threshold", () => {
    // Create many routine observations that exceed the threshold
    const obs: Observation[] = Array.from({ length: 200 }, (_, i) =>
      makeObs({
        id: `obs-${i}`,
        priority: "routine",
        content: "x".repeat(500),
        created_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
      }),
    );
    const result = reflectObservations(obs, { observationTokenThreshold: 5000 });
    expect(result.length).toBeLessThan(obs.length);
  });

  it("returns empty array for empty input", () => {
    expect(reflectObservations([])).toEqual([]);
  });
});
