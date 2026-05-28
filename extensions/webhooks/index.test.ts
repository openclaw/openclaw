import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  logger?: OpenClawPluginApi["logger"];
  bindSession?: ReturnType<typeof vi.fn>;
  scheduleSessionTurn?: ReturnType<typeof vi.fn>;
  loadAdapter?: ReturnType<typeof vi.fn>;
  openKeyedStore?: ReturnType<typeof vi.fn>;
  registerAgentEventSubscription?: ReturnType<typeof vi.fn>;
  registerGatewayMethod?: OpenClawPluginApi["registerGatewayMethod"];
  registerCli?: OpenClawPluginApi["registerCli"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      tasks: {
        managedFlows: {
          bindSession:
            params?.bindSession ??
            vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey })),
        },
      },
      channel: {
        outbound: {
          loadAdapter: params?.loadAdapter ?? vi.fn(),
        },
      },
      state: {
        openKeyedStore: params?.openKeyedStore ?? vi.fn(),
      },
      events: {
        onAgentEvent: vi.fn(() => () => {}),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    agent: {
      events: {
        registerAgentEventSubscription: params?.registerAgentEventSubscription ?? vi.fn(),
      },
    } as unknown as OpenClawPluginApi["agent"],
    runContext: {
      setRunContext: vi.fn(() => true),
    } as unknown as OpenClawPluginApi["runContext"],
    session: {
      workflow: {
        scheduleSessionTurn: params?.scheduleSessionTurn ?? vi.fn(async () => undefined),
      },
    } as unknown as OpenClawPluginApi["session"],
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
    registerGatewayMethod: params?.registerGatewayMethod ?? vi.fn(),
    registerCli: params?.registerCli ?? vi.fn(),
    logger:
      params?.logger ??
      ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as OpenClawPluginApi["logger"]),
  });
}

function createJsonRequest(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}) {
  const rawBody = JSON.stringify(params.body);
  return {
    method: "POST",
    url: params.url,
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === "data") {
        setImmediate(() => handler(Buffer.from(rawBody)));
      }
      if (event === "end") {
        setImmediate(() => handler());
      }
      return this;
    },
    removeListener() {
      return this;
    },
    destroy() {
      return this;
    },
  };
}

function createJsonResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body?: string) {
      this.body = body ?? "";
    },
  };
}

async function callGatewayMethod(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
  requestParams: Record<string, unknown>,
) {
  const registration = registerGatewayMethod.mock.calls.find(([name]) => name === method);
  if (!registration) {
    throw new Error(`gateway method not registered: ${method}`);
  }
  let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await registration[1]({
    params: requestParams,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      response = { ok, payload, error };
    },
  });
  if (!response) {
    throw new Error(`gateway method did not respond: ${method}`);
  }
  return response;
}

function requireFirstRouteRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected webhook route registration");
  }
  return call[0] as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

function requireRouteRegistration(mock: ReturnType<typeof vi.fn>, path: string) {
  const call = mock.mock.calls.find(([params]) => params?.path === path);
  if (!call) {
    throw new Error(`expected webhook route registration for ${path}`);
  }
  return call[0] as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

function expectDynamicPrefixRoute(mock: ReturnType<typeof vi.fn>) {
  const route = requireRouteRegistration(mock, "/plugins/webhooks");
  expect(route.auth).toBe("plugin");
  expect(route.match).toBe("prefix");
  expect(route.replaceExisting).toBe(true);
  expect(route.handler).toBeTypeOf("function");
}

function createMemoryKeyedStore<T>() {
  const entries = new Map<string, T>();
  return {
    register: vi.fn(async (key: string, value: T) => {
      entries.set(key, value);
    }),
    registerIfAbsent: vi.fn(async (key: string, value: T) => {
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, value);
      return true;
    }),
    lookup: vi.fn(async (key: string) => entries.get(key)),
    consume: vi.fn(async (key: string) => {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    }),
    delete: vi.fn(async (key: string) => entries.delete(key)),
    entries: vi.fn(async () => []),
    clear: vi.fn(async () => entries.clear()),
  };
}

