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
