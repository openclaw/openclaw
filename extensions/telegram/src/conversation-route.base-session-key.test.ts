import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { resolveTelegramConversationBaseSessionKey } from "./conversation-route.js";

describe("resolveTelegramConversationBaseSessionKey", () => {
  const cfg: OpenClawConfig = {};

  it("uses a per-account key for default-account DMs", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "main",
          accountId: "default",
          matchedBy: "default",
          sessionKey: "agent:main:main",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:main:telegram:default:direct:12345");
  });

  it("uses the per-account fallback key for named-account DMs without an explicit binding", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "main",
          accountId: "personal",
          matchedBy: "default",
          sessionKey: "agent:main:main",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:main:telegram:personal:direct:12345");
  });

  it("keeps explicit bound DM sessions intact", () => {
    expect(
      resolveTelegramConversationBaseSessionKey({
        cfg,
        route: {
          agentId: "codex-acp",
          accountId: "default",
          matchedBy: "binding.channel",
          sessionKey: "agent:codex-acp:session-dm",
        },
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
      }),
    ).toBe("agent:codex-acp:session-dm");
  });

  it("keeps DM topic isolation on the named-account fallback key", () => {
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg,
      route: {
        agentId: "main",
        accountId: "personal",
        matchedBy: "default",
        sessionKey: "agent:main:main",
      },
      chatId: 12345,
      isGroup: false,
      senderId: 12345,
    });

    expect(
      resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "12345:99",
      }).sessionKey,
    ).toBe("agent:main:telegram:personal:direct:12345:thread:12345:99");
  });
});
