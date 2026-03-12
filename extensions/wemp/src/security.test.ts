import { describe, expect, it } from "vitest";
import { collectWarnings, resolveDmPolicy } from "./security.js";
import type { ResolvedWempAccount } from "./types.js";

function createAccount(overrides?: Partial<ResolvedWempAccount>): ResolvedWempAccount {
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
      handoff: {
        enabled: false,
        contact: "",
        message: "如需人工支持，请联系：{{contact}}",
        autoResumeMinutes: 30,
        activeReply: "当前会话已转人工处理，请稍候。",
        ticketWebhook: {
          enabled: false,
          endpoint: "",
          token: "",
          events: ["activated"],
        },
      },
      welcome: { enabled: false, subscribeText: "" },
      routeGuard: { enabled: true, unpairedAllowedAgents: ["wemp-kf"] },
    },
    config: {},
    ...overrides,
  };
}

describe("wemp security warnings", () => {
  it("dm.policy=open 时给出开放策略告警", () => {
    const warnings = collectWarnings(
      createAccount({
        dm: { policy: "open", allowFrom: [] },
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dm.policy="open"');
  });

  it("缺凭证时给出凭证缺失告警", () => {
    const warnings = collectWarnings(
      createAccount({
        appId: "",
        appSecret: "",
        token: "",
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing required credentials");
  });

  it("开放策略且缺凭证时返回双告警", () => {
    const warnings = collectWarnings(
      createAccount({
        dm: { policy: "open", allowFrom: [] },
        appId: "",
        appSecret: "",
        token: "",
      }),
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('dm.policy="open"');
    expect(warnings[1]).toContain("missing required credentials");
  });

  it("resolveDmPolicy 在 open 策略下补齐 allowFrom 通配符", () => {
    const resolved = resolveDmPolicy(
      createAccount({
        dm: { policy: "open", allowFrom: ["openid-1"] },
      }),
    );
    expect(resolved.policy).toBe("open");
    expect(resolved.allowFrom).toEqual(["*", "openid-1"]);
  });

  it("resolveDmPolicy 在 disabled 策略下返回空 allowFrom", () => {
    const resolved = resolveDmPolicy(
      createAccount({
        dm: { policy: "disabled", allowFrom: ["openid-1"] },
      }),
    );
    expect(resolved.policy).toBe("disabled");
    expect(resolved.allowFrom).toEqual([]);
  });
});
