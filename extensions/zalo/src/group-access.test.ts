import { describe, expect, it } from "vitest";
import { isZaloSenderAllowed } from "./group-access.js";

describe("zalo sender allowlist", () => {
  it("accepts direct sender id matches", () => {
    expect(isZaloSenderAllowed("12345", ["12345"])).toBe(true);
  });

  it("accepts prefixed allowlist entries", () => {
    expect(isZaloSenderAllowed("12345", ["zalo:12345", "zl:999"])).toBe(true);
  });

  it("rejects non-matching sender ids", () => {
    expect(isZaloSenderAllowed("12345", ["999", "zalo:abc"])).toBe(false);
  });
});
