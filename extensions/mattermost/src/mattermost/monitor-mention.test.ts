import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { resolveChannelGroupRequireMention } from "../../../../src/config/group-policy.js";
import { resolveMattermostAccount } from "./accounts.js";

/**
 * Tests that the monitor's mention gate respects account-level requireMention
 * when passed as requireMentionOverride.
 */
describe("mattermost monitor mention gate", () => {
  const channelId = "some-channel-id";

  function resolveRequireMention(cfg: OpenClawConfig): boolean {
    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    return resolveChannelGroupRequireMention({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      groupId: channelId,
      requireMentionOverride: account.requireMention,
    });
  }

  it("defaults to requireMention=true with no config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: { default: {} },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(true);
  });

  it("respects chatmode=onmessage (requireMention=false)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          accounts: { default: {} },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(false);
  });

  it("respects explicit requireMention=false on account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            default: {
              requireMention: false,
            },
          },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(false);
  });

  it("per-group config overrides account-level requireMention", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groups: {
            [channelId]: { requireMention: true },
          },
          accounts: { default: {} },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(true);
  });

  it("wildcard group config overrides account-level requireMention", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groups: {
            "*": { requireMention: true },
          },
          accounts: { default: {} },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(true);
  });

  it("chatmode=oncall forces requireMention=true", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "oncall",
          accounts: { default: {} },
        },
      },
    };
    expect(resolveRequireMention(cfg)).toBe(true);
  });
});
