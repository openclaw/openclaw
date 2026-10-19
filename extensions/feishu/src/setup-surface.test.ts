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

const {
  beginAppRegistrationMock,
  getAppOwnerOpenIdMock,
  initAppRegistrationMock,
  pollAppRegistrationMock,
  printQrCodeMock,
  probeFeishuMock,
} = vi.hoisted(() => ({
  beginAppRegistrationMock: vi.fn(),
  getAppOwnerOpenIdMock: vi.fn(),
  initAppRegistrationMock: vi.fn(),
  pollAppRegistrationMock: vi.fn(),
  printQrCodeMock: vi.fn(),
  probeFeishuMock: vi.fn<() => Promise<FeishuProbeResult>>(async () => ({
    ok: false,
    error: "mocked",
  })),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./app-registration.js", () => ({
  initAppRegistration: initAppRegistrationMock,
  beginAppRegistration: beginAppRegistrationMock,
  pollAppRegistration: pollAppRegistrationMock,
  printQrCode: printQrCodeMock,
  getAppOwnerOpenId: getAppOwnerOpenIdMock,
}));

import { feishuPlugin } from "./channel.js";
import { setFeishuNamedAccountEnabled } from "./setup-core.js";

async function getStatusWithEnvRefs(params: { appIdKey: string; appSecretKey: string }) {
  return status({
    appId: { source: "env", id: params.appIdKey, provider: "default" },
    appSecret: { source: "env", id: params.appSecretKey, provider: "default" },
  });
}

const feishuConfigure = createPluginSetupWizardConfigure(feishuPlugin);
const feishuGetStatus = createPluginSetupWizardStatus(feishuPlugin);
function withFeishu(feishu: Record<string, unknown>) {
  return { channels: { feishu } };
}
function status(feishu: Record<string, unknown>) {
  return feishuGetStatus({ cfg: withFeishu(feishu), accountOverrides: {} });
}
function configure(
  prompter: ReturnType<typeof createTestWizardPrompter>,
  feishu?: Record<string, unknown>,
  options?: Parameters<typeof feishuConfigure>[0]["options"],
) {
  return runSetupWizardConfigure({
    configure: feishuConfigure,
    cfg: feishu ? withFeishu(feishu) : {},
    prompter,
    runtime: createNonExitingRuntimeEnv(),
    options,
  });
}

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./app-registration.js");
  vi.resetModules();
});

describe("feishu setup wizard", () => {
  it("preserves the exact named-account key without enabling the channel", () => {
    const accountId = " Alert Account ";
    const result = setFeishuNamedAccountEnabled(
      withFeishu({
        enabled: false,
        accounts: {
          [accountId]: { appId: "kept", enabled: false },
          sibling: { enabled: false },
        },
      }),
      accountId,
      true,
    );

    expect(result).toEqual(
      withFeishu({
        enabled: false,
        accounts: {
          [accountId]: { appId: "kept", enabled: true },
          sibling: { enabled: false },
        },
      }),
    );
  });

  beforeEach(() => {
    probeFeishuMock.mockReset().mockResolvedValue({ ok: false, error: "mocked" });
    initAppRegistrationMock
      .mockReset()
      .mockRejectedValue(new Error("mocked: scan-to-create not available"));
    beginAppRegistrationMock.mockReset();
    pollAppRegistrationMock.mockReset();
    printQrCodeMock.mockReset().mockResolvedValue(undefined);
    getAppOwnerOpenIdMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses manual credentials by default instead of starting scan-to-create", async () => {
    const text = vi.fn().mockResolvedValueOnce("cli_manual").mockResolvedValueOnce("secret_manual");
    const prompter = createTestWizardPrompter({ text });

    const result = await configure(prompter);

    expect(initAppRegistrationMock).not.toHaveBeenCalled();
    expect(beginAppRegistrationMock).not.toHaveBeenCalled();
    expect(result.cfg.channels?.feishu).toMatchObject({
      appId: "cli_manual",
      appSecret: "secret_manual",
      connectionMode: "websocket",
      domain: "feishu",
    });
  });

  it("passes selected domain through scan-to-create and poll", async () => {
    initAppRegistrationMock.mockResolvedValueOnce(undefined);
    beginAppRegistrationMock.mockResolvedValueOnce({
      deviceCode: "device-code",
      qrUrl: "https://accounts.larksuite.com/qr",
      userCode: "user-code",
      interval: 1,
      expireIn: 10,
    });
    pollAppRegistrationMock.mockResolvedValueOnce({
      status: "success",
      result: {
        appId: "cli_lark",
        appSecret: "secret_lark",
        domain: "lark",
        openId: "ou_owner",
      },
    });
    const prompter = createTestWizardPrompter({
      select: vi
        .fn()
        .mockResolvedValueOnce("scan")
        .mockResolvedValueOnce("lark")
        .mockResolvedValueOnce("open") as never,
    });
    const beforePersistentEffect = vi.fn(async () => {});

    const result = await configure(prompter, undefined, { beforePersistentEffect });

    expect(initAppRegistrationMock).toHaveBeenCalledWith("lark");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(beginAppRegistrationMock).toHaveBeenCalledWith("lark");
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      beginAppRegistrationMock.mock.invocationCallOrder[0]!,
    );
    const [pollOptions] = pollAppRegistrationMock.mock.calls.at(0) ?? [];
    expect(pollOptions).toMatchObject({
      deviceCode: "device-code",
      initialDomain: "lark",
      tp: "ob_cli_app",
    });
    expect(result.cfg.channels?.feishu).toMatchObject({
      appId: "cli_lark",
      appSecret: "secret_lark",
      domain: "lark",
      groupPolicy: "open",
      requireMention: true,
    });
  });

  it("propagates the persistent-effect guard before scan-to-create begins", async () => {
    initAppRegistrationMock.mockResolvedValueOnce(undefined);
    const guardError = new Error("verified inference changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    const prompter = createTestWizardPrompter({
      select: vi.fn().mockResolvedValueOnce("scan").mockResolvedValueOnce("feishu") as never,
    });

    await expect(configure(prompter, undefined, { beforePersistentEffect })).rejects.toBe(
      guardError,
    );

    expect(initAppRegistrationMock).toHaveBeenCalledWith("feishu");
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(beginAppRegistrationMock).not.toHaveBeenCalled();
    expect(pollAppRegistrationMock).not.toHaveBeenCalled();
  });

  it("falls back to manual credentials when selected scan-to-create is unavailable", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_fallback")
      .mockResolvedValueOnce("secret_from_fallback");
    const prompter = createTestWizardPrompter({
      text,
      select: vi
        .fn()
        .mockResolvedValueOnce("scan")
        .mockResolvedValueOnce("feishu")
        .mockResolvedValueOnce("allowlist") as never,
    });

    const result = await configure(prompter);

    expect(initAppRegistrationMock).toHaveBeenCalledWith("feishu");
    expect(beginAppRegistrationMock).not.toHaveBeenCalled();
    expect(result.cfg.channels?.feishu).toMatchObject({
      appId: "cli_from_fallback",
      appSecret: "secret_from_fallback",
      domain: "feishu",
    });
  });

  it("prompts over SecretRef appId/appSecret config objects", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce("cli_from_prompt")
      .mockResolvedValueOnce("secret_from_prompt");
    const prompter = createTestWizardPrompter({
      text,
      confirm: vi.fn(async () => true),
      select: vi.fn(
        async ({ initialValue }: { initialValue?: string }) => initialValue ?? "bot",
      ) as never,
    });

    const result = await configure(prompter, {
      appId: { source: "env", id: "FEISHU_APP_ID", provider: "default" },
      appSecret: { source: "env", id: "FEISHU_APP_SECRET", provider: "default" },
    });

    expect(result.cfg.channels?.feishu).toEqual({
      appId: "cli_from_prompt",
      appSecret: "secret_from_prompt",
      enabled: true,
      domain: "feishu",
      connectionMode: "websocket",
      groupPolicy: "allowlist",
    });
  });
});

