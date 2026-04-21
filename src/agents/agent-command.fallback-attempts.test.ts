import { describe, expect, it } from "vitest";
import { sanitizeFallbackAttemptsForMeta } from "./agent-command.js";
import type { FallbackAttempt } from "./model-fallback.types.js";

describe("sanitizeFallbackAttemptsForMeta", () => {
  it("redacts tokens, caps count, and truncates oversized error strings", () => {
    const many: FallbackAttempt[] = Array.from({ length: 32 }, (_, i) => ({
      provider: `p${i}`,
      model: `m${i}`,
      error: i === 31 ? "x".repeat(5000) : `Authorization: Bearer sk-abcdef0123456789ABCDEF${i}`,
      reason: "unknown",
    }));
    const sanitized = sanitizeFallbackAttemptsForMeta(many);
    expect(sanitized.length).toBe(16);
    expect(sanitized[0]?.provider).toBe("p16");
    for (const attempt of sanitized.slice(0, -1)) {
      expect(attempt.error).not.toContain("sk-abcdef0123456789ABCDEF");
    }
    const big = sanitized.at(-1);
    expect(big?.error.length).toBeLessThanOrEqual(501);
    expect(big?.error.endsWith("…")).toBe(true);
  });
});
