import { describe, expect, it } from "vitest";
import { normalizeTarget, parseExplicitTarget, parseTarget } from "./target-parser.js";

describe("QQ Bot target parser", () => {
  it("parses documented provider-prefixed targets", () => {
    expect(parseTarget("qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toEqual({
      type: "c2c",
      id: "A2B91CCEA0E039905B45C84DD96C92FD",
    });
    expect(parseTarget("qqbot:group:group-openid")).toEqual({
      type: "group",
      id: "group-openid",
    });
    expect(parseTarget("qqbot:channel:channel-id")).toEqual({
      type: "channel",
      id: "channel-id",
    });
  });

  it("rejects repeated provider prefixes instead of treating them as C2C ids", () => {
    expect(() => parseTarget("qqbot:qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toThrow(
      /repeated qqbot: prefix/,
    );
    expect(normalizeTarget("qqbot:qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toBeUndefined();
  });

  it("normalizes typed targets with one provider prefix", () => {
    expect(normalizeTarget("qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toBe(
      "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
    );
    expect(normalizeTarget("C2C:A2B91CCEA0E039905B45C84DD96C92FD")).toBe(
      "qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD",
    );
  });

  it("returns channel-local explicit targets for cron delivery routing", () => {
    expect(parseExplicitTarget("qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toEqual({
      to: "c2c:A2B91CCEA0E039905B45C84DD96C92FD",
      chatType: "direct",
    });
    expect(parseExplicitTarget("qqbot:group:group-openid")).toEqual({
      to: "group:group-openid",
      chatType: "group",
    });
    expect(parseExplicitTarget("qqbot:channel:channel-id")).toEqual({
      to: "channel:channel-id",
      chatType: "channel",
    });
  });

  it("declines foreign provider-prefixed explicit targets", () => {
    expect(parseExplicitTarget("telegram:1234567890")).toBeNull();
    expect(parseExplicitTarget("slack:C1234567890")).toBeNull();
  });

  it("does not parse repeated provider prefixes as explicit targets", () => {
    expect(parseExplicitTarget("qqbot:qqbot:c2c:A2B91CCEA0E039905B45C84DD96C92FD")).toBeNull();
  });
});
