import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveEmailAccountForRecipient } from "./accounts.js";

function makeCfg(accounts: Record<string, Record<string, unknown>>): OpenClawConfig {
  return {
    channels: {
      email: {
        accounts,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("resolveEmailAccountForRecipient", () => {
  it("matches account by recipient address", () => {
    const cfg = makeCfg({
      support: {
        address: "support@example.com",
        outboundUrl: "https://example.com/outbound",
        outboundToken: "tok-support",
      },
      sales: {
        address: "sales@example.com",
        outboundUrl: "https://example.com/outbound",
        outboundToken: "tok-sales",
      },
    });

    const account = resolveEmailAccountForRecipient({
      cfg,
      recipient: "sales@example.com",
    });

    expect(account.accountId).toBe("sales");
    expect(account.address).toBe("sales@example.com");
  });

  it("falls back to default resolver when no address matches", () => {
    const cfg = makeCfg({
      default: {
        address: "default@example.com",
        outboundUrl: "https://example.com/outbound",
        outboundToken: "tok-default",
      },
    });

    const account = resolveEmailAccountForRecipient({
      cfg,
      recipient: "other@example.com",
    });

    expect(account.accountId).toBe("default");
    expect(account.address).toBe("default@example.com");
  });
});
