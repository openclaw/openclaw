import {
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
    const cfg = configuredAccount({
      accounts: {
        alpha: { botToken: { source: "env", provider: "default", id: "BOT_TOKEN" } },
      },
    });
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
