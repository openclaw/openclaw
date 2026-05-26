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

  it("canonicalizes known platform aliases during target normalization", () => {
    expect(normalizeBrokerTarget("teams:19:meeting-channel")).toBe(
      "microsoft-teams:19%3Ameeting-channel",
    );
    expect(normalizeBrokerTarget("broker:teams:19:meeting-channel")).toBe(
      "broker:microsoft-teams:19:meeting-channel",
    );
    expect(normalizeBrokerTarget("broker:openclaw-weixin:direct:wxid_friend")).toBe(
      "broker:wechat:direct:wxid_friend",
    );
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
    "discord:user%3A123?conversationType=channel",
    "broker:discord:user%3A123?conversationType=channel",
  ])("preserves type-like opaque conversation ids from %s", (rawTarget) => {
    const platform = rawTarget.includes("discord") ? "discord" : "slack";
    const conversationId = platform === "discord" ? "user:123" : "user:U123";
    expect(parseChannelBrokerTarget({ rawTarget, account })).toEqual({
      platform,
      conversationId,
      conversationType: "channel",
    });
  });

  it("does not strip type-like Discord id prefixes after explicit shorthand", () => {
    expect(
      parseChannelBrokerTarget({
        rawTarget: "broker:discord:channel:user:123",
        account,
      }),
    ).toEqual({
      platform: "discord",
      conversationId: "user:123",
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

  it("keeps Telegram inference behind the account default conversation type", () => {
    const telegramAccount = {
      ...account,
      platforms: ["telegram"],
      defaultPlatform: "telegram",
      defaultConversationType: "channel",
      config: { defaultConversationType: "channel" },
    } satisfies ResolvedChannelBrokerAccount;

    expect(
      parseChannelBrokerTarget({
        rawTarget: "broker:12345",
        account: telegramAccount,
      }),
    ).toEqual({
      platform: "telegram",
      conversationId: "12345",
      conversationType: "channel",
    });
    expect(
      parseChannelBrokerTarget({
        rawTarget: "broker:telegram:-100123",
        account: telegramAccount,
      }),
    ).toEqual({
      platform: "telegram",
      conversationId: "-100123",
      conversationType: "channel",
    });
  });

  it("lets explicit Telegram conversation type override the account default", () => {
    expect(
      parseChannelBrokerTarget({
        rawTarget: "broker:telegram:12345?conversationType=direct",
        account: {
          ...account,
          platforms: ["telegram"],
          defaultPlatform: "telegram",
          defaultConversationType: "channel",
          config: { defaultConversationType: "channel" },
        },
      }),
    ).toEqual({
      platform: "telegram",
      conversationId: "12345",
      conversationType: "direct",
    });
  });

  it("keeps positive Telegram ids direct when a thread id is present", () => {
    expect(
      parseChannelBrokerTarget({
        rawTarget: "telegram:12345?threadId=42",
        account: { ...account, platforms: ["telegram"] },
      }),
    ).toEqual({
      platform: "telegram",
      conversationId: "12345",
      conversationType: "direct",
      threadId: "42",
    });
  });
});
