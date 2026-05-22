import { describe, expect, it } from "vitest";
import { parsePlaybookYaml } from "./yaml-parsers.js";

describe("parsePlaybookYaml hitl steps", () => {
  it("maps prompt, label/value options, timeout_hours, and auto_approve_if", () => {
    const def = parsePlaybookYaml(
      `
id: test_hitl
name: Test
trigger:
  kind: event
  pattern: test.event
steps:
  - id: confirm
    kind: hitl
    prompt: Approve task {{ payload.title }}
    options:
      - label: Accept
        value: accepted
      - label: Reject
        value: rejected
    timeout_hours: 2
    auto_approve_if: "payload.get('priority') == 'low'"
`,
      "enterprise-general",
    );
    const step = def.steps[0];
    expect(step?.kind).toBe("hitl");
    if (step?.kind !== "hitl") {
      return;
    }
    expect(step.message).toContain("Approve task");
    expect(step.options).toEqual(["accepted", "rejected"]);
    expect(step.timeout_seconds).toBe(7200);
    expect(step.hitl?.autoApproveIf).toContain("priority");
    expect(step.hitl?.timeoutHours).toBe(2);
  });
});
