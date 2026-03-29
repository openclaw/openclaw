import { describe, expect, it } from "vitest";
import { JiraApiError, normalizeJiraError, sanitizeJiraErrorMessage } from "./errors.js";

describe("jira errors", () => {
  it("sanitizes token and authorization values", () => {
    const message = sanitizeJiraErrorMessage({
      message:
        "failed with token super-secret and Authorization: Basic abc123 and Authorization: Bearer my-token and x-api-key: key-123",
      secrets: ["super-secret"],
    });
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("my-token");
    expect(message).not.toContain("key-123");
    expect(message).toContain("[REDACTED]");
  });

  it("normalizes JiraApiError preserving code and status", () => {
    const payload = normalizeJiraError(
      new JiraApiError("too many requests", "jira_rate_limited", 429, true),
    );
    expect(payload).toEqual({
      ok: false,
      code: "jira_rate_limited",
      status: 429,
      retryable: true,
      message: "too many requests",
    });
  });

  it("normalizes unknown errors with fallback code", () => {
    const payload = normalizeJiraError(new Error("boom"), {
      fallbackCode: "jira_validation_failed",
    });
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("jira_validation_failed");
    expect(payload.retryable).toBe(false);
  });

  it("redacts embedded basic token and apiToken in upstream-like text", () => {
    const payload = normalizeJiraError(
      new Error("upstream echoed Authorization: Basic ZXhhbXBsZTpzZWNyZXQ= apiToken=abc123"),
      {
        secrets: ["abc123"],
      },
    );
    expect(payload.message).not.toContain("ZXhhbXBsZTpzZWNyZXQ=");
    expect(payload.message).not.toContain("abc123");
    expect(payload.message).toContain("[REDACTED]");
  });
});
