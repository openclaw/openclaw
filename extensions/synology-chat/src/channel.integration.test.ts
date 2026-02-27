import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function makeReq(method: string, body: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.socket = { remoteAddress: "127.0.0.1" } as any;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(statusCode: number, _headers: Record<string, string>) {
      res._status = statusCode;
    },
    end(body?: string) {
      res._body = body ?? "";
    },
  } as any;
  return res;
}

function makeFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

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
