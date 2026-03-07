import { describe, expect, it } from "vitest";
import { sanitizePayloadForLogging } from "./payload-log-redaction.js";

describe("sanitizePayloadForLogging", () => {
  it("reuses sanitized clone for repeated object references", () => {
    const shared = { secret: "OPENAI_API_KEY=sk-1234567890abcdef" };
    const payload = { a: shared, b: shared };

    const sanitized = sanitizePayloadForLogging(payload);

    expect(sanitized).not.toBe(payload);
    expect(sanitized.a).toBe(sanitized.b);
    expect(sanitized.a).not.toBe(shared);
    expect(sanitized.a.secret).not.toBe(shared.secret);
    expect(sanitized.a.secret).toContain("sk-123");
    expect(sanitized.a.secret).toContain("cdef");
  });

  it("preserves cycles through sanitized clones", () => {
    const payload: { note: string; self?: unknown } = {
      note: "OPENAI_API_KEY=sk-1234567890abcdef",
    };
    payload.self = payload;

    const sanitized = sanitizePayloadForLogging(payload) as { note: string; self?: unknown };

    expect(sanitized).not.toBe(payload);
    expect(sanitized.self).toBe(sanitized);
    expect(sanitized.note).not.toBe(payload.note);
    expect(sanitized.note).toContain("sk-123");
    expect(sanitized.note).toContain("cdef");
  });

  it("reuses sanitized clone for repeated array members", () => {
    const shared = { token: "OPENAI_API_KEY=sk-1234567890abcdef" };
    const payload = [shared, shared];

    const sanitized = sanitizePayloadForLogging(payload);

    expect(Array.isArray(sanitized)).toBe(true);
    expect(sanitized[0]).toBe(sanitized[1]);
    expect(sanitized[0]).not.toBe(shared);
    expect((sanitized[0] as { token: string }).token).not.toBe(shared.token);
  });
});
