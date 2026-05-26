import { describe, expect, it } from "vitest";
import { parseChannelBrokerTarget } from "./target.js";
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
  it.each([
    ["broker:slack:user:U12345678", "slack", "U12345678"],
    ["broker:discord:dm:123456789012345678", "discord", "123456789012345678"],
  ])("normalizes %s as a direct conversation", (rawTarget, platform, conversationId) => {
    expect(parseChannelBrokerTarget({ rawTarget, account })).toEqual({
      platform,
      conversationId,
      conversationType: "direct",
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
