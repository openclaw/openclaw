import type { IncomingMessage } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import type { dispatchA2aInbound } from "./inbound.js";
import { createStreamingResponse, type StreamingResponse } from "./streaming.test-support.js";
import type { A2aTaskStore } from "./task-store.js";

type GuardedFetchCall = { url: string; init: { headers?: Record<string, string>; body?: string } };

const { createdStores, dispatchers, fetchCalls } = vi.hoisted(() => ({
  createdStores: [] as A2aTaskStore[],
  dispatchers: new WeakMap<
    A2aTaskStore,
    (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>
  >(),
  fetchCalls: [] as GuardedFetchCall[],
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: GuardedFetchCall & { url: string }) => {
      fetchCalls.push({ url: params.url, init: params.init ?? {} });
      return {
        response: { ok: true, status: 200 },
        release: async () => undefined,
      };
    },
  };
});
vi.mock("./task-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-store.js")>();
  return {
    ...actual,
    A2aTaskStore: class extends actual.A2aTaskStore {
      constructor() {
        super();
        createdStores.push(this);
      }
    },
  };
});
vi.mock("./inbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound.js")>()),
  dispatchA2aInbound: async (message: Parameters<typeof dispatchA2aInbound>[0]) =>
    dispatchers.get(message.store)?.(message),
}));

const activeAccounts: Array<{ controller: AbortController; lifecycle: Promise<unknown> }> = [];

