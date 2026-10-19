// Register loopback transport mocks before loading proxy consumers.
// oxfmt-ignore
import {
  child,
  complete,
  open,
  post,
  proxy,
  send,
  transport,
} from "./inference-proxy.capacity-test-support.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { CodexInferenceAuthorizationError } from "./inference-dispatch.js";
import type { createCodexInferenceProxy } from "./inference-proxy.js";

type BindModelExecution = NonNullable<
  Parameters<typeof createCodexInferenceProxy>[0]["bindModelExecution"]
>;
type ModelExecution = Awaited<ReturnType<BindModelExecution>>;

const bindModelExecution = vi.fn<BindModelExecution>();
transport.proxyOptions.bindModelExecution = bindModelExecution;
beforeEach(() => {
  bindModelExecution.mockReset();
});
afterAll(() => {
  delete transport.proxyOptions.bindModelExecution;
});

function execution() {
  const controller = new AbortController();
  const released = createDeferred<void>();
  let active = true;
  const release = vi.fn(() => {
    active = false;
    released.resolve();
  });
  const binding: ModelExecution = {
    signal: controller.signal,
    assertCurrent: () => {
      controller.signal.throwIfAborted();
      if (!active) {
        throw new Error("Synthetic model authority was released");
      }
    },
    release,
  };
  return { binding, controller, release, released };
}
function pendingBinding() {
  const model = execution();
  const entered = createDeferred<AbortSignal>();
  const acquired = createDeferred<ModelExecution>();
  bindModelExecution.mockImplementation(({ signal }) => {
    entered.resolve(signal);
    return acquired.promise;
  });
  return { model, entered, acquired };
}
function holdSends(socket: WebSocket, count = 1) {
  const uploads = Array.from({ length: count }, () => createDeferred<() => void>());
  const callbacks: (() => void)[] = [];
  const sendNow = socket.send.bind(socket);
  let index = 0;
  vi.spyOn(socket, "send").mockImplementation((data, options, callback) => {
    const uploaded = uploads[index++];
    assert(uploaded);
    sendNow(data, options, (error) => {
      const finish = () => callback?.(error);
      callbacks.push(finish);
      uploaded.resolve(finish);
    });
  });
  return { uploads, finish: () => callbacks.forEach((finish) => finish()) };
}
const expectReleased = async (model: ReturnType<typeof execution>) => {
  await model.released.promise;
  expect(model.release).toHaveBeenCalledOnce();
};
function expectDenied(body: string, ...secrets: string[]) {
  expect(JSON.parse(body)).toMatchObject({
    type: "error",
    status: 403,
    error: { type: "invalid_request_error", code: "model_permission_denied" },
  });
  for (const secret of [...secrets, proxy.baseUrl]) {
    expect(body).not.toContain(secret);
  }
}
function expectBinding(expected: object) {
  expect(bindModelExecution).toHaveBeenCalledOnce();
  expect(bindModelExecution.mock.calls[0]?.[0]).toMatchObject(expected);
}

it.each(["/responses", "/responses/compact", "/images/generations"])(
  "checks HTTP model authority on %s",
  async (path) => {
    const allowed = execution();
    bindModelExecution.mockImplementation(({ body }) => {
      if (body.model === "forbidden") {
        throw new CodexInferenceAuthorizationError("model");
      }
      return allowed.binding;
    });
    const image = path.startsWith("/images/");
    const headerMetadata = path !== "/responses";
    const requestKind = path.endsWith("compact") ? "compaction" : "turn";
    const headers: Record<string, string> = { authorization: "Bearer synthetic-private-auth" };
    if (image) {
      headers["x-codex-image-turn-id"] = "image-turn";
    } else if (headerMetadata) {
      Object.assign(headers, {
        "thread-id": "child",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "child",
          parent_thread_id: "parent",
          request_kind: requestKind,
        }),
      });
    }
    const body = {
      ...(headerMetadata ? {} : child),
      model: "forbidden",
      input: "synthetic private prompt",
    };
    const denied = await post(undefined, false, { path, body, headers });
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(denied.status).toBe(403);
    expectDenied(denied.body, "synthetic-private-auth", "synthetic private prompt");
    expectBinding({
      path,
      transport: "http",
      body,
      metadata: image
        ? { nativeImageTurnId: "image-turn" }
        : { threadId: "child", parentThreadId: "parent", requestKind },
    });

    expect(
      await post(undefined, false, { path, body: { ...body, model: "allowed" }, headers }),
    ).toMatchObject({ status: 200, body: "synthetic HTTP response" });
    await expectReleased(allowed);
    expect(bindModelExecution).toHaveBeenCalledTimes(2);
    expect(transport.fetch).toHaveBeenCalledOnce();
  },
);

it.each(["completed", "revoked"] as const)("HTTP %s waits for cleanup", async (ending) => {
  const model = execution();
  const uploaded = createDeferred<AbortSignal>();
  const responseBody = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
  const cleanup = createDeferred<void>();
  bindModelExecution.mockReturnValue(model.binding);
  transport.fetch.mockImplementation(async (args: Parameters<typeof fetchWithSsrFGuard>[0]) => {
    await new Response(args.init?.body).arrayBuffer();
    args.beforeRequest?.();
    assert(args.signal);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          responseBody.resolve(controller);
          controller.enqueue(new TextEncoder().encode("synthetic response delta"));
        },
      }),
    );
    uploaded.resolve(args.signal);
    return { response, release: () => cleanup.promise };
  });
  const request = post(undefined, false, { body: { ...child, model: "allowed" } }).then(
    (result) => ({ status: result.status }),
    (error: unknown) => ({ error }),
  );
  try {
    const signal = await uploaded.promise;
    expect(bindModelExecution).toHaveBeenCalledOnce();
    expect(model.release).not.toHaveBeenCalled();
    if (ending === "completed") {
      (await responseBody.promise).close();
      expect(await request).toEqual({ status: 200 });
    } else {
      model.controller.abort(new Error("synthetic private revocation"));
      expect(signal.aborted).toBe(true);
      expect(await request).not.toMatchObject({ status: 200 });
    }
    expect(model.release).not.toHaveBeenCalled();
    cleanup.resolve();
    await expectReleased(model);
  } finally {
    cleanup.resolve();
    proxy.close();
    await request;
  }
});

