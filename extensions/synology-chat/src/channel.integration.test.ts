// Synology Chat tests cover channel.integration plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    setStatus: vi.fn(),
  };
}

function startAccount(
  cfg: Parameters<typeof synologyChatPlugin.gateway.startAccount>[0]["cfg"],
  accountId = "default",
) {
  const controller = new AbortController();
  const ctx = makeStartContext(cfg, accountId, controller.signal);
  const started = synologyChatPlugin.gateway.startAccount(ctx);
  return {
    ctx,
    task: started,
    stop: async () => {
      controller.abort();
      await started;
    },
  };
}

const routeAt = (index = 0) =>
  expectDefined(registerPluginHttpRouteMock.mock.calls[index], "registered route")[0];
async function post(
  route: ReturnType<typeof routeAt>,
  fields: Record<string, string>,
  options?: Parameters<typeof makeReq>[2],
) {
  const res = makeRes();
  await route.handler(request(fields, options), res);
  return res;
}

describe("Synology channel wiring integration", () => {
  beforeAll(async () => {
    ({ synologyChatPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    vi.stubEnv("SYNOLOGY_CHAT_TOKEN", "");
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
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
  afterEach(() => vi.unstubAllEnvs());

  function namedConfig(overrides: SynologyChatChannelConfig) {
    return config(
      account({
        webhookPath: "/webhook/shared",
        webhookUrl: "https://gateway.example.com/shared",
        accounts: {
          alerts: {
            enabled: true,
            token: "alerts-token",
            incomingUrl: "https://nas/alerts",
            ...overrides,
          },
        },
      }),
    );
  }

  it.each([
    ["disabled", config({ enabled: false }), "default", ""],
    ["empty allowlist", config(account({ allowedUserIds: [] })), "default", "empty allowedUserIds"],
    [
      "empty open policy",
      config(account({ dmPolicy: "open", allowedUserIds: [] })),
      "default",
      "dmPolicy=open but empty allowedUserIds",
    ],
    [
      "inherited path",
      namedConfig({ dmPolicy: "allowlist", allowedUserIds: ["123"] }),
      "alerts",
      "must set an explicit webhookPath",
    ],
    [
      "duplicate path",
      namedConfig({ webhookPath: "/webhook/shared", dmPolicy: "open", allowedUserIds: ["*"] }),
      "alerts",
      "conflicts on webhookPath",
    ],
    [
      "duplicate URL",
      namedConfig({
        webhookPath: "/alerts",
        webhookUrl: "https://gateway.example.com/shared",
        dmPolicy: "open",
        allowedUserIds: ["*"],
      }),
      "alerts",
      "conflicts on webhookUrl",
    ],
  ] as const)("blocks startup for %s until aborted", async (_name, cfg, id, warning) => {
    const { ctx, task, stop } = startAccount(cfg, id);
    let settled = false;
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(task).toBeInstanceOf(Promise);
    expect(settled).toBe(false);
    if (warning) {
      expect(JSON.stringify(ctx.log.warn.mock.calls)).toContain(warning);
    } else {
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "Synology Chat account failed startup validation",
      });
    }
    expect(registerPluginHttpRouteMock).not.toHaveBeenCalled();
    await stop();
  });

  it("publishes ready after registration and stopped after cleanup", async () => {
    const { ctx, stop } = startAccount(config());
    await vi.waitFor(() => expect(registerPluginHttpRouteMock).toHaveBeenCalledOnce());
    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    await stop();
    expect(registerPluginHttpRouteMock.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(ctx.setStatus).toHaveBeenLastCalledWith({
      accountId: "default",
      running: false,
      connected: false,
      lifecycle: "stopped",
    });
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
    const cfg = config({
      enabled: true,
      accounts: {
        alerts: account({ webhookPath: "/webhook/synology-alerts", allowedUserIds: ["456"] }),
      },
    });
    const { stop } = startAccount(cfg, "alerts");
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    const registered = routeAt();
    expect(registered).toMatchObject({
      path: "/webhook/synology-alerts",
      accountId: "alerts",
      throwOnFailure: true,
    });
    const res = await post(registered, {
      token: "valid-token",
      username: "unauthorized-user",
      post_id: "post-allowlist-rejected",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    await stop();
  });

  it("dispatches hosted GET and HEAD capabilities before the inbound webhook parser", async () => {
    const cfg = config(account({ webhookUrl: "https://gateway.example.com/webhook/synology" }));
    const { stop } = startAccount(cfg);
    const registered = routeAt();
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
    await stop();
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
    const cfg = {
      gateway: {
        trustedProxies: ["127.0.0.1"],
      },
      ...config(account({ dmPolicy: "open", allowedUserIds: ["*"], rateLimitPerMinute: 1 })),
    };
    const { ctx: startContext, stop } = startAccount(cfg);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);
    const registered = routeAt();
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
    await stop();
  });

  it("isolates same user_id across different accounts", async () => {
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
    const alpha = startAccount(cfg, "alpha");
    const beta = startAccount(cfg, "beta");
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);
    const alphaRoute = routeAt();
    const betaRoute = routeAt(1);
    const alphaRes = await post(alphaRoute, {
      token: "token-alpha",
      username: "alice",
      text: "alpha secret",
      post_id: "post-alpha",
    });
    const betaRes = await post(betaRoute, {
      token: "token-beta",
      username: "bob",
      text: "beta secret",
      post_id: "post-beta",
    });
    expect(alphaRes.status).toBe(204);
    expect(betaRes.status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock.mock.calls[0]?.[0]).toMatchObject({
      AccountId: "alpha",
      SessionKey: "agent:agent-alpha:synology-chat:alpha:direct:123",
    });
    expect(finalizeInboundContextMock.mock.calls[1]?.[0]).toMatchObject({
      AccountId: "beta",
      SessionKey: "agent:agent-beta:synology-chat:beta:direct:123",
    });
    await Promise.all([alpha.stop(), beta.stop()]);
  });
});
