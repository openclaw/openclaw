import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveTelegramConversationRoute } from "./conversation-route.js";

describe("resolveTelegramConversationRoute account agentId routing", () => {
  function buildConfig(): OpenClawConfig {
    return {
      agents: {
        list: [{ id: "main", default: true }, { id: "atlas" }, { id: "support" }, { id: "bound" }],
      },
      channels: {
        telegram: {
          accounts: {
            atlas: {
              agentId: "atlas",
            },
          },
        },
      },
    };
  }

  it("routes named-account DMs to the configured account agent", () => {
    const { route } = resolveTelegramConversationRoute({
      cfg: buildConfig(),
      accountId: "atlas",
      chatId: 814912386,
      isGroup: false,
      senderId: 814912386,
    });

    expect(route.agentId).toBe("atlas");
    expect(route.accountId).toBe("atlas");
    expect(route.matchedBy).toBe("binding.account");
    expect(route.sessionKey).toBe("agent:atlas:main");
  });

  it("routes named-account groups to the configured account agent", () => {
    const { route } = resolveTelegramConversationRoute({
      cfg: buildConfig(),
      accountId: "atlas",
      chatId: -1001234567890,
      isGroup: true,
    });

    expect(route.agentId).toBe("atlas");
    expect(route.matchedBy).toBe("binding.account");
    expect(route.sessionKey).toBe("agent:atlas:telegram:group:-1001234567890");
  });

  it("keeps explicit bindings ahead of account agentId", () => {
    const cfg = buildConfig();
    cfg.bindings = [
      {
        agentId: "bound",
        match: {
          channel: "telegram",
          accountId: "atlas",
        },
      },
    ];

    const { route } = resolveTelegramConversationRoute({
      cfg,
      accountId: "atlas",
      chatId: 814912386,
      isGroup: false,
      senderId: 814912386,
    });

    expect(route.agentId).toBe("bound");
    expect(route.matchedBy).toBe("binding.account");
    expect(route.sessionKey).toBe("agent:bound:main");
  });

  it("lets topic agentId override the account agent", () => {
    const { route } = resolveTelegramConversationRoute({
      cfg: buildConfig(),
      accountId: "atlas",
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId: 42,
      topicAgentId: "support",
    });

    expect(route.agentId).toBe("support");
    expect(route.sessionKey).toBe("agent:support:telegram:group:-1001234567890:topic:42");
  });
});
