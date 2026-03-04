import { describe, expect, it } from "vitest";
import {
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./credential-state.js";

describe("resolveTokenExpiryState", () => {
  const now = 1_700_000_000_000;

  it("treats undefined as missing", () => {
    expect(resolveTokenExpiryState(undefined, now)).toBe("missing");
  });

  it("treats non-finite and non-positive values as invalid_expires", () => {
    expect(resolveTokenExpiryState(0, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(-1, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(Number.NaN, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(Number.POSITIVE_INFINITY, now)).toBe("invalid_expires");
  });

  it("returns expired when expires is in the past", () => {
    expect(resolveTokenExpiryState(now - 1, now)).toBe("expired");
  });

  it("returns valid when expires is in the future", () => {
    expect(resolveTokenExpiryState(now + 1, now)).toBe("valid");
  });
});

describe("evaluateStoredCredentialEligibility", () => {
  const now = 1_700_000_000_000;

  it("marks api_key with keyRef as eligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "api_key",
        provider: "anthropic",
        keyRef: {
          source: "env",
          provider: "default",
          id: "ANTHROPIC_API_KEY",
        },
      },
      now,
    });
    expect(result).toEqual({ eligible: true, reasonCode: "ok" });
  });

  it("marks api_key with legacy apiKey field as eligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        type: "api_key",
        provider: "anthropic",
        apiKey: "sk-anthropic-legacy",
      },
      now,
    });
    expect(result).toEqual({ eligible: true, reasonCode: "ok" });
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
});
