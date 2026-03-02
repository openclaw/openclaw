import { describe, expect, it } from "vitest";
import {
  UserbotError,
  UserbotFloodError,
  UserbotAuthError,
  UserbotPeerError,
  UserbotDisconnectedError,
  wrapGramJSError,
} from "./errors.js";

describe("UserbotError", () => {
  it("creates a base error with all fields", () => {
    const err = new UserbotError("Something went wrong", "RPC_ERROR");
    expect(err.code).toBe("RPC_ERROR");
    expect(err.message).toBe("Something went wrong");
    expect(err.retryAfter).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts retryAfter", () => {
    const err = new UserbotError("wait", "FLOOD_WAIT", 30);
    expect(err.retryAfter).toBe(30);
  });
});

describe("UserbotFloodError", () => {
  it("sets retryAfter from seconds", () => {
    const err = new UserbotFloodError(30);
    expect(err.code).toBe("FLOOD_WAIT");
    expect(err.retryAfter).toBe(30);
    expect(err.message).toBe("Flood wait: retry after 30s");
    expect(err.name).toBe("UserbotFloodError");
    expect(err).toBeInstanceOf(UserbotError);
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new UserbotFloodError(10, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("UserbotAuthError", () => {
  it("wraps auth error message", () => {
    const err = new UserbotAuthError("AUTH_KEY_DUPLICATED");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.message).toBe("Auth error: AUTH_KEY_DUPLICATED");
    expect(err).toBeInstanceOf(UserbotError);
  });
});

describe("UserbotPeerError", () => {
  it("wraps peer resolution failure with string input", () => {
    const err = new UserbotPeerError("@nonexistent");
    expect(err.code).toBe("PEER_NOT_FOUND");
    expect(err.message).toContain("@nonexistent");
    expect(err).toBeInstanceOf(UserbotError);
  });

  it("handles numeric peer input", () => {
    const err = new UserbotPeerError(12345);
    expect(err.message).toContain("12345");
  });

  it("handles bigint peer input", () => {
    const err = new UserbotPeerError(BigInt("9999999999999"));
    expect(err.message).toContain("9999999999999");
  });
});

describe("UserbotDisconnectedError", () => {
  it("creates disconnected error with message", () => {
    const err = new UserbotDisconnectedError("Client is not connected");
    expect(err.code).toBe("DISCONNECTED");
    expect(err.message).toBe("Client is not connected");
    expect(err).toBeInstanceOf(UserbotError);
  });

  it("uses default message when omitted", () => {
    const err = new UserbotDisconnectedError();
    expect(err.message).toBe("Client is disconnected");
  });
});

describe("wrapGramJSError", () => {
  it("returns UserbotError instances unchanged", () => {
    const original = new UserbotFloodError(10);
    expect(wrapGramJSError(original)).toBe(original);
  });

  it("wraps FloodWaitError (duck-typed) into UserbotFloodError", () => {
    // Simulate GramJS FloodWaitError via duck-typing
    class FloodWaitError extends Error {
      seconds = 42;
      constructor() {
        super("FLOOD_WAIT_42");
      }
    }
    const err = new FloodWaitError();
    const wrapped = wrapGramJSError(err);
    expect(wrapped).toBeInstanceOf(UserbotFloodError);
    expect(wrapped.retryAfter).toBe(42);
    expect(wrapped.cause).toBe(err);
  });

  it("wraps AuthKeyError (duck-typed) into UserbotAuthError", () => {
    class AuthKeyError extends Error {
      constructor() {
        super("AUTH_KEY_DUPLICATED");
      }
    }
    const err = new AuthKeyError();
    const wrapped = wrapGramJSError(err);
    expect(wrapped).toBeInstanceOf(UserbotAuthError);
    expect(wrapped.cause).toBe(err);
  });

  it("wraps generic Error as UNKNOWN_ERROR", () => {
    const genericErr = new Error("network failure");
    const wrapped = wrapGramJSError(genericErr);
    expect(wrapped).toBeInstanceOf(UserbotError);
    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("network failure");
  });

  it("wraps non-Error values", () => {
    const wrapped = wrapGramJSError("string error");
    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("string error");
  });

  it("wraps null/undefined", () => {
    const wrapped = wrapGramJSError(null);
    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("null");
  });

  it("detects AUTH-related RPC errors via message content", () => {
    const err = new Error("SESSION_REVOKED");
    Object.defineProperty(err, "constructor", {
      value: { name: "RPCError" },
      writable: false,
    });
    // Falls through to message-based detection
    const wrapped = wrapGramJSError(err);
    expect(wrapped).toBeInstanceOf(UserbotAuthError);
  });
});
