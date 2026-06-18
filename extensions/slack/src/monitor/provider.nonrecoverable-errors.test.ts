// Slack tests cover non-recoverable provider errors.
import { describe, it, expect } from "vitest";
import { isNonRecoverableSlackSocketError } from "./reconnect-policy.js";

describe("isNonRecoverableSlackSocketError", () => {
  it.each([
    "An API error occurred: account_inactive",
    "An API error occurred: invalid_auth",
    "An API error occurred: token_revoked",
    "An API error occurred: token_expired",
    "An API error occurred: not_authed",
    "An API error occurred: org_login_required",
    "An API error occurred: team_access_not_granted",
    "An API error occurred: user_removed_from_team",
    "An API error occurred: team_disabled",
    "An API error occurred: missing_scope",
    "An API error occurred: cannot_find_service",
    "An API error occurred: invalid_token",
  ])("returns true for non-recoverable error: %s", (msg) => {
    expect(isNonRecoverableSlackSocketError(new Error(msg))).toBe(true);
  });

  it("returns true when error is a plain string", () => {
    expect(isNonRecoverableSlackSocketError("account_inactive")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isNonRecoverableSlackSocketError(new Error("ACCOUNT_INACTIVE"))).toBe(true);
    expect(isNonRecoverableSlackSocketError(new Error("Invalid_Auth"))).toBe(true);
  });

  it.each(["slack_webapi_request_error", "slack_webapi_http_error"])(
    "matches SDK non-recoverable start error code: %s",
    (code) => {
      expect(isNonRecoverableSlackSocketError({ code })).toBe(true);
    },
  );

  it("matches SDK error codes alongside structured details", () => {
    expect(
      isNonRecoverableSlackSocketError({
        code: "slack_webapi_http_error",
        statusCode: 503,
        statusMessage: "Service Unavailable",
      }),
    ).toBe(true);
  });

  it.each([
    "Connection timed out",
    "ECONNRESET",
    "Network request failed",
    "socket hang up",
    "ETIMEDOUT",
    "rate_limited",
  ])("returns false for recoverable/transient error: %s", (msg) => {
    expect(isNonRecoverableSlackSocketError(new Error(msg))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isNonRecoverableSlackSocketError(null)).toBe(false);
    expect(isNonRecoverableSlackSocketError(undefined)).toBe(false);
    expect(isNonRecoverableSlackSocketError(42)).toBe(false);
    expect(isNonRecoverableSlackSocketError({})).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isNonRecoverableSlackSocketError("")).toBe(false);
    expect(isNonRecoverableSlackSocketError(new Error(""))).toBe(false);
  });
});
