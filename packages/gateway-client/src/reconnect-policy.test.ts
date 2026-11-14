import { ConnectErrorDetailCodes } from "@openclaw/gateway-protocol/connect-error-details";
import { describe, expect, it } from "vitest";
import { shouldPauseGatewayReconnect } from "./reconnect-policy.js";

function shouldPause(details?: unknown): boolean {
  return shouldPauseGatewayReconnect({
    details,
    protocolMismatchIsTerminal: true,
  });
}

describe("shouldPauseGatewayReconnect", () => {
  it.each([
    ["access-record-inactive", true],
    ["profile-invalidated", true],
    ["grant-revoked", true],
    ["policy-check-failed", true],
    ["unknown-cause", true],
    ["policy-unavailable", false],
    ["plugin-lifetime-retired", false],
    ["policy-set-changed", false],
  ])("uses only the closed access cause %s for retry", (accessCause, pause) => {
    expect(shouldPause({ code: "OPERATOR_ACCESS_DENIED", accessCause, retryable: true })).toBe(
      pause,
    );
  });
  it.each([
    "AUTH_IDENTITY_HEADER_REQUIRED",
    "OPERATOR_ACCESS_DENIED",
    "CONTROL_UI_ORIGIN_NOT_ALLOWED",
    "AUTH_TOKEN_NOT_CONFIGURED",
    "AUTH_PASSWORD_NOT_CONFIGURED",
  ])("pauses reconnect for %s", (code) => {
    expect(shouldPause({ code })).toBe(true);
  });

  it("keeps reconnect active when pairing retry hints allow it", () => {
    expect(
      shouldPause({
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        reason: "not-paired",
        recommendedNextStep: "wait_then_retry",
        pauseReconnect: false,
      }),
    ).toBe(false);
  });

  it("leaves token mismatch to the caller's bounded retry policy", () => {
    expect(shouldPause({ code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH })).toBe(false);
  });

  it("keeps the identity-header pause behind a pending device-token retry", () => {
    expect(
      shouldPauseGatewayReconnect({
        details: { code: "AUTH_IDENTITY_HEADER_REQUIRED" },
        deviceTokenRetryPending: true,
      }),
    ).toBe(false);
  });

  it.each([{}, { code: "SOME_FUTURE_CODE" }, { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" }])(
    "keeps reconnect active for recoverable details",
    (details) => {
      expect(shouldPause(details)).toBe(false);
    },
  );
});
