import { describe, expect, it } from "vitest";
import {
  DatabricksAllowlistError,
  DatabricksError,
  DatabricksHttpError,
  isRetryableStatus,
  normalizeDatabricksError,
  redactToken,
  sanitizeDatabricksText,
} from "./errors.js";

describe("databricks errors", () => {
  it("maps retryable status codes", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it("creates typed http errors", () => {
    const error = new DatabricksHttpError({
      statusCode: 401,
      message: "Unauthorized",
    });
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.retryable).toBe(false);
    expect(error.statusCode).toBe(401);
  });

  it("normalizes abort errors into TIMEOUT", () => {
    const error = normalizeDatabricksError(
      new DOMException("The operation was aborted.", "AbortError"),
      "timeout",
    );
    expect(error.code).toBe("TIMEOUT");
    expect(error.retryable).toBe(true);
  });

  it("passes through DatabricksError instances", () => {
    const original = new DatabricksError({
      code: "POLICY_VIOLATION",
      message: "blocked",
    });
    const normalized = normalizeDatabricksError(original, "fallback");
    expect(normalized).toBe(original);
  });

  it("creates allowlist violation error", () => {
    const error = new DatabricksAllowlistError("catalog blocked");
    expect(error.code).toBe("ALLOWLIST_VIOLATION");
    expect(error.retryable).toBe(false);
  });

  it("sanitizes urls and bearer tokens from text", () => {
    const text = sanitizeDatabricksText(
      "request to https://dbc-example.cloud.databricks.com failed with Bearer dapi1234567890token",
    );
    expect(text).not.toContain("https://dbc-example.cloud.databricks.com");
    expect(text).not.toContain("dapi1234567890token");
    expect(text).toContain("[redacted-url]");
    expect(text).toContain("Bearer dapi***ken");
  });

  it("redacts tokens consistently", () => {
    expect(redactToken("dapi1234567890token")).toBe("dapi***ken");
  });
});
