import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createMockIncomingRequest,
  createMockServerResponse,
  postRawWebhook,
  withEnv,
  withServer,
  withStateDirEnv,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveA2aChannelAccount } from "./accounts.js";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import type { dispatchA2aInbound } from "./inbound.js";
import type { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig } from "./types.js";

type HttpReply = { status: number; json(): Promise<unknown>; text(): Promise<string> };
async function expectReply(reply: HttpReply | Promise<HttpReply>, expected: object, status = 200) {
  const response = await reply;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject(expected);
  return response;
}

function taskRequest(id: string, requestId = "task", method = "GetTask") {
  return rpc(method, { id }, requestId);
}

const taskResult = (task: unknown) => ({ result: { task } });
const rpcError = (code: number, message?: unknown) => ({
  error: { code, ...(message === undefined ? {} : { message }) },
});
const rpc = (method: string, params?: unknown, id: string | number | null = "bad") => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const rpcFailure = (id: string | null, code: number, message: unknown) => ({
  jsonrpc: "2.0",
  id,
  ...rpcError(code, message),
});
const wireHeaders = { "content-type": "application/json", authorization: "Bearer alpha-secret" };

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

const { createdStores, dispatchers } = vi.hoisted(() => ({
  createdStores: [] as A2aTaskStore[],
  dispatchers: new WeakMap<
    A2aTaskStore,
    (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>
  >(),
}));
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
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function startHttpHarness(options?: {
  config?: OpenClawConfig;
  a2aConfig?: Partial<A2aChannelConfig>;
  onDispatch?: (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>;
}) {
  const { registry, controller, ctx } = createA2aGatewayFixture({
    cfg: options?.config ?? {},
    version: VERSION,
    config: {
      peers: { alpha: { token: "alpha-secret" }, beta: { token: "beta-secret" } },
      ...options?.a2aConfig,
    },
  });
  const lifecycle = Promise.resolve(a2aChannelPlugin.gateway!.startAccount!(ctx));
  activeAccounts.push({ controller, lifecycle });
  const taskStore = createdStores.pop();
  const handler = registry.httpRoutes.find((route) => route.path === "/a2a/v1")?.handler;
  if (!taskStore || !handler) {
    throw new Error("A2A account did not register its HTTP route");
  }
  dispatchers.set(
    taskStore,
    options?.onDispatch ??
      (async (message) => {
        taskStore.complete(message.taskId, `echo: ${message.text}`);
      }),
  );
  const baseUrl = "http://gateway.example.test";

  const dispatchRequest = async (dispatch: {
    method: "GET" | "POST";
    endpoint: string;
    body?: string;
    token?: string | null;
  }) => {
    const request = createMockIncomingRequest(dispatch.body === undefined ? [] : [dispatch.body]);
    request.method = dispatch.method;
    request.url = dispatch.endpoint;
    request.headers = {
      host: "gateway.example.test",
      ...(dispatch.body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(dispatch.body)),
          }),
      ...(dispatch.token ? { authorization: `Bearer ${dispatch.token}` } : {}),
    };
    Object.defineProperty(request.socket, "remoteAddress", { value: "127.0.0.1" });

    const response = createMockServerResponse();
    const events = new EventEmitter();
    response.once = events.once.bind(events) as ServerResponse["once"];
    const originalEnd = response.end.bind(response);
    response.end = ((body?: string) => {
      originalEnd(body);
      events.emit("finish");
      return response;
    }) as ServerResponse["end"];
    await handler(request, response);

    return {
      status: response.statusCode,
      json: async (): Promise<unknown> => JSON.parse(response.body ?? ""),
      text: async () => response.body ?? "",
    };
  };

  return {
    baseUrl,
    taskStore,
    handler,
    get: (endpoint: string) => dispatchRequest({ method: "GET", endpoint }),
    post: (body: unknown, token: string | null = "alpha-secret") =>
      dispatchRequest({
        method: "POST",
        endpoint: "/a2a/v1",
        body: typeof body === "string" ? body : JSON.stringify(body),
        token,
      }),
  };
}

