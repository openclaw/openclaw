import { describe, expect, it } from "vitest";
import { resolveTelegramSecurityDmRoute } from "./dm-session-key.js";

describe("Telegram DM session keys", () => {
  it.each([
    {
      name: "named-account default fallback",
      accountId: "personal",
      fallbackRoute: { dmScope: "main" as const, matchedBy: "default" as const },
      expected: "isolated",
    },
    {
      name: "default-account main scope",
      accountId: "default",
      fallbackRoute: { dmScope: "main" as const, matchedBy: "default" as const },
      expected: "shared",
    },
    {
      name: "named account with a winning binding",
      accountId: "personal",
      fallbackRoute: { dmScope: "main" as const, matchedBy: "binding.account" as const },
      expected: "shared",
    },
    {
      name: "account-isolated core scope",
      accountId: "default",
      fallbackRoute: {
        dmScope: "per-account-channel-peer" as const,
        matchedBy: "default" as const,
      },
      expected: "isolated",
    },
    {
      name: "per-peer core namespace",
      accountId: "default",
      fallbackRoute: { dmScope: "per-peer" as const, matchedBy: "default" as const },
      expected: "core",
    },
    {
      name: "per-channel core namespace",
      accountId: "default",
      fallbackRoute: { dmScope: "per-channel-peer" as const, matchedBy: "default" as const },
      expected: "core",
    },
  ])("classifies $name as $expected", ({ accountId, fallbackRoute, expected }) => {
    const result = resolveTelegramSecurityDmRoute("default", {
      cfg: {},
      accountId,
      route: {
        ...fallbackRoute,
        agentId: "main",
        accountId,
        channel: "telegram",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
      },
    });
    expect("kind" in result ? result.kind : "shared").toBe(expected);
  });
});
