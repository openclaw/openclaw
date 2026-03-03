import { describe, expect, it } from "vitest";
import {
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
} from "./accounts.js";

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

  it("keeps configured defaultAccount even when not present in accounts map", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" },
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("router-d");
  });

  it("falls back to literal default account id when present", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
            zeta: { appId: "cli_zeta", appSecret: "secret_zeta" },
          },
        },
      },
    };

    expect(resolveDefaultFeishuAccountId(cfg as never)).toBe("default");
  });

  it("reports selection source for configured defaults and mapped defaults", () => {
    const explicitDefaultCfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          accounts: {},
        },
      },
    };
    expect(resolveDefaultFeishuAccountSelection(explicitDefaultCfg as never)).toEqual({
      accountId: "router-d",
      source: "explicit-default",
    });

    const mappedDefaultCfg = {
      channels: {
        feishu: {
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
          },
        },
      },
    };
    expect(resolveDefaultFeishuAccountSelection(mappedDefaultCfg as never)).toEqual({
      accountId: "default",
      source: "mapped-default",
    });
  });
});

describe("resolveFeishuAccount", () => {
  it("uses top-level credentials with configured default account id even without account map entry", () => {
    const cfg = {
      channels: {
        feishu: {
          defaultAccount: "router-d",
          appId: "top_level_app",
          appSecret: "top_level_secret",
          accounts: {
            default: { appId: "cli_default", appSecret: "secret_default" },
          },
        },
      },
    };

    const account = resolveFeishuAccount({ cfg: cfg as never, accountId: undefined });
    expect(account.accountId).toBe("router-d");
    expect(account.selectionSource).toBe("explicit-default");
    expect(account.configured).toBe(true);
    expect(account.appId).toBe("top_level_app");
  });

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
    expect(account.selectionSource).toBe("explicit-default");
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
    expect(account.selectionSource).toBe("explicit");
    expect(account.appId).toBe("cli_default");
  });
});
