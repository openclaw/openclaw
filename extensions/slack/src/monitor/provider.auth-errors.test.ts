import { expect, it } from "vitest";
import { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

it("does not treat missing or non-error values as permanent auth failures", () => {
  expect(isNonRecoverableSlackAuthError(null)).toBe(false);
  expect(isNonRecoverableSlackAuthError(undefined)).toBe(false);
  expect(isNonRecoverableSlackAuthError(42)).toBe(false);
  expect(isNonRecoverableSlackAuthError({})).toBe(false);
});
