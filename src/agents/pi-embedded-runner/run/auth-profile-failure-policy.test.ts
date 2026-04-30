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

  it("does not punish profile for client-side / non-auth failure reasons", () => {
    // Regression: a single Anthropic 400 "assistant message prefill" 400 from
    // one model used to mark the only github-copilot profile failed, cascading
    // into "all profiles unavailable" across every fallback model.
    for (const reason of ["format", "overloaded", "model_not_found", "unknown"] as const) {
      expect(
        resolveAuthProfileFailureReason({
          failoverReason: reason,
          policy: "shared",
        }),
      ).toBeNull();
    }
  });

  it("records genuine auth-health signals", () => {
    for (const reason of ["auth", "auth_permanent", "session_expired"] as const) {
      expect(
        resolveAuthProfileFailureReason({
          failoverReason: reason,
          policy: "shared",
        }),
      ).toBe(reason);
    }
  });
});
