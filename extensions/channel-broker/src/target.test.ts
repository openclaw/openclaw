import { describe, expect, it } from "vitest";
import { normalizeBrokerTarget, parseChannelBrokerTarget } from "./target.js";
import type { ResolvedChannelBrokerAccount } from "./types.js";

const account = {
  accountId: "acme",
  providerId: "acme",
  enabled: true,
  configured: true,
  baseUrl: "https://broker.example.test",
  outboundToken: null,
  signingSecret: null,
  platforms: ["discord", "slack"],
  platformAliases: {},
  defaultPlatform: null,
  defaultConversationType: "channel",
  allowFrom: [],
  capabilities: {},
  config: {},
} satisfies ResolvedChannelBrokerAccount;

describe("parseChannelBrokerTarget", () => {
  it("keeps broker-prefixed generic normalization account-agnostic", () => {
    expect(normalizeBrokerTarget("broker:slack:C123")).toBe("broker:slack:C123");
    expect(normalizeBrokerTarget("broker:slack:user:U123")).toBe("broker:slack:user:U123");
    expect(normalizeBrokerTarget("broker:C123")).toBe("broker:C123");
    expect(normalizeBrokerTarget("telegram:12345")).toBe("telegram:12345");
  });

  it.each([
    ["slack:user:U12345678", "slack", "U12345678"],
    ["broker:slack:user:U12345678", "slack", "U12345678"],
    ["broker:discord:dm:123456789012345678", "discord", "123456789012345678"],
  ])("normalizes %s as a direct conversation", (rawTarget, platform, conversationId) => {
    expect(parseChannelBrokerTarget({ rawTarget, account })).toEqual({
      platform,
      conversationId,
      conversationType: "direct",
    });
  });

  it.each([
    "slack:user%3AU123?conversationType=channel",
    "broker:slack:user%3AU123?conversationType=channel",
  ])("preserves type-like opaque conversation ids from %s", (rawTarget) => {
    expect(parseChannelBrokerTarget({ rawTarget, account })).toEqual({
      platform: "slack",
      conversationId: "user:U123",
      conversationType: "channel",
    });
  });

  it("keeps encoded type-like conversation ids opaque without an explicit type", () => {
    expect(parseChannelBrokerTarget({ rawTarget: "slack:user%3AU123", account })).toEqual({
      platform: "slack",
      conversationId: "user:U123",
      conversationType: "channel",
    });
  });

  it.each(["slack:%20", "broker:slack:user:", "broker:discord:dm:%20"])(
    "rejects blank conversation ids from %s",
    (rawTarget) => {
      expect(() => parseChannelBrokerTarget({ rawTarget, account })).toThrow(
        "broker conversation id is required",
      );
    },
  );

  it("rejects broker-prefixed targets without a platform or defaultPlatform", () => {
    expect(() =>
      parseChannelBrokerTarget({
        rawTarget: "broker:C12345678",
        account: { ...account, platforms: [] },
      }),
    ).toThrow("broker target must include a platform or configure defaultPlatform");
  });

  it("uses defaultPlatform for broker-prefixed targets without an embedded platform", () => {
    expect(
      parseChannelBrokerTarget({
        rawTarget: "broker:C12345678",
        account: { ...account, defaultPlatform: "slack" },
      }),
    ).toEqual({
      platform: "slack",
      conversationId: "C12345678",
      conversationType: "channel",
    });
  });
});
