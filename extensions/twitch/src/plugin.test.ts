import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { twitchPlugin } from "./plugin.js";
import { twitchSetupPlugin } from "./setup-surface.js";

function multiAccountConfig(defaultAccount?: string, selectedToken = "oauth:secondary-token") {
  const account = (name: string, accessToken: string) => ({
    channel: `${name}-channel`,
    username: name,
    accessToken,
    clientId: `${name}-client`,
    enabled: true,
  });
  return {
    channels: {
      twitch: {
        defaultAccount,
        accounts: {
          default: account("default", "oauth:default-token"),
          secondary: account("secondary", selectedToken),
        },
      },
    },
  } as OpenClawConfig;
}

describe("twitchPlugin", () => {
  it("classifies only channel targets as groups", () => {
    expect(twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:openclaw" })).toBe("group");
    expect(
      twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:user:operator" }),
    ).toBeUndefined();
  });
  it("reproduces the canonical inbound channel session", async () => {
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      accountId: "stream",
      target: "twitch:channel:OpenClaw",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:ops:twitch:group:openclaw",
      baseSessionKey: "agent:ops:twitch:group:openclaw",
      recipientSessionExact: true,
      peer: { kind: "group", id: "openclaw" },
      chatType: "group",
      to: "openclaw",
    });
  });

  it("rejects unsupported direct targets", async () => {
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      target: "twitch:dm:alice",
    });

    expect(route).toBeNull();
  });
  it("uses the resolved account ID for multi-account configs", async () => {
    const cfg = multiAccountConfig();
    const snapshot = await twitchPlugin.status?.buildAccountSnapshot?.({
      account: twitchPlugin.config.resolveAccount(cfg, "secondary"),
      cfg,
    });

    expect(snapshot?.accountId).toBe("secondary");
  });
  it("uses configured defaultAccount for omitted-account plugin resolution", () => {
    const cfg = multiAccountConfig("secondary");
    expect(twitchPlugin.config.defaultAccountId?.(cfg)).toBe("secondary");
    expect(twitchPlugin.config.resolveAccount(cfg).accountId).toBe("secondary");
  });

  it("does not borrow the configured default account's token", () => {
    const cfg = multiAccountConfig(undefined, "");
    for (const config of [twitchPlugin.config, twitchSetupPlugin.config]) {
      const account = config.resolveAccount(cfg, "secondary");
      expect(account.accountId).toBe("secondary");
      expect(config.isConfigured?.(account, cfg)).toBe(false);
    }
  });
});
