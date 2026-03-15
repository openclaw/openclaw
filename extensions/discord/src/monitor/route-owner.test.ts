import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import { resolveDiscordRouteOwner } from "./route-owner.js";

describe("resolveDiscordRouteOwner", () => {
  it("prefers another account when the current account only falls back to default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/ws/main" },
          { id: "monitor", workspace: "/ws/monitor" },
        ],
      },
      channels: {
        discord: {
          accounts: {
            default: {},
            notifier: {},
          },
        },
      },
      bindings: [
        {
          agentId: "monitor",
          match: {
            channel: "discord",
            accountId: "notifier",
            peer: { kind: "channel", id: "channel-monitor" },
          },
        },
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "channel-main" },
          },
        },
      ],
    };

    const currentRoute = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "channel-monitor" },
      guildId: "guild-1",
    });

    const owner = resolveDiscordRouteOwner({
      cfg,
      currentAccountId: "default",
      currentRoute,
      guildId: "guild-1",
      peer: { kind: "channel", id: "channel-monitor" },
    });

    expect(currentRoute.matchedBy).toBe("default");
    expect(owner).toEqual({
      accountId: "notifier",
      route: expect.objectContaining({
        agentId: "monitor",
        accountId: "notifier",
        matchedBy: "binding.peer",
      }),
    });
  });

  it("prefers a more specific peer binding on another account over an account-wide match", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          accounts: {
            default: {},
            notifier: {},
          },
        },
      },
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "default",
          },
        },
        {
          agentId: "monitor",
          match: {
            channel: "discord",
            accountId: "notifier",
            peer: { kind: "channel", id: "channel-monitor" },
          },
        },
      ],
    };

    const currentRoute = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "channel-monitor" },
      guildId: "guild-1",
    });

    const owner = resolveDiscordRouteOwner({
      cfg,
      currentAccountId: "default",
      currentRoute,
      guildId: "guild-1",
      peer: { kind: "channel", id: "channel-monitor" },
    });

    expect(currentRoute.matchedBy).toBe("binding.account");
    expect(owner).toEqual({
      accountId: "notifier",
      route: expect.objectContaining({
        agentId: "monitor",
        accountId: "notifier",
        matchedBy: "binding.peer",
      }),
    });
  });

  it("keeps the current account when it already has the most specific binding", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          accounts: {
            default: {},
            notifier: {},
          },
        },
      },
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "channel-main" },
          },
        },
        {
          agentId: "monitor",
          match: {
            channel: "discord",
            accountId: "notifier",
          },
        },
      ],
    };

    const currentRoute = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "channel-main" },
      guildId: "guild-1",
    });

    const owner = resolveDiscordRouteOwner({
      cfg,
      currentAccountId: "default",
      currentRoute,
      guildId: "guild-1",
      peer: { kind: "channel", id: "channel-main" },
    });

    expect(currentRoute.matchedBy).toBe("binding.peer");
    expect(owner).toBeNull();
  });
});
