import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";

describe("resolveAuthProfileFailureReason", () => {
  it("records shared non-timeout provider failures", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "billing",
        policy: "shared",
      }),
    ).toBe("billing");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "rate_limit",
        policy: "shared",
      }),
    ).toBe("rate_limit");
  });

  it("does not record local helper failures in shared auth state", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "billing",
        policy: "local",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "auth",
        policy: "local",
      }),
    ).toBeNull();
  });

  it("does not persist transport timeouts as auth-profile health", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
      }),
    ).toBeNull();
  });

  it("does not persist session-local format failures as auth-profile health", () => {
    // `format` failures come from request-shape problems (malformed transcript,
    // empty messages array, schema mismatch). They are session-local and must
    // not put the shared provider profile into cooldown — unrelated sessions
    // would be skipped from the profile (#76829).
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "format",
        policy: "shared",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "format",
      }),
    ).toBeNull();
  });

  it("still records non-format provider failures so genuine profile cooldown is preserved", () => {
    // Sanity: the format carve-out must not affect auth/billing/rate-limit reporting.
    for (const reason of [
      "auth",
      "auth_permanent",
      "billing",
      "rate_limit",
      "overloaded",
      "model_not_found",
    ] as const) {
      expect(
        resolveAuthProfileFailureReason({
          failoverReason: reason,
          policy: "shared",
        }),
      ).toBe(reason);
    }
  });
});
