import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isProviderRequestSizeCeilingError,
} from "./classify.js";

// Groq states both numbers in the refusal, so the two shapes are separable by wording alone.
const GROQ_OVERSIZED_REQUEST_413 =
  "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
  "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
  "please reduce your message size and try again.";
describe("isProviderRequestSizeCeilingError", () => {
  it("does not read an RPM pair when TPM is only mentioned elsewhere", () => {
    // Groq states the throttled unit in the same clause as its figures. A message whose only
    // stated pair is denominated in requests, with TPM named somewhere else, would otherwise
    // compare a request count against a token budget and end a session waiting would clear.
    expect(
      isProviderRequestSizeCeilingError(
        "429 Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on " +
          "requests per minute (RPM): Limit 30, Used 30, Requested 100, please try again in 2s. " +
          "See the tokens per minute (TPM) guidance for details.",
      ),
    ).toBe(false);
  });

  it("reads the token pair when a request count is stated first", () => {
    // Both units appear with figures; only the token-denominated pair may decide the ceiling.
    expect(
      isProviderRequestSizeCeilingError(
        "429 Rate limit reached on requests per minute (RPM): Limit 30, Requested 1. " +
          "Also on tokens per minute (TPM): Limit 8000, Requested 8098.",
      ),
    ).toBe(true);
  });

  it.each([["no message", undefined]])("returns false for %s", (_name, message) => {
    expect(isProviderRequestSizeCeilingError(message)).toBe(false);
  });
});

describe("provider request-size ceilings worded as TPM limits", () => {
  it("treats a request larger than the whole token limit as overflow", () => {
    expect(isContextOverflowError(GROQ_OVERSIZED_REQUEST_413)).toBe(true);
    expect(isLikelyContextOverflowError(GROQ_OVERSIZED_REQUEST_413)).toBe(true);
    expect(classifyFailoverReason(GROQ_OVERSIZED_REQUEST_413)).toBe("context_overflow");
  });

  it.each([["states neither size", "413 request too large: 203557 tokens per minute (TPM)"]])(
    "keeps a TPM refusal that %s a rate limit",
    (_name, message) => {
      expect(isContextOverflowError(message)).toBe(false);
      expect(isLikelyContextOverflowError(message)).toBe(false);
      expect(classifyFailoverReason(message)).toBe("rate_limit");
    },
  );
});
