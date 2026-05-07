import { describe, expect, it } from "vitest";
import { looksLikeQQBotTarget, normalizeTarget, parseTarget } from "./target-parser.js";

describe("qqbot target parser", () => {
  it("accepts provider-prefixed and channel-local target forms", () => {
    expect(parseTarget("qqbot:c2c:USER_OPENID")).toEqual({
      type: "c2c",
      id: "USER_OPENID",
    });
    expect(parseTarget("group:GROUP_OPENID")).toEqual({
      type: "group",
      id: "GROUP_OPENID",
    });
    expect(parseTarget("A2B91CCEA0E039905B45C84DD96C92FD")).toEqual({
      type: "c2c",
      id: "A2B91CCEA0E039905B45C84DD96C92FD",
    });
  });

  it("rejects repeated qqbot provider prefixes", () => {
    expect(() => parseTarget("qqbot:qqbot:c2c:USER_OPENID")).toThrow(
      /repeated qqbot: provider prefix/,
    );
    expect(normalizeTarget("qqbot:qqbot:c2c:USER_OPENID")).toBeUndefined();
    expect(looksLikeQQBotTarget("qqbot:qqbot:c2c:USER_OPENID")).toBe(false);
  });

  it("normalizes accepted inputs to one provider prefix", () => {
    expect(normalizeTarget("qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toBe(
      "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
    );
    expect(normalizeTarget("c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toBe(
      "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
    );
    expect(normalizeTarget("A2B91CCEA0E039905B45C84DD96C92FD")).toBe(
      "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
    );
  });
});
