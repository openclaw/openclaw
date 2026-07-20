// Microsoft Graph Mail Wake tests cover config behavior.
import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import {
  buildGraphMailboxResource,
  DEFAULT_GRAPH_WAKE_PATH,
  DEFAULT_RENEW_EVERY_MINUTES,
  DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES,
  MAX_DURABLE_GRAPH_MAILBOXES,
  MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES,
  resolveGraphWakePluginConfig,
} from "./config.js";

const BASE_CONFIG = {
  notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
  auth: { bearerToken: "test-token" },
  mailboxes: {
    main: {
      user: "ops@example.com",
      wake: { sessionKey: "agent:main:main" },
    },
  },
};

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

function manifestAcceptsAuth(auth: unknown): boolean {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "msgraph-mail-wake.manifest.config-schema",
    value: { ...BASE_CONFIG, auth },
  }).ok;
}

describe("resolveGraphWakePluginConfig", () => {
  it("resolves a minimal config with defaults", () => {
    const resolved = resolveGraphWakePluginConfig({ pluginConfig: BASE_CONFIG });
    expect(resolved).not.toBeNull();
    expect(resolved?.path).toBe(DEFAULT_GRAPH_WAKE_PATH);
    expect(resolved?.subscription).toEqual({
      expirationMinutes: DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES,
      renewEveryMinutes: DEFAULT_RENEW_EVERY_MINUTES,
      handleLifecycleEvents: true,
    });
    expect(resolved?.mailboxes).toHaveLength(1);
    expect(resolved?.mailboxes[0]).toMatchObject({
      mailboxId: "main",
      user: "ops@example.com",
      changeType: "created",
      fetchMessage: true,
      resource: "users/ops%40example.com/messages",
      wake: { sessionKey: "agent:main:main", deliveryMode: "none" },
    });
  });

  it("returns null when disabled or no mailboxes are enabled", () => {
    expect(
      resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, enabled: false } }),
    ).toBeNull();
    expect(
      resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, mailboxes: {} } }),
    ).toBeNull();
    // Ships no-op like the webhooks plugin: an empty/default config must not throw.
    expect(resolveGraphWakePluginConfig({ pluginConfig: {} })).toBeNull();
    expect(resolveGraphWakePluginConfig({ pluginConfig: undefined })).toBeNull();
    expect(
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          mailboxes: { main: { ...BASE_CONFIG.mailboxes.main, enabled: false } },
        },
      }),
    ).toBeNull();
  });

  it("builds the canonical mailFolders resource when a folder is configured", () => {
    const resolved = resolveGraphWakePluginConfig({
      pluginConfig: {
        ...BASE_CONFIG,
        mailboxes: {
          main: { ...BASE_CONFIG.mailboxes.main, folder: "inbox" },
        },
      },
    });
    expect(resolved?.mailboxes[0]?.resource).toBe(
      "users/ops%40example.com/mailFolders('inbox')/messages",
    );
  });

  it("requires auth and notificationUrl once mailboxes are configured", () => {
    const { auth: _auth, ...withoutAuth } = BASE_CONFIG;
    expect(() => resolveGraphWakePluginConfig({ pluginConfig: withoutAuth })).toThrow(/auth/);
    const { notificationUrl: _url, ...withoutUrl } = BASE_CONFIG;
    expect(() =>
      resolveGraphWakePluginConfig({ pluginConfig: { ...withoutUrl, notificationUrl: undefined } }),
    ).toThrow(/notificationUrl/);
  });

  it("rejects a non-https notificationUrl", () => {
    expect(() =>
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          notificationUrl: "http://gateway.example.com/plugins/msgraph-mail-wake",
        },
      }),
    ).toThrow(/https/);
  });

  it("rejects a notificationUrl whose pathname does not match the route path", () => {
    expect(() =>
      resolveGraphWakePluginConfig({
        pluginConfig: { ...BASE_CONFIG, notificationUrl: "https://gateway.example.com/elsewhere" },
      }),
    ).toThrow(/must match the registered route path/);
    expect(() =>
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          path: "/graph/wake",
          notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
        },
      }),
    ).toThrow(/must match the registered route path/);
  });

  it("supports client-credentials auth and rejects mixed auth shapes", () => {
    const resolved = resolveGraphWakePluginConfig({
      pluginConfig: {
        ...BASE_CONFIG,
        auth: {
          tenantId: "t",
          clientId: "c",
          clientSecret: { source: "env", provider: "default", id: "GRAPH_SECRET" },
        },
      },
    });
    expect(resolved?.auth).toMatchObject({ tenantId: "t", clientId: "c" });
    expect(() =>
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          auth: { tenantId: "t", clientId: "c", clientSecret: "s", bearerToken: "b" },
        },
      }),
    ).toThrow();
  });

  it.each([
    ["empty", {}],
    ["incomplete client credentials", { tenantId: "tenant", clientId: "client" }],
    [
      "mixed modes",
      { tenantId: "tenant", clientId: "client", clientSecret: "secret", bearerToken: "token" },
    ],
    ["blank bearer token", { bearerToken: "   " }],
    ["blank client id", { tenantId: "tenant", clientId: "   ", clientSecret: "secret" }],
    [
      "blank secret ref field",
      {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: { source: "env", provider: "   ", id: "GRAPH_SECRET" },
      },
    ],
  ])("keeps runtime and manifest auth rejection aligned for %s", (_label, auth) => {
    expect(() =>
      resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, auth } }),
    ).toThrow();
    expect(manifestAcceptsAuth(auth)).toBe(false);
  });

  it.each([
    ["bearer token", { bearerToken: "token" }],
    ["client credentials", { tenantId: "tenant", clientId: "client", clientSecret: "secret" }],
  ])("keeps runtime and manifest auth acceptance aligned for %s", (_label, auth) => {
    expect(resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, auth } })).not.toBeNull();
    expect(manifestAcceptsAuth(auth)).toBe(true);
  });

  it("uses the real Graph mail ceiling (10070) and a clock-skew-safe default (10000)", () => {
    // Live Graph rejects 10080 with "can only be 10070 minutes in the future";
    // the default sits below the ceiling so clock skew never trips the limit.
    expect(MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES).toBe(10_070);
    expect(DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES).toBe(10_000);
    expect(DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES).toBeLessThan(
      MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES,
    );
  });

  it("caps subscription expiration at the Graph mail limit", () => {
    expect(
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          subscription: { expirationMinutes: MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES },
        },
      })?.subscription.expirationMinutes,
    ).toBe(MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES);
    expect(() =>
      resolveGraphWakePluginConfig({
        pluginConfig: {
          ...BASE_CONFIG,
          subscription: { expirationMinutes: MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES + 1 },
        },
      }),
    ).toThrow();
  });

  it("fails closed before startup when enabled mailboxes exceed durable capacity", () => {
    const mailboxes = Object.fromEntries(
      Array.from({ length: MAX_DURABLE_GRAPH_MAILBOXES + 1 }, (_, index) => [
        `mailbox-${String(index)}`,
        {
          user: `user-${String(index)}@example.com`,
          wake: { sessionKey: `agent:main:mailbox-${String(index)}` },
        },
      ]),
    );
    expect(() =>
      resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, mailboxes } }),
    ).toThrow(`at most ${String(MAX_DURABLE_GRAPH_MAILBOXES)} enabled mailboxes`);

    delete mailboxes[`mailbox-${String(MAX_DURABLE_GRAPH_MAILBOXES)}`];
    expect(
      resolveGraphWakePluginConfig({ pluginConfig: { ...BASE_CONFIG, mailboxes } })?.mailboxes,
    ).toHaveLength(MAX_DURABLE_GRAPH_MAILBOXES);
  });
});

describe("buildGraphMailboxResource", () => {
  it("escapes single quotes in folder names", () => {
    expect(buildGraphMailboxResource({ user: "u", folder: "o'brien" })).toBe(
      "users/u/mailFolders('o''brien')/messages",
    );
  });
});
