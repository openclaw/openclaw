import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenClaw } from "./client.js";
import { GatewayClientTransport } from "./transport.js";
import { createSdkWebSocketServer } from "./transport.websocket.test-support.js";

describe("GatewayClientTransport live WebSocket lifecycle", () => {
  let gateway: Awaited<ReturnType<typeof createSdkWebSocketServer>>;
  let transport: GatewayClientTransport;
  let oc: OpenClaw;
  function createClient(requestTimeoutMs?: number) {
    transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs,
    });
    oc = new OpenClaw({ transport });
  }
  function assistant(
    socket: Parameters<typeof gateway.sendEvent>[0],
    scope: { runId: string; sessionKey: string },
    data: { text?: string; delta: string },
  ) {
    gateway.sendEvent(socket, "agent", { ...scope, agentId: "main", stream: "assistant", data });
  }
  beforeAll(async () => {
    gateway = await createSdkWebSocketServer();
  });
  beforeEach(() => {
    gateway.setRequestHandler();
  });
  afterEach(() => oc.close());
  afterAll(() => gateway.close());
  it("bounds replay after 150 confirmed session unsubscribe cycles", async () => {
    createClient();
    const subscriptions = new Map<string, { runId: string; sessionKey: string }>();
    let runIndex = 0;
    function sessionDelta(...[socket, scope, data]: Parameters<typeof assistant>) {
      gateway.sendEvent(socket, "chat", {
        ...scope,
        agentId: "main",
        state: "delta",
        deltaText: data.delta,
        ...(data.text ? { message: { role: "assistant", content: data.text } } : {}),
      });
      assistant(socket, scope, data);
    }
    gateway.setRequestHandler((socket, request) => {
      const key = request.params.key;
      if (typeof key !== "string") {
        throw new Error("Expected a session key");
      }
      const canonicalKey = key === "global" ? key : `agent:main:${key}`;
      if (request.method === "sessions.messages.subscribe") {
        const scope = { runId: `run-${runIndex++}`, sessionKey: canonicalKey };
        subscriptions.set(key, scope);
        sessionDelta(socket, scope, { text: "prefix", delta: "prefix" });
        gateway.reply(socket, request.id, { subscribed: true, key: canonicalKey });
      } else if (request.method === "sessions.messages.unsubscribe") {
        const scope = subscriptions.get(key);
        if (!scope) {
          throw new Error("Expected a live subscription");
        }
        sessionDelta(socket, scope, { delta: " tail" });
        gateway.sendEvent(socket, "board.changed", {});
        subscriptions.delete(key);
        gateway.reply(socket, request.id, { subscribed: false, key: canonicalKey });
      }
    });
    await oc.connect();
    for (let index = 0; index < 150; index += 1) {
      const key = index % 2 === 0 ? "global" : `session-${index}`;
      await oc.request("sessions.messages.subscribe", { key, agentId: "main" });
      await oc.request("sessions.messages.unsubscribe", { key, agentId: "main" });
    }
    expect(subscriptions.size).toBe(0);
    const recent = oc.runEvents("run-50")[Symbol.asyncIterator]();
    await expect(recent.next()).resolves.toMatchObject({ value: { data: { text: "prefix" } } });
    const expired = oc.runEvents("run-49")[Symbol.asyncIterator]();
    const next = expired.next();
    gateway.sendEvent(gateway.socket(), "agent", {
      runId: "run-49",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await expect(next).resolves.toMatchObject({ value: { type: "run.started" } });
  });

  it("preserves the current baseline when unsubscribe is rejected", async () => {
    createClient();
    gateway.setRequestHandler((socket, request) => {
      if (request.method === "sessions.messages.subscribe") {
        assistant(socket, { runId: "run", sessionKey: "global" }, { text: "old", delta: "" });
        gateway.reply(socket, request.id, { subscribed: true, key: "global" });
      } else {
        const error = { code: "UNAVAILABLE", message: "unsubscribe rejected" };
        socket.send(JSON.stringify({ type: "res", id: request.id, ok: false, error }));
      }
    });
    const scope = { key: "global", agentId: "main" };
    await oc.request("sessions.messages.subscribe", scope);
    const iterator = oc.runEvents("run")[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { data: { text: "old" } } });
    await expect(oc.request("sessions.messages.unsubscribe", scope)).rejects.toThrow(
      "unsubscribe rejected",
    );
    assistant(gateway.socket(), { runId: "run", sessionKey: "global" }, { delta: " tail" });
    await expect(iterator.next()).resolves.toMatchObject({ value: { data: { text: "old tail" } } });
  });

  it("keeps healthy concurrent event readers alive when another subscriber fails", async () => {
    createClient(2_000);
    await oc.connect();
    const normalized = (await oc.runs.get("stream-1")).events()[Symbol.asyncIterator]();
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
      gateway.sendEvent(socket, "chat", {
        runId: "stream-1",
        state: "delta",
        deltaText: seq === 1 ? "hello" : " world",
        ...(seq === 1 ? { message: { role: "assistant", content: "hello" } } : {}),
      });
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
  });
});
