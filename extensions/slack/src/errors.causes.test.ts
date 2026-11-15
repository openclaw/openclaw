import { describe, expect, it } from "vitest";
import { formatSlackError } from "./errors.js";

describe("Slack error cause traversal", () => {
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

  it("does not retain visited errors between independent formatting calls", () => {
    const shared = Object.assign(new Error("shared cause"), { statusCode: 503 });
    const first = Object.assign(new Error("first", { cause: shared }), { code: "http_error" });
    const second = new Error("second", { cause: shared });
    expect(formatSlackError(first)).toBe(
      "first; cause: shared cause; statusCode: 503; code: http_error",
    );
    expect(formatSlackError(second)).toBe("second; cause: shared cause; statusCode: 503");
    expect(formatSlackError(first)).toBe(
      "first; cause: shared cause; statusCode: 503; code: http_error",
    );
  });

  it("preserves primitive causes and empty fallback behavior", () => {
    expect(formatSlackError(new Error("outer", { cause: 0 }))).toBe("outer; cause: 0");
    expect(formatSlackError(new Error("outer", { cause: "" }))).toBe("outer");
    expect(formatSlackError(undefined, "fallback")).toBe("fallback");
  });

  it("still redacts sensitive strings inside a cyclic cause chain", () => {
    const token = ["xoxb", "1234567890abcdef"].join("-");
    const outer = Object.assign(new Error("request failed"), { code: "transport_error" });
    const inner = new Error(`Authorization: Bearer ${token}`, { cause: outer });
    outer.cause = inner;
    const formatted = formatSlackError(outer);
    expect(formatted).not.toContain(token);
    expect(formatted).toContain("xoxb-1…cdef");
    expect(formatted).toContain("[Circular]");
    expect(formatted).toBe(
      "request failed; cause: Authorization: Bearer xoxb-1…cdef; cause: [Circular]; code: transport_error",
    );
  });
});
