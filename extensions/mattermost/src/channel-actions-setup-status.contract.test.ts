import {
  installChannelActionsContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { mattermostPlugin, mattermostSetupPlugin } from "../channel-plugin-api.js";
import type { MattermostConfig } from "./types.js";

const configuredAccount = (overrides: Partial<MattermostConfig> = {}): OpenClawConfig => ({
  channels: {
    mattermost: {
      enabled: true,
      botToken: "test-token",
      baseUrl: "https://chat.example.com",
      ...overrides,
    },
  },
});

installChannelActionsContractSuite({
  plugin: mattermostPlugin,
  unsupportedAction: "poll",
  cases: [
    {
      name: "configured account exposes send and react while reads stay opt in",
      cfg: configuredAccount(),
      expectedActions: ["send", "react"],
      expectedCapabilities: ["presentation"],
    },
    {
      name: "disabled reactions do not enable message reads",
      cfg: configuredAccount({ actions: { reactions: false } }),
      expectedActions: ["send"],
      expectedCapabilities: ["presentation"],
    },
    {
      name: "message reads can be disabled while send and react stay available",
      cfg: configuredAccount({ actions: { messages: false } }),
      expectedActions: ["send", "react"],
      expectedCapabilities: ["presentation"],
    },
    {
      name: "missing bot credentials disables the actions surface",
      cfg: { channels: { mattermost: { enabled: true } } },
      expectedActions: [],
      expectedCapabilities: [],
    },
  ],
});

installChannelSetupContractSuite({
  plugin: mattermostSetupPlugin,
  cases: [
    {
      name: "default account stores token and normalized base URL",
      cfg: {},
      input: { botToken: "test-token", httpUrl: "https://chat.example.com/" },
      expectedAccountId: "default",
      assertPatchedConfig: (cfg) => {
        expect(cfg.channels?.mattermost).toMatchObject({
          enabled: true,
          botToken: "test-token",
          baseUrl: "https://chat.example.com",
        });
      },
    },
    {
      name: "missing credentials are rejected",
      cfg: {},
      input: { httpUrl: "" },
      expectedAccountId: "default",
      expectedValidation: "Mattermost requires --bot-token and --http-url (or --use-env).",
    },
  ],
});

installChannelStatusContractSuite({
  plugin: mattermostPlugin,
  cases: [
    {
      name: "configured account preserves connectivity details in the snapshot",
      cfg: configuredAccount(),
      runtime: { accountId: "default", connected: true, lastConnectedAt: 1234 },
      probe: { ok: true },
      assertSnapshot: (snapshot) => {
        expect(snapshot).toMatchObject({
          accountId: "default",
          enabled: true,
          configured: true,
          connected: true,
          baseUrl: "https://chat.example.com",
        });
      },
    },
  ],
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
