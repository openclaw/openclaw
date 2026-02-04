import { describe, expect, it } from "vitest";

import { buildUnpairConfigUpdate, isUnpairAuthorized } from "./unpair-http.js";

describe("dailyflows unpair", () => {
  it("clears secrets and disables the account", () => {
    const current = {
      channels: {
        dailyflows: {
          accounts: {
            default: {
              enabled: true,
              outboundToken: "token",
              webhookSecret: "secret",
              outboundUrl: "https://example.com/openclaw/outbound",
            },
          },
        },
      },
    };

    const next = buildUnpairConfigUpdate({ current, accountId: "default" });
    const channels = next.channels as Record<string, unknown>;
    const dailyflows = channels.dailyflows as Record<string, unknown>;
    const accounts = dailyflows.accounts as Record<string, unknown>;
    const account = accounts.default as Record<string, unknown>;

    expect(account.enabled).toBe(false);
    expect(account.outboundToken).toBeUndefined();
    expect(account.webhookSecret).toBeUndefined();
    expect(account.outboundUrl).toBeUndefined();
  });

  it("authorizes with either outbound token or webhook secret", () => {
    const prevEnvGlobal = process.env.DAILYFLOWS_WEBHOOK_SECRET;
    const prevEnvSpecific = process.env.DAILYFLOWS_WEBHOOK_SECRET_DEFAULT;
    process.env.DAILYFLOWS_WEBHOOK_SECRET = "";
    process.env.DAILYFLOWS_WEBHOOK_SECRET_DEFAULT = "";

    const cfg: Record<string, unknown> = {
      channels: {
        dailyflows: {
          accounts: {
            default: {
              outboundToken: "token",
              webhookSecret: "secret",
            },
          },
        },
      },
    };

    expect(
      isUnpairAuthorized({ cfg, accountId: "default", outboundToken: "token" }),
    ).toBe(true);
    expect(
      isUnpairAuthorized({ cfg, accountId: "default", webhookSecret: "secret" }),
    ).toBe(true);
    expect(
      isUnpairAuthorized({ cfg, accountId: "default", outboundToken: "nope" }),
    ).toBe(false);

    if (prevEnvGlobal === undefined) {
      delete process.env.DAILYFLOWS_WEBHOOK_SECRET;
    } else {
      process.env.DAILYFLOWS_WEBHOOK_SECRET = prevEnvGlobal;
    }
    if (prevEnvSpecific === undefined) {
      delete process.env.DAILYFLOWS_WEBHOOK_SECRET_DEFAULT;
    } else {
      process.env.DAILYFLOWS_WEBHOOK_SECRET_DEFAULT = prevEnvSpecific;
    }
  });
});
