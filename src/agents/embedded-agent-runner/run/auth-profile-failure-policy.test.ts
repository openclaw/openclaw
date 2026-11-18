// Coverage for deciding which failover reasons affect auth profile health.
import { describe, expect, it } from "vitest";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";

describe("resolveAuthProfileFailureReason", () => {
  it.each(["route_unavailable", "server_error"] as const)(
    "keeps %s out of shared credential health",
    (failoverReason) => {
      expect(resolveAuthProfileFailureReason({ failoverReason, providerStarted: true })).toBeNull();
    },
  );

  it.each([
    ["rate_limit", undefined, "rate_limit"],
    ["rate_limit", true, null],
    ["overloaded", undefined, null],
    ["auth", undefined, "auth"],
    ["billing", undefined, "billing"],
  ] as const)(
    "classifies local-transient %s (transient=%s)",
    (failoverReason, transientRateLimit, expected) => {
      expect(
        resolveAuthProfileFailureReason({
          failoverReason,
          policy: "local_transient",
          transientRateLimit,
        }),
      ).toBe(expected);
    },
  );

  // Only a provider-started timeout is evidence about credential health.
  it.each([
    [undefined, null],
    [false, null],
    [true, "timeout"],
  ] as const)("classifies timeout with providerStarted=%s", (providerStarted, expected) => {
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: "timeout",
        providerStarted,
      }),
    ).toBe(expected);
  });
});
