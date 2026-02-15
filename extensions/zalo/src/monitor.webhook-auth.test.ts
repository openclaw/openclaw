import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "node:crypto";

/**
 * Mirror of the safeEqualSecret helper added to monitor.ts.
 * Tests the logic in isolation since the monitor handler is not easily
 * unit-callable without full runtime wiring.
 */
function safeEqualSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

describe("Zalo webhook secret comparison", () => {
  it("returns true for matching secrets", () => {
    expect(safeEqualSecret("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("returns false for mismatched secrets", () => {
    expect(safeEqualSecret("my-secret-token", "wrong-token-here")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeEqualSecret("short", "a-much-longer-secret")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(safeEqualSecret("", "")).toBe(true);
    expect(safeEqualSecret("", "non-empty")).toBe(false);
  });

  it("handles unicode secrets", () => {
    expect(safeEqualSecret("密码🔑", "密码🔑")).toBe(true);
    expect(safeEqualSecret("密码🔑", "密码🔒")).toBe(false);
  });
});
