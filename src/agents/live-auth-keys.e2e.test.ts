import { describe, expect, it } from "vitest";
import { isAnthropicBillingError } from "./live-auth-keys.js";

describe("isAnthropicBillingError", () => {
  it("does not false-positive on plain 'a 402' prose", () => {
    const samples = [
      "Use a 402 stainless bolt",
      "Book a 402 room",
      "There is a 402 near me",
      "The building at 402 Main Street",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(false);
    }
  });

  it("matches real 402 billing payload contexts including JSON keys", () => {
    const samples = [
      "HTTP 402 Payment Required",
      "status: 402",
      "error code 402",
      '{"status":402,"type":"error"}',
      '{"code":402,"message":"payment required"}',
      '{"error":{"code":402,"message":"billing hard limit reached"}}',
      "got a 402 from the API",
      "returned 402",
      "received a 402 response",
    ];

    for (const sample of samples) {
      expect(isAnthropicBillingError(sample)).toBe(true);
    }
  });
});
