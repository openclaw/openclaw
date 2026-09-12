import { describe, expect, it } from "vitest";
import { formatSlackError } from "./errors.js";

describe("Slack error cause traversal", () => {
  it("terminates a self-referencing Error cause", () => {
    const error = new Error("request failed");
    error.cause = error;
    expect(formatSlackError(error)).toBe("request failed; cause: [Circular]");
  });

  it("terminates a multi-error cycle without losing outer metadata", () => {
    const outer = Object.assign(new Error("request failed"), { code: "transport_error" });
    const inner = new Error("socket failed", { cause: outer });
    outer.cause = inner;
    expect(formatSlackError(outer)).toBe(
      "request failed; cause: socket failed; cause: [Circular]; code: transport_error",
    );
  });

  it("bounds a deeply nested acyclic cause chain", () => {
    let error = new Error("leaf");
    for (let index = 0; index < 10_000; index += 1) {
      error = new Error("wrapper", { cause: error });
    }
    const formatted = formatSlackError(error);
    expect(formatted).toContain("[Cause chain truncated]");
    expect(formatted.match(/wrapper/gu)).toHaveLength(32);
    expect(formatted).not.toContain("leaf");
  });

  it("preserves a short acyclic chain and structured metadata ordering", () => {
    const inner = Object.assign(new Error("upstream"), { statusCode: 503 });
    const outer = Object.assign(new Error("request", { cause: inner }), { code: "http_error" });
    expect(formatSlackError(outer)).toBe(
      "request; cause: upstream; statusCode: 503; code: http_error",
    );
  });

  it("does not retain visited errors between independent formatting calls", () => {
    const shared = new Error("shared cause");
    const first = new Error("first", { cause: shared });
    const second = new Error("second", { cause: shared });
    expect(formatSlackError(first)).toBe("first; cause: shared cause");
    expect(formatSlackError(second)).toBe("second; cause: shared cause");
    expect(formatSlackError(first)).toBe("first; cause: shared cause");
  });

  it("preserves circular plain-object serialization at a cause leaf", () => {
    const cause: Record<string, unknown> = {};
    cause.self = cause;
    expect(formatSlackError(new Error("outer", { cause }))).toBe(
      'outer; cause: {"self":"[Circular]"}',
    );
  });

  it("preserves primitive causes and empty fallback behavior", () => {
    expect(formatSlackError(new Error("outer", { cause: 0 }))).toBe("outer; cause: 0");
    expect(formatSlackError(new Error("outer", { cause: "" }))).toBe("outer");
    expect(formatSlackError(undefined, "fallback")).toBe("fallback");
  });

  it("still redacts sensitive strings inside a cyclic cause chain", () => {
    const token = ["xoxb", "1234567890abcdef"].join("-");
    const outer = new Error("request failed");
    const inner = new Error(`Authorization: Bearer ${token}`, { cause: outer });
    outer.cause = inner;
    const formatted = formatSlackError(outer);
    expect(formatted).not.toContain(token);
    expect(formatted).toContain("xoxb-1…cdef");
    expect(formatted).toContain("[Circular]");
  });
});
