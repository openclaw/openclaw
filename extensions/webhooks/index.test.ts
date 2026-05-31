import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRuntimeTaskFlow } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

function createJsonRequest(params: {
  path: string;
  secret?: string;
  body: unknown;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    "content-type": "application/json",
    ...(params.secret ? { "x-openclaw-webhook-secret": params.secret } : {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body), "utf8"));
    req.emit("end");
  });

  return req;
}

async function dispatchJsonRequest(params: {
  handler: (
    req: IncomingMessage,
    res: ReturnType<typeof createMockServerResponse>,
  ) => Promise<unknown>;
  path: string;
  secret?: string;
  body: unknown;
}) {
  const req = createJsonRequest({
    path: params.path,
    secret: params.secret,
    body: params.body,
  });
  const res = createMockServerResponse();
  await params.handler(req, res);
  return res;
}

function parseJsonBody(res: { body?: string | Buffer | null }) {
  return JSON.parse(String(res.body ?? ""));
}

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  logger?: OpenClawPluginApi["logger"];
  sessionStores?: Record<
    string,
    Record<
      string,
      { sessionId: string; updatedAt: number; spawnedBy?: string; parentSessionKey?: string }
    >
  >;
}): OpenClawPluginApi {
  const taskFlowRuntime = createRuntimeTaskFlow();
  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      tasks: {
        managedFlows: taskFlowRuntime,
      },
      agent: {
        session: {
          resolveStorePath: vi.fn(
            (_store: unknown, context: { agentId: string }) => context.agentId,
          ),
          loadSessionStore: vi.fn((storePath: string) => params?.sessionStores?.[storePath] ?? {}),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
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

function requireFirstRouteRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected webhook route registration");
  }
  return call[0] as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

describe("webhooks plugin registration", () => {
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
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = requireFirstRouteRegistration(registerHttpRoute);
    expect(route.path).toBe("/plugins/webhooks/zapier");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");
  });

  it("scopes run_task child session keys to the route session tree", async () => {
    const registerHttpRoute = vi.fn();

    const api = createApi({
      pluginConfig: {
        routes: {
          zapier: {
            sessionKey: "agent:main:main",
            secret: "shared-secret",
          },
        },
      },
      registerHttpRoute,
      sessionStores: {
        worker: {
          "agent:worker:acp:child": {
            sessionId: "child-session",
            updatedAt: 1,
            spawnedBy: "agent:main:main",
          },
        },
      },
    });
    plugin.register(api);

    const handler = registerHttpRoute.mock.calls[0]?.[0]?.handler as (
      req: IncomingMessage,
      res: ReturnType<typeof createMockServerResponse>,
    ) => Promise<boolean>;
    const created = await dispatchJsonRequest({
      handler,
      path: "/plugins/webhooks/zapier",
      secret: "shared-secret",
      body: {
        action: "create_flow",
        goal: "Review inbound queue",
      },
    });
    const flowId = parseJsonBody(created).result.flow.flowId;

    const denied = await dispatchJsonRequest({
      handler,
      path: "/plugins/webhooks/zapier",
      secret: "shared-secret",
      body: {
        action: "run_task",
        flowId,
        runtime: "acp",
        childSessionKey: "agent:victim:acp:child",
        task: "Inspect another session",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(api.runtime.agent.session.loadSessionStore).toHaveBeenCalledWith("victim", {
      clone: false,
    });
    expect(parseJsonBody(denied)).toMatchObject({
      ok: false,
      code: "child_session_forbidden",
    });

    const allowed = await dispatchJsonRequest({
      handler,
      path: "/plugins/webhooks/zapier",
      secret: "shared-secret",
      body: {
        action: "run_task",
        flowId,
        runtime: "acp",
        childSessionKey: "agent:worker:acp:child",
        task: "Inspect owned session",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(api.runtime.agent.session.loadSessionStore).toHaveBeenCalledWith("worker", {
      clone: false,
    });
    expect(parseJsonBody(allowed)).toMatchObject({
      ok: true,
      result: {
        created: true,
      },
    });
  });
});
