import { expect, it } from "vitest";
import { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

it.each([
  "account_inactive",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "not_authed",
  "org_login_required",
  "team_access_not_granted",
  "user_removed_from_team",
  "team_disabled",
  "missing_scope",
  "cannot_find_service",
  "invalid_token",
])("recognizes permanent Slack credential failure %s", (code) => {
  expect(isNonRecoverableSlackAuthError(new Error(`An API error occurred: ${code}`))).toBe(true);
});

it("does not treat missing or non-error values as permanent auth failures", () => {
  expect(isNonRecoverableSlackAuthError(null)).toBe(false);
  expect(isNonRecoverableSlackAuthError(undefined)).toBe(false);
  expect(isNonRecoverableSlackAuthError(42)).toBe(false);
  expect(isNonRecoverableSlackAuthError({})).toBe(false);
});
