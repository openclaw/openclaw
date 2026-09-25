// Webhooks tests cover index plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  logger?: OpenClawPluginApi["logger"];
  runtime?: OpenClawPluginApi["runtime"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: params?.runtime ?? createPluginRuntimeMock(),
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
  it("propagates an uncertain managed creation without retrying or reporting a created flow", async () => {
    const runtime = createPluginRuntimeMock();
    const sessionKey = "agent:main:webhook-uncertain";
    const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey });
    const bound = runtime.tasks.async.managedFlows.bindSession({ sessionKey });
    const lost = Object.assign(new Error("Worker reply was lost"), { code: "outcome-unknown" });
    const failure = new AggregateError(
      [new Error("Cleanup failed")],
      "Creation outcome is unknown",
      { cause: lost },
    );
    vi.mocked(bound.tryCreateManaged).mockRejectedValue(failure);
    vi.mocked(runtime.tasks.managedFlows.bindSession).mockReturnValue(legacy);
    vi.mocked(runtime.tasks.async.managedFlows.bindSession).mockReturnValue(bound);
    const registerHttpRoute = vi.fn();
    plugin.register(
      createApi({
        runtime,
        registerHttpRoute,
        pluginConfig: { routes: { uncertain: { sessionKey, secret: "synthetic-secret" } } },
      }),
    );
    const route = requireFirstRouteRegistration(registerHttpRoute);
    const request = createMockIncomingRequest([
      JSON.stringify({ action: "create_flow", goal: "Synthetic uncertain flow" }),
    ]);
    request.method = "POST";
    request.url = route.path;
    request.headers = {
      "content-type": "application/json",
      "x-openclaw-webhook-secret": "synthetic-secret",
    };
    const response = createMockServerResponse();
    try {
      await expect(route.handler(request, response)).rejects.toBe(failure);
      expect(bound.tryCreateManaged).toHaveBeenCalledTimes(1);
      expect(bound.createManaged).not.toHaveBeenCalled();
      expect(legacy.tryCreateManaged).not.toHaveBeenCalled();
      expect(legacy.createManaged).not.toHaveBeenCalled();
      expect(response.headersSent).toBe(false);
      expect(response.body).toBeUndefined();
    } finally {
      request.destroy();
    }
  });

  it.each([
    ["create_flow", "tryCreateManaged"],
    ["set_waiting", "setWaiting"],
    ["resume_flow", "resume"],
    ["finish_flow", "finish"],
    ["fail_flow", "fail"],
    ["request_cancel", "requestCancel"],
  ] as const)(
    "awaits %s persistence through the registered async binding",
    async (action, method) => {
      const runtime = createPluginRuntimeMock();
      const sessionKey = "agent:main:webhook-write";
      const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey });
      const bound = runtime.tasks.async.managedFlows.bindSession({ sessionKey });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const failed = vi.fn(() => {
        throw new Error("Legacy mutation should not run");
      });
      legacy[method] = failed;
      if (method === "tryCreateManaged") {
        bound.tryCreateManaged = vi.fn(async () => {
          entered.resolve();
          await release.promise;
          return null;
        });
      } else {
        bound[method] = vi.fn(async () => {
          entered.resolve();
          await release.promise;
          return { applied: false, code: "persist_failed" } as const;
        });
      }
      vi.mocked(runtime.tasks.managedFlows.bindSession).mockReturnValue(legacy);
      vi.mocked(runtime.tasks.async.managedFlows.bindSession).mockReturnValue(bound);
      const registerHttpRoute = vi.fn();
      plugin.register(
        createApi({
          runtime,
          registerHttpRoute,
          pluginConfig: { routes: { write: { sessionKey, secret: "synthetic-secret" } } },
        }),
      );
      const route = requireFirstRouteRegistration(registerHttpRoute);
      const request = createMockIncomingRequest([
        JSON.stringify({
          action,
          ...(action === "create_flow"
            ? { goal: "Synthetic flow" }
            : { flowId: "flow-1", expectedRevision: 1 }),
        }),
      ]);
      request.method = "POST";
      request.url = route.path;
      request.headers = {
        "content-type": "application/json",
        "x-openclaw-webhook-secret": "synthetic-secret",
      };
      const response = createMockServerResponse();
      const handled = route.handler(request, response);
      try {
        await Promise.race([entered.promise, handled]);
        expect(response.headersSent).toBe(false);
        release.resolve();
        await handled;
        expect(response.statusCode).toBe(503);
        expect(JSON.parse(response.body ?? "{}")).toMatchObject({
          ok: false,
          code: "persist_failed",
        });
        expect(failed).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await handled;
        request.destroy();
      }
    },
  );

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
});
