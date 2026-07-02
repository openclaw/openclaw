import { describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason", () => {
  it.each([
    { code: "UNAVAILABLE", expected: "overloaded" },
    { code: "DEADLINE_EXCEEDED", expected: "timeout" },
    { code: "INTERNAL", expected: "server_error" },
  ] as const)("classifies google-family $code as $expected", ({ code, expected }) => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider: "google",
        errorMessage: "",
        code,
      }),
    ).toBe(expected);
  });

  it("leaves unknown codes for generic classification", () => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider: "google-vertex",
        errorMessage: "",
        code: "INSUFFICIENT_QUOTA",
      }),
    ).toBeUndefined();
  });
});
