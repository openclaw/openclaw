// Discord tests cover probe.parse token plugin behavior.
import { describe, expect, it } from "vitest";
import { parseApplicationIdFromToken } from "./probe.js";

describe("parseApplicationIdFromToken", () => {
  it("returns undefined for whitespace-only input", () => {
    expect(parseApplicationIdFromToken("   ")).toBeUndefined();
  });

  it("returns undefined when first segment is empty (starts with dot)", () => {
    expect(parseApplicationIdFromToken(".ts.hmac")).toBeUndefined();
  });
});
