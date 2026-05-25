import { describe, expect, it } from "vitest";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { createPlaybookMatcher, semanticFallbackScore } from "./playbook-matcher.js";

describe("semantic fallback matcher", () => {
  it("scores overlapping event tokens", () => {
    expect(semanticFallbackScore("alarm.*", "alarm.created")).toBeGreaterThan(0.4);
  });

  it("does not cross-match sibling evolution event types", () => {
    expect(
      semanticFallbackScore("evolution.regression_requested", "evolution.simulation_requested"),
    ).toBe(0);
    expect(
      semanticFallbackScore("evolution.simulation_requested", "evolution.regression_requested"),
    ).toBe(0);
  });

  it("does not match weak_model playbook on simulation_requested via semantic fallback", () => {
    const matcher = createPlaybookMatcher();
    matcher.load([
      {
        id: "evolution_simulation_pipeline",
        name: "Simulation",
        pack: "base",
        trigger: { kind: "event", pattern: "evolution.simulation_requested" },
        priority: 910,
        steps: [],
      },
      {
        id: "weak_model_regression_suite",
        name: "Regression",
        pack: "base",
        trigger: { kind: "event", pattern: "evolution.regression_requested" },
        priority: 10,
        steps: [],
      },
    ]);

    const matches = matcher.match({
      id: "1",
      type: "evolution.simulation_requested",
      source: "test",
      payload: {},
      timestamp: 0,
    });

    expect(matches.map((m) => m.playbookId)).toEqual(["evolution_simulation_pipeline"]);
  });

  it("matches via semantic fallback when glob misses", () => {
    const matcher = createPlaybookMatcher();
    const pb: PlaybookDefinition = {
      id: "observe_alarm",
      name: "Observe",
      pack: "t",
      trigger: { kind: "event", pattern: "equipment.alarm" },
      priority: 1,
      steps: [],
    };
    matcher.load([pb]);
    const matches = matcher.match({
      id: "1",
      type: "equipment.alarm.tripped",
      source: "ot",
      payload: {},
      timestamp: 0,
    });
    expect(matches.some((m) => m.playbookId === "observe_alarm")).toBe(true);
  });
});
