import {
  createNonExitingRuntimeEnv,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuProbeResult } from "./types.js";

const { begin, owner, init, poll, qr, probe } = vi.hoisted(() => ({
  begin: vi.fn(),
  owner: vi.fn(),
  init: vi.fn(),
  poll: vi.fn(),
  qr: vi.fn(),
  probe: vi.fn<() => Promise<FeishuProbeResult>>(),
}));
// mock-isolation: setup discovery must not probe the Feishu network.
vi.mock("./probe.js", () => ({ probeFeishu: probe }));
// mock-isolation: setup tests control registration and QR polling without remote account effects.
vi.mock("./app-registration.js", () => ({
  initAppRegistration: init,
  beginAppRegistration: begin,
  pollAppRegistration: poll,
  printQrCode: qr,
  getAppOwnerOpenId: owner,
}));
import { feishuPlugin } from "./channel.js";
import { setFeishuNamedAccountEnabled } from "./setup-core.js";

const credentials = <I, S>(appId: I, appSecret: S) => ({ appId, appSecret });
function credentialRefs(appId = "FEISHU_APP_ID", appSecret = "FEISHU_APP_SECRET") {
  const ref = (id: string) => ({ source: "env", id, provider: "default" });
  return credentials(ref(appId), ref(appSecret));
}
function answers(...values: string[]) {
  const mock = vi.fn();
  for (const value of values) {
    mock.mockResolvedValueOnce(value);
  }
  return mock;
}
const feishuConfigure = createPluginSetupWizardConfigure(feishuPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuPlugin);
const withFeishu = (feishu: Record<string, unknown>) => ({ channels: { feishu } });
const status = (feishu: Record<string, unknown>) =>
  feishuGetStatus({ cfg: withFeishu(feishu), accountOverrides: {} });
const scanPrompts = (domain = "feishu", policy = "allowlist") => ({
  select: answers("scan", domain, policy) as never,
});
async function configure(
  prompts: Parameters<typeof createTestWizardPrompter>[0] = {},
  feishu?: Record<string, unknown>,
  options?: Parameters<typeof feishuConfigure>[0]["options"],
) {
  const result = await runSetupWizardConfigure({
    configure: feishuConfigure,
    cfg: feishu ? withFeishu(feishu) : {},
    prompter: createTestWizardPrompter(prompts),
    runtime: createNonExitingRuntimeEnv(),
    options,
  });
  return result.cfg.channels?.feishu;
}
afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./app-registration.js");
  vi.resetModules();
});
beforeEach(() => {
  probe.mockReset().mockResolvedValue({ ok: false, error: "mocked" });
  init.mockReset().mockRejectedValue(new Error("mocked: scan-to-create not available"));
  begin.mockReset();
  poll.mockReset();
  qr.mockReset().mockResolvedValue(undefined);
  owner.mockReset().mockResolvedValue(undefined);
});

