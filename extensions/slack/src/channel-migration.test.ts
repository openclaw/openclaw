import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateSlackChannelConfig } from "./channel-migration.js";

function createSlackGlobalChannelConfig(channels: Record<string, Record<string, unknown>>) {
  return { channels: { slack: { channels } } };
}

function createSlackAccountChannelConfig(
  accountId: string,
  channels: Record<string, Record<string, unknown>>,
) {
  return { channels: { slack: { accounts: { [accountId]: { channels } } } } };
}

function migrate(cfg: OpenClawConfig, accountId = "default") {
  return migrateSlackChannelConfig({ cfg, accountId, oldChannelId: "C123", newChannelId: "C999" });
}

describe("migrateSlackChannelConfig", () => {
  it("migrates global channel ids", () => {
    const cfg = createSlackGlobalChannelConfig({ C123: { requireMention: false } });
    expect(migrate(cfg).migrated).toBe(true);
    expect(cfg.channels.slack.channels).toEqual({ C999: { requireMention: false } });
  });

  it.each([
    ["primary", { requireMention: true }],
    ["Primary", {}],
  ] as const)("migrates account-scoped channels for %s", (accountId, channel) => {
    const cfg = createSlackAccountChannelConfig(accountId, { C123: channel });
    const expected = structuredClone(channel);
    expect(migrate(cfg, "primary").migrated).toBe(true);
    expect(expectDefined(cfg.channels.slack.accounts[accountId], "Slack account").channels).toEqual(
      { C999: expected },
    );
  });

  it("does not borrow channels from a case alias when the exact account has none", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            Primary: { channels: { C123: { requireMention: true } } },
            primary: {},
          },
        },
      },
    };

    expect(migrate(cfg, "primary")).toEqual({ migrated: false, skippedExisting: false });
    expect(cfg.channels.slack.accounts.Primary.channels).toEqual({
      C123: { requireMention: true },
    });
  });

  it("skips migration when new id already exists", () => {
    const cfg = createSlackGlobalChannelConfig({
      C123: { requireMention: true },
      C999: { requireMention: false },
    });

    expect(migrate(cfg)).toEqual({ migrated: false, skippedExisting: true });
    expect(cfg.channels.slack.channels).toEqual({
      C123: { requireMention: true },
      C999: { requireMention: false },
    });
  });
});