it("releases authority on parent-context failure", async () => {
  const model = execution();
  bindModelExecution.mockReturnValue(model.binding);
  const registration = proxy.context.register({
    threadId: "root",
    text: "synthetic private instructions",
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const result = await post(undefined, false, {
    body: {
      model: "allowed",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "root",
          request_kind: "turn",
          [CODEX_INFERENCE_GENERATION_KEY]: registration.generation + "-stale",
        }),
      },
    },
  });
  expect(result.status).toBe(502);
  expect(result.body).not.toContain("synthetic private instructions");
  expect(transport.fetch).not.toHaveBeenCalled();
  expect(bindModelExecution).toHaveBeenCalledOnce();
  expect(model.release).toHaveBeenCalledOnce();
});

it.each(["HTTP", "WebSocket"])("releases late %s bindings on cancellation", async (kind) => {
  const { model, entered, acquired } = pendingBinding();
  const caller = new AbortController();
  const stream = kind === "WebSocket" ? await open() : undefined;
  const forwarded = vi.fn();
  stream?.upstream.on("message", forwarded);
  const request = stream
    ? once(stream.upstream, "message")
    : post(caller.signal, false, { body: { ...child, model: "allowed" } }).catch(() => undefined);
  if (stream) {
    stream.client.send(JSON.stringify({ ...child, model: "first" }));
  }
  try {
    const signal = await Promise.race([
      entered.promise,
      request.then(() => {
        throw new Error("Dispatch bypassed pending model authorization");
      }),
    ]);
    if (stream) {
      const downstream = transport.downstreams.at(-1);
      assert(downstream);
      const closed = once(stream.client, "close");
      const second = once(downstream, "message");
      stream.client.send(JSON.stringify({ ...child, model: "second" }));
      await second;
      expect(signal.aborted).toBe(true);
      expect(bindModelExecution).toHaveBeenCalledOnce();
      expect(forwarded).not.toHaveBeenCalled();
      await closed;
    } else {
      const closed = once(signal, "abort");
      caller.abort();
      await closed;
    }
    acquired.resolve(model.binding);
    await expectReleased(model);
    if (!stream) {
      expect(await request).toBeUndefined();
      expect(transport.fetch).not.toHaveBeenCalled();
    }
  } finally {
    acquired.resolve(model.binding);
    caller.abort();
    if (!stream) {
      await request;
    }
  }
});

it.each(["/responses", "/guardian-classifier"])("WS %s denies models", async (path) => {
  bindModelExecution.mockImplementation(() => {
    throw new CodexInferenceAuthorizationError("model");
  });
  const { client, upstream } = await open(path);
  const forwarded = vi.fn(() => {
    upstream.send('{"type":"response.completed","response":{"id":"unexpected"}}');
  });
  upstream.on("message", forwarded);
  const closed = once(client, "close");
  const reply = Promise.race([
    once(client, "message").then(([bytes]) => bytes.toString()),
    closed.then(() => "null"),
  ]);
  client.send(JSON.stringify({ ...child, model: "forbidden", input: "private model input" }));
  const body = await reply;
  expect(forwarded).not.toHaveBeenCalled();
  expectDenied(body, "private model input");
  expectBinding({
    path,
    transport: "websocket",
    body: { model: "forbidden" },
  });
  await closed;
});

it.each(["terminal", "socket"] as const)("WS %s ignores stale send", async (ending) => {
  const first = execution();
  const second = execution();
  bindModelExecution.mockReturnValueOnce(first.binding).mockReturnValueOnce(second.binding);
  const stream = await open();
  const uploads = holdSends(stream.remote, 2);
  try {
    await send(stream.client, stream.upstream, { ...child, model: "first" });
    const oldSendCompleted = await uploads.uploads[0]!.promise;
    expect(bindModelExecution).toHaveBeenCalledOnce();
    expect(first.release).not.toHaveBeenCalled();
    await complete(stream.client, stream.upstream);
    await first.released.promise;
    await send(stream.client, stream.upstream, { ...child, model: "second" });
    const nextSendCompleted = await uploads.uploads[1]!.promise;
    oldSendCompleted();
    expect(second.release).not.toHaveBeenCalled();
    expect(stream.client.readyState).toBe(WebSocket.OPEN);
    if (ending === "terminal") {
      const downstream = transport.downstreams.at(-1);
      assert(downstream);
      const delivered = holdSends(downstream);
      await complete(stream.client, stream.upstream);
      const finishTerminal = await delivered.uploads[0]!.promise;
      expect(second.release).not.toHaveBeenCalled();
      finishTerminal();
    } else {
      const closed = once(stream.client, "close");
      stream.client.terminate();
      await closed;
    }
    await second.released.promise;
    nextSendCompleted();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
  } finally {
    uploads.finish();
  }
});
