import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWempPlugin() {
  vi.resetModules();
  vi.doMock("./webhook.js", () => ({
    handleRegisteredWebhookRequest: async () => ({ handled: false, reason: "mocked" }),
    registerWempWebhook: () => ({ path: "/mocked" }),
    unregisterWempWebhook: () => undefined,
    unregisterWempWebhookByAccountId: () => undefined,
  }));
  const mod = await import("./channel.js");
  return mod.wempPlugin;
}

describe("wemp channel setup", () => {
  afterEach(() => {
    vi.unmock("./webhook.js");
    vi.resetModules();
  });

  it("applyAccountConfig 写回 default 账号结构", async () => {
    const wempPlugin = await loadWempPlugin();
    const cfg = {
      channels: {
        wemp: {
          appId: "app-root",
          appSecret: "secret-root",
        },
      },
    } as OpenClawConfig;

    const next = wempPlugin.setup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        name: "默认公众号",
        token: "token-default",
        webhookPath: "/wemp-default",
      },
    });

    const wemp = (next.channels as Record<string, any>).wemp;
    expect(wemp).toMatchObject({
      name: "默认公众号",
      enabled: true,
      token: "token-default",
      webhookPath: "/wemp-default",
    });
    expect(wemp.accounts).toBeUndefined();
  });

  it("applyAccountConfig 写回 named 账号结构并迁移 base name", async () => {
    const wempPlugin = await loadWempPlugin();
    const cfg = {
      channels: {
        wemp: {
          name: "旧默认名",
          appId: "app-root",
          appSecret: "secret-root",
          token: "token-root",
          accounts: {
            legacy: { name: "遗留账号" },
          },
        },
      },
    } as OpenClawConfig;

    const next = wempPlugin.setup.applyAccountConfig({
      cfg,
      accountId: "branda",
      input: {
        name: "品牌 A",
        token: "token-a",
        webhookPath: "/wemp-a",
      },
    });

    const wemp = (next.channels as Record<string, any>).wemp;
    expect(wemp.enabled).toBe(true);
    expect(wemp.name).toBeUndefined();
    expect(wemp.accounts.default.name).toBe("旧默认名");
    expect(wemp.accounts.legacy.name).toBe("遗留账号");
    expect(wemp.accounts.branda).toMatchObject({
      name: "品牌 A",
      enabled: true,
      token: "token-a",
      webhookPath: "/wemp-a",
    });
  });

  it("setAccountEnabled 覆盖 default 与 named 分支", async () => {
    const wempPlugin = await loadWempPlugin();
    const cfg = {
      channels: {
        wemp: {
          enabled: true,
          accounts: {
            branda: { enabled: true, token: "token-a" },
          },
        },
      },
    } as OpenClawConfig;

    const defaultDisabled = wempPlugin.config.setAccountEnabled({
      cfg,
      accountId: "default",
      enabled: false,
    });
    expect((defaultDisabled.channels as Record<string, any>).wemp.enabled).toBe(false);
    expect((defaultDisabled.channels as Record<string, any>).wemp.accounts.branda.enabled).toBe(
      true,
    );

    const namedDisabled = wempPlugin.config.setAccountEnabled({
      cfg,
      accountId: "branda",
      enabled: false,
    });
    expect((namedDisabled.channels as Record<string, any>).wemp.enabled).toBe(true);
    expect((namedDisabled.channels as Record<string, any>).wemp.accounts.branda.enabled).toBe(
      false,
    );
  });

  it("deleteAccount 覆盖 default 与 named 分支", async () => {
    const wempPlugin = await loadWempPlugin();
    const cfg = {
      channels: {
        wemp: {
          enabled: true,
          accounts: {
            branda: { enabled: true },
            brandb: { enabled: false },
          },
        },
      },
    } as OpenClawConfig;

    const defaultDeleted = wempPlugin.config.deleteAccount({
      cfg,
      accountId: "default",
    });
    expect((defaultDeleted.channels as Record<string, any>).wemp.enabled).toBe(false);
    expect((defaultDeleted.channels as Record<string, any>).wemp.accounts.branda).toBeTruthy();

    const namedDeleted = wempPlugin.config.deleteAccount({
      cfg,
      accountId: "branda",
    });
    expect((namedDeleted.channels as Record<string, any>).wemp.enabled).toBe(true);
    expect((namedDeleted.channels as Record<string, any>).wemp.accounts.branda).toBeUndefined();
    expect((namedDeleted.channels as Record<string, any>).wemp.accounts.brandb).toBeTruthy();
  });
});
