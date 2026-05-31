import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSmsWebhookRoute } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";

const registerPluginHttpRoute = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  registerPluginHttpRoute,
}));

function createAccount(accountId: string, webhookPath = "/webhooks/sms"): ResolvedSmsAccount {
  return {
    accountId,
    enabled: true,
    accountSid: `AC-${accountId}`,
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    webhookPath,
    publicWebhookUrl: `https://gateway.example.com${webhookPath}`,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
  };
}

describe("registerSmsWebhookRoute", () => {
  beforeEach(() => {
    registerPluginHttpRoute.mockClear();
  });

  it("rejects duplicate webhook paths across SMS accounts", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    const unregister = registerSmsWebhookRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });

    expect(() =>
      registerSmsWebhookRoute({
        cfg: {},
        account: createAccount("support"),
        channelRuntime,
      }),
    ).toThrow(/already registered by account default/u);

    unregister();
  });

  it("rejects duplicate webhook paths after route normalization", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    const unregister = registerSmsWebhookRoute({
      cfg: {},
      account: createAccount("default", "/webhooks/sms"),
      channelRuntime,
    });

    expect(() =>
      registerSmsWebhookRoute({
        cfg: {},
        account: createAccount("support", "webhooks/sms"),
        channelRuntime,
      }),
    ).toThrow(/already registered by account default/u);
    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(1);

    unregister();
  });

  it("allows distinct webhook paths across SMS accounts", () => {
    const channelRuntime = {} as SmsChannelRuntime;
    const unregisterDefault = registerSmsWebhookRoute({
      cfg: {},
      account: createAccount("default"),
      channelRuntime,
    });
    const unregisterSupport = registerSmsWebhookRoute({
      cfg: {},
      account: createAccount("support", "/webhooks/sms/support"),
      channelRuntime,
    });

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);

    unregisterSupport();
    unregisterDefault();
  });
});
