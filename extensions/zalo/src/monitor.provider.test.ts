import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  deleteWebhook: vi.fn(),
  registerPluginWebhookRoute: vi.fn(),
  setWebhook: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    registerPluginWebhookRoute: hoisted.registerPluginWebhookRoute,
  };
});

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    deleteWebhook: hoisted.deleteWebhook,
    setWebhook: hoisted.setWebhook,
  };
});

import { monitorZaloProvider } from "./monitor.js";
import { setZaloRuntime } from "./runtime.js";

const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {
    webhookUrl: "https://example.com/zalo",
    webhookSecret: "supersecret",
    webhookPath: "/zalo-hook",
  },
};

describe("monitorZaloProvider webhook startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setZaloRuntime({
      logging: { shouldLogVerbose: () => false },
    } as PluginRuntime);
    hoisted.unregister.mockReset();
    hoisted.registerPluginWebhookRoute.mockReturnValue({
      ok: true,
      unregister: hoisted.unregister,
    });
    hoisted.setWebhook.mockResolvedValue({ ok: true });
    hoisted.deleteWebhook.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails before setting the remote webhook when local route registration is rejected", async () => {
    hoisted.registerPluginWebhookRoute.mockReturnValueOnce({
      ok: false,
      unregister: hoisted.unregister,
    });

    await expect(
      monitorZaloProvider({
        token: DEFAULT_ACCOUNT.token,
        account: DEFAULT_ACCOUNT,
        config: {} as OpenClawConfig,
        runtime: {},
        abortSignal: new AbortController().signal,
        useWebhook: true,
        webhookUrl: DEFAULT_ACCOUNT.config.webhookUrl,
        webhookSecret: DEFAULT_ACCOUNT.config.webhookSecret,
        webhookPath: DEFAULT_ACCOUNT.config.webhookPath,
        fetcher: vi.fn(),
      }),
    ).rejects.toThrow("Failed to register HTTP route: /zalo-hook");

    expect(hoisted.setWebhook).not.toHaveBeenCalled();
    expect(hoisted.unregister).not.toHaveBeenCalled();
  });

  it("unregisters the local route when remote webhook setup fails", async () => {
    hoisted.setWebhook.mockRejectedValueOnce(new Error("setWebhook failed"));

    await expect(
      monitorZaloProvider({
        token: DEFAULT_ACCOUNT.token,
        account: DEFAULT_ACCOUNT,
        config: {} as OpenClawConfig,
        runtime: {},
        abortSignal: new AbortController().signal,
        useWebhook: true,
        webhookUrl: DEFAULT_ACCOUNT.config.webhookUrl,
        webhookSecret: DEFAULT_ACCOUNT.config.webhookSecret,
        webhookPath: DEFAULT_ACCOUNT.config.webhookPath,
        fetcher: vi.fn(),
      }),
    ).rejects.toThrow("setWebhook failed");

    expect(hoisted.unregister).toHaveBeenCalledTimes(1);
  });
});
