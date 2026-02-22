/**
 * Phase 0 — redaction.test.ts
 *
 * Verifies that common secret patterns are masked before persisting to disk.
 */
import { describe, it, expect } from "vitest";
import { redact, maybeRedact } from "../core/redaction.js";

describe("redaction", () => {
  it("masks Authorization Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abcdef.ghijkl";
    const result = redact(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("masks apiKey values", () => {
    const input = 'apiKey: "sk-proj-abc123def456ghi789jkl012mno345pqr678"';
    const result = redact(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-proj-abc123def456ghi789jkl012mno345pqr678");
  });

  it("masks token = <value>", () => {
    const input = 'token = "FAKE_TOKEN_VALUE_abc123def456ghi789jkl012mno345pqr678stu901"';
    const result = redact(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("FAKE_TOKEN_VALUE_abc123");
  });

  it("masks long hex strings (like API secrets)", () => {
    const input = "endpointSecret = c0a6592f0b276f3cd6cca09a631f60a9e22fe2703ae47975";
    const result = redact(input);
    expect(result).toContain("[REDACTED");
    expect(result).not.toContain("c0a6592f0b276f3cd6cca09a631f60a9e22fe2703ae47975");
  });

  it("preserves normal text without secrets", () => {
    const input = "I created src/payment/webhook.ts with Stripe integration";
    const result = redact(input);
    expect(result).toBe(input);
  });

  it("preserves short strings that look like code variables", () => {
    const input = "const port = 18789; const host = 'localhost';";
    const result = redact(input);
    expect(result).toBe(input);
  });

  it("maybeRedact with enabled=false returns original", () => {
    const input = "apiKey: sk-proj-abc123def456ghi789jkl012mno345pqr678";
    expect(maybeRedact(input, false)).toBe(input);
  });

  it("maybeRedact with enabled=true applies redaction", () => {
    const input = "apiKey: sk-proj-abc123def456ghi789jkl012mno345pqr678";
    const result = maybeRedact(input, true);
    expect(result).not.toBe(input);
    expect(result).toContain("[REDACTED]");
  });
});
