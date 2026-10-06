import { describe, expect, it } from "vitest";
import { validateTalkSessionCreateParams } from "./index.js";

describe("Talk opening greeting schema", () => {
  it.each(["Briefly explain the prepared call topic.", "x".repeat(1000)])(
    "accepts a bounded opening",
    (greeting) => {
      expect(validateTalkSessionCreateParams({ sessionKey: "agent:main:call", greeting })).toBe(
        true,
      );
    },
  );

  it.each(["", "   ", "x".repeat(1001), true])("rejects invalid opening content", (greeting) => {
    expect(validateTalkSessionCreateParams({ sessionKey: "agent:main:call", greeting })).toBe(
      false,
    );
  });

  it.each([0, 10_000, 10_001, 30_000])(
    "accepts bounded recovery duration %i",
    (interruptedForMs) => {
      expect(validateTalkSessionCreateParams({ recovery: { interruptedForMs } })).toBe(true);
    },
  );

  it.each([-1, 30_001, 1.5, "10001", null, undefined])(
    "rejects invalid recovery duration %j",
    (interruptedForMs) => {
      expect(validateTalkSessionCreateParams({ recovery: { interruptedForMs } })).toBe(false);
    },
  );

  it("rejects freeform recovery context", () => {
    expect(
      validateTalkSessionCreateParams({ recovery: { interruptedForMs: 12_000, text: "Say this" } }),
    ).toBe(false);
  });
});
