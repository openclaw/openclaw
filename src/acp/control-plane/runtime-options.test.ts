import { describe, expect, it } from "vitest";
import { validateRuntimeModeInput } from "./runtime-options.js";

describe("validateRuntimeModeInput", () => {
  it.each(["plan", "normal", "auto"] as const)("accepts %s", (mode) => {
    expect(validateRuntimeModeInput(mode)).toBe(mode);
  });

  it("rejects unsupported runtime modes", () => {
    expect(() => validateRuntimeModeInput("execute")).toThrow(
      "Runtime mode must be one of plan, normal, auto.",
    );
  });
});
