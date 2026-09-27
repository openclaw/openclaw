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
});
