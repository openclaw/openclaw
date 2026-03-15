import { describe, it, expect } from "vitest";
import { scanForLeaks, redactLeaks } from "./leak-detector.js";

describe("scanForLeaks", () => {
  // ── Should detect ──────────────────────────────────────────────
  it("detects OpenAI API key", () => {
    const m = scanForLeaks("key is sk-proj-abcdefghijklmnopqrstuvwx");
    expect(m.some((r) => r.ruleId === "openai-key")).toBe(true);
  });

  it("detects Anthropic API key", () => {
    const m = scanForLeaks("sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(m.some((r) => r.ruleId === "anthropic-key")).toBe(true);
  });

  it("detects GitHub PAT (ghp_)", () => {
    const m = scanForLeaks("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(m.some((r) => r.ruleId === "github-pat")).toBe(true);
  });

  it("detects AWS access key (AKIA)", () => {
    const m = scanForLeaks("AKIAIOSFODNN7EXAMPLE");
    expect(m.some((r) => r.ruleId === "aws-access-key")).toBe(true);
  });

  it("detects AWS secret key with context", () => {
    const m = scanForLeaks("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1");
    expect(m.some((r) => r.ruleId === "aws-secret-key")).toBe(true);
  });

  it("detects Stripe key", () => {
    // Use a clearly fake key pattern that won't trigger GitHub push protection
    const m = scanForLeaks("sk_live_" + "x".repeat(24));
    expect(m.some((r) => r.ruleId === "stripe-key")).toBe(true);
  });

  it("detects Slack token", () => {
    const m = scanForLeaks("xoxb-1234567890-abcdefghij");
    expect(m.some((r) => r.ruleId === "slack-token")).toBe(true);
  });

  it("detects full PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...base64data...\n-----END RSA PRIVATE KEY-----";
    const m = scanForLeaks(pem);
    expect(m.some((r) => r.ruleId === "private-key-pem")).toBe(true);
  });

  it("redacts entire PEM block, not just header", () => {
    const pem =
      "before -----BEGIN RSA PRIVATE KEY-----\nSECRETDATA\n-----END RSA PRIVATE KEY----- after";
    const result = redactLeaks(pem);
    expect(result).not.toContain("SECRETDATA");
    expect(result).toContain("[REDACTED:private-key-pem]");
  });

  it("detects URL credentials", () => {
    const m = scanForLeaks("https://admin:password123@db.example.com");
    expect(m.some((r) => r.ruleId === "url-credentials")).toBe(true);
  });

  it("detects Bearer token", () => {
    const m = scanForLeaks("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6");
    expect(m.some((r) => r.ruleId === "bearer-token")).toBe(true);
  });

  it("detects generic API key assignment", () => {
    const m = scanForLeaks('api_key = "abcdef1234567890abcd"');
    expect(m.some((r) => r.ruleId === "generic-api-key-assignment")).toBe(true);
  });

  it("detects Heroku key with context", () => {
    const m = scanForLeaks("HEROKU_API_KEY=01234567-abcd-ef01-2345-6789abcdef01");
    expect(m.some((r) => r.ruleId === "heroku-key")).toBe(true);
  });

  // ── Should NOT detect (false positives fixed) ──────────────────
  it("does not flag random 40-char string as AWS secret", () => {
    const m = scanForLeaks("abcdefghijABCDEFGHIJ1234567890abcdefghij");
    expect(m.some((r) => r.ruleId === "aws-secret-key")).toBe(false);
  });

  it("does not flag git SHA as AWS secret", () => {
    const m = scanForLeaks("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(m.some((r) => r.ruleId === "aws-secret-key")).toBe(false);
  });

  it("does not flag random UUID as Heroku key", () => {
    const m = scanForLeaks("user_id: 550e8400-e29b-41d4-a716-446655440000");
    expect(m.some((r) => r.ruleId === "heroku-key")).toBe(false);
  });

  it("does not flag session UUID as Heroku key", () => {
    const m = scanForLeaks("session: a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(m.some((r) => r.ruleId === "heroku-key")).toBe(false);
  });

  it("does not flag empty input", () => {
    const m = scanForLeaks("");
    expect(m.length).toBe(0);
  });

  it("does not flag normal text", () => {
    const m = scanForLeaks("Hello, this is a normal message with no secrets.");
    expect(m.length).toBe(0);
  });
});

describe("redactLeaks", () => {
  it("redacts OpenAI key", () => {
    const text = "my key: sk-proj-abcdefghijklmnopqrstuvwx";
    const result = redactLeaks(text);
    expect(result).toContain("[REDACTED:openai-key]");
    expect(result).not.toContain("sk-proj-");
  });

  it("redacts multiple secrets in one string", () => {
    const text = "AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = redactLeaks(text);
    expect(result).toContain("[REDACTED:aws-access-key]");
    expect(result).toContain("[REDACTED:github-pat]");
  });

  it("preserves non-secret text", () => {
    const text = "normal text here";
    expect(redactLeaks(text)).toBe("normal text here");
  });

  it("redacts AWS secret key with assignment context", () => {
    const text = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1";
    const result = redactLeaks(text);
    expect(result).toContain("[REDACTED:aws-secret-key]");
  });
});
