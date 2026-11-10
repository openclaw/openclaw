import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, vi } from "vitest";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import type { dispatchA2aInbound } from "./inbound.js";
import type { A2aTaskStore } from "./task-store.js";
import {
  createPendingStoreFixture,
  createTerminalStoreFixture,
} from "./task-store.test-support.js";
import type { A2aChannelConfig } from "./types.js";

type HttpReply = { status: number; json(): Promise<unknown>; text(): Promise<string> };
export async function expectReply(
  reply: HttpReply | Promise<HttpReply>,
  expected: object,
  status = 200,
) {
  const response = await reply;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject(expected);
  return response;
}

export function taskRequest(id: string, requestId = "task", method = "GetTask") {
  return rpc(method, { id }, requestId);
}

export const taskResult = (task: unknown) => ({ result: { task } });
export const rpcError = (code: number, message?: unknown) => ({
  error: { code, ...(message === undefined ? {} : { message }) },
});
export const rpc = (method: string, params?: unknown, id: string | number | null = "bad") => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
export const rpcFailure = (id: string | null, code: number, message: unknown) => ({
  jsonrpc: "2.0",
  id,
  ...rpcError(code, message),
});
export const wireHeaders = {
  "content-type": "application/json",
  authorization: "Bearer alpha-secret",
};

// mock-isolation: Keep request timeouts driven by the test clock.
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
// mock-isolation: Observe the real store while exercising HTTP admission and persistence.
vi.mock("./task-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-store.js")>();
  return {
    ...actual,
    A2aTaskStore: class extends actual.A2aTaskStore {
      constructor(...args: ConstructorParameters<typeof actual.A2aTaskStore>) {
        super(...args);
        createdStores.push(this);
      }
    },
  };
});
// mock-isolation: Native agent execution is external I/O for the HTTP protocol owner.
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

const { a2aChannelPlugin } = await import("./channel.js");

export async function startHttpHarness(options?: {
  terminalStore?: ReturnType<typeof createTerminalStoreFixture>;
  pendingStore?: ReturnType<typeof createPendingStoreFixture>;
  config?: OpenClawConfig;
  a2aConfig?: Partial<A2aChannelConfig>;
  onDispatch?: (message: Parameters<typeof dispatchA2aInbound>[0]) => Promise<void>;
}) {
  const { registry, controller, ctx, runtime } = createA2aGatewayFixture({
    cfg: options?.config ?? {},
    version: VERSION,
    terminalStore: options?.terminalStore,
    pendingStore: options?.pendingStore,
    config: {
      peers: { alpha: { token: "alpha-secret" }, beta: { token: "beta-secret" } },
      ...options?.a2aConfig,
    },
  });
  const lifecycle = Promise.resolve(a2aChannelPlugin.gateway!.startAccount!(ctx));
  activeAccounts.push({ controller, lifecycle });
  await vi.waitFor(() =>
    expect(registry.httpRoutes.some((route) => route.path === "/a2a/v1")).toBe(true),
  );
  const taskStore = createdStores.pop();
  const handler = registry.httpRoutes.find((route) => route.path === "/a2a/v1")?.handler;
  if (!taskStore || !handler) {
    throw new Error("A2A account did not register its HTTP route");
  }
  const onDispatch = vi.fn<typeof dispatchA2aInbound>(
    options?.onDispatch ??
      (async (message) => {
        await taskStore.complete(message.taskId, `echo: ${message.text}`);
      }),
  );
  dispatchers.set(taskStore, onDispatch);
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
    runtime,
    signal: controller.signal,
    stop: async () => {
      controller.abort();
      await lifecycle;
    },
    taskStore,
    handler,
    onDispatch,
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

export async function workingTask(harness: Awaited<ReturnType<typeof startHttpHarness>>) {
  const response = await harness.post(sendRequest({ returnImmediately: true }));
  const { result } = (await response.json()) as { result: { task: { id: string } } };
  return result.task.id;
}

export function sendRequest({
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
