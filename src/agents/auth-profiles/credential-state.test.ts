import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  evaluateStoredCredentialEligibility,
  hasUsableOAuthCredential,
  resolveTokenExpiryState,
} from "./credential-state.js";

describe("resolveTokenExpiryState", () => {
  const now = 1_700_000_000_000;

  it("returns expired when expires is in the past", () => {
    expect(resolveTokenExpiryState(now - 1, now)).toBe("expired");
  });

  it("returns valid when expires is in the future", () => {
    expect(resolveTokenExpiryState(now + 1, now)).toBe("valid");
  });
});

describe("hasUsableOAuthCredential", () => {
  const now = 1_700_000_000_000;

  it("treats near-expiry oauth credentials as no longer usable", () => {
    expect(
      hasUsableOAuthCredential(
        {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: now + DEFAULT_OAUTH_REFRESH_MARGIN_MS - 1,
        },
        { now },
      ),
    ).toBe(false);
  });
});

describe("evaluateStoredCredentialEligibility", () => {
  const now = 1_700_000_000_000;

  it.each([
    "openclaw onboard --non-interactive --auth-choice=zai-coding-global --zai-api-key $ZAI_API_KEY",
  ])("marks pasted OpenClaw onboarding command %p as a malformed api key", (key) => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "api_key",
        provider: "zai",
        key,
      },
      now,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "malformed_api_key" });
  });

  it("marks tokenRef with missing expires as eligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "token",
        provider: "github-copilot",
        tokenRef: {
          source: "env",
          provider: "default",
          id: "GITHUB_TOKEN",
        },
      },
      now,
    });
    expect(result).toEqual({ eligible: true, reasonCode: "ok" });
  });

  it("marks token with invalid expires as ineligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "token",
        provider: "github-copilot",
        token: "tok",
        expires: 0,
      },
      now,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "invalid_expires" });
  });

  it("marks oauth without inline credential material as ineligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "oauth",
        provider: "openai",
        access: "",
        refresh: "",
        expires: now + 60_000,
      },
      now,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "missing_credential" });
  });
});
