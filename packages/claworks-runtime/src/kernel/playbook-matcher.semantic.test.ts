import { describe, expect, it } from "vitest";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { createPlaybookMatcher, semanticFallbackScore } from "./playbook-matcher.js";

describe("semantic fallback matcher", () => {
  it("scores overlapping event tokens", () => {
    expect(semanticFallbackScore("alarm.*", "alarm.created")).toBeGreaterThan(0.4);
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
