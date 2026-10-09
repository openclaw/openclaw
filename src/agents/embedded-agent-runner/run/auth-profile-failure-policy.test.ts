// Coverage for deciding which failover reasons affect auth profile health.
import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";

describe("resolveAuthProfileFailureReason", () => {
  it("keeps only transient local failures out of shared auth state", () => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "rate_limit",
        policy: "local_transient",
      }),
    ).toBe("rate_limit");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "rate_limit",
        policy: "local_transient",
        transientRateLimit: true,
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "overloaded",
        policy: "local_transient",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "auth",
        policy: "local_transient",
      }),
    ).toBe("auth");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "billing",
        policy: "local_transient",
      }),
    ).toBe("billing");
  });

  it("only persists timeouts when the provider request started", () => {
    // Pre-provider timeout says nothing about credential health; started
    // provider timeouts can cool down the active profile.
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
        providerStarted: false,
      }),
    ).toBeNull();
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
        providerStarted: true,
      }),
    ).toBe("timeout");
  });
});
