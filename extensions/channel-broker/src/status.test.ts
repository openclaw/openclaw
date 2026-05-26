import { describe, expect, it } from "vitest";
import { channelBrokerStatus } from "./status.js";
import type { ResolvedChannelBrokerAccount } from "./types.js";

function account(overrides: Partial<ResolvedChannelBrokerAccount>): ResolvedChannelBrokerAccount {
  return {
    accountId: "acme",
    providerId: "acme",
    enabled: true,
    configured: true,
    baseUrl: "https://broker.example.test",
    outboundToken: null,
    signingSecret: null,
    platforms: [],
    platformAliases: {},
    defaultPlatform: null,
    defaultConversationType: "channel",
    allowFrom: [],
    capabilities: {},
    config: {},
    ...overrides,
  };
}

describe("channelBrokerStatus", () => {
  it("does not warn for disabled unconfigured accounts", () => {
    expect(
      channelBrokerStatus.collectStatusIssues?.([
        account({ accountId: "disabled", enabled: false, configured: false, baseUrl: null }),
        account({ accountId: "active" }),
      ]),
    ).toEqual([]);
  });

  it("warns for enabled unconfigured accounts", () => {
    expect(
      channelBrokerStatus.collectStatusIssues?.([
        account({ accountId: "active", enabled: true, configured: false, baseUrl: null }),
      ]),
    ).toEqual([
      {
        channel: "channel-broker",
        accountId: "active",
        kind: "config",
        message: "Provider not configured (missing baseUrl)",
      },
    ]);
  });
});
