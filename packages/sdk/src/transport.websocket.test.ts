import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { OpenClaw } from "./client.js";
import { GatewayClientTransport } from "./transport.js";
import { createSdkWebSocketServer } from "./transport.websocket.test-support.js";
import type {
  ConnectableOpenClawTransport,
  GatewayRequestOptions,
  OpenClawEvent,
} from "./types.js";

describe("GatewayClientTransport live WebSocket lifecycle", () => {
  let gateway: Awaited<ReturnType<typeof createSdkWebSocketServer>>;
  beforeAll(async () => {
    gateway = await createSdkWebSocketServer();
  });
  beforeEach(() => {
    gateway.setRequestHandler();
  });
  afterAll(async () => {
    await gateway.close();
  });
  it("bounds replay after 150 confirmed session unsubscribe cycles", async () => {
    const subscriptions = new Map<string, { runId: string; sessionKey: string }>();
    let runIndex = 0;
    gateway.setRequestHandler((socket, request) => {
      const key = request.params.key;
      if (typeof key !== "string") {
        throw new Error("Expected a session key");
      }
      const canonicalKey = key === "global" ? key : `agent:main:${key}`;
      if (request.method === "sessions.messages.subscribe") {
        const scope = {
          runId: `run-${runIndex++}`,
          sessionKey: canonicalKey,
        };
        subscriptions.set(key, scope);
        gateway.sendEvent(socket, "chat", {
          ...scope,
          agentId: "main",
          state: "delta",
          deltaText: "prefix",
          message: { role: "assistant", content: "prefix" },
        });
        gateway.sendEvent(socket, "agent", {
          ...scope,
          agentId: "main",
          stream: "assistant",
          data: { text: "prefix", delta: "prefix" },
        });
        gateway.reply(socket, request.id, { subscribed: true, key: canonicalKey });
      } else if (request.method === "sessions.messages.unsubscribe") {
        const scope = subscriptions.get(key);
        if (!scope) {
          throw new Error("Expected a live subscription");
        }
        gateway.sendEvent(socket, "chat", {
          ...scope,
          agentId: "main",
          state: "delta",
          deltaText: " tail",
        });
        gateway.sendEvent(socket, "agent", {
          ...scope,
          agentId: "main",
          stream: "assistant",
          data: { delta: " tail" },
        });
        gateway.sendEvent(socket, "board.changed", {});
        subscriptions.delete(key);
        gateway.reply(socket, request.id, { subscribed: false, key: canonicalKey });
      }
    });
    const oc = new OpenClaw({
      transport: new GatewayClientTransport({ url: gateway.url, deviceIdentity: null }),
    });
    let recent: AsyncIterator<OpenClawEvent> | undefined;
    let expired: AsyncIterator<OpenClawEvent> | undefined;
    try {
      await oc.connect();
      for (let index = 0; index < 150; index += 1) {
        const key = index % 2 === 0 ? "global" : `session-${index}`;
        await oc.request("sessions.messages.subscribe", { key, agentId: "main" });
        await oc.request("sessions.messages.unsubscribe", { key, agentId: "main" });
      }
      expect(subscriptions.size).toBe(0);
      recent = oc.runEvents("run-50")[Symbol.asyncIterator]();
      await expect(recent.next()).resolves.toMatchObject({ value: { data: { text: "prefix" } } });
      expired = oc.runEvents("run-49")[Symbol.asyncIterator]();
      const next = expired.next();
      gateway.sendEvent(gateway.socket(), "agent", {
        runId: "run-49",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await expect(next).resolves.toMatchObject({ value: { type: "run.started" } });
    } finally {
      await recent?.return?.();
      await expired?.return?.();
      await oc.close();
    }
  });

  it("preserves a rejected unsubscribe and a resubscription newer than the successful ACK", async () => {
    let subscriptions = 0;
    let rejectUnsubscribe = true;
    gateway.setRequestHandler((socket, request) => {
      if (request.method === "sessions.messages.subscribe") {
        gateway.sendEvent(socket, "agent", {
          runId: "run",
          sessionKey: "global",
          agentId: "main",
          stream: "assistant",
          data: { text: ++subscriptions === 1 ? "old" : "fresh", delta: "" },
        });
        gateway.reply(socket, request.id, { subscribed: true, key: "global" });
      } else if (rejectUnsubscribe) {
        rejectUnsubscribe = false;
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: false,
            error: { code: "UNAVAILABLE", message: "unsubscribe rejected" },
          }),
        );
      } else {
        gateway.reply(socket, request.id, { subscribed: false, key: "global" });
      }
    });
    const acknowledged = createDeferred();
    const releaseAck = createDeferred();
    const underlying = new GatewayClientTransport({ url: gateway.url, deviceIdentity: null });
    const transport: ConnectableOpenClawTransport = {
      connect: () => underlying.connect(),
      close: () => underlying.close(),
      events: (filter) => underlying.events(filter),
      request: async <T>(
        method: string,
        params?: unknown,
        options?: GatewayRequestOptions,
      ): Promise<T> => {
        const result = await underlying.request<T>(method, params, options);
        if (method === "sessions.messages.unsubscribe") {
          acknowledged.resolve();
          await releaseAck.promise;
        }
        return result;
      },
    };
    const oc = new OpenClaw({ transport });
    let iterator: AsyncIterator<OpenClawEvent> | undefined;
    const scope = { key: "global", agentId: "main" };
    try {
      await oc.request("sessions.messages.subscribe", scope);
      iterator = oc.runEvents("run")[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ value: { data: { text: "old" } } });
      await expect(oc.request("sessions.messages.unsubscribe", scope)).rejects.toThrow(
        "unsubscribe rejected",
      );
      gateway.sendEvent(gateway.socket(), "agent", {
        runId: "run",
        sessionKey: "global",
        agentId: "main",
        stream: "assistant",
        data: { delta: " tail" },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "old tail" } },
      });
      const unsubscribe = oc.request("sessions.messages.unsubscribe", scope);
      await acknowledged.promise;
      await oc.request("sessions.messages.subscribe", scope);
      await expect(iterator.next()).resolves.toMatchObject({ value: { data: { text: "fresh" } } });
      releaseAck.resolve();
      await unsubscribe;
      gateway.sendEvent(gateway.socket(), "agent", {
        runId: "run",
        sessionKey: "global",
        agentId: "main",
        stream: "assistant",
        data: { delta: " tail" },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        value: { data: { text: "fresh tail" } },
      });
    } finally {
      releaseAck.resolve();
      await iterator?.return?.();
      await oc.close();
    }
  });

  it("settles a gap-revealing final snapshot before reconnecting", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const disconnected = createDeferred();
    const reconnected = createDeferred();
    let hellos = 0;
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      onClose: () => disconnected.resolve(),
      onHelloOk: () => {
        if (++hellos === 2) {
          reconnected.resolve();
        }
      },
    });
    const oc = new OpenClaw({ transport });
    try {
      await oc.connect();
      const completion = (async () => {
        for await (const event of oc.runEvents("gap-run")) {
          if (event.type === "run.completed") {
            return event;
          }
        }
        throw new Error("Run ended without its terminal event");
      })();
      const socket = gateway.socket();
      gateway.sendEvent(socket, "chat", {
        runId: "gap-run",
        sessionKey: "gap-session",
        state: "delta",
        deltaText: "hello",
        message: { role: "assistant", content: "hello" },
      });
      socket.send(
        JSON.stringify({
          type: "event",
          event: "chat",
          seq: 3,
          payload: {
            runId: "gap-run",
            sessionKey: "gap-session",
            state: "final",
            message: { role: "assistant", content: "hello complete answer" },
          },
        }),
      );
      await expect(completion).resolves.toMatchObject({
        type: "run.completed",
        data: { outputText: "hello complete answer" },
      });
      await disconnected.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await reconnected.promise;
      expect(hellos).toBe(2);
    } finally {
      await oc.close();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps healthy concurrent event readers alive when another subscriber fails", async () => {
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    try {
      await oc.connect();
      const run = await oc.runs.get("stream-1");
      const normalized = run.events()[Symbol.asyncIterator]();
      const normalizedFirst = normalized.next();
      const failedStream = transport.events(() => {
        throw new Error("subscriber filter failed");
      });
      const failed = failedStream[Symbol.asyncIterator]();
      const healthy = transport.events()[Symbol.asyncIterator]();
      const failedRead = expect(failed.next()).rejects.toThrow("subscriber filter failed");
      const first = healthy.next();
      const second = healthy.next();
      const socket = gateway.socket();
      for (const seq of [1, 2]) {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            seq,
            payload: {
              runId: "stream-1",
              state: "delta",
              deltaText: seq === 1 ? "hello" : " world",
              ...(seq === 1 ? { message: { role: "assistant", content: "hello" } } : {}),
            },
          }),
        );
      }

      await failedRead;
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { done: false, value: { event: "chat", payload: { deltaText: "hello" } } },
        { done: false, value: { event: "chat", payload: { deltaText: " world" } } },
      ]);
      await expect(normalizedFirst).resolves.toMatchObject({
        value: { type: "assistant.delta", data: { text: "hello", delta: "hello" } },
      });
      const normalizedSecond = await normalized.next();
      expect(normalizedSecond).toMatchObject({
        value: { type: "assistant.delta", data: { text: "hello world", delta: " world" } },
      });
      expect(normalizedSecond.value?.raw?.payload).not.toHaveProperty("message");
      await normalized.return?.();
      await healthy.return?.();
    } finally {
      await oc.close();
    }
  });
});
