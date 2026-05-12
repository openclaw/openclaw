import { describe, expect, it } from "vitest";
import { validateRuntimeOptionPatch } from "./runtime-options.js";

describe("ACP runtime options", () => {
  it("rejects fractional timeoutSeconds numeric patches", () => {
    expect(() => validateRuntimeOptionPatch({ timeoutSeconds: 1.4 })).toThrow(
      "Timeout must be a positive integer in seconds.",
    );
    expect(() => validateRuntimeOptionPatch({ timeoutSeconds: 1.6 })).toThrow(
      "Timeout must be a positive integer in seconds.",
    );
  });
});
