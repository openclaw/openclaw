import { describe, expect, it } from "vitest";
import { resolveDefaultFeishuAccountId, resolveFeishuAccount } from "./accounts.js";

describe("resolveDefaultFeishuAccountId", () => {
  it("prefers channels.feishu.defaultAccount when configured", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            "router-d": { appId: "cli_router", appSecret: "secret_router" },
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("normalizes configured defaultAccount before lookup", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "Router D",
          accounts: {
            "router-d": { appId: "cli_router", appSecret: "secret_router" },
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("falls back to literal default account id when preferred is missing", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "missing",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" },
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("default");
  });
});

describe("resolveFeishuAccount", () => {
  it("uses configured default account when accountId is omitted", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { enabled: true },
            "router-d": { appId: "cli_router", appSecret: "secret_router", enabled: true },
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: undefined });
    expect(account.accountId).toBe("router-d");
    expect(account.configured).toBe(true);
    expect(account.appId).toBe("cli_router");
  });

  it("keeps explicit accountId selection", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            "router-d": { appId: "cli_router", appSecret: "secret_router" },
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: "default" });
    expect(account.accountId).toBe("default");
    expect(account.appId).toBe("cli_default");
  });
});