describe("feishu setup wizard", () => {
  it("preserves the exact named-account key without enabling the channel", () => {
    const accountId = " Alert Account ";
    const accountConfig = (enabled: boolean) =>
      withFeishu({
        enabled: false,
        accounts: { [accountId]: { appId: "kept", enabled }, sibling: { enabled: false } },
      });
    expect(setFeishuNamedAccountEnabled(accountConfig(false), accountId, true)).toEqual(
      accountConfig(true),
    );
  });

  it.each([
    ["manual default", "cli_manual", "secret_manual"],
    ["scan fallback", "cli_from_fallback", "secret_from_fallback"],
    ["SecretRef replacement", "cli_from_prompt", "secret_from_prompt"],
  ])("uses manual credentials via %s", async (mode, appId, appSecret) => {
    const scan = mode === "scan fallback";
    const refs = mode === "SecretRef replacement";
    const result = await configure(
      {
        text: answers(appId, appSecret),
        ...(scan ? scanPrompts() : {}),
        ...(refs
          ? {
              confirm: vi.fn(async () => true),
              select: vi.fn(
                async ({ initialValue }: { initialValue?: string }) => initialValue ?? "bot",
              ) as never,
            }
          : {}),
      },
      refs ? credentialRefs() : undefined,
    );
    const expected = {
      ...credentials(appId, appSecret),
      connectionMode: "websocket",
      domain: "feishu",
    };
    if (refs) {
      expect(result).toEqual({ ...expected, enabled: true, groupPolicy: "allowlist" });
    } else {
      if (scan) {
        expect(init).toHaveBeenCalledWith("feishu");
      } else {
        expect(init).not.toHaveBeenCalled();
      }
      expect(begin).not.toHaveBeenCalled();
      expect(result).toMatchObject(expected);
    }
  });

  it("passes selected domain through scan-to-create and poll", async () => {
    init.mockResolvedValueOnce(undefined);
    begin.mockResolvedValueOnce({
      deviceCode: "device-code",
      qrUrl: "https://accounts.larksuite.com/qr",
      interval: 1,
      expireIn: 10,
    });
    poll.mockResolvedValueOnce({
      status: "success",
      result: { ...credentials("cli_lark", "secret_lark"), domain: "lark", openId: "ou_owner" },
    });
    const beforePersistentEffect = vi.fn(async () => {});
    const result = await configure(scanPrompts("lark", "open"), undefined, {
      beforePersistentEffect,
    });
    expect(init).toHaveBeenCalledWith("lark");
    expect(begin).toHaveBeenCalledWith("lark");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      begin.mock.invocationCallOrder[0]!,
    );
    expect(poll.mock.calls.at(0)?.[0]).toMatchObject({
      deviceCode: "device-code",
      initialDomain: "lark",
      tp: "ob_cli_app",
    });
    expect(result).toMatchObject({
      ...credentials("cli_lark", "secret_lark"),
      domain: "lark",
      groupPolicy: "open",
      requireMention: true,
    });
  });

  it("propagates the persistent-effect guard before scan-to-create begins", async () => {
    init.mockResolvedValueOnce(undefined);
    const guardError = new Error("verified inference changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    await expect(configure(scanPrompts(), undefined, { beforePersistentEffect })).rejects.toBe(
      guardError,
    );
    expect(init).toHaveBeenCalledWith("feishu");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  it("probes the resolved default account in multi-account config", async () => {
    probe.mockResolvedValueOnce({ ok: true, botName: "Feishu Main" });
    const account = { ...credentials("cli_main", "main-app-secret"), connectionMode: "websocket" };
    expect(
      await status({
        enabled: true,
        defaultAccount: "main-bot",
        accounts: { "main-bot": account },
      }),
    ).toMatchObject({ configured: true, statusLines: ["Feishu: connected as Feishu Main"] });
    expect(probe).toHaveBeenCalledWith({
      accountId: "main-bot",
      enabled: true,
      configured: true,
      name: undefined,
      appId: account.appId,
      appSecret: account.appSecret,
      encryptKey: undefined,
      verificationToken: undefined,
      domain: "feishu",
      config: { enabled: true, ...account },
    });
  });

  it("localizes existing bot setup prompts and status lines", async () => {
    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      const confirm = vi.fn(async () => true);
      const note = vi.fn(async () => {});
      await configure({ confirm, note }, credentials("cli_a123456", "sample-app-credential"));
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "发现已有 bot（App ID：cli_a123456）。用于本次设置？",
        }),
      );
      expect(note).toHaveBeenCalledWith("Bot 已配置。", "");
    });
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    expect(
      (
        await status({
          appId: "top_level_app",
          accounts: { main: credentials("", "sample-app-credential") },
        })
      ).configured,
    ).toBe(false);
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const keys = ["FEISHU_APP_ID_STATUS_TEST", "FEISHU_APP_CREDENTIAL_STATUS_TEST"] as const;
    await withEnvAsync(
      {
        [keys[0]]: "cli_env_123",
        [keys[1]]: "env-credential-456",
      },
      async () => {
        expect((await status(credentialRefs(...keys))).configured).toBe(true);
      },
    );
  });
});
