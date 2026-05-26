import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { channelBrokerStatus } from "./status.js";
import type { ResolvedChannelBrokerAccount } from "./types.js";

function account(overrides: Partial<ChannelAccountSnapshot>): ChannelAccountSnapshot {
  return {
    accountId: "acme",
    enabled: true,
    configured: true,
    baseUrl: "https://broker.example.test",
    allowFrom: [],
    ...overrides,
  };
}

function resolvedAccount(
  overrides: Partial<ResolvedChannelBrokerAccount> = {},
): ResolvedChannelBrokerAccount {
  return {
    accountId: "acme",
    providerId: "acme",
    enabled: true,
    configured: true,
    baseUrl: "https://broker.example.test",
    outboundToken: null,
    signingSecret: null,
    platforms: ["slack"],
    platformAliases: {},
    defaultPlatform: "slack",
    defaultConversationType: "channel",
    allowFrom: ["U123"],
    capabilities: {},
    config: {},
    ...overrides,
  };
}

describe("channelBrokerStatus", () => {
  it("does not warn for disabled unconfigured accounts", () => {
    expect(
      channelBrokerStatus.collectStatusIssues?.([
        account({ accountId: "disabled", enabled: false, configured: false, baseUrl: undefined }),
        account({ accountId: "active" }),
      ]),
    ).toEqual([]);
  });

  it("warns for enabled unconfigured accounts", () => {
    expect(
      channelBrokerStatus.collectStatusIssues?.([
        account({ accountId: "active", enabled: true, configured: false, baseUrl: undefined }),
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

  it("preserves broker status metadata for channel summaries", async () => {
    const snapshot = await channelBrokerStatus.buildAccountSnapshot?.({
      account: resolvedAccount(),
      cfg: {} as never,
    });

    expect(snapshot).toMatchObject({
      accountId: "acme",
      baseUrl: "https://broker.example.test",
      allowFrom: ["U123"],
      platforms: ["slack"],
      defaultPlatform: "slack",
      defaultConversationType: "channel",
    });
    expect(
      await channelBrokerStatus.buildChannelSummary?.({
        account: resolvedAccount(),
        cfg: {} as never,
        defaultAccountId: "acme",
        snapshot: snapshot as ChannelAccountSnapshot,
      }),
    ).toEqual({
      configured: true,
      baseUrl: "https://broker.example.test",
    });
  });
});
