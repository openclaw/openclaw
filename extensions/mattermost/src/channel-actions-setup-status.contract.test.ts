// Mattermost tests cover channel actions setup status.contract plugin behavior.
import {
  installChannelActionsContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { mattermostPlugin, mattermostSetupPlugin } from "../channel-plugin-api.js";

describe("mattermost actions contract", () => {
  installChannelActionsContractSuite({
    plugin: mattermostPlugin,
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes send and react while reads stay opt in",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "react"],
        expectedCapabilities: ["presentation"],
      },
      {
        name: "disabled reactions do not enable message reads",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
              actions: { reactions: false },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send"],
        expectedCapabilities: ["presentation"],
      },
      {
        name: "message reads can be disabled while send and react stay available",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token-placeholder",
              baseUrl: "https://chat.example.com",
              actions: { messages: false },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "react"],
        expectedCapabilities: ["presentation"],
      },
      {
        name: "missing bot credentials disables the actions surface",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  });
});

describe("mattermost setup contract", () => {
  installChannelSetupContractSuite({
    plugin: mattermostSetupPlugin,
    cases: [
      {
        name: "default account stores token and normalized base URL",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "test-token",
          httpUrl: "https://chat.example.com/",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          const mattermostConfig = cfg.channels?.mattermost;
          if (!mattermostConfig) {
            throw new Error("expected Mattermost config patch");
          }
          expect(mattermostConfig.enabled).toBe(true);
          expect(mattermostConfig.botToken).toBe("test-token");
          expect(mattermostConfig.baseUrl).toBe("https://chat.example.com");
        },
      },
      {
        name: "missing credentials are rejected",
        cfg: {} as OpenClawConfig,
        input: {
          httpUrl: "",
        },
        expectedAccountId: "default",
        expectedValidation: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
    ],
  });
});

describe("mattermost status contract", () => {
  installChannelStatusContractSuite({
    plugin: mattermostPlugin,
    cases: [
      {
        name: "configured account preserves connectivity details in the snapshot",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          lastConnectedAt: 1234,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
          expect(snapshot.connected).toBe(true);
          expect(snapshot.baseUrl).toBe("https://chat.example.com");
        },
      },
    ],
  });
});

describe.each([
  ["runtime", mattermostPlugin],
  ["setup", mattermostSetupPlugin],
] as const)("mattermost %s account inspection", (_name, plugin) => {
  it("inspects source SecretRefs while strict account resolution rejects them", () => {
    const cfg = {
      channels: {
        mattermost: {
          baseUrl: "https://chat.example.com",
          accounts: {
            alpha: { botToken: { source: "env", provider: "default", id: "BOT_TOKEN" } },
          },
        },
      },
    } as OpenClawConfig;
    expect(plugin.config.listAccountIds(cfg)).toContain("alpha");
    expect(plugin.config.inspectAccount?.(cfg, "alpha")).toMatchObject({
      accountId: "alpha",
      configured: true,
      botTokenStatus: "configured_unavailable",
      botToken: undefined,
    });
    expect(() => plugin.config.resolveAccount(cfg, "alpha")).toThrow();
  });
});
