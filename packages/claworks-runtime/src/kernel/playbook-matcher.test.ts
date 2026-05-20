import { describe, expect, it } from "vitest";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import { createPlaybookMatcher, evaluateCondition } from "./playbook-matcher.js";
import type { CwEvent } from "./types.js";

describe("playbook-matcher", () => {
  const event: CwEvent = {
    id: "e1",
    type: "alarm.created",
    source: "test",
    timestamp: new Date(),
    payload: { mro_alarm_to_wo: true, alarm_id: "a1" },
  };

  const playbooks: PlaybookDefinition[] = [
    {
      id: "mro_alarm_to_workorder",
      name: "MRO",
      pack: "process-industry",
      trigger: {
        kind: "event",
        pattern: "alarm.created",
        condition: "bool(payload.get('mro_alarm_to_wo'))",
      },
      priority: 10,
      steps: [],
    },
    {
      id: "observe_and_record",
      name: "Observe",
      pack: "base",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [],
    },
  ];

  it("matches event playbooks with condition", () => {
    const matcher = createPlaybookMatcher();
    matcher.load(playbooks);
    const matches = matcher.match(event);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.playbookId).toBe("mro_alarm_to_workorder");
  });

  it("evaluates python-style conditions", () => {
    expect(
      evaluateCondition("bool(payload.get('mro_alarm_to_wo'))", { mro_alarm_to_wo: true }),
    ).toBe(true);
    expect(evaluateCondition("bool(payload.get('mro_alarm_to_wo'))", {})).toBe(false);
  });

  it("evaluates compound and conditions", () => {
    expect(
      evaluateCondition(
        "bool(payload.get('source_alarm_id')) and bool(payload.get('workorder_id'))",
        { source_alarm_id: "a1", workorder_id: "w1" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        "bool(payload.get('source_alarm_id')) and bool(payload.get('workorder_id'))",
        { source_alarm_id: "a1" },
      ),
    ).toBe(false);
  });

  it("evaluates in-list conditions", () => {
    expect(
      evaluateCondition("payload.get('severity') in ('critical', 'high')", {
        severity: "critical",
      }),
    ).toBe(true);
    expect(
      evaluateCondition("payload.get('severity') in ('critical', 'high')", { severity: "low" }),
    ).toBe(false);
  });
});
