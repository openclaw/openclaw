import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  resolveAgentRoute as resolveAgentRouteForTest,
  type ResolveAgentRouteInput,
  type ResolvedAgentRoute,
} from "../../../src/routing/resolve-route.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";

type RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const registerPluginHttpRouteMock = vi.fn<(params: RegisteredRoute) => () => void>(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({ counts: {} });
const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
const loadConfigMock = vi.fn().mockResolvedValue({});
const defaultResolvedRoute = {
  agentId: "nas-code",
  channel: "synology-chat",
  accountId: "code-developer",
  sessionKey: "agent:nas-code:synology-chat:direct:123",
  mainSessionKey: "agent:nas-code:main",
  lastRoutePolicy: "session",
  matchedBy: "binding.account",
} satisfies ResolvedAgentRoute;
const resolveAgentRoute = vi.fn<(params: ResolveAgentRouteInput) => ResolvedAgentRoute>(() => ({
  ...defaultResolvedRoute,
}));

vi.mock("openclaw/plugin-sdk/synology-chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/synology-chat")>();
  return {
    ...actual,
    DEFAULT_ACCOUNT_ID: "default",
    setAccountEnabledInConfigSection: vi.fn((_opts: any) => ({})),
    registerPluginHttpRoute: registerPluginHttpRouteMock,
    buildChannelConfigSchema: vi.fn((schema: any) => ({ schema })),
    createFixedWindowRateLimiter: vi.fn(() => ({
      isRateLimited: vi.fn(() => false),
      size: vi.fn(() => 0),
      clear: vi.fn(),
    })),
  };
});

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: loadConfigMock },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext,
      },
      routing: {
        resolveAgentRoute,
      },
    },
  })),
}));

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
  resolveChatUserId: vi.fn().mockResolvedValue(undefined),
}));

const { createSynologyChatPlugin } = await import("./channel.js");
describe("Synology channel wiring integration", () => {
  beforeEach(() => {
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    finalizeInboundContext.mockClear();
    loadConfigMock.mockReset().mockResolvedValue({});
    resolveAgentRoute.mockReset().mockImplementation(() => ({ ...defaultResolvedRoute }));
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
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
    abortController.abort();
    await started;
  });

  it("routes inbound messages through account-scoped bindings before dispatch", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const cfg = {
      bindings: [
        { agentId: "nas-code", match: { channel: "synology-chat", accountId: "code-developer" } },
      ],
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            "code-developer": {
              enabled: true,
              token: "valid-token",
              incomingUrl: "https://nas.example.com/incoming",
              webhookPath: "/webhook/synology-code",
              dmPolicy: "allowlist",
              allowedUserIds: ["123"],
            },
          },
        },
      },
    };
    const ctx = {
      cfg,
      accountId: "code-developer",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: abortController.signal,
    };

    loadConfigMock.mockResolvedValue(cfg);
    const started = plugin.gateway.startAccount(ctx);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    const registered = registerPluginHttpRouteMock.mock.calls[0]?.[0];
    if (!registered) {
      throw new Error("Expected registerPluginHttpRoute to be called");
    }

    const req = makeReq(
      "POST",
      makeFormBody({
        token: "valid-token",
        user_id: "123",
        username: "bound-user",
        text: "Hello",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(204);
    expect(resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "synology-chat",
      accountId: "code-developer",
      peer: {
        kind: "direct",
        id: "123",
      },
    });
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:nas-code:synology-chat:direct:123",
        AccountId: "code-developer",
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionKey: "agent:nas-code:synology-chat:direct:123",
          AccountId: "code-developer",
        }),
      }),
    );

    abortController.abort();
    await started;
  });

  it("keeps real account-scoped session keys when dmScope requires account isolation", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const cfg: OpenClawConfig = {
      session: {
        dmScope: "per-account-channel-peer",
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "nas-code" }],
      },
      bindings: [
        {
          agentId: "nas-code",
          match: { channel: "synology-chat", accountId: "code-developer" },
        },
      ],
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            "code-developer": {
              enabled: true,
              token: "valid-token",
              incomingUrl: "https://nas.example.com/incoming",
              webhookPath: "/webhook/synology-code-account",
              dmPolicy: "allowlist",
              allowedUserIds: ["123"],
            },
          },
        },
      },
    };
    const ctx = {
      cfg,
      accountId: "code-developer",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: abortController.signal,
    };

    resolveAgentRoute.mockImplementation((params: ResolveAgentRouteInput) =>
      resolveAgentRouteForTest(params),
    );
    loadConfigMock.mockResolvedValue(cfg);

    const started = plugin.gateway.startAccount(ctx);
    const registered = registerPluginHttpRouteMock.mock.calls[0]?.[0];
    if (!registered) {
      throw new Error("Expected registerPluginHttpRoute to be called");
    }

    const req = makeReq(
      "POST",
      makeFormBody({
        token: "valid-token",
        user_id: "123",
        username: "bound-user",
        text: "Hello",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(204);
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:nas-code:synology-chat:code-developer:direct:123",
        AccountId: "code-developer",
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionKey: "agent:nas-code:synology-chat:code-developer:direct:123",
          AccountId: "code-developer",
        }),
      }),
    );

    abortController.abort();
    await started;
  });
});