describe("webhooks plugin registration", () => {
  it("registers Gateway-managed dynamic subscriptions through the prefix HTTP route", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-webhook-subscriptions-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const registerHttpRoute = vi.fn();
      const registerGatewayMethod = vi.fn();
      const registerCli = vi.fn();
      const scheduleSessionTurn = vi.fn(async () => ({
        id: "job-dynamic",
        pluginId: "webhooks",
        sessionKey: "agent:webhook-reviewer:webhook-github",
        kind: "agentTurn",
      }));

      plugin.register(
        createApi({
          pluginConfig: {
            publicUrl: "https://gateway.example.com",
          },
          registerHttpRoute,
          registerGatewayMethod,
          registerCli,
          scheduleSessionTurn,
        }),
      );

      expect(registerGatewayMethod).toHaveBeenCalledWith(
        "webhooks.subscribe",
        expect.any(Function),
        { scope: "operator.write" },
      );
      expect(registerCli).toHaveBeenCalledTimes(1);
      expect(registerHttpRoute).toHaveBeenCalledTimes(1);
      const prefixRoute = requireRouteRegistration(registerHttpRoute, "/plugins/webhooks");

      const subscribe = await callGatewayMethod(registerGatewayMethod, "webhooks.subscribe", {
        name: "github-pr-review",
        agentId: "webhook-reviewer",
        sessionKey: "agent:webhook-reviewer:webhook-github",
        eventHeader: "x-github-event",
        events: ["pull_request"],
        idempotencyHeader: "x-github-delivery",
        prompt: "Review GitHub PR {body.pull_request.html_url}. Payload: {__raw__}",
      });
      expect(subscribe.ok).toBe(true);
      const payload = subscribe.payload as { secret: string; webhookUrl?: string };
      const secret = payload.secret;
      expect(secret).toBeTypeOf("string");
      expect(payload.webhookUrl).toBe(
        "https://gateway.example.com/plugins/webhooks/github-pr-review",
      );

      const body = { pull_request: { html_url: "https://github.com/openclaw/test/pull/1" } };
      const rawBody = JSON.stringify(body);
      const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
      const req = createJsonRequest({
        url: "/plugins/webhooks/github-pr-review",
        body,
        headers: {
          "x-openclaw-webhook-signature-256": `sha256=${signature}`,
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-1",
        },
      });
      const res = createJsonResponse();

      await prefixRoute.handler(req as never, res as never);

      expect(res.statusCode).toBe(202);
      expect(scheduleSessionTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:webhook-reviewer:webhook-github",
          agentId: "webhook-reviewer",
          message: expect.stringContaining("https://github.com/openclaw/test/pull/1"),
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("registers SecretRef-backed routes synchronously", () => {
    const registerHttpRoute = vi.fn();

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            zapier: {
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_WEBHOOK_SECRET",
              },
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    const route = requireRouteRegistration(registerHttpRoute, "/plugins/webhooks/zapier");
    expect(route.path).toBe("/plugins/webhooks/zapier");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");
    expectDynamicPrefixRoute(registerHttpRoute);
  });

  it("answers static route verification challenges without dispatching", async () => {
    const registerHttpRoute = vi.fn();
    const scheduleSessionTurn = vi.fn(async () => ({
      id: "job-meego",
      pluginId: "webhooks",
      sessionKey: "agent:webhook-reviewer:meego",
      kind: "agentTurn",
    }));

    plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            meego_requirement_created: {
              path: "/plugins/webhooks/meego-requirement-created",
              sessionKey: "agent:webhook-reviewer:meego",
              auth: {
                mode: "header",
                header: "x-meego-webhook-token",
                secret: "shared-secret",
              },
              dispatch: {
                mode: "agent",
                agent: { deliveryMode: "none" },
              },
              verification: {
                challengePath: "challenge",
                responsePath: "challenge",
              },
            },
          },
        },
        registerHttpRoute,
        scheduleSessionTurn,
      }),
    );

    const route = requireRouteRegistration(
      registerHttpRoute,
      "/plugins/webhooks/meego-requirement-created",
    );
    const req = createJsonRequest({
      url: "/plugins/webhooks/meego-requirement-created",
      headers: {
        "x-meego-webhook-token": "shared-secret",
      },
      body: {
        type: "url_verification",
        challenge: "verify-me",
      },
    });
    const res = createJsonResponse();

    await route.handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: "verify-me" });
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("registers ack-only routes without binding TaskFlow sessions", () => {
    const registerHttpRoute = vi.fn();
    const bindSession = vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey }));

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            alerts: {
              dispatch: { mode: "ack" },
              auth: {
                mode: "header",
                header: "x-alert-token",
                secret: "shared-secret",
              },
            },
          },
        },
        registerHttpRoute,
        bindSession,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(bindSession).not.toHaveBeenCalled();
    const route = requireRouteRegistration(registerHttpRoute, "/plugins/webhooks/alerts");
    expect(route.path).toBe("/plugins/webhooks/alerts");
    expect(route.handler).toBeTypeOf("function");
    expectDynamicPrefixRoute(registerHttpRoute);
  });

  it("registers agent routes without binding TaskFlow sessions", () => {
    const registerHttpRoute = vi.fn();
    const bindSession = vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey }));
    const scheduleSessionTurn = vi.fn(async () => undefined);

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            incidents: {
              sessionKey: "agent:main:main",
              dispatch: { mode: "agent" },
              auth: {
                mode: "bearer",
                secret: "shared-secret",
              },
              prompt: "Investigate {incident.id}",
            },
          },
        },
        registerHttpRoute,
        bindSession,
        scheduleSessionTurn,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(bindSession).not.toHaveBeenCalled();
    const route = requireRouteRegistration(registerHttpRoute, "/plugins/webhooks/incidents");
    expect(route.path).toBe("/plugins/webhooks/incidents");
    expect(route.handler).toBeTypeOf("function");
    expectDynamicPrefixRoute(registerHttpRoute);
  });

  it("registers completion delivery for agent routes and binds webhook context to started runs", async () => {
    const registerHttpRoute = vi.fn();
    const registerAgentEventSubscription = vi.fn();
    const scheduleSessionTurn = vi.fn(async () => ({
      id: "job-1",
      pluginId: "webhooks",
      sessionKey: "agent:reviewer:codebase",
      kind: "agentTurn",
    }));
    const sendText = vi.fn(async () => ({ ok: true }));
    const loadAdapter = vi.fn(async () => ({
      sendText,
    }));
    const keyedStore = createMemoryKeyedStore<unknown>();
    const openKeyedStore = vi.fn(() => keyedStore);

    plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            codebase: {
              sessionKey: "agent:reviewer:codebase",
              auth: {
                mode: "header",
                header: "x-vecode-hook-id",
                secret: "hook-secret",
              },
              dispatch: {
                mode: "agent",
                agent: {
                  deliveryMode: "none",
                  onCompletion: {
                    deliver: {
                      mode: "channel",
                      channel: "codebase",
                      to: "{Repository.Path}",
                      threadId: "{MergeRequest.Number}",
                      textTemplate: "{completionText}",
                    },
                  },
                },
              },
            },
          },
        },
        registerHttpRoute,
        scheduleSessionTurn,
        registerAgentEventSubscription,
        loadAdapter,
        openKeyedStore,
      }),
    );

    expect(registerAgentEventSubscription).toHaveBeenCalledTimes(1);
    const route = requireFirstRouteRegistration(registerHttpRoute);
    const req = {
      method: "POST",
      url: "/plugins/webhooks/codebase",
      headers: {
        "content-type": "application/json",
        "x-vecode-hook-id": "hook-secret",
      },
      socket: { remoteAddress: "127.0.0.1" },
      on(event: string, handler: (chunk?: Buffer) => void) {
        if (event === "data") {
          setImmediate(() =>
            handler(
              Buffer.from(
                JSON.stringify({
                  Repository: { Path: "iaasng/openclaw-session-search" },
                  MergeRequest: { Number: 9 },
                }),
              ),
            ),
          );
        }
        if (event === "end") {
          setImmediate(() => handler());
        }
        return this;
      },
      removeListener() {
        return this;
      },
      destroy() {
        return this;
      },
    };
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: "",
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(body?: string) {
        this.body = body ?? "";
      },
    };
    await route.handler(req as never, res as never);
    expect(res.statusCode).toBe(202);
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(keyedStore.register).toHaveBeenCalledTimes(1));
    expect(openKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "webhook-agent-completion",
      }),
    );

    const subscription = registerAgentEventSubscription.mock.calls[0]?.[0];
    const contextStore = new Map<string, unknown>();
    const ctx = {
      getRunContext: (namespace: string) => contextStore.get(namespace),
      setRunContext: (namespace: string, value: unknown) => contextStore.set(namespace, value),
      clearRunContext: (namespace?: string) =>
        namespace ? contextStore.delete(namespace) : contextStore.clear(),
    };
    await subscription.handle(
      {
        runId: "run-1",
        stream: "lifecycle",
        sessionKey: "agent:reviewer:codebase",
        data: { phase: "start" },
      },
      ctx,
    );
    expect(keyedStore.lookup).toHaveBeenCalledWith("agent:reviewer:codebase");
    expect(contextStore.get("agent-completion-delivery")).toEqual(
      expect.objectContaining({
        routeId: "codebase",
        sessionKey: "agent:reviewer:codebase",
        body: {
          Repository: { Path: "iaasng/openclaw-session-search" },
          MergeRequest: { Number: 9 },
        },
      }),
    );
    await subscription.handle(
      { runId: "run-1", stream: "assistant", data: { delta: "Review " } },
      ctx,
    );
    await subscription.handle({ runId: "run-1", stream: "assistant", data: { delta: "ok" } }, ctx);
    await subscription.handle({ runId: "run-1", stream: "lifecycle", data: { phase: "end" } }, ctx);

    expect(loadAdapter).toHaveBeenCalledWith("codebase");
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "iaasng/openclaw-session-search",
        text: "Review ok",
        threadId: "9",
      }),
    );
    expect(keyedStore.consume).toHaveBeenCalledWith("agent:reviewer:codebase");
  });

  it("registers deliver routes without binding TaskFlow sessions", () => {
    const registerHttpRoute = vi.fn();
    const bindSession = vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey }));
    const loadAdapter = vi.fn();

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            alerts: {
              dispatch: { mode: "deliver" },
              auth: {
                mode: "bearer",
                secret: "shared-secret",
              },
              deliver: {
                channel: "telegram",
                to: "{alert.chat_id}",
              },
            },
          },
        },
        registerHttpRoute,
        bindSession,
        loadAdapter,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(bindSession).not.toHaveBeenCalled();
    const route = requireRouteRegistration(registerHttpRoute, "/plugins/webhooks/alerts");
    expect(route.path).toBe("/plugins/webhooks/alerts");
    expect(route.handler).toBeTypeOf("function");
    expectDynamicPrefixRoute(registerHttpRoute);
  });

  it("opens the persistent idempotency store when any route enables dedupe", () => {
    const registerHttpRoute = vi.fn();
    const openKeyedStore = vi.fn(() => ({
      registerIfAbsent: vi.fn(async () => true),
    }));

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            incidents: {
              dispatch: { mode: "ack" },
              auth: {
                mode: "bearer",
                secret: "shared-secret",
              },
              idempotency: {
                payloadPath: "delivery.id",
              },
            },
          },
        },
        registerHttpRoute,
        openKeyedStore,
      }),
    );

    expect(result).toBeUndefined();
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "webhook-idempotency",
      maxEntries: 25_000,
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
  });
});
