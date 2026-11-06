import { describe, expect, it } from "vitest";
import { FAILOVER_REASONS } from "./signal.js";

describe("FAILOVER_REASONS", () => {
  it("freezes every persisted and wire-visible reason code", () => {
    expect(FAILOVER_REASONS).toEqual([
      "auth",
      "auth_permanent",
      "session_authority",
      "format",
      "rate_limit",
      "overloaded",
      "billing",
      "server_error",
      "route_unavailable",
      "timeout",
      "tls_certificate",
      "context_overflow",
      "model_not_found",
      "session_expired",
      "empty_response",
      "no_error_details",
      "unclassified",
      "unknown",
    ]);
  });
});
