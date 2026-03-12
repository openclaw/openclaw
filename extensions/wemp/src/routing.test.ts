import { describe, expect, it } from "vitest";
import { resolveInboundAgent } from "./inbound.js";
import { resolvePairedAgent, resolveUnpairedAgent } from "./routing.js";
import type { ResolvedWempAccount } from "./types.js";

function accountFixture(): ResolvedWempAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "app",
    appSecret: "secret",
    token: "token",
    webhookPath: "/wemp",
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: false, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: { enabled: false, contact: "", message: "" },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

describe("wemp routing", () => {
  it("routing helpers return configured paired/unpaired agents", () => {
    const account = accountFixture();
    expect(resolvePairedAgent(account)).toBe("main");
    expect(resolveUnpairedAgent(account)).toBe("wemp-kf");
  });

  it("resolveInboundAgent follows paired flag", () => {
    const account = accountFixture();
    expect(resolveInboundAgent(account, { openId: "o1", text: "hi", paired: true })).toBe("main");
    expect(resolveInboundAgent(account, { openId: "o2", text: "hi", paired: false })).toBe(
      "wemp-kf",
    );
  });
});
