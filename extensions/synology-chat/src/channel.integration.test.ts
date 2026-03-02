import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";

type RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const registerPluginHttpRouteMock = vi.fn<(params: RegisteredRoute) => () => void>(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({ counts: {} });

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn((_opts: any) => ({})),
  registerPluginHttpRoute: registerPluginHttpRouteMock,
  buildChannelConfigSchema: vi.fn((schema: any) => ({ schema })),
  createFixedWindowRateLimiter: vi.fn(() => ({
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
    clear: vi.fn(),
  })),
}));

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  })),
}));

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
}));

const { createSynologyChatPlugin } = await import("./channel.js");

describe("Synology channel wiring integration", () => {
  beforeEach(() => {
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = createSynologyChatPlugin();
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
    };

    const started = await plugin.gateway.startAccount(ctx);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);

    const firstCall = registerPluginHttpRouteMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    if (!firstCall) throw new Error("Expected registerPluginHttpRoute to be called");
    const registered = firstCall[0];
    expect(registered.path).toBe("/webhook/synology-alerts");
    expect(registered.accountId).toBe("alerts");
    expect(typeof registered.handler).toBe("function");

    const req = makeReq(
      "POST",
      makeFormBody({
        token: "valid-token",
        user_id: "123",
        username: "unauthorized-user",
        text: "Hello",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(403);
    expect(res._body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    started.stop();
  });
});