describe("feishu setup wizard status", () => {
  beforeEach(() => {
    probeFeishuMock.mockReset().mockResolvedValue({ ok: false, error: "mocked" });
  });

  it("probes the resolved default account in multi-account config", async () => {
    probeFeishuMock.mockResolvedValueOnce({ ok: true, botName: "Feishu Main" });

    const result = await status({
      enabled: true,
      defaultAccount: "main-bot",
      accounts: {
        "main-bot": {
          appId: "cli_main",
          appSecret: "main-app-secret", // pragma: allowlist secret
          connectionMode: "websocket",
        },
      },
    });

    expect(result.configured).toBe(true);
    expect(result.statusLines).toEqual(["Feishu: connected as Feishu Main"]);
    expect(probeFeishuMock).toHaveBeenCalledWith({
      accountId: "main-bot",
      selectionSource: "explicit-default",
      enabled: true,
      configured: true,
      name: undefined,
      appId: "cli_main",
      appSecret: "main-app-secret", // pragma: allowlist secret
      encryptKey: undefined,
      verificationToken: undefined,
      domain: "feishu",
      config: {
        enabled: true,
        appId: "cli_main",
        appSecret: "main-app-secret", // pragma: allowlist secret
        connectionMode: "websocket",
      },
    });
  });

  it("localizes existing bot setup prompts and status lines", async () => {
    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      const confirm = vi.fn(async () => true);
      const note = vi.fn(async () => {});
      const prompter = createTestWizardPrompter({
        confirm,
        note,
      });

      await configure(prompter, {
        appId: "cli_a123456",
        appSecret: "sample-app-credential", // pragma: allowlist secret
      });

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "发现已有 bot（App ID：cli_a123456）。用于本次设置？",
        }),
      );
      expect(note).toHaveBeenCalledWith("Bot 已配置。", "");
    });
  });

  it("does not fallback to top-level appId when account explicitly sets empty appId", async () => {
    const result = await status({
      appId: "top_level_app",
      accounts: { main: { appId: "", appSecret: "sample-app-credential" } }, // pragma: allowlist secret
    });
    expect(result.configured).toBe(false);
  });

  it("treats env SecretRef appId/appSecret as configured in status", async () => {
    const appIdKey = "FEISHU_APP_ID_STATUS_TEST";
    const appSecretKey = "FEISHU_APP_CREDENTIAL_STATUS_TEST"; // pragma: allowlist secret
    await withEnvAsync(
      {
        [appIdKey]: "cli_env_123",
        [appSecretKey]: "env-credential-456", // pragma: allowlist secret
      },
      async () => {
        const result = await getStatusWithEnvRefs({ appIdKey, appSecretKey });
        expect(result.configured).toBe(true);
      },
    );
  });
});
