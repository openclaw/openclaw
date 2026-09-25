// Covers message predicates whose truth values intentionally differ from the central outcome.
import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isFailoverErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";

const PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE = "Proxy notice: Status: Internal Server Error";
const MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE = `${PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE}; upstream connect error`;
const INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE = `${PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE}; code:500`;
describe("isBillingErrorMessage", () => {
  it.each([
    {
      name: "does not false-positive on issue ids and numeric references",
      samples: [
        "Fixed issue CHE-402 in the latest release",
        "Error code 403 was returned, not 402-related",
        "402 items found in the database",
      ],
      expected: false,
    },
    {
      name: "still matches real HTTP 402 billing errors",
      samples: [
        "status: 402",
        "error code 402",
        "http 402",
        "got a 402 from the API",
        "returned 402",
        '{"status":402,"type":"error"}',
        '{"code":402,"message":"payment required"}',
        '{"error":{"code":402,"message":"billing hard limit reached"}}',
      ],
      expected: true,
    },
  ])("$name", ({ samples, expected }) => {
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample), sample).toBe(expected);
    }
  });

  it("still matches explicit 402 markers in long payloads", () => {
    const longStructuredError =
      '{"error":{"code":402,"message":"payment required","details":"' + "x".repeat(700) + '"}}';
    expect(longStructuredError.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(longStructuredError)).toBe(true);
  });
  it("does not match long numeric text that is not a billing error", () => {
    const longNonError =
      "Quarterly report summary: subsystem A returned 402 records after retry. " +
      "This is an analytics count, not an HTTP/API billing failure. " +
      "Notes: " +
      "x".repeat(700);
    expect(longNonError.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(longNonError)).toBe(false);
  });
});

describe("isCloudCodeAssistFormatError", () => {
  it("excludes unrelated and image-dimension errors", () => {
    for (const sample of [
      "rate limit exceeded",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
    ]) {
      expect(isCloudCodeAssistFormatError(sample)).toBe(false);
    }
  });
});

describe("isFailoverErrorMessage", () => {
  it("recognizes classified failover errors", () => {
    expect(isFailoverErrorMessage("429 rate limit exceeded")).toBe(true);
  });

  it("classifies Provider finish_reason: error as server_error, not timeout (#109218)", () => {
    // OpenRouter/Google can complete quickly with finish_reason:error; that is a
    // provider-completed failure, not a hung request. Fallback must remain eligible.
    const samples = [
      "Provider finish_reason: error",
      "finish_reason: error",
      "stop reason: error",
      "Unhandled stop reason: error",
    ];
    for (const sample of samples) {
      expect(isTimeoutErrorMessage(sample)).toBe(false);
      expect(classifyFailoverReason(sample)).toBe("server_error");
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("matches google INTERNAL status errors as timeout", () => {
    const sample =
      "provider=google model=gemini-3.1-flash-lite-preview got status: INTERNAL upstream failure code:500";
    expect(isTimeoutErrorMessage(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBe("timeout");
    expect(isFailoverErrorMessage(sample)).toBe(true);
  });

  it("does not treat plain status text with internal-server-error wording as timeout", () => {
    expect(isTimeoutErrorMessage(PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(false);
    expect(classifyFailoverReason(PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBeNull();
    expect(isFailoverErrorMessage(PLAIN_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(false);
  });

  it("keeps mixed upstream server errors retryable when they also mention status prose", () => {
    expect(isTimeoutErrorMessage(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(false);
    expect(classifyFailoverReason(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe("timeout");
    expect(isFailoverErrorMessage(MIXED_INTERNAL_SERVER_ERROR_STATUS_SAMPLE)).toBe(true);
  });

  it("keeps status prose retryable when it is explicitly paired with code 500", () => {
    expect(isTimeoutErrorMessage(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe(false);
    expect(classifyFailoverReason(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe("timeout");
    expect(isFailoverErrorMessage(INTERNAL_SERVER_ERROR_STATUS_WITH_500_SAMPLE)).toBe(true);
  });
});
