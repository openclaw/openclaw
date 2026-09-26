// Register the existing loopback transport fixtures before loading proxy consumers.
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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import * as inferenceProxy from "./inference-proxy.js";

type BindModelExecution = NonNullable<
  Parameters<typeof inferenceProxy.createCodexInferenceProxy>[0]["bindModelExecution"]
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

describe("inference transport model authority", () => {
  it.each([
    "/responses",
    "/responses/compact",
    "/alpha/search",
    "/images/generations",
    "/images/edits",
  ])(
    "rejects a forbidden HTTP model on %s before forwarding and accepts an allowed model",
    async (path) => {
      const allowed = execution();
      bindModelExecution.mockImplementation(({ body }) => {
        if (body.model === "forbidden") {
          // The old transport ignores the hook, so its RED failure is an upstream write.
          throw new inferenceProxy.CodexInferenceAuthorizationError("model");
        }
        return allowed.binding;
      });
      const image = path.startsWith("/images/");
      const headerMetadata = path !== "/responses";
      const requestKind = path.endsWith("compact") ? "compaction" : "turn";
      const headers = {
        authorization: "Bearer synthetic-private-auth",
        ...(image
          ? { "x-codex-image-turn-id": "image-turn" }
          : headerMetadata
            ? {
                "thread-id": "child",
                "x-codex-turn-metadata": JSON.stringify({
                  thread_id: "child",
                  parent_thread_id: "parent",
                  request_kind: requestKind,
                }),
              }
            : {}),
      };
      const body = {
        ...(headerMetadata ? {} : child),
        model: "forbidden",
        input: "synthetic private prompt",
      };
      const denied = await post(undefined, false, { path, body, headers });
      expect(transport.fetch).not.toHaveBeenCalled();
      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body)).toMatchObject({
        type: "error",
        status: 403,
        error: { type: "invalid_request_error", code: "model_permission_denied" },
      });
      expect(denied.body).not.toContain("synthetic-private-auth");
      expect(denied.body).not.toContain("synthetic private prompt");
      expect(denied.body).not.toContain(proxy.baseUrl);
      expect(bindModelExecution.mock.calls[0]?.[0]).toMatchObject({
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
      await allowed.released.promise;
      expect(bindModelExecution).toHaveBeenCalledTimes(2);
      expect(transport.fetch).toHaveBeenCalledOnce();
      expect(allowed.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["completed", "revoked"] as const)(
    "holds HTTP model authority beyond upload until the response is %s and cleanup settles",
    async (ending) => {
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
        await model.released.promise;
        expect(model.release).toHaveBeenCalledOnce();
      } finally {
        cleanup.resolve();
        proxy.close();
        await request;
      }
    },
  );

  it("releases acquired authority when parent-context preparation fails", async () => {
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

  it("releases a late HTTP binding after its caller closes during acquisition", async () => {
    const model = execution();
    const entered = createDeferred<AbortSignal>();
    const acquired = createDeferred<ModelExecution>();
    bindModelExecution.mockImplementation(({ signal }) => {
      entered.resolve(signal);
      return acquired.promise;
    });
    const caller = new AbortController();
    const request = post(caller.signal, false, { body: { ...child, model: "allowed" } }).then(
      (result) => result,
      () => undefined,
    );
    try {
      const signal = await Promise.race([
        entered.promise,
        request.then(() => {
          throw new Error("HTTP dispatch completed without awaiting model authorization");
        }),
      ]);
      const closed = once(signal, "abort");
      caller.abort();
      await closed;
      acquired.resolve(model.binding);
      await model.released.promise;
      expect(await request).toBeUndefined();
      expect(transport.fetch).not.toHaveBeenCalled();
      expect(model.release).toHaveBeenCalledOnce();
    } finally {
      acquired.resolve(model.binding);
      caller.abort();
      await request;
    }
  });

  it.each(["/responses", "/guardian", "/guardian-classifier"])(
    "authorizes WebSocket frames on %s and returns a sanitized denial before forwarding",
    async (path) => {
      bindModelExecution.mockImplementation(() => {
        throw new inferenceProxy.CodexInferenceAuthorizationError("model");
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
      expect(JSON.parse(body)).toMatchObject({
        status: 403,
        error: { code: "model_permission_denied" },
      });
      expect(body).not.toContain("private model input");
      expect(body).not.toContain(proxy.baseUrl);
      expect(bindModelExecution).toHaveBeenCalledOnce();
      expect(bindModelExecution.mock.calls[0]?.[0]).toMatchObject({
        path,
        transport: "websocket",
        body: { model: "forbidden" },
      });
      await closed;
    },
  );

  it("reserves the WebSocket frame before asynchronous binding and releases a late acquisition", async () => {
    const model = execution();
    const entered = createDeferred<AbortSignal>();
    const acquired = createDeferred<ModelExecution>();
    bindModelExecution.mockImplementation(({ signal }) => {
      entered.resolve(signal);
      return acquired.promise;
    });
    const { client, upstream } = await open();
    const forwarded = vi.fn();
    upstream.on("message", forwarded);
    try {
      const earlyForward = once(upstream, "message").then(() => {
        throw new Error("WS frame was forwarded without awaiting model authorization");
      });
      client.send(JSON.stringify({ ...child, model: "first" }));
      const signal = await Promise.race([entered.promise, earlyForward]);
      const downstream = transport.downstreams.at(-1);
      assert(downstream);
      const closed = once(client, "close");
      const second = once(downstream, "message");
      client.send(JSON.stringify({ ...child, model: "second" }));
      await second;
      expect(signal.aborted).toBe(true);
      expect(bindModelExecution).toHaveBeenCalledOnce();
      expect(forwarded).not.toHaveBeenCalled();
      await closed;
      acquired.resolve(model.binding);
      await model.released.promise;
      expect(model.release).toHaveBeenCalledOnce();
    } finally {
      acquired.resolve(model.binding);
      client.terminate();
    }
  });

  it.each(["terminal", "socket"] as const)(
    "retains each WS binding through its %s and ignores an older send completion",
    async (ending) => {
      const first = execution();
      const second = execution();
      bindModelExecution.mockReturnValueOnce(first.binding).mockReturnValueOnce(second.binding);
      const stream = await open();
      const nativeSend = stream.remote.send.bind(stream.remote);
      const firstUpload = createDeferred<() => void>();
      const secondUpload = createDeferred<() => void>();
      const callbacks: (() => void)[] = [];
      let uploadCount = 0;
      vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
        const uploaded = ++uploadCount === 1 ? firstUpload : secondUpload;
        nativeSend(data, options, (error) => {
          const finish = () => callback?.(error);
          callbacks.push(finish);
          uploaded.resolve(finish);
        });
      });
      try {
        await send(stream.client, stream.upstream, { ...child, model: "first" });
        const oldSendCompleted = await firstUpload.promise;
        expect(bindModelExecution).toHaveBeenCalledOnce();
        expect(first.release).not.toHaveBeenCalled();
        await complete(stream.client, stream.upstream);
        await first.released.promise;
        await send(stream.client, stream.upstream, { ...child, model: "second" });
        const nextSendCompleted = await secondUpload.promise;
        oldSendCompleted();
        expect(second.release).not.toHaveBeenCalled();
        expect(stream.client.readyState).toBe(WebSocket.OPEN);
        if (ending === "terminal") {
          const downstream = transport.downstreams.at(-1);
          assert(downstream);
          const sendNow = downstream.send.bind(downstream);
          const delivered = createDeferred<() => void>();
          vi.spyOn(downstream, "send").mockImplementation((data, options, callback) => {
            sendNow(data, options, (error) => delivered.resolve(() => callback?.(error)));
          });
          await complete(stream.client, stream.upstream);
          const finishTerminal = await delivered.promise;
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
        for (const finish of callbacks) {
          finish();
        }
        stream.client.terminate();
      }
    },
  );
});
