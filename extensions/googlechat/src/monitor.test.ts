import { describe, expect, it } from "vitest";
import { isSenderAllowed } from "./monitor.js";

describe("isSenderAllowed", () => {
  it("matches raw email entries only when dangerous name matching is enabled", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(false);
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"], true)).toBe(true);
  });

  it("does not treat users/<email> entries as email allowlist (deprecated form)", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"])).toBe(
      false,
    );
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching raw email entries", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["other@example.com"], true)).toBe(
      false,
    );
  });

  it("matches domain pattern entries (e.g. @example.com)", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["@example.com"])).toBe(true);
    expect(isSenderAllowed("users/123", "Jane@Example.COM", ["@example.com"])).toBe(true);
  });

  it("rejects non-matching domain patterns", () => {
    expect(isSenderAllowed("users/123", "jane@other.com", ["@example.com"])).toBe(false);
  });

  it("rejects domain pattern when sender has no email", () => {
    expect(isSenderAllowed("users/123", undefined, ["@example.com"])).toBe(false);
  });
});