async function workingTask(harness: Awaited<ReturnType<typeof startHttpHarness>>) {
  const response = await harness.post(sendRequest({ returnImmediately: true }));
  const { result } = (await response.json()) as { result: { task: { id: string } } };
  return result.task.id;
}

function sendRequest({
  id = "send-1",
  text = "hello",
  returnImmediately,
  ...message
}: {
  id?: string | number;
  taskId?: string;
  contextId?: string;
  messageId?: string;
  text?: string;
  returnImmediately?: boolean;
} = {}) {
  return rpc(
    "SendMessage",
    {
      message: { ...message, role: "ROLE_USER", parts: [{ text }] },
      ...(returnImmediately ? { configuration: { returnImmediately: true } } : {}),
    },
    id,
  );
}

describe("A2A message replay", () => {
  it("returns the existing task for a peer message ID before and after completion", async () => {
    const dispatch = vi.fn(async () => {});
    const harness = await startHttpHarness({ onDispatch: dispatch });
    const request = sendRequest({ messageId: "same-message", returnImmediately: true });
    const first = (await (await harness.post(request)).json()) as {
      result: { task: { id: string; contextId: string; status: { state: string } } };
    };
    const replay = await (await harness.post(request)).json();
    expect(replay).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);

    harness.taskStore.fail(first.result.task.id, "provider unavailable");
    expect(await (await harness.post(request)).json()).toMatchObject({
      result: { task: { id: first.result.task.id, status: { state: "TASK_STATE_FAILED" } } },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const otherPeer = (await (await harness.post(request, "beta-secret")).json()) as typeof first;
    expect(otherPeer.result.task.id).not.toBe(first.result.task.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("A2A HTTP agent discovery", () => {
  it("serves both public discovery paths with the canonical bounded v1.0 card", async () => {
    const hiddenDescription = "hidden-secret-description";
    const harness = await startHttpHarness({
      config: {
        agents: {
          entries: {
            hidden: { description: hiddenDescription },
            writer: { name: "Writing assistant", description: "x".repeat(500) },
            reviewer: {},
          },
        },
      },
      a2aConfig: {
        advertisedUrl: "https://agents.example.test/",
        exposeAgents: ["writer", "reviewer"],
      },
    });

    for (const endpoint of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const response = await harness.get(endpoint);
      const card: unknown = await response.json();
      expect(response.status).toBe(200);
      // Exact shape also excludes retired 0.3 fields and stateTransitionHistory.
      expect(card).toEqual({
        name: "Writing assistant",
        description: expect.any(String),
        supportedInterfaces: [
          {
            url: "https://agents.example.test/a2a/v1",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
        version: VERSION,
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: ["writer", "reviewer"].map((id) => ({
          id,
          name: id,
          tags: ["openclaw"],
          description: `OpenClaw agent ${id}.`,
        })),
      });
      // Unauthenticated discovery must not publish any operator-authored description.
      expect(JSON.stringify(card)).not.toContain(hiddenDescription);
      expect(JSON.stringify(card)).not.toContain("x".repeat(50));
    }
  });

  it("derives the advertised interface origin from the request Host", async () => {
    const harness = await startHttpHarness({
      config: { agents: { entries: { main: {} } } },
    });
    const response = await harness.get("/.well-known/agent-card.json");
    const card = (await response.json()) as { supportedInterfaces: Array<{ url: string }> };

    expect(card.supportedInterfaces[0]?.url).toBe(`${harness.baseUrl}/a2a/v1`);
  });
});

describe("A2A HTTP authentication and request limits", () => {
  it("rejects a missing bearer", async () => {
    const { post } = await startHttpHarness();
    await expectReply(
      post(sendRequest(), null),
      { error: expect.stringContaining("channels.a2a.peers") },
      401,
    );
  });

  it("limits each peer independently and admits requests when the sliding window expires", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const harness = await startHttpHarness({ a2aConfig: { rateLimitPerMinute: 2 } });
    const request = taskRequest("missing");

    await harness.post(request);
    await harness.post(request);
    await expectReply(
      harness.post(request),
      rpcError(-32000, expect.stringContaining("rate limited")),
    );

    await expectReply(harness.post(request, "beta-secret"), rpcError(-32001));

    now += 60_001;
    await expectReply(harness.post(request), rpcError(-32001));
  });

  it("allows unlimited requests when the per-peer rate limit is zero", async () => {
    const harness = await startHttpHarness({ a2aConfig: { rateLimitPerMinute: 0 } });
    const request = { ...taskRequest("missing"), id: 1 };

    const responses = await Promise.all(Array.from({ length: 35 }, () => harness.post(request)));
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject(rpcError(-32001));
    }
  });

  it.each([false, true])(
    "flushes rejection before closing (partial upload: %s)",
    async (partial) => {
      const harness = await startHttpHarness();
      const requestReceived = createDeferred<void>();
      await withServer(
        (req, res) => {
          void harness.handler(req, res);
          // Observe after the body reader is installed; Bun's socket wrapper omits raw data events.
          if (partial) {
            req.once("data", () => requestReceived.resolve());
          }
        },
        async (baseUrl) => {
          if (partial) {
            vi.useFakeTimers();
          }
          try {
            // The oversized body is declared and sent in one write, reproducing the flush race.
            const resultPromise = postRawWebhook({
              url: `${baseUrl}/a2a/v1`,
              body: partial ? "{" : "x".repeat(1024 * 1024 + 1),
              ...(partial ? { contentLength: 2, idleTimeoutMs: 60_000 } : {}),
              headers: wireHeaders,
            });
            if (partial) {
              await requestReceived.promise;
              await vi.advanceTimersByTimeAsync(31_000);
            }
            const result = await resultPromise;
            expect(result).toMatchObject({
              statusLine: partial ? "HTTP/1.1 200 OK" : "HTTP/1.1 413 Payload Too Large",
              headers: { connection: "close" },
              closedByServer: true,
            });
            expect(JSON.parse(result.body)).toEqual(
              partial
                ? rpcFailure(null, -32000, "Request body could not be read")
                : { error: "Request body exceeds the 1 MiB limit" },
            );
          } finally {
            vi.useRealTimers();
          }
        },
      );
    },
  );

  it("rejects oversized batches with one bounded error", async () => {
    const harness = await startHttpHarness();
    const response = await expectReply(harness.post(Array.from({ length: 1_000 }, () => null)), {
      id: null,
      ...rpcError(-32000, expect.stringContaining("batch")),
    });
    expect(Buffer.byteLength(await response.text())).toBeLessThan(1_024);
  });

  it("charges schema-invalid requests to the peer rate limit", async () => {
    const harness = await startHttpHarness({ a2aConfig: { rateLimitPerMinute: 1 } });

    await expectReply(harness.post({ jsonrpc: "2.0", id: "invalid" }), rpcError(-32600));
    await expectReply(harness.post(taskRequest("missing", "limited")), {
      id: "limited",
      ...rpcError(-32000, expect.stringContaining("rate limited")),
    });
  });

  it("keeps the overflow fallback bounded when its request ID cannot fit", async () => {
    const harness = await startHttpHarness();
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "i".repeat(1024 * 1024 - 25),
    });
    expect(Buffer.byteLength(requestBody)).toBeLessThanOrEqual(1024 * 1024);

    const response = await expectReply(harness.post(requestBody), {
      id: null,
      ...rpcError(-32000, expect.stringContaining("response")),
    });
    expect(Buffer.byteLength(await response.text())).toBeLessThan(1_024);
  });

  it("preserves batch response IDs when aggregate results exceed the response limit", async () => {
    const harness = await startHttpHarness();
    const taskA = harness.taskStore.create("ctx-large-a", "alpha", "large-a");
    const taskB = harness.taskStore.create("ctx-large-b", "alpha", "large-b");
    harness.taskStore.complete(taskA.id, "a".repeat(600 * 1024));
    harness.taskStore.complete(taskB.id, "b".repeat(600 * 1024));
    const stringifySpy = vi.spyOn(JSON, "stringify");

    const response = await harness.post([
      taskRequest(taskA.id, "large-a"),
      taskRequest(taskB.id, "large-b"),
    ]);

    expect(stringifySpy).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ result: taskA })]),
    );

    await expect(response.json()).resolves.toEqual([
      rpcFailure("large-a", -32000, expect.stringContaining("response")),
      rpcFailure("large-b", -32000, expect.stringContaining("response")),
    ]);
    expect(Buffer.byteLength(await response.text())).toBeLessThan(1_024);
  });
});

