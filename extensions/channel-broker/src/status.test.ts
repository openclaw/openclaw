import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { channelBrokerStatus } from "./status.js";

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
});
