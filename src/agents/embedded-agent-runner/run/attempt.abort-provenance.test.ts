import { describe, expect, it } from "vitest";
import { isNonUserAbortReason, shouldSuppressTakeoverErrorOnUserAbort } from "./attempt.js";
import { EmbeddedAttemptSessionTakeoverError } from "./attempt.session-lock.js";

describe("isNonUserAbortReason", () => {
  it("returns true for TimeoutError", () => {
    const err = new Error("chat run timed out");
    err.name = "TimeoutError";
    expect(isNonUserAbortReason(err)).toBe(true);
  });

  it("returns true for restart AbortError", () => {
    const err = new Error("chat run aborted for gateway restart");
    err.name = "AbortError";
    expect(isNonUserAbortReason(err)).toBe(true);
  });

  it("returns true for auth-revoked AbortError", () => {
    const err = new Error("chat run aborted for provider auth revocation");
    err.name = "AbortError";
    expect(isNonUserAbortReason(err)).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isNonUserAbortReason(undefined)).toBe(false);
  });

  it("returns false for plain AbortError without restart/auth-revoked message", () => {
    const err = new Error("user pressed stop");
    err.name = "AbortError";
    expect(isNonUserAbortReason(err)).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isNonUserAbortReason(new Error("something"))).toBe(false);
  });
});

describe("shouldSuppressTakeoverErrorOnUserAbort", () => {
  it("returns true when userInitiatedAbort and cleanupError is takeover error", () => {
    expect(
      shouldSuppressTakeoverErrorOnUserAbort({
        cleanupError: new EmbeddedAttemptSessionTakeoverError("/tmp/session.jsonl"),
        userInitiatedAbort: true,
      }),
    ).toBe(true);
  });

  it("returns false when not userInitiatedAbort", () => {
    expect(
      shouldSuppressTakeoverErrorOnUserAbort({
        cleanupError: new EmbeddedAttemptSessionTakeoverError("/tmp/session.jsonl"),
        userInitiatedAbort: false,
      }),
    ).toBe(false);
  });

  it("returns false when cleanupError is not takeover error", () => {
    expect(
      shouldSuppressTakeoverErrorOnUserAbort({
        cleanupError: new Error("other error"),
        userInitiatedAbort: true,
      }),
    ).toBe(false);
  });
});
