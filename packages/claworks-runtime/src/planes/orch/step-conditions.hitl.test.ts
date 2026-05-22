import { describe, expect, it } from "vitest";
import { evaluatePlaybookCondition } from "./step-conditions.js";

describe("evaluatePlaybookCondition hitl step results", () => {
  it("evaluates steps[id].result.get('choice')", () => {
    const ok = evaluatePlaybookCondition(
      "steps['confirm_accept']['result'].get('choice') == 'accepted'",
      {
        steps: {
          confirm_accept: { status: "ok", result: { choice: "accepted" } },
        },
      },
    );
    expect(ok).toBe(true);
  });
});
