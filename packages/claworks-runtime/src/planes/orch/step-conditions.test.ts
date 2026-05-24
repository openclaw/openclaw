import { describe, expect, it } from "vitest";
import { evaluatePlaybookCondition } from "./step-conditions.js";

describe("evaluatePlaybookCondition template interpolation", () => {
  it("treats interpolated channel_id as truthy", () => {
    const ok = evaluatePlaybookCondition("{{channel_id}}", {
      payload: { channel_id: "feishu" },
      channel_id: "feishu",
    });
    expect(ok).toBe(true);
  });

  it("treats empty interpolated template as falsy", () => {
    const ok = evaluatePlaybookCondition("{{channel_id}}", {
      payload: {},
      channel_id: "",
    });
    expect(ok).toBe(false);
  });

  it("still evaluates payload.get python-style conditions", () => {
    const ok = evaluatePlaybookCondition("payload.get('priority') in ('P1', 'P2')", {
      payload: { priority: "P1" },
    });
    expect(ok).toBe(true);
  });
});

describe("evaluatePlaybookCondition — or / not / simple comparisons", () => {
  it("or: returns true if any branch is true", () => {
    expect(
      evaluatePlaybookCondition(
        "payload.get('status') in ('ok',) or payload.get('status') in ('done',)",
        {
          payload: { status: "done" },
        },
      ),
    ).toBe(true);
  });

  it("or: returns false if all branches are false", () => {
    expect(
      evaluatePlaybookCondition(
        "payload.get('status') in ('ok',) or payload.get('status') in ('done',)",
        {
          payload: { status: "error" },
        },
      ),
    ).toBe(false);
  });

  it("not: negates a truthy condition", () => {
    expect(
      evaluatePlaybookCondition("not payload.get('status') in ('error',)", {
        payload: { status: "ok" },
      }),
    ).toBe(true);
  });

  it("not: negates a falsy condition", () => {
    expect(
      evaluatePlaybookCondition("not payload.get('status') in ('ok',)", {
        payload: { status: "ok" },
      }),
    ).toBe(false);
  });

  it("simple numeric comparison >", () => {
    expect(evaluatePlaybookCondition("10 > 5", {})).toBe(true);
    expect(evaluatePlaybookCondition("3 > 5", {})).toBe(false);
  });

  it("simple numeric comparison ==", () => {
    expect(evaluatePlaybookCondition("42 == 42", {})).toBe(true);
    expect(evaluatePlaybookCondition("42 == 43", {})).toBe(false);
  });

  it("simple numeric comparison !=", () => {
    expect(evaluatePlaybookCondition("5 != 3", {})).toBe(true);
    expect(evaluatePlaybookCondition("5 != 5", {})).toBe(false);
  });

  it("steps result get with != operator", () => {
    expect(
      evaluatePlaybookCondition("steps['analyze']['result'].get('status') != 'error'", {
        steps: { analyze: { result: { status: "ok" } } },
      }),
    ).toBe(true);
    expect(
      evaluatePlaybookCondition("steps['analyze']['result'].get('status') != 'error'", {
        steps: { analyze: { result: { status: "error" } } },
      }),
    ).toBe(false);
  });

  it("and combined with or (and has higher precedence)", () => {
    // "A and B or C" = "(A and B) or C"
    // In our impl: or is checked first → splits on " or " → ["A and B", "C"]
    // Then evaluates each side
    expect(evaluatePlaybookCondition("5 > 3 and 2 > 1 or 1 > 100", {})).toBe(true);
  });
});
