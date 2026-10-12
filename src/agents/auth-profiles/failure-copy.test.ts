import { describe, expect, it } from "vitest";

const LOGIN_HINT_SENTINEL = "<<login-hint-for-provider>>";

import { FAILOVER_REASONS, type FailoverReason } from "../failover/signal.js";
import { renderAuthProfileFailoverCopy } from "../failover/user-copy.js";

const formatAuthProfileFailureMessage = (
  params: Parameters<typeof renderAuthProfileFailoverCopy>[0],
) =>
  renderAuthProfileFailoverCopy({
    ...params,
    recoveryHint: `${LOGIN_HINT_SENTINEL}:${params.provider}`,
  });

const PROVIDER = "openai-codex";

const RECOVERY_BY_REASON = {
  auth: true,
  auth_permanent: true,
  format: false,
  rate_limit: false,
  overloaded: false,
  billing: true,
  server_error: false,
  timeout: false,
  tls_certificate: false,
  context_overflow: true,
  model_not_found: false,
  session_expired: true,
  empty_response: true,
  no_error_details: true,
  unclassified: true,
  unknown: true,
} satisfies Record<FailoverReason, boolean>;

describe("renderAuthProfileFailoverCopy", () => {
  describe("recovery-hint dispatch", () => {
    it("dispatches the login command for every failover reason", () => {
      for (const reason of FAILOVER_REASONS) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message.includes(LOGIN_HINT_SENTINEL), `reason=${reason}`).toBe(
          RECOVERY_BY_REASON[reason],
        );
      }
    });
  });

  describe("reason coverage", () => {
    it("always mentions the provider name", () => {
      for (const reason of FAILOVER_REASONS) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message, `reason=${reason}`).toContain(PROVIDER);
      }
    });
  });

  it("keeps recovery actionable for an unknown failure", () => {
    const message = formatAuthProfileFailureMessage({
      reason: "unknown",
      provider: PROVIDER,
      allInCooldown: false,
    });
    expect(message).toContain(PROVIDER);
    expect(message).toContain(LOGIN_HINT_SENTINEL);
  });
});
