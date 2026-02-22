import { describe, expect, it } from "vitest";
import { resolveConversationLane, parseConversationPartsFromSessionKey } from "./lanes.js";

describe("resolveConversationLane", () => {
  it("builds lane key from channel + accountId + peerId", () => {
    expect(
      resolveConversationLane({
        channel: "discord",
        accountId: "acct1",
        peerId: "C12345",
      }),
    ).toBe("conv:discord:acct1:c12345");
  });

  it("defaults accountId to 'default'", () => {
    expect(resolveConversationLane({ channel: "telegram", peerId: "G999" })).toBe(
      "conv:telegram:default:g999",
    );
  });

  it("returns empty string when both channel and peerId are missing", () => {
    expect(resolveConversationLane({})).toBe("");
    expect(resolveConversationLane({ accountId: "acct" })).toBe("");
  });

  it("uses 'unknown' when channel is missing but peerId is present", () => {
    expect(resolveConversationLane({ peerId: "C123" })).toBe("conv:unknown:default:c123");
  });

  it("uses 'unknown' when peerId is missing but channel is present", () => {
    expect(resolveConversationLane({ channel: "discord" })).toBe("conv:discord:default:unknown");
  });

  it("lowercases all parts", () => {
    expect(
      resolveConversationLane({
        channel: "Discord",
        accountId: "ACCT",
        peerId: "ABC",
      }),
    ).toBe("conv:discord:acct:abc");
  });

  it("trims whitespace", () => {
    expect(
      resolveConversationLane({
        channel: "  discord  ",
        peerId: "  C1  ",
      }),
    ).toBe("conv:discord:default:c1");
  });
});

describe("parseConversationPartsFromSessionKey", () => {
  it("extracts channel and peerId from a well-formed session key", () => {
    const result = parseConversationPartsFromSessionKey("agent:main:discord:channel:c12345");
    expect(result).toEqual({ channel: "discord", peerId: "c12345" });
  });

  it("returns empty strings for undefined input", () => {
    expect(parseConversationPartsFromSessionKey(undefined)).toEqual({
      channel: "",
      peerId: "",
    });
  });

  it("returns empty strings for empty input", () => {
    expect(parseConversationPartsFromSessionKey("")).toEqual({
      channel: "",
      peerId: "",
    });
  });

  it("returns empty strings for non-agent keys", () => {
    expect(parseConversationPartsFromSessionKey("session:something")).toEqual({
      channel: "",
      peerId: "",
    });
  });

  it("returns empty strings for short agent keys", () => {
    expect(parseConversationPartsFromSessionKey("agent:main:discord")).toEqual({
      channel: "",
      peerId: "",
    });
  });
});
