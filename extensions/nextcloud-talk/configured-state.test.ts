import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { hasConfiguredNextcloudTalkChannelState } from "./configured-state.js";

describe("Nextcloud Talk lightweight configured-state", () => {
  it("declares the account owner as the package configured-state checker", () => {
    const manifest = createRequire(import.meta.url)("./package.json") as {
      openclaw: { channel: { configuredState: unknown } };
    };

    expect(manifest.openclaw.channel.configuredState).toEqual({
      specifier: "./configured-state",
      exportName: "hasConfiguredNextcloudTalkChannelState",
    });
  });

  it("rejects an environment secret without a configured Nextcloud URL", () => {
    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg: {},
        env: { NEXTCLOUD_TALK_BOT_SECRET: "nextcloud-secret" },
      }),
    ).toBe(false);
  });

  it("recognizes an environment secret when the Nextcloud URL is configured", () => {
    const cfg: OpenClawConfig = {
      channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.com" } },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "nextcloud-secret" },
      }),
    ).toBe(true);
  });

  it("does not treat the optional API password as the required webhook bot secret", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          apiUser: "nextcloud-user",
        },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_API_PASSWORD: "optional-api-password" },
      }),
    ).toBe(false);
  });

  it("preserves the historical API-password environment alongside valid bot credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          apiUser: "nextcloud-user",
        },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: {
          NEXTCLOUD_TALK_API_PASSWORD: "optional-api-password",
          NEXTCLOUD_TALK_BOT_SECRET: "required-bot-secret",
        },
      }),
    ).toBe(true);
  });

  it("requires a bot secret even when an inline API user and password are configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          apiUser: "nextcloud-user",
          apiPassword: "optional-api-password",
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects a whitespace-only Nextcloud URL", () => {
    const cfg: OpenClawConfig = {
      channels: { "nextcloud-talk": { baseUrl: "   " } },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "nextcloud-secret" },
      }),
    ).toBe(false);
  });

  it("rejects a whitespace-only environment secret", () => {
    const cfg: OpenClawConfig = {
      channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.com" } },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "   " },
      }),
    ).toBe(false);
  });

  it("recognizes a configured inline bot secret", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "nextcloud-secret",
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes a configured bot-secret reference", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_OWNER_SECRET",
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes a configured bot-secret file", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecretFile: "/run/secrets/nextcloud-talk",
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("rejects a configured Nextcloud URL without any bot secret", () => {
    const cfg: OpenClawConfig = {
      channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.com" } },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes inline credentials on a named Nextcloud account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              baseUrl: "https://cloud.example.com",
              botSecret: "nextcloud-work-secret",
            },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes a named account inheriting the configured Nextcloud URL", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          accounts: { work: { botSecret: "nextcloud-work-secret" } },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes a named account bot-secret reference", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              baseUrl: "https://cloud.example.com",
              botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_WORK_SECRET" },
            },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes a configured named account bot-secret file", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              baseUrl: "https://cloud.example.com",
              botSecretFile: "/run/secrets/nextcloud-work",
            },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("does not assign a default-only environment secret to named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: { work: { baseUrl: "https://cloud.example.com" } },
        },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "default-only-secret" },
      }),
    ).toBe(false);
  });

  it("rejects credentials belonging only to a disabled named account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              enabled: false,
              baseUrl: "https://cloud.example.com",
              botSecret: "nextcloud-work-secret",
            },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("allows environment secrets on an explicitly mapped default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          accounts: { default: { baseUrl: "https://cloud.example.com" } },
        },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "default-only-secret" },
      }),
    ).toBe(true);
  });

  it("rejects ambient credentials for an explicitly disabled default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          accounts: { default: { enabled: false } },
        },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "default-only-secret" },
      }),
    ).toBe(false);
  });

  it("rejects root credentials for an explicitly disabled default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "root-bot-secret",
          accounts: { default: { enabled: false } },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes an active named account beside an explicitly disabled default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          accounts: {
            default: { enabled: false },
            work: { botSecret: "work-bot-secret" },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });

  it("rejects a disabled channel with complete ambient bot credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": { enabled: false, baseUrl: "https://cloud.example.com" },
      },
    };

    expect(
      hasConfiguredNextcloudTalkChannelState({
        cfg,
        env: { NEXTCLOUD_TALK_BOT_SECRET: "default-only-secret" },
      }),
    ).toBe(false);
  });

  it("rejects an explicit default that clears its inherited Nextcloud URL", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "root-bot-secret",
          accounts: { default: { baseUrl: "" } },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects an explicit default that clears its inherited webhook secret", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "root-bot-secret",
          accounts: { default: { botSecret: "" } },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes an enabled named account beside an invalid merged Nextcloud default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "root-bot-secret",
          accounts: {
            default: { botSecret: "" },
            work: { botSecret: "work-bot-secret" },
          },
        },
      },
    };

    expect(hasConfiguredNextcloudTalkChannelState({ cfg, env: {} })).toBe(true);
  });
});
