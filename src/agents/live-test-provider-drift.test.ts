import { expect, it } from "vitest";
import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";
import {
  isLiveAuthDrift,
  isLiveBillingDrift,
  isLiveProviderUnavailableDrift,
  isLiveRateLimitDrift,
} from "./live-test-provider-drift.test-support.js";

const authError = '401 {"error":{"message":"The API key you provided is invalid."}}';
it("classifies provider account drift", () => {
  expect(
    isLiveBillingDrift(new Error("Your credit balance is too low to access the Anthropic API.")),
  ).toBe(true);
  expect(isLiveBillingDrift("billing has been disabled for this API key")).toBe(true);
  expect(isLiveBillingDrift("insufficient credit")).toBe(true);
  expect(isLiveAuthDrift(authError)).toBe(true);
  expect(isLiveAuthDrift("invalid x-api-key")).toBe(true);
});

it("classifies Anthropic 402 payloads without matching unrelated prose", () => {
  for (const sample of [
    "HTTP 402 Payment Required",
    "status: 402",
    "error code 402",
    '{"status":402,"type":"error"}',
    '{"code":402,"message":"payment required"}',
    '{"error":{"code":402,"message":"billing hard limit reached"}}',
    "got a 402 from the API",
    "returned 402",
    "received a 402 response",
  ]) {
    expect(isLiveBillingDrift(sample)).toBe(true);
  }
  for (const sample of [
    "Use a 402 stainless bolt",
    "Book a 402 room",
    "There is a 402 near me",
    "The building at 402 Main Street",
  ]) {
    expect(isLiveBillingDrift(sample)).toBe(false);
  }
});

it("classifies API-key rate-limit drift", () => {
  expect(isLiveRateLimitDrift("resource exhausted")).toBe(true);
});

it("classifies transient provider availability drift", () => {
  for (const sample of [
    "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
    "Error: <html><head><title>Service Unavailable</title></head><body>try again</body></html>",
    "Error: <html><head><title>500 Internal Server Error</title></head><body>try again</body></html>",
    "provider returned error: 502 Internal Server Error",
    "Service temporarily unavailable. The model is at capacity and currently cannot serve this request.",
    "Error Code unknown: Service temporarily unavailable. The model's availability is currently degraded.",
    "400 Error from provider (Console Go): Upstream request failed: Model is unavailable.",
  ]) {
    expect(isLiveProviderUnavailableDrift(sample), sample).toBe(true);
  }
});

it.each([
  [
    { error: authError, allowAuth: true },
    { reason: "auth", label: "auth drift" },
  ],
  [{ error: authError, allowBilling: true }, undefined],
  [
    {
      error:
        "Error Code unknown: Service temporarily unavailable. The model's availability is currently degraded.",
      allowProviderUnavailable: true,
    },
    { reason: "provider-unavailable", label: "provider unavailable" },
  ],
] as const)("returns only the enabled drift decision for %j", (options, expected) => {
  expect(shouldSkipLiveProviderDrift(options)).toEqual(expected);
});
