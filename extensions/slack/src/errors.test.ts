import { describe, expect, it } from "vitest";
import { formatSlackError } from "./errors.js";

describe("formatSlackError", () => {
  it("returns String(err) for non-Error values", () => {
    expect(formatSlackError("boom")).toBe("boom");
    expect(formatSlackError(42)).toBe("42");
    expect(formatSlackError(null)).toBe("null");
  });

  it("returns just the message for a plain Error", () => {
    expect(formatSlackError(new Error("plain"))).toBe("plain");
  });

  it("includes code and data fields from a platform error", () => {
    const err = Object.assign(new Error("not_authed"), {
      code: "slack_webapi_platform_error",
      data: {
        ok: false,
        error: "not_authed",
        needed: "chat:write",
        provided: "users:read",
        response_metadata: {
          scopes: ["users:read"],
          acceptedScopes: ["chat:write", "chat:write.public"],
          messages: ["missing required scope"],
        },
      },
    });
    const result = formatSlackError(err);
    expect(result).toContain("code=slack_webapi_platform_error");
    expect(result).toContain("error=not_authed");
    expect(result).toContain("needed=chat:write");
    expect(result).toContain("provided=users:read");
    expect(result).toContain("scopes=users:read");
    expect(result).toContain("acceptedScopes=chat:write,chat:write.public");
    expect(result).toContain("messages=missing required scope");
  });

  it("includes retryAfter from rate-limited errors", () => {
    const err = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 30,
    });
    const result = formatSlackError(err);
    expect(result).toContain("retryAfter=30");
  });

  it("includes http status details", () => {
    const err = Object.assign(new Error("http failed"), {
      code: "slack_webapi_http_error",
      statusCode: 429,
      statusMessage: "Too Many Requests",
    });
    const result = formatSlackError(err);
    expect(result).toContain("statusCode=429");
    expect(result).toContain("statusMessage=Too Many Requests");
  });

  it("handles coded error with no data property", () => {
    const err = Object.assign(new Error("request failed"), {
      code: "slack_webapi_request_error",
    });
    const result = formatSlackError(err);
    expect(result).toBe("request failed [code=slack_webapi_request_error]");
  });
});
