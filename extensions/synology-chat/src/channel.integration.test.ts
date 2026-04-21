import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContextMock,
  registerPluginHttpRouteMock,
  resolveAgentRouteMock,
} from "./channel.test-mocks.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

type _RegisteredRoute = {
  path: string;
  accountId: string;
  match?: "exact" | "prefix";
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
};

let createSynologyChatPlugin: typeof import("./channel.js").createSynologyChatPlugin;
let clearSynologyHostedMediaStateForTest: typeof import("./media-proxy.js").clearSynologyHostedMediaStateForTest;
let resolveSynologyWebhookFileUrl: typeof import("./media-proxy.js").resolveSynologyWebhookFileUrl;

function makeStartContext<T>(cfg: T, accountId: string, abortSignal: AbortSignal) {
  return {
    cfg,
    accountId,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    abortSignal,
  };
}

describe("Synology channel wiring integration", () => {
  beforeAll(async () => {
    ({ createSynologyChatPlugin } = await import("./channel.js"));
    ({ clearSynologyHostedMediaStateForTest, resolveSynologyWebhookFileUrl } =
      await import("./media-proxy.js"));
  });

  beforeEach(() => {
    clearSynologyHostedMediaStateForTest();
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    finalizeInboundContextMock.mockClear();
    resolveAgentRouteMock.mockClear();
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const cfg = {
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
    };

    const started = plugin.gateway.startAccount(
      makeStartContext(cfg, "alerts", abortController.signal),
    );
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);

    const firstCall = registerPluginHttpRouteMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    if (!firstCall) {
      throw new Error("Expected registerPluginHttpRoute to be called");
    }
    const registered = firstCall[0];
    expect(registered.path).toBe("/webhook/synology-alerts");
    expect(registered.accountId).toBe("alerts");
    expect(registerPluginHttpRouteMock.mock.calls[1]?.[0]).toMatchObject({
      path: "/webhook/synology-alerts/__openclaw-media/",
      accountId: "alerts",
      match: "prefix",
    });

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

  it("isolates same user_id across different accounts", async () => {
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
              dmPolicy: "open",
            },
            beta: {
              enabled: true,
              token: "token-beta",
              incomingUrl: "https://nas.example.com/incoming-beta",
              webhookPath: "/webhook/synology-beta",
              dmPolicy: "open",
            },
          },
        },
      },
      session: {
        dmScope: "main" as const,
      },
    };

    const alphaStarted = plugin.gateway.startAccount(
      makeStartContext(cfg, "alpha", alphaAbortController.signal),
    );
    const betaStarted = plugin.gateway.startAccount(
      makeStartContext(cfg, "beta", betaAbortController.signal),
    );

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(4);
    const alphaRoute = registerPluginHttpRouteMock.mock.calls.find(
      ([route]) => route.path === "/webhook/synology-alpha" && route.match !== "prefix",
    )?.[0];
    const betaRoute = registerPluginHttpRouteMock.mock.calls.find(
      ([route]) => route.path === "/webhook/synology-beta" && route.match !== "prefix",
    )?.[0];
    if (!alphaRoute || !betaRoute) {
      throw new Error("Expected both Synology Chat routes to register");
    }

    const alphaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-alpha",
        user_id: "123",
        username: "alice",
        text: "alpha secret",
      }),
    );
    const alphaRes = makeRes();
    await alphaRoute.handler(alphaReq, alphaRes);

    const betaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-beta",
        user_id: "123",
        username: "bob",
        text: "beta secret",
      }),
    );
    const betaRes = makeRes();
    await betaRoute.handler(betaReq, betaRes);

    expect(alphaRes._status).toBe(204);
    expect(betaRes._status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);

    const alphaCtx = finalizeInboundContextMock.mock.calls[0]?.[0];
    const betaCtx = finalizeInboundContextMock.mock.calls[1]?.[0];
    expect(alphaCtx).toMatchObject({
      AccountId: "alpha",
      SessionKey: "agent:agent-alpha:synology-chat:alpha:direct:123",
    });
    expect(betaCtx).toMatchObject({
      AccountId: "beta",
      SessionKey: "agent:agent-beta:synology-chat:beta:direct:123",
    });

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });

  it("does not activate hosted media when the media route registration conflicts", async () => {
    type LoggedRegisteredRoute = _RegisteredRoute & {
      log?: (message: string) => void;
    };

    registerPluginHttpRouteMock.mockImplementation((params: LoggedRegisteredRoute) => {
      if (params.match === "prefix") {
        params.log?.(
          `plugin: route conflict at ${params.path} (prefix) for account "${params.accountId}"`,
        );
        return vi.fn();
      }
      return vi.fn();
    });

    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alerts: {
              enabled: true,
              token: "valid-token",
              incomingUrl: "https://nas.example.com/incoming",
              publicOrigin: "https://gateway-config.example.com",
              webhookPath: "/webhook/synology-alerts",
              dmPolicy: "allowlist",
              allowedUserIds: ["456"],
            },
          },
        },
      },
    };

    const started = plugin.gateway.startAccount(
      makeStartContext(cfg, "alerts", abortController.signal),
    );
    const account: ResolvedSynologyChatAccount = {
      accountId: "alerts",
      enabled: true,
      token: "valid-token",
      incomingUrl: "https://nas.example.com/incoming",
      nasHost: "localhost",
      publicOrigin: "https://gateway-config.example.com",
      webhookPath: "/webhook/synology-alerts",
      webhookPathSource: "account",
      dangerouslyAllowNameMatching: false,
      dangerouslyAllowInheritedWebhookPath: false,
      dmPolicy: "allowlist",
      allowedUserIds: ["456"],
      rateLimitPerMinute: 30,
      botName: "OpenClaw",
      allowInsecureSsl: false,
    };

    const resolved = await resolveSynologyWebhookFileUrl({
      account,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toBeNull();
    abortController.abort();
    await started;
  });
});
