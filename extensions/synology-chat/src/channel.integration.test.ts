import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

function startAccount(
  cfg: Parameters<typeof synologyChatPlugin.gateway.startAccount>[0]["cfg"],
  accountId = "default",
) {
  const controller = new AbortController();
  setSynologyRuntimeConfigForTest(cfg);
  const ctx = {
    cfg,
    accountId,
    abortSignal: controller.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setStatus: vi.fn(),
  };
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
    vi.clearAllMocks();
    tryHandleSynologyHostedMediaRequestMock.mockResolvedValue(false);
    setSynologyRuntimeConfigForTest({});
  });
  afterEach(() => vi.unstubAllEnvs());

  function namedConfig(overrides: SynologyChatChannelConfig) {
    return config(
      account({
        webhookPath: "/webhook/shared",
        webhookUrl: "https://gateway.example.com/shared?a=1&b=2",
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
      namedConfig({ webhookPath: "/webhook/shared" }),
      "alerts",
      "conflicts on webhookPath",
    ],
    [
      "duplicate URL",
      namedConfig({
        webhookPath: "/alerts",
        webhookUrl: "https://gateway.example.com/shared?b=2&a=1",
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
    expect(settled).toBe(false);
    if (warning) {
      expect(JSON.stringify(ctx.log.warn.mock.calls)).toContain(warning);
      if (id === "alerts") {
        const resolved = synologyChatPlugin.config.resolveAccount(cfg, id);
        const findings = synologyChatPlugin.security.collectWarnings({ cfg, account: resolved });
        expect(JSON.stringify(findings)).toContain(warning);
        if (warning === "conflicts on webhookUrl") {
          expect(findings).toContainEqual(
            expect.objectContaining({
              severity: "critical",
              detail: expect.stringContaining(warning),
            }),
          );
        }
      }
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
    const sibling = Object.freeze({ enabled: false, token: "sibling-token" });
    const root = { enabled: false, token: "root-token" };
    const alerts = Object.freeze({ enabled: false, token: "old-alerts", webhookPath: "/alerts" });
    const configured = synologyChatSetupAdapter.applyAccountConfig({
      cfg: config({ ...root, accounts: { alerts, sibling } }),
      accountId: "alerts",
      input: { token: "replacement", url: "https://nas.example.com/alerts" },
    });
    expect(configured.channels?.["synology-chat"]).toEqual({
      ...root,
      enabled: true,
      accounts: {
        alerts: {
          ...alerts,
          enabled: true,
          token: "replacement",
          incomingUrl: "https://nas.example.com/alerts",
        },
        sibling,
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
    registerPluginHttpRouteMock.mockImplementationOnce(() => {
      throw new Error("Synology route conflict");
    });
    const { ctx, task } = startAccount(config());
    await expect(task).rejects.toThrow("Synology route conflict");
    expect(synologyIngressStartMock).toHaveBeenCalledOnce();
    expect(synologyIngressStopMock).toHaveBeenCalledOnce();
    expect(ctx.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("uses gateway trusted proxy settings for pre-auth invalid-token throttling", async () => {
    const cfg = {
      gateway: {
        trustedProxies: ["127.0.0.1"],
      },
      ...config(account({ dmPolicy: "open", allowedUserIds: ["*"], rateLimitPerMinute: 1 })),
    };
    const { stop } = startAccount(cfg);
    const registered = routeAt();
    for (let i = 0; i < 2; i += 1) {
      const res = await post(
        registered,
        { token: "wrong-token" },
        { headers: { "x-forwarded-for": "198.51.100.9" } },
      );
      expect(res.status).toBe(i === 0 ? 401 : 429);
    }
    const validRes = await post(
      registered,
      { token: "valid-token", post_id: "post-proxy-accepted" },
      { headers: { "x-forwarded-for": "203.0.113.11" } },
    );
    expect(validRes.status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(channelInboundRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnAdoptionLifecycle: expect.objectContaining({ admission: "exclusive" }),
      }),
    );
    await stop();
  });

  it.each([false, true])(
    "isolates accounts and users with different agents=%s",
    async (different) => {
      const namedAccount = (id: string) =>
        account({
          token: `token-${id}`,
          incomingUrl: `https://nas.example.com/incoming-${id}`,
          webhookPath: `/webhook/synology-${id}`,
          dmPolicy: "open",
          allowedUserIds: ["*"],
        });
      const cfg = {
        ...config({
          enabled: true,
          accounts: { alpha: namedAccount("alpha"), beta: namedAccount("beta") },
        }),
        session: { dmScope: "main" as const },
      };
      const accounts = [startAccount(cfg, "alpha"), startAccount(cfg, "beta")];
      for (const [index, accountId, userId] of [
        [0, "alpha", "123"],
        [1, "beta", "123"],
        [0, "alpha", "456"],
      ] as const) {
        const agentId = different ? `agent-${accountId}` : "main";
        resolveAgentRouteMock.mockReturnValueOnce({
          agentId,
          accountId,
          sessionKey: `agent:${agentId}:main`,
        });
        const res = await post(routeAt(index), {
          token: `token-${accountId}`,
          user_id: userId,
          post_id: `${accountId}-${userId}`,
        });
        expect(res.status).toBe(204);
        expect(finalizeInboundContextMock.mock.lastCall?.[0]).toMatchObject({
          AccountId: accountId,
          SessionKey: `agent:${agentId}:synology-chat:${accountId}:direct:${userId}`,
        });
      }
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
      await Promise.all(accounts.map((active) => active.stop()));
    },
  );
});
