import { describe, expect, it, vi } from "vitest";
import {
  isApiKeyRateLimitError,
  isAnthropicRateLimitError,
  isAnthropicBillingError,
} from "./live-auth-keys.js";

describe("isApiKeyRateLimitError", () => {
  it("detects rate_limit in message", () => {
    expect(isApiKeyRateLimitError("rate_limit exceeded")).toBe(true);
    expect(isApiKeyRateLimitError("RATE_LIMIT error")).toBe(true);
  });

  it("detects 'rate limit' phrase", () => {
    expect(isApiKeyRateLimitError("rate limit exceeded")).toBe(true);
  });

  it("detects 429 status code", () => {
    expect(isApiKeyRateLimitError("error 429")).toBe(true);
    expect(isApiKeyRateLimitError("HTTP 429")).toBe(true);
  });

  it("detects quota exceeded", () => {
    expect(isApiKeyRateLimitError("quota exceeded")).toBe(true);
    expect(isApiKeyRateLimitError("quota_exceeded")).toBe(true);
  });

  it("detects resource exhausted", () => {
    expect(isApiKeyRateLimitError("resource exhausted")).toBe(true);
    expect(isApiKeyRateLimitError("resource_exhausted")).toBe(true);
  });

  it("detects too many requests", () => {
    expect(isApiKeyRateLimitError("too many requests")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isApiKeyRateLimitError("invalid api key")).toBe(false);
    expect(isApiKeyRateLimitError("server error")).toBe(false);
  });
});

describe("isAnthropicRateLimitError", () => {
  it("delegates to isApiKeyRateLimitError", () => {
    expect(isAnthropicRateLimitError("rate_limit")).toBe(true);
    expect(isAnthropicRateLimitError("429")).toBe(true);
  });
});

describe("isAnthropicBillingError", () => {
  it("detects credit balance errors", () => {
    expect(isAnthropicBillingError("credit balance too low")).toBe(true);
    expect(isAnthropicBillingError("insufficient credit")).toBe(true);
  });

  it("detects insufficient credits", () => {
    expect(isAnthropicBillingError("insufficient credits")).toBe(true);
  });

  it("detects payment required", () => {
    expect(isAnthropicBillingError("payment required")).toBe(true);
  });

  it("detects billing disabled", () => {
    expect(isAnthropicBillingError("billing is disabled")).toBe(true);
  });

  it("detects 402 status codes", () => {
    expect(isAnthropicBillingError('{"status": 402}')).toBe(true);
    expect(isAnthropicBillingError("error code: 402")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAnthropicBillingError("rate limit exceeded")).toBe(false);
    expect(isAnthropicBillingError("invalid request")).toBe(false);
  });
});
