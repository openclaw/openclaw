import { describe, expect, it } from "vitest";
import { looksLikeQQBotTarget, normalizeTarget, parseTarget } from "./target-parser.js";

describe("parseTarget", () => {
  it("parses lowercase type prefixes", () => {
    expect(parseTarget("qqbot:c2c:user-openid")).toEqual({ type: "c2c", id: "user-openid" });
    expect(parseTarget("qqbot:group:group-openid")).toEqual({ type: "group", id: "group-openid" });
    expect(parseTarget("qqbot:channel:chan-1")).toEqual({ type: "channel", id: "chan-1" });
    expect(parseTarget("group:group-openid")).toEqual({ type: "group", id: "group-openid" });
  });

  // Regression: the qqbot: prefix and looksLikeQQBotTarget matched
  // case-insensitively while the type prefix matched case-sensitively, so
  // "qqbot:Group:x" passed target validation but was delivered as a C2C
  // direct message to the literal openid "Group:x".
  it.each([
    { to: "qqbot:C2C:user-openid", expected: { type: "c2c", id: "user-openid" } },
    { to: "qqbot:Group:group-openid", expected: { type: "group", id: "group-openid" } },
    { to: "QQBOT:GROUP:group-openid", expected: { type: "group", id: "group-openid" } },
    { to: "qqbot:Channel:chan-1", expected: { type: "channel", id: "chan-1" } },
    { to: "Group:group-openid", expected: { type: "group", id: "group-openid" } },
    { to: "CHANNEL:chan-1", expected: { type: "channel", id: "chan-1" } },
  ])("parses mixed-case type prefix $to", ({ to, expected }) => {
    expect(parseTarget(to)).toEqual(expected);
  });

  it("preserves the ID's original case", () => {
    expect(parseTarget("qqbot:Group:AbCdEf")).toEqual({ type: "group", id: "AbCdEf" });
    expect(parseTarget("qqbot:c2c:OpenIdCase")).toEqual({ type: "c2c", id: "OpenIdCase" });
  });

  it("defaults bare IDs to c2c", () => {
    expect(parseTarget("bare-openid")).toEqual({ type: "c2c", id: "bare-openid" });
  });

  it("rejects type prefixes with empty IDs regardless of case", () => {
    expect(() => parseTarget("qqbot:c2c:")).toThrow(/missing user ID/);
    expect(() => parseTarget("qqbot:Group:")).toThrow(/missing group ID/);
    expect(() => parseTarget("CHANNEL:")).toThrow(/missing channel ID/);
    expect(() => parseTarget("qqbot:")).toThrow(/empty ID/);
  });
});

describe("normalizeTarget", () => {
  it("canonicalizes the type tag to lowercase and keeps the ID case", () => {
    expect(normalizeTarget("qqbot:Group:AbC")).toBe("qqbot:group:AbC");
    expect(normalizeTarget("C2C:OpenId")).toBe("qqbot:c2c:OpenId");
    expect(normalizeTarget("qqbot:channel:chan-1")).toBe("qqbot:channel:chan-1");
  });

  it("normalizes bare hex and UUID openids to c2c", () => {
    const hex = "0123456789abcdef0123456789ABCDEF";
    expect(normalizeTarget(hex)).toBe(`qqbot:c2c:${hex}`);
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    expect(normalizeTarget(uuid)).toBe(`qqbot:c2c:${uuid}`);
  });

  it("returns undefined for non-qqbot-shaped targets", () => {
    expect(normalizeTarget("not-a-target")).toBeUndefined();
  });
});

describe("target predicate and parser consistency", () => {
  // looksLikeQQBotTarget gates outbound target validation; every shape it
  // accepts must parse and normalize to the same delivery type.
  it.each([
    { to: "qqbot:Group:group-openid", type: "group" },
    { to: "qqbot:C2C:user-openid", type: "c2c" },
    { to: "Channel:chan-1", type: "channel" },
    { to: "group:group-openid", type: "group" },
  ])("accepted target $to parses to its declared type", ({ to, type }) => {
    expect(looksLikeQQBotTarget(to)).toBe(true);
    expect(parseTarget(to).type).toBe(type);
    expect(normalizeTarget(to)).toBe(`qqbot:${type}:${parseTarget(to).id}`);
  });
});
