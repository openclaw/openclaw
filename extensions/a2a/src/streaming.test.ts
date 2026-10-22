import type { IncomingMessage } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import type { dispatchA2aInbound } from "./inbound.js";
import {
  createStreamingResponse,
  parseSseFrames,
  parseSseJsonFrames,
  type StreamingResponse,
} from "./streaming.test-support.js";
import type { A2aTaskStore } from "./task-store.js";

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

type JsonRpcHandler = (request: IncomingMessage, response: StreamingResponse) => Promise<boolean>;

const activeAccounts: Array<{ controller: AbortController; lifecycle: Promise<unknown> }> = [];

afterEach(async () => {
  for (const { controller, lifecycle } of activeAccounts.splice(0)) {
    controller.abort();
    await lifecycle;
  }
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function startStreamHarness(options?: {
  a2aConfig?: Record<string, unknown>;
  onDispatch?: (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>;
}) {
  const { controller, ctx, registry } = createA2aGatewayFixture({
    version: VERSION,
    config: {
      peers: { alpha: { token: "alpha-secret" } },
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
  return { taskStore, handler: route.handler as unknown as JsonRpcHandler };
}

function streamRequest(body: unknown): IncomingMessage {
  const request = createMockIncomingRequest([JSON.stringify(body)]);
  request.method = "POST";
  request.url = "/a2a/v1";
  request.headers = {
    host: "gateway.example.test",
    "content-type": "application/json",
    authorization: "Bearer alpha-secret",
  };
  return request;
}

function sendStreamRequest(text: string) {
  return {
    jsonrpc: "2.0",
    id: "stream-1",
    method: "SendStreamingMessage",
    params: { message: { role: "ROLE_USER" as const, parts: [{ text }] } },
  };
}

const resultOf = (frame: { json: unknown }) =>
  (frame.json as { result: Record<string, unknown> }).result;

/** Poll until `predicate` holds, so a test can act once a stream is established. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the stream to open");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("A2A streaming (SendStreamingMessage / SubscribeToTask)", () => {
  it("streams the task lifecycle as SSE frames and closes at the terminal state", async () => {
    const { taskStore, handler } = await startStreamHarness();
    const response = createStreamingResponse();
    await handler(streamRequest(sendStreamRequest("hello stream")), response);

    expect(response.status()).toBe(200);
    expect(response.header("content-type")).toContain("text/event-stream");

    const frames = parseSseJsonFrames(response.body());
    // Every JSON-RPC frame is a full envelope so the peer can correlate it.
    for (const frame of frames) {
      expect(frame.json).toMatchObject({ jsonrpc: "2.0", id: "stream-1" });
    }

    const payloads = frames.map(resultOf);
    // The stream must open with the Task object, never with a bare update.
    expect(Object.keys(payloads[0] ?? {})).toEqual(["task"]);
    const states = payloads
      .filter((entry) => "statusUpdate" in entry)
      .map((entry) => (entry.statusUpdate as { status: { state: string } }).status.state);
    expect(states).toContain("TASK_STATE_WORKING");
    expect(states.at(-1)).toBe("TASK_STATE_COMPLETED");
    expect(payloads.some((entry) => "artifactUpdate" in entry)).toBe(true);
    expect(taskStore.listTasks({ ownerPeer: "alpha" }).tasks).toHaveLength(1);
  });

  it("emits a normal JSON-RPC error instead of a stream when the request is invalid", async () => {
    const { handler } = await startStreamHarness();
    const response = createStreamingResponse();
    await handler(
      streamRequest({
        jsonrpc: "2.0",
        id: "bad",
        method: "SubscribeToTask",
        params: {},
      }),
      response,
    );

    // The peer gets one ordinary JSON response, not an opened event stream.
    expect(response.header("content-type")).not.toContain("text/event-stream");
    expect(JSON.parse(response.body())).toMatchObject({
      jsonrpc: "2.0",
      id: "bad",
      error: { code: -32602 },
    });
  });

  it("attaches SubscribeToTask to an existing task and ends on completion", async () => {
    const { taskStore, handler } = await startStreamHarness();
    const task = taskStore.create("ctx-subscribe", "alpha");
    taskStore.start(task.id);

    const response = createStreamingResponse();
    const pending = handler(
      streamRequest({
        jsonrpc: "2.0",
        id: "sub",
        method: "SubscribeToTask",
        params: { id: task.id },
      }),
      response,
    );
    // Let the subscription attach before settling the task, so the completion
    // update is observed live rather than replayed from the buffer.
    await waitUntil(() => response.body().length > 0);
    taskStore.complete(task.id, "done");
    await pending;

    const payloads = parseSseJsonFrames(response.body()).map(resultOf);
    expect(Object.keys(payloads[0] ?? {})).toEqual(["task"]);
    expect(payloads.at(-1)).toMatchObject({
      statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } },
    });
  });

  it("refuses SubscribeToTask for a task that already reached a terminal state", async () => {
    const { taskStore, handler } = await startStreamHarness();
    const task = taskStore.create("ctx-done", "alpha");
    taskStore.complete(task.id, "done");

    const response = createStreamingResponse();
    await handler(
      streamRequest({
        jsonrpc: "2.0",
        id: "sub",
        method: "SubscribeToTask",
        params: { id: task.id },
      }),
      response,
    );

    expect(JSON.parse(response.body())).toMatchObject({ error: { code: -32004 } });
  });

  it("rejects streaming methods when the capability is disabled", async () => {
    const { handler } = await startStreamHarness({
      a2aConfig: { capabilities: { streaming: false } },
    });
    const response = createStreamingResponse();
    await handler(streamRequest(sendStreamRequest("hello")), response);

    expect(JSON.parse(response.body())).toMatchObject({ error: { code: -32004 } });
  });

  it("parses SSE frames with and without an explicit event name", () => {
    expect(parseSseFrames('event: error\ndata: {"code":-32001}\n\n')).toEqual([
      { event: "error", data: '{"code":-32001}' },
    ]);
    // A2A 1.0 data frames carry no `event:` line, so they default to "message".
    expect(parseSseFrames('data: {"task":{}}\n\n')).toEqual([
      { event: "message", data: '{"task":{}}' },
    ]);
  });
});
