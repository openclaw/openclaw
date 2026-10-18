// Synology Chat tests cover channel.integration plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelInboundEventContextMock,
  channelInboundRunMock,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContextMock,
  registerPluginHttpRouteMock,
  resolveAgentRouteMock,
  setSynologyRuntimeConfigForTest,
  synologyIngressStartMock,
  synologyIngressStopMock,
  tryHandleSynologyHostedMediaRequestMock,
} from "./channel.test-mocks.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";
import type { SynologyChatChannelConfig } from "./types.js";

function account(overrides: SynologyChatChannelConfig = {}) {
  return {
    enabled: true,
    token: "valid-token",
    incomingUrl: "https://nas.example.com/incoming",
    webhookPath: "/webhook/synology",
    dmPolicy: "allowlist" as const,
    allowedUserIds: ["123"],
    ...overrides,
  };
}

function config(channel: SynologyChatChannelConfig = account()) {
  return { channels: { "synology-chat": channel } };
}

function request(fields: Record<string, string>, options?: Parameters<typeof makeReq>[2]) {
  return makeReq("POST", makeFormBody({ user_id: "123", text: "Hello", ...fields }), options);
}

let synologyChatPlugin: typeof import("./channel.js").synologyChatPlugin;

function makeStartContext<T>(cfg: T, accountId: string, abortSignal: AbortSignal) {
  setSynologyRuntimeConfigForTest(cfg);
  return {
    cfg,
    accountId,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    abortSignal,
  };
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  index: number,
  label: string,
): TArgs {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

describe("Synology channel wiring integration", () => {
  beforeAll(async () => {
    ({ synologyChatPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    buildChannelInboundEventContextMock.mockClear();
    channelInboundRunMock.mockClear();
    finalizeInboundContextMock.mockClear();
    resolveAgentRouteMock.mockClear();
    synologyIngressStartMock.mockClear();
    synologyIngressStopMock.mockClear();
    tryHandleSynologyHostedMediaRequestMock.mockClear();
    tryHandleSynologyHostedMediaRequestMock.mockResolvedValue(false);
    setSynologyRuntimeConfigForTest({});
  });

  it("re-enables a configured named account without replacing root or sibling credentials", async () => {
    const { synologyChatSetupAdapter } = await import("./setup-surface.js");
    const input = { token: "replacement", url: "https://nas.example.com/alerts" };
    const configured = synologyChatSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          "synology-chat": {
            enabled: false,
            token: "root-token",
            accounts: {
              alerts: { enabled: false, token: "old-alerts", webhookPath: "/alerts" },
              sibling: { enabled: false, token: "sibling-token" },
            },
          },
        },
      },
      accountId: "alerts",
      input,
    });

    expect(configured).toEqual({
      channels: {
        "synology-chat": {
          enabled: true,
          token: "root-token",
          accounts: {
            alerts: {
              enabled: true,
              token: "replacement",
              webhookPath: "/alerts",
              incomingUrl: "https://nas.example.com/alerts",
            },
            sibling: { enabled: false, token: "sibling-token" },
          },
        },
      },
    });
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = synologyChatPlugin;
    const abortController = new AbortController();
    const cfg = config({
      enabled: true,
      accounts: {
        alerts: account({ webhookPath: "/webhook/synology-alerts", allowedUserIds: ["456"] }),
      },
    });

    const started = plugin.gateway.startAccount(
      makeStartContext(cfg, "alerts", abortController.signal),
    );
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);

    const [registered] = requireMockCall(registerPluginHttpRouteMock, 0, "alerts route");
    expect(registered).toMatchObject({
      path: "/webhook/synology-alerts",
      accountId: "alerts",
      throwOnFailure: true,
    });

    const req = request({
      token: "valid-token",
      username: "unauthorized-user",
      post_id: "post-allowlist-rejected",
    });
    const res = makeRes();
    await registered.handler(req, res);

    expect(res.status).toBe(403);
    expect(res.body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    abortController.abort();
    await started;
  });

  it("dispatches hosted GET and HEAD capabilities before the inbound webhook parser", async () => {
    const abortController = new AbortController();
    const cfg = config(account({ webhookUrl: "https://gateway.example.com/webhook/synology" }));
    const started = synologyChatPlugin.gateway.startAccount(
      makeStartContext(cfg, "default", abortController.signal),
    );
    const [registered] = requireMockCall(
      registerPluginHttpRouteMock,
      0,
      "Synology hosted media route",
    );
    tryHandleSynologyHostedMediaRequestMock.mockResolvedValue(true);

    for (const method of ["GET", "HEAD"]) {
      await registered.handler(
        makeReq(method, "", {
          url: "/webhook/synology?__openclaw_synology_media_token_id=token",
        }),
        makeRes(),
      );
    }

    expect(tryHandleSynologyHostedMediaRequestMock).toHaveBeenCalledTimes(2);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    abortController.abort();
    await started;
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const abortController = new AbortController();
    const statusSink = vi.fn();
    const cfg = config();
    registerPluginHttpRouteMock.mockImplementationOnce(() => {
      throw new Error("Synology route conflict");
    });

    await expect(
      synologyChatPlugin.gateway.startAccount({
        ...makeStartContext(cfg, "default", abortController.signal),
        setStatus: statusSink,
      }),
    ).rejects.toThrow("Synology route conflict");

    expect(synologyIngressStartMock).toHaveBeenCalledOnce();
    expect(synologyIngressStopMock).toHaveBeenCalledOnce();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("uses gateway trusted proxy settings for pre-auth invalid-token throttling", async () => {
    const plugin = synologyChatPlugin;
    const abortController = new AbortController();
    const cfg = {
      gateway: {
        trustedProxies: ["127.0.0.1"],
      },
      ...config(account({ dmPolicy: "open", allowedUserIds: ["*"], rateLimitPerMinute: 1 })),
    };

    const startContext = makeStartContext(cfg, "default", abortController.signal);
    const started = plugin.gateway.startAccount(startContext);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    const [registered] = requireMockCall(registerPluginHttpRouteMock, 0, "default Synology route");

    for (let i = 0; i < 2; i += 1) {
      const req = request(
        {
          token: "wrong-token",
          username: "attacker",
        },
        { headers: { "x-forwarded-for": "198.51.100.9" } },
      );
      (req.socket as { remoteAddress?: string }).remoteAddress = "127.0.0.1";
      const res = makeRes();
      await registered.handler(req, res);
      expect(res.status).toBe(i === 0 ? 401 : 429);
    }

    const validReq = request(
      {
        token: "valid-token",
        username: "legitimate-user",
        post_id: "post-proxy-accepted",
      },
      { headers: { "x-forwarded-for": "203.0.113.11" } },
    );
    (validReq.socket as { remoteAddress?: string }).remoteAddress = "127.0.0.1";
    const validRes = makeRes();
    await registered.handler(validReq, validRes);

    expect(validRes.status, JSON.stringify(startContext.log.error.mock.calls)).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(channelInboundRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnAdoptionLifecycle: expect.objectContaining({ admission: "exclusive" }),
      }),
    );
    abortController.abort();
    await started;
  });

  it("isolates same user_id across different accounts", async () => {
    const plugin = synologyChatPlugin;
    const alphaAbortController = new AbortController();
    const betaAbortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alpha: account({
              token: "token-alpha",
              incomingUrl: "https://nas.example.com/incoming-alpha",
              webhookPath: "/webhook/synology-alpha",
              dmPolicy: "open",
              allowedUserIds: ["*"],
            }),
            beta: account({
              token: "token-beta",
              incomingUrl: "https://nas.example.com/incoming-beta",
              webhookPath: "/webhook/synology-beta",
              dmPolicy: "open",
              allowedUserIds: ["*"],
            }),
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

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);
    const [alphaRoute] = requireMockCall(registerPluginHttpRouteMock, 0, "alpha Synology route");
    const [betaRoute] = requireMockCall(registerPluginHttpRouteMock, 1, "beta Synology route");

    const alphaReq = request({
      token: "token-alpha",
      username: "alice",
      text: "alpha secret",
      post_id: "post-alpha",
    });
    const alphaRes = makeRes();
    await alphaRoute.handler(alphaReq, alphaRes);

    const betaReq = request({
      token: "token-beta",
      username: "bob",
      text: "beta secret",
      post_id: "post-beta",
    });
    const betaRes = makeRes();
    await betaRoute.handler(betaReq, betaRes);

    expect(alphaRes.status).toBe(204);
    expect(betaRes.status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);

    const [alphaCtx] = requireMockCall(finalizeInboundContextMock, 0, "alpha inbound context");
    const [betaCtx] = requireMockCall(finalizeInboundContextMock, 1, "beta inbound context");
    const alphaContext = requireRecord(alphaCtx, "alpha inbound context");
    expect(alphaContext).toMatchObject({
      AccountId: "alpha",
      SessionKey: "agent:agent-alpha:synology-chat:alpha:direct:123",
    });
    const betaContext = requireRecord(betaCtx, "beta inbound context");
    expect(betaContext).toMatchObject({
      AccountId: "beta",
      SessionKey: "agent:agent-beta:synology-chat:beta:direct:123",
    });

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });
});