afterEach(async () => {
  for (const { controller, lifecycle } of activeAccounts.splice(0)) {
    controller.abort();
    await lifecycle;
  }
  fetchCalls.length = 0;
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function startPushHarness(options?: {
  a2aConfig?: Record<string, unknown>;
  onDispatch?: (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>;
}) {
  const { controller, ctx, registry } = createA2aGatewayFixture({
    version: VERSION,
    config: {
      peers: {
        alpha: { token: "alpha-secret" },
        beta: { token: "beta-secret" },
      },
      capabilities: { pushNotifications: true },
      ...options?.a2aConfig,
    } as never,
  });
  const lifecycle = Promise.resolve(a2aChannelPlugin.gateway!.startAccount!(ctx));
  activeAccounts.push({ controller, lifecycle });
  const taskStore = createdStores.pop();
  const route = registry.httpRoutes.find((entry) => entry.path === "/a2a/v1");
  if (!taskStore || !route) {
    throw new Error("A2A account did not register its JSON-RPC route");
  }
  dispatchers.set(
    taskStore,
    options?.onDispatch ??
      (async (message) => {
        taskStore.complete(message.taskId, `echo: ${message.text}`);
      }),
  );

  const post = async (body: unknown, token = "alpha-secret") => {
    const request = createMockIncomingRequest([JSON.stringify(body)]);
    request.method = "POST";
    request.url = "/a2a/v1";
    request.headers = {
      host: "gateway.example.test",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const response = createStreamingResponse();
    await (route.handler as (req: IncomingMessage, res: StreamingResponse) => Promise<boolean>)(
      request,
      response,
    );
    return { status: response.status(), json: async () => JSON.parse(response.body()) };
  };
  return { taskStore, post };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for push notification delivery");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function rpc(method: string, params: unknown, id = "push") {
  return { jsonrpc: "2.0", id, method, params };
}

describe("A2A push notification configuration", () => {
  it("creates, reads, lists and deletes a task webhook registration", async () => {
    const { taskStore, post } = await startPushHarness();
    const task = taskStore.create("ctx-push", "alpha");

    const created = await post(
      rpc("CreateTaskPushNotificationConfig", {
        taskId: task.id,
        url: "https://peer.example.test/webhook",
        token: "peer-secret",
      }),
    );
    const createdBody = (await created.json()) as { result: { id: string; taskId: string } };
    expect(createdBody.result.taskId).toBe(task.id);
    // The specification treats `id` as a Create result, not an input requirement.
    expect(createdBody.result.id).toEqual(expect.any(String));

    const configId = createdBody.result.id;
    const fetched = await post(
      rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: configId }),
    );
    await expect(fetched.json()).resolves.toMatchObject({
      result: { id: configId, url: "https://peer.example.test/webhook" },
    });

    const listed = await post(rpc("ListTaskPushNotificationConfigs", { taskId: task.id }));
    await expect(listed.json()).resolves.toMatchObject({
      result: { configs: [{ id: configId }], pageSize: 1 },
    });

    // Delete maps to google.protobuf.Empty, i.e. a JSON-RPC null result.
    const deleted = await post(
      rpc("DeleteTaskPushNotificationConfig", { taskId: task.id, id: configId }),
    );
    await expect(deleted.json()).resolves.toEqual({ jsonrpc: "2.0", id: "push", result: null });

    const afterDelete = await post(rpc("ListTaskPushNotificationConfigs", { taskId: task.id }));
    await expect(afterDelete.json()).resolves.toMatchObject({
      result: { configs: [], pageSize: 0 },
    });

    // §3.1.10: deletion is idempotent — a repeat delete of the same config is
    // the same success, not a not-found error.
    const deletedAgain = await post(
      rpc("DeleteTaskPushNotificationConfig", { taskId: task.id, id: configId }),
    );
    await expect(deletedAgain.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "push",
      result: null,
    });
  });

  it("delivers task updates to the registered webhook with its auth header", async () => {
    const { taskStore, post } = await startPushHarness();
    const task = taskStore.create("ctx-deliver", "alpha");
    taskStore.start(task.id);
    await post(
      rpc("CreateTaskPushNotificationConfig", {
        taskId: task.id,
        url: "https://peer.example.test/webhook",
        authentication: { scheme: "Bearer", credentials: "peer-token" },
      }),
    );

    taskStore.complete(task.id, "final answer");
    await waitFor(() => fetchCalls.length > 0);

    expect(fetchCalls[0]?.url).toBe("https://peer.example.test/webhook");
    expect(fetchCalls[0]?.init.headers).toMatchObject({
      authorization: "Bearer peer-token",
      "content-type": "application/a2a+json",
    });
    const payload = JSON.parse(fetchCalls.at(-1)?.init.body ?? "{}") as Record<string, unknown>;
    // Push payloads share the StreamResponse shape used by streaming.
    expect(payload).toMatchObject({
      statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } },
    });
  });

  it("registers a webhook supplied inline with SendMessage", async () => {
    const { post } = await startPushHarness();
    await post(
      rpc("SendMessage", {
        message: { role: "ROLE_USER", parts: [{ text: "hello" }] },
        configuration: {
          taskPushNotificationConfig: { url: "https://peer.example.test/inline" },
        },
      }),
    );

    await waitFor(() => fetchCalls.length > 0);
    expect(fetchCalls[0]?.url).toBe("https://peer.example.test/inline");
  });

  it("scopes registrations to the owning peer", async () => {
    const { taskStore, post } = await startPushHarness();
    const task = taskStore.create("ctx-scope", "alpha");
    const created = (await (
      await post(
        rpc("CreateTaskPushNotificationConfig", {
          taskId: task.id,
          url: "https://peer.example.test/webhook",
        }),
      )
    ).json()) as { result: { id: string } };

    // Another configured peer must not be able to read or delete the registration.
    const foreign = await post(
      rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: created.result.id }),
      "beta-secret",
    );
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: -32001 } });
  });

  it("refuses push configuration when the capability is disabled", async () => {
    const { taskStore, post } = await startPushHarness({
      a2aConfig: { capabilities: { pushNotifications: false } },
    });
    const task = taskStore.create("ctx-off", "alpha");
    const response = await post(
      rpc("CreateTaskPushNotificationConfig", {
        taskId: task.id,
        url: "https://peer.example.test/webhook",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32003, data: [{ reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" }] },
    });
  });

  it("rejects a webhook registration for a task the peer does not own", async () => {
    const { taskStore, post } = await startPushHarness();
    const task = taskStore.create("ctx-foreign", "alpha");
    const response = await post(
      rpc(
        "CreateTaskPushNotificationConfig",
        { taskId: task.id, url: "https://peer.example.test/webhook" },
        "beta",
      ),
      "beta-secret",
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32001 } });
  });

  it("requires an http(s) webhook URL", async () => {
    const { taskStore, post } = await startPushHarness();
    const task = taskStore.create("ctx-bad-url", "alpha");
    const response = await post(
      rpc("CreateTaskPushNotificationConfig", {
        taskId: task.id,
        url: "file:///etc/passwd",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32602 } });
  });
});