describe("A2A JSON-RPC protocol boundary", () => {
  it.each([
    ["malformed JSON", "{", -32700],
    ["empty batch", "[]", -32600],
  ])("maps %s to its JSON-RPC error with HTTP 200", async (_label, body, errorCode) => {
    const harness = await startHttpHarness();
    await expectReply(harness.post(body), {
      jsonrpc: "2.0",
      id: null,
      error: { code: errorCode },
    });
  });

  it.each([
    ["unknown method", rpc("tasks/send"), -32601],
    ["missing message parts", rpc("SendMessage", { message: { role: "user" } }), -32602],
    [
      "invalid context id",
      rpc("SendMessage", {
        message: { role: "user", contextId: "../../secret", parts: [{ text: "hi" }] },
      }),
      -32602,
    ],
    [
      "file-only message",
      rpc("SendMessage", {
        message: { role: "user", parts: [{ url: "https://example.test/file" }] },
      }),
      -32602,
    ],
    ["missing task id", rpc("GetTask", {}), -32602],
  ])("rejects %s", async (_label, request, errorCode) => {
    const harness = await startHttpHarness();
    await expectReply(harness.post(request), { id: "bad", error: { code: errorCode } });
  });

  it.each([
    ["CreateTaskPushNotificationConfig", -32003],
    ["SetTaskPushNotificationConfig", -32003],
    ["GetTaskPushNotificationConfig", -32003],
    ["ListTaskPushNotificationConfig", -32003],
    ["ListTaskPushNotificationConfigs", -32003],
    ["DeleteTaskPushNotificationConfig", -32003],
    ["SendStreamingMessage", -32004],
    ["SubscribeToTask", -32004],
    ["GetExtendedAgentCard", -32004],
    ["UnknownTaskPushNotificationConfig", -32601],
  ])("rejects %s with capability-specific error %s", async (method, code) => {
    const onDispatch = vi.fn(async () => {});
    const harness = await startHttpHarness({ onDispatch });
    const createTask = vi.spyOn(harness.taskStore, "create");
    const response = await harness.post(rpc(method, undefined, "capability"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      rpcFailure("capability", code, expect.any(String)),
    );
    expect(onDispatch).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("executes batch notifications without returning notification response entries", async () => {
    const harness = await startHttpHarness();
    const notification = sendRequest({ text: "notify", returnImmediately: true });
    const { id: _notificationId, ...withoutId } = notification;
    const response = await harness.post([
      withoutId,
      sendRequest({ id: "visible", text: "visible" }),
      42,
    ]);

    expect(response.status).toBe(200);
    const results = (await response.json()) as Array<{ id: string | null }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "visible",
      result: { task: { artifacts: [{ parts: [{ text: "echo: visible" }] }] } },
    });
    expect(results[1]).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("responds to notification-only requests with HTTP 200 and an empty body", async () => {
    const harness = await startHttpHarness();
    const { id: _notificationId, ...notification } = sendRequest({ returnImmediately: true });
    const response = await harness.post(notification);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("rejects task inspection from a different configured peer", async () => {
    const harness = await startHttpHarness({ onDispatch: async () => {} });
    const id = await workingTask(harness);
    await expectReply(harness.post(taskRequest(id, "GetTask"), "beta-secret"), {
      id: "GetTask",
      ...rpcError(-32001, "Task not found"),
    });
  });

  it("refuses cancellation instead of reporting a terminal state it cannot enforce", async () => {
    const harness = await startHttpHarness({ onDispatch: async () => {} });
    const id = await workingTask(harness);

    // A dispatched agent run has no plugin-facing abort seam, so acknowledging
    // cancellation would report a terminal state while the run kept going.
    await expectReply(harness.post(taskRequest(id, "cancel", "tasks/cancel")), rpcError(-32004));
    await expectReply(harness.post(taskRequest(id, "after")), {
      result: { status: { state: "TASK_STATE_WORKING" } },
    });
  });

  it("transitions the task to FAILED when inbound dispatch throws", async () => {
    const harness = await startHttpHarness({
      onDispatch: async () => {
        throw new Error("dispatch unavailable");
      },
    });
    await expectReply(
      harness.post(sendRequest()),
      taskResult({
        status: {
          state: "TASK_STATE_FAILED",
          message: { parts: [{ text: "dispatch unavailable" }] },
        },
      }),
    );
  });
});

describe("A2A SendMessage task references", () => {
  it.each([
    ["unknown", -32001],
    ["foreign", -32001],
    ["owned", -32004],
    ["conflicting context", -32602],
  ])("rejects %s task references without new work", async (kind, code) => {
    const onDispatch = vi.fn(async () => {});
    const harness = await startHttpHarness({ onDispatch });
    const referenced =
      kind === "unknown"
        ? undefined
        : harness.taskStore.create(
            "existing-context",
            kind === "foreign" ? "beta" : "alpha",
            "existing-message",
          );
    const before = referenced && structuredClone(referenced);
    const create = vi.spyOn(harness.taskStore, "create");

    const response = await harness.post(
      sendRequest({
        taskId: referenced?.id ?? "missing",
        contextId: kind === "conflicting context" ? "other-context" : undefined,
        returnImmediately: true,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(create).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
    if (referenced) {
      expect(harness.taskStore.get(referenced.id, kind === "foreign" ? "beta" : "alpha")).toEqual(
        before,
      );
    }
  });

  it("accepts a context-only follow-up as a new task", async () => {
    const harness = await startHttpHarness();
    const original = harness.taskStore.create("shared-context", "alpha", "original-message");
    harness.taskStore.complete(original.id, "original reply");

    await expectReply(
      harness.post(sendRequest({ contextId: original.contextId, text: "follow up" })),
      taskResult({
        id: expect.not.stringMatching(original.id),
        contextId: original.contextId,
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{ parts: [{ text: "echo: follow up" }] }],
      }),
    );
    expect(harness.taskStore.get(original.id, "alpha")?.artifacts[0]?.parts).toEqual([
      { text: "original reply" },
    ]);
  });
});

describe("A2A HTTP authentication with unresolved token references", () => {
  const PLACEHOLDER = "${OPENCLAW_A2A_HTTP_TEST_UNSET}";

  it("rejects the literal placeholder as a bearer and never dispatches a task", async () => {
    await withStateDirEnv("a2a-http-unresolved-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          channels: {
            a2a: {
              peers: {
                lost: { token: PLACEHOLDER },
                kept: { token: "${OPENCLAW_A2A_HTTP_TEST_SET}" },
              },
            },
          },
        }),
      );
      const cfg = withEnv(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_A2A_HTTP_TEST_UNSET: undefined,
          OPENCLAW_A2A_HTTP_TEST_SET: "kept-secret-value",
        },
        // Each case needs a fresh load; the default read pins the first snapshot.
        () => getRuntimeConfig({ pin: false }),
      );
      // The loader keeps the literal text: this is the value a caller could replay.
      expect(cfg.channels?.a2a?.peers?.lost?.token).toBe(PLACEHOLDER);

      const dispatched: string[] = [];
      const harness = await startHttpHarness({
        a2aConfig: resolveA2aChannelAccount({ cfg }).config,
        onDispatch: async (message) => {
          dispatched.push(message.peerName);
        },
      });

      await expectReply(
        harness.post(sendRequest({ returnImmediately: true }), PLACEHOLDER),
        {
          error: expect.stringContaining("channels.a2a.peers"),
        },
        401,
      );
      await expectReply(
        harness.post(sendRequest({ returnImmediately: true }), "kept-secret-value"),
        taskResult({ status: { state: "TASK_STATE_WORKING" } }),
      );
      // Only the resolved peer reached the agent; the forged request created no task.
      expect(dispatched).toEqual(["kept"]);
    });
  });
});
