import { describe, expect, it } from "vitest";
import {
  classifyRateLimitWindow,
  hasOrganizationTpmRateLimitEvidence,
  resolveRetryAfterMs,
} from "./retry-evidence.js";

const NOW_MS = Date.parse("2015-10-21T07:27:00.000Z");
const MULTIPLE_FLOORS =
  "Retry-After: 0.5 seconds; please try again in 1.25 SECS, then continue.\nRetry after in 1s";
const expectDelay = (message: string, expected: number | undefined, errorBody?: unknown) =>
  expect(resolveRetryAfterMs(message, NOW_MS, errorBody)).toBe(expected);
const tpm = "429 Rate limit reached for gpt in organization org-synthetic on tokens per min (TPM)";
const retryInfo = (retryDelay: string, type = "RetryInfo") => ({
  error: { details: [{ retryDelay, "@type": `type.googleapis.com/google.rpc.${type}` }] },
});

describe("resolveRetryAfterMs", () => {
  it.each<[string, number | undefined, unknown?]>([
    ["Retry-After: 1.25 seconds", 1250],
    ["Retry-After: 0.5 days", 43_200_000],
    ["Retry-After: 0.01ms", 1],
    ["Retry-After: 0s", 0],
    ["Retry-After: iNfInItY milliseconds", Infinity],
    [`Retry-After: ${"9".repeat(400)} days`, Infinity],
    [`Retry-After: ${"0".repeat(101)}2s`, 2000],
    ["Retry-After: 9007199254741 seconds", 9_007_199_254_741_000],
    ["Retry-After: Wed, 21 Oct 2015 07:28:00 GMT", 60_000],
    ["Retry-After: Wed, 21 Oct 2015 07:26:00 GMT", 0],
    ["Retry-After: 1 constructor", undefined],
    [MULTIPLE_FLOORS, 1250],
    [MULTIPLE_FLOORS, 2501, { headers: { "retry-after": "2", "retry-after-ms": "2500.5" } }],
    [MULTIPLE_FLOORS, 1250, JSON.stringify({ headers: { "retry-after": "1" } })],
  ])("resolves the provider floor from %s", (message, expected, errorBody) => {
    expectDelay(message, expected, errorBody);
    if (expected === Infinity) {
      expect(classifyRateLimitWindow(message, NOW_MS)).toEqual({ kind: "long" });
    }
  });

  it("reads Google RetryInfo delays from projected Gemini errors", () => {
    const body = (retryDelay: string) =>
      `429: ${JSON.stringify({
        error: {
          message: "You exceeded your current quota. Please retry in 32.578767138s.",
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
            ...retryInfo(retryDelay).error.details,
          ],
        },
      })}`;
    expectDelay(body("32s"), 32_579);
    expectDelay(body("40.5s"), 40_500);
    expect(classifyRateLimitWindow(body("3600s"), NOW_MS)).toEqual({ kind: "long" });
    expectDelay(body("soon"), 32_579);
    expectDelay("429 RESOURCE_EXHAUSTED: retry in 4.5s", 4_500);
    expectDelay("429 RESOURCE_EXHAUSTED: please retry soon", undefined);
  });

  it("reads RetryInfo in any key order from a structured error body", () => {
    expectDelay("429 RESOURCE_EXHAUSTED", 12_000, retryInfo("12s"));
    expectDelay("429 RESOURCE_EXHAUSTED", undefined, retryInfo("12s", "Help"));
  });

  it("applies an exhausted-bucket reset only when the provider gave no explicit time", () => {
    const exhausted = {
      status: 429,
      headers: { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "5m" },
    };
    expectDelay(`${tpm}. Please try again in 6s.`, 6_000, exhausted);
    expectDelay(tpm, 300_000, exhausted);
    expectDelay(`${tpm}. Please try again in 6s.`, 9_000, {
      ...exhausted,
      headers: { ...exhausted.headers, "retry-after": "9" },
    });
  });
});

describe("classifyRateLimitWindow", () => {
  it.each([
    ["请求过于频繁，请稍后重试", "short"],
    ["上下文长度上限为 128k tokens", "unknown"],
  ])("keeps transient throttles and context caps out of long windows: %s", (message, kind) =>
    expect(classifyRateLimitWindow(message, NOW_MS)).toEqual({ kind }),
  );

  it.each([
    [`${tpm}. Please try again in 1s.`, true],
    [`${tpm.replace("tokens per min (TPM)", "requests per min (RPM)")}.`, false],
    [`${tpm.replace("Rate limit reached", "Request too large")}.`, false],
    [
      `${tpm.replace("tokens per min (TPM)", "requests per minute (RPM)")}: Limit 30, Used 30, Requested 100. Please try again in 2s. See the tokens per minute (TPM) guidance for details.`,
      false,
    ],
    ["429 Rate limit reached on tokens per minute (TPM).", false],
  ])("distinguishes exhausted organization TPM from request throttles: %s", (message, expected) =>
    expect(hasOrganizationTpmRateLimitEvidence(message)).toBe(expected),
  );

  it.each([
    ["Try again in 0.5 minutes", { kind: "short", retryAfterSeconds: 30 }],
    ["Retry-After: 60000ms", { kind: "short", retryAfterSeconds: 60 }],
    ["Retry-After: 60001ms", { kind: "long" }],
  ])("compares converted durations against the one-minute limit: %s", (message, expected) =>
    expect(classifyRateLimitWindow(`429 ${message}`, NOW_MS)).toEqual(expected),
  );
});
