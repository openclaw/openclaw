import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { getSoonestCooldownExpiry } from "./auth-profiles/usage-state.js";

const now = 1_700_000_000_000;
function expiry(usageStats: AuthProfileStore["usageStats"], forModel?: string) {
  return getSoonestCooldownExpiry(
    { version: 1, profiles: {}, usageStats },
    ["missing", ...Object.keys(usageStats ?? {})],
    { now, forModel },
  );
}

describe("getSoonestCooldownExpiry", () => {
  it("selects the earliest valid unusable timestamp, including expired windows", () => {
    expect(
      expiry({
        invalid: { cooldownUntil: -1 },
        infinite: { cooldownUntil: Infinity },
        nan: { disabledUntil: Number.NaN },
        later: { cooldownUntil: now + 2_000, disabledUntil: now + 4_000 },
        expired: { cooldownUntil: now - 1_000 },
        disabled: { disabledUntil: now + 1_000 },
      }),
    ).toBe(now - 1_000);
  });

  it("waits for the latest matching model rate limit", () => {
    expect(
      expiry(
        {
          first: {
            cooldownUntil: now + 10_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model",
          },
          last: {
            cooldownUntil: now + 30_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model",
          },
        },
        "model",
      ),
    ).toBe(now + 30_000);
  });

  it("uses the earliest non-rate-limit cooldown for the requested model", () => {
    expect(
      expiry(
        {
          timeout: {
            cooldownUntil: now + 10_000,
            cooldownReason: "timeout",
            cooldownModel: "model",
          },
          missingModel: {
            cooldownUntil: now + 30_000,
            cooldownReason: "model_not_found",
            cooldownModel: "model",
          },
        },
        "model",
      ),
    ).toBe(now + 10_000);
  });

  it("honors profile-wide blocks and disables alongside model cooldowns", () => {
    expect(
      expiry(
        {
          disabled: {
            disabledUntil: now + 20_000,
            cooldownUntil: now + 10_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model",
          },
          blocked: {
            blockedUntil: now + 25_000,
            blockedReason: "subscription_limit",
            cooldownUntil: now + 10_000,
            cooldownReason: "timeout",
            cooldownModel: "model",
          },
          rateLimit: {
            cooldownUntil: now + 30_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model",
          },
        },
        "model",
      ),
    ).toBe(now + 20_000);
  });
});
