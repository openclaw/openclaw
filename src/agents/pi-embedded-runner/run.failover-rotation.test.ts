import { describe, expect, it } from "vitest";
import {
  shouldRotateAuthProfileOnAssistantFailover,
  shouldRotateAuthProfileOnPromptFailover,
} from "./run.js";

describe("auth profile rotation failover guards", () => {
  it("skips prompt profile rotation on rate limits when a fallback model is configured", () => {
    expect(
      shouldRotateAuthProfileOnPromptFailover({
        promptFailoverFailure: true,
        promptFailoverReason: "rate_limit",
        fallbackConfigured: true,
      }),
    ).toBe(false);
  });

  it("still rotates prompt profiles on rate limits when no fallback model is configured", () => {
    expect(
      shouldRotateAuthProfileOnPromptFailover({
        promptFailoverFailure: true,
        promptFailoverReason: "rate_limit",
        fallbackConfigured: false,
      }),
    ).toBe(true);
  });

  it("still rotates prompt profiles for non-timeout transient failures", () => {
    expect(
      shouldRotateAuthProfileOnPromptFailover({
        promptFailoverFailure: true,
        promptFailoverReason: "overloaded",
        fallbackConfigured: true,
      }),
    ).toBe(true);
  });

  it("does not rotate prompt profiles for timeouts", () => {
    expect(
      shouldRotateAuthProfileOnPromptFailover({
        promptFailoverFailure: true,
        promptFailoverReason: "timeout",
        fallbackConfigured: false,
      }),
    ).toBe(false);
  });

  it("skips assistant profile rotation on rate limits when a fallback model is configured", () => {
    expect(
      shouldRotateAuthProfileOnAssistantFailover({
        assistantFailoverReason: "rate_limit",
        fallbackConfigured: true,
      }),
    ).toBe(false);
  });

  it("still rotates assistant profiles on rate limits when no fallback model is configured", () => {
    expect(
      shouldRotateAuthProfileOnAssistantFailover({
        assistantFailoverReason: "rate_limit",
        fallbackConfigured: false,
      }),
    ).toBe(true);
  });

  it("still rotates assistant profiles for non-rate-limit failover reasons", () => {
    expect(
      shouldRotateAuthProfileOnAssistantFailover({
        assistantFailoverReason: "overloaded",
        fallbackConfigured: true,
      }),
    ).toBe(true);
  });
});
