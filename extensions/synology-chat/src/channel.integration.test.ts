import { beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayRuntimeModule from "./gateway-runtime.js";

const registerSynologyWebhookRouteMock = vi
  .spyOn(gatewayRuntimeModule, "registerSynologyWebhookRoute")
  .mockImplementation(() => vi.fn());

const freshChannelModulePath = "./channel.js?channel-integration-test";
const { createSynologyChatPlugin } = await import(freshChannelModulePath);

async function expectPendingStartAccountPromise(
  result: Promise<unknown>,
  abortController: AbortController,
) {
  expect(result).toBeInstanceOf(Promise);
  const resolved = await Promise.race([
    result,
    new Promise((r) => setTimeout(() => r("pending"), 50)),
  ]);
  expect(resolved).toBe("pending");
  abortController.abort();
  await result;
}

describe("Synology channel wiring integration", () => {
  beforeEach(() => {
    registerSynologyWebhookRouteMock.mockClear();
    registerSynologyWebhookRouteMock.mockImplementation(() => vi.fn());
  });

  it("registers the gateway route with resolved named-account config", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const ctx = {
      cfg: {
        channels: {
          "synology-chat": {
            enabled: true,
            accounts: {
              alerts: {
                enabled: true,
                token: "valid-token",
                incomingUrl: "https://nas.example.com/incoming",
                webhookPath: "/webhook/synology-alerts",
                dmPolicy: "allowlist",
                allowedUserIds: ["456"],
              },
            },
          },
        },
      },
      accountId: "alerts",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: abortController.signal,
    };

    const started = plugin.gateway.startAccount(ctx);
    expect(registerSynologyWebhookRouteMock).toHaveBeenCalledTimes(1);

    const firstCall = registerSynologyWebhookRouteMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    if (!firstCall) throw new Error("Expected registerSynologyWebhookRoute to be called");

    const registered = firstCall[0];
    expect(registered.accountId).toBe("alerts");
    expect(registered.account).toMatchObject({
      accountId: "alerts",
      token: "valid-token",
      incomingUrl: "https://nas.example.com/incoming",
      webhookPath: "/webhook/synology-alerts",
      webhookPathSource: "explicit",
      dmPolicy: "allowlist",
      allowedUserIds: ["456"],
    });

    await expectPendingStartAccountPromise(started, abortController);
  });

  it("passes distinct resolved accounts for separate named-account starts", async () => {
    const plugin = createSynologyChatPlugin();
    const alphaAbortController = new AbortController();
    const betaAbortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alpha: {
              enabled: true,
              token: "token-alpha",
              incomingUrl: "https://nas.example.com/incoming-alpha",
              webhookPath: "/webhook/synology-alpha",
              dmPolicy: "open" as const,
            },
            beta: {
              enabled: true,
              token: "token-beta",
              incomingUrl: "https://nas.example.com/incoming-beta",
              webhookPath: "/webhook/synology-beta",
              dmPolicy: "open" as const,
            },
          },
        },
      },
      session: {
        dmScope: "main" as const,
      },
    };

    const alphaStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "alpha",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: alphaAbortController.signal,
    });
    const betaStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "beta",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: betaAbortController.signal,
    });

    expect(registerSynologyWebhookRouteMock).toHaveBeenCalledTimes(2);

    const alphaCall = registerSynologyWebhookRouteMock.mock.calls[0]?.[0];
    const betaCall = registerSynologyWebhookRouteMock.mock.calls[1]?.[0];
    if (!alphaCall || !betaCall) {
      throw new Error("Expected both Synology Chat routes to register");
    }

    expect(alphaCall).toMatchObject({
      accountId: "alpha",
      account: {
        accountId: "alpha",
        token: "token-alpha",
        incomingUrl: "https://nas.example.com/incoming-alpha",
        webhookPath: "/webhook/synology-alpha",
        webhookPathSource: "explicit",
      },
    });
    expect(betaCall).toMatchObject({
      accountId: "beta",
      account: {
        accountId: "beta",
        token: "token-beta",
        incomingUrl: "https://nas.example.com/incoming-beta",
        webhookPath: "/webhook/synology-beta",
        webhookPathSource: "explicit",
      },
    });

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });
});
