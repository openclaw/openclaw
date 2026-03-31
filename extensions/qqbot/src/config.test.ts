import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { qqbotSetupPlugin } from "./channel.setup.js";
import { QQBotConfigSchema } from "./config-schema.js";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./config.js";

describe("qqbot config", () => {
  it("accepts SecretRef-backed credentials in the runtime schema", () => {
    const parsed = QQBotConfigSchema.safeParse({
      appId: "123456",
      clientSecret: {
        source: "env",
        provider: "default",
        id: "QQBOT_CLIENT_SECRET",
      },
      allowFrom: ["*"],
      audioFormatPolicy: {
        sttDirectFormats: [".wav"],
        uploadDirectFormats: [".mp3"],
        transcodeEnabled: false,
      },
      urlDirectUpload: false,
      upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
      upgradeMode: "doc",
      accounts: {
        bot2: {
          appId: "654321",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "QQBOT_CLIENT_SECRET_BOT2",
          },
          allowFrom: ["user-1"],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("preserves top-level media and upgrade config on the default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: "secret-value",
          audioFormatPolicy: {
            sttDirectFormats: [".wav"],
            uploadDirectFormats: [".mp3"],
            transcodeEnabled: false,
          },
          urlDirectUpload: false,
          upgradeUrl: "https://docs.openclaw.ai/channels/qqbot",
          upgradeMode: "hot-reload",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID);

    expect(resolved.clientSecret).toBe("secret-value");
    expect(resolved.config.audioFormatPolicy).toEqual({
      sttDirectFormats: [".wav"],
      uploadDirectFormats: [".mp3"],
      transcodeEnabled: false,
    });
    expect(resolved.config.urlDirectUpload).toBe(false);
    expect(resolved.config.upgradeUrl).toBe("https://docs.openclaw.ai/channels/qqbot");
    expect(resolved.config.upgradeMode).toBe("hot-reload");
  });

  it("rejects unresolved SecretRefs on runtime resolution", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "QQBOT_CLIENT_SECRET",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID)).toThrow(
      'channels.qqbot.clientSecret: unresolved SecretRef "env:default:QQBOT_CLIENT_SECRET"',
    );
  });

  it("allows unresolved SecretRefs for setup/status flows", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "QQBOT_CLIENT_SECRET",
          },
        },
      },
    } as OpenClawConfig;

    const resolved = resolveQQBotAccount(cfg, DEFAULT_ACCOUNT_ID, {
      allowUnresolvedSecretRef: true,
    });

    expect(resolved.clientSecret).toBe("");
    expect(resolved.secretSource).toBe("config");
    expect(qqbotSetupPlugin.config.isConfigured?.(resolved, cfg)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(resolved, cfg)?.configured).toBe(true);
  });

  it.each([
    {
      accountId: DEFAULT_ACCOUNT_ID,
      inputAccountId: DEFAULT_ACCOUNT_ID,
      expectedPath: ["channels", "qqbot"],
    },
    {
      accountId: "bot2",
      inputAccountId: "bot2",
      expectedPath: ["channels", "qqbot", "accounts", "bot2"],
    },
  ])("splits --token on the first colon for $accountId", ({ inputAccountId, expectedPath }) => {
    const setup = qqbotSetupPlugin.setup;
    expect(setup).toBeDefined();

    const next = setup!.applyAccountConfig?.({
      cfg: {} as OpenClawConfig,
      accountId: inputAccountId,
      input: {
        token: "102905186:Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
      },
    }) as Record<string, unknown>;

    const accountConfig = expectedPath.reduce<unknown>((value, key) => {
      if (!value || typeof value !== "object") {
        return undefined;
      }
      return (value as Record<string, unknown>)[key];
    }, next) as Record<string, unknown> | undefined;

    expect(accountConfig).toMatchObject({
      enabled: true,
      appId: "102905186",
      clientSecret: "Oi2Mg1Mh2Ni3:Pl7TpBXuHe1OmAYwKi7W",
    });
  });
});
