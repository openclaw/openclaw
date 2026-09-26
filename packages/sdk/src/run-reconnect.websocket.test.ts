import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { OpenClaw } from "./client.js";
import { GatewayClientTransport } from "./transport.js";
import { createSdkWebSocketServer } from "./transport.websocket.test-support.js";
import type { GatewayRequestOptions, OpenClawEvent } from "./types.js";

describe("SDK run reconciliation over reconnect", () => {
  let gateway: Awaited<ReturnType<typeof createSdkWebSocketServer>>;
  let oc: OpenClaw;
  const scope = { runId: "run", sessionKey: "agent:main:recovery" };
  beforeAll(async () => {
    gateway = await createSdkWebSocketServer();
  });
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    gateway.setRequestHandler();
  });
  afterEach(async () => {
    await oc?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await gateway.close();
  });

  async function connect() {
    const disconnected = createDeferred();
    const reconnected = createDeferred();
    const aborted = createDeferred();
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
      onRequestTiming: (timing) => {
        if (timing.method === "agent.wait" && timing.errorCode === "CLIENT_ABORTED") {
          aborted.resolve();
        }
      },
    });
    oc = new OpenClaw({ transport });
    await oc.connect();
    return {
      transport,
      aborted: aborted.promise,
      reconnect: async () => {
        await disconnected.promise;
        await vi.advanceTimersByTimeAsync(1_000);
        await reconnected.promise;
      },
    };
  }

  async function baseline(): Promise<AsyncIterator<OpenClawEvent>> {
    const events = oc.runEvents(scope.runId)[Symbol.asyncIterator]();
    const first = events.next();
    gateway.sendEvent(gateway.socket(), "chat", {
      ...scope,
      state: "delta",
      deltaText: "hello",
      message: { role: "assistant", content: "hello" },
    });
    await expect(first).resolves.toMatchObject({ value: { data: { text: "hello" } } });
    return events;
  }

  it.each(["agent-lifecycle", "chat-delta"])(
    "recovers an exact full reply when %s reveals the gap before the lost final",
    async (gapFrame) => {
      const outputText = "complete answer ".repeat(400);
      const methods: string[] = [];
      gateway.setRequestHandler((socket, request) => {
        methods.push(request.method);
        gateway.reply(
          socket,
          request.id,
          request.method === "agent.wait"
            ? {
                runId: scope.runId,
                status: "ok",
                endedAt: 123,
                terminalReply: { disposition: "visible", text: outputText.slice(0, 4_096) },
              }
            : {
                sessionId: "physical-session",
                messages: [
                  { role: "assistant", content: outputText, __openclaw: { runId: scope.runId } },
                ],
              },
        );
      });
      const connection = await connect();
      const events = await baseline();
      const terminal = events.next();
      const socket = gateway.socket();
      socket.send(
        JSON.stringify({
          type: "event",
          seq: 3,
          event: gapFrame === "agent-lifecycle" ? "agent" : "chat",
          payload:
            gapFrame === "agent-lifecycle"
              ? { ...scope, stream: "lifecycle", data: { phase: "end" } }
              : { ...scope, state: "delta", deltaText: " lost suffix" },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "event",
          event: "chat",
          seq: 4,
          payload: {
            ...scope,
            state: "final",
            message: { role: "assistant", content: outputText },
          },
        }),
      );
      await connection.reconnect();
      const recovered = await terminal;
      expect(recovered.value).toMatchObject({
        type: "run.completed",
        data: { outputText, recovery: { status: "recovered" } },
      });
      expect(recovered.value?.raw).toBeUndefined();
      expect(methods).toEqual(["agent.wait", "chat.history"]);
      await events.return?.();
    },
  );

  it.each(["history", "newer-live-snapshot", "failed-history"])(
    "rearms completion and continues chat suffixes after %s recovery",
    async (mode) => {
      const history = createDeferred<() => void>();
      const waiting = createDeferred();
      gateway.setRequestHandler((socket, request) => {
        if (request.method === "agent.wait") {
          if (request.params.timeoutMs === 0) {
            gateway.reply(socket, request.id, { runId: scope.runId, status: "timeout" });
          } else {
            waiting.resolve();
          }
        } else {
          history.resolve(() => {
            if (mode === "failed-history") {
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: request.id,
                  ok: false,
                  error: { code: "UNAVAILABLE", message: "history unavailable" },
                }),
              );
            } else {
              gateway.reply(socket, request.id, {
                sessionId: "physical-session",
                inFlightRun: { runId: scope.runId, text: "hello recovered" },
              });
            }
          });
        }
      });
      const connection = await connect();
      const events = await baseline();
      gateway.socket().close();
      await connection.reconnect();
      const resolveHistory = await history.promise;
      const socket = gateway.socket();
      if (mode === "newer-live-snapshot") {
        gateway.sendEvent(socket, "chat", {
          ...scope,
          state: "delta",
          message: { role: "assistant", content: "hello newer" },
          deltaText: "hello newer",
        });
        await expect(events.next()).resolves.toMatchObject({
          value: { data: { text: "hello newer" } },
        });
      }
      resolveHistory();
      await waiting.promise;
      if (mode === "history") {
        const recovered = await events.next();
        expect(recovered.value).toMatchObject({
          type: "assistant.delta",
          data: {
            text: "hello recovered",
            replace: true,
            recovery: { projection: "chat" },
          },
        });
        expect(recovered.value?.raw).toBeUndefined();
      } else if (mode === "failed-history") {
        await expect(events.next()).resolves.toMatchObject({
          value: { type: "raw", data: { recovery: { reason: "history-request-failed" } } },
        });
      }
      if (mode !== "newer-live-snapshot") {
        gateway.sendEvent(socket, "chat", {
          ...scope,
          state: "delta",
          message: { role: "assistant", content: "hello recovered" },
          deltaText: "hello recovered",
        });
        await expect(events.next()).resolves.toMatchObject({
          value: {
            data: {
              text: "hello recovered",
              delta: mode === "history" ? "" : " recovered",
            },
          },
        });
      }
      const text = mode === "newer-live-snapshot" ? "hello newer suffix" : "hello recovered suffix";
      gateway.sendEvent(socket, "chat", { ...scope, state: "delta", deltaText: " suffix" });
      await expect(events.next()).resolves.toMatchObject({
        value: { data: { text, delta: " suffix" } },
      });
      gateway.sendEvent(socket, "chat", {
        ...scope,
        state: "final",
        message: { role: "assistant", content: text },
      });
      await expect(events.next()).resolves.toMatchObject({
        value: { type: "run.completed", data: { outputText: text } },
      });
      await connection.aborted;
      await events.return?.();
    },
  );

  it.each(["iterator-return", "client-close"])(
    "cancels an active completion wait on %s",
    async (stop) => {
      const waiting = createDeferred();
      gateway.setRequestHandler((socket, request) => {
        if (request.method === "agent.wait") {
          if (request.params.timeoutMs === 0) {
            gateway.reply(socket, request.id, { runId: scope.runId, status: "timeout" });
          } else {
            waiting.resolve();
          }
        } else {
          gateway.reply(socket, request.id, {
            sessionId: "physical-session",
            sessionInfo: { activeRunIds: [scope.runId] },
          });
        }
      });
      const connection = await connect();
      const events = await baseline();
      const pending = events.next();
      gateway.socket().close();
      await connection.reconnect();
      await waiting.promise;
      if (stop === "iterator-return") {
        await events.return?.();
      } else {
        await oc.close();
      }
      await connection.aborted;
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
    },
  );

  it("recovers a started acknowledgment before the first output without fabricating a raw terminal", async () => {
    gateway.setRequestHandler((socket, request) => {
      gateway.reply(
        socket,
        request.id,
        request.method === "chat.send"
          ? { runId: scope.runId, status: "started" }
          : request.method === "agent.wait"
            ? {
                runId: scope.runId,
                status: "ok",
                endedAt: 123,
                terminalReply: { text: "clipped summary" },
              }
            : {
                sessionId: "physical-session",
                messages: [
                  {
                    role: "assistant",
                    content: "complete output",
                    __openclaw: { runId: scope.runId },
                  },
                ],
              },
      );
    });
    const connection = await connect();
    await oc.request("chat.send", {
      sessionKey: scope.sessionKey,
      message: "hello",
      idempotencyKey: scope.runId,
    });
    gateway.socket().close();
    await connection.reconnect();
    const events = oc.runEvents(scope.runId)[Symbol.asyncIterator]();
    const terminal = await events.next();
    expect(terminal.value).toMatchObject({
      type: "run.completed",
      data: {
        outputText: "complete output",
        recovery: { status: "recovered" },
      },
    });
    expect(terminal.value?.raw).toBeUndefined();
    await events.return?.();
  });

  it("reports an expired observation without converting bare wait timeout into completion", async () => {
    let waits = 0;
    const rearmed = createDeferred();
    gateway.setRequestHandler((socket, request) => {
      if (request.method === "agent.wait" && ++waits === 3) {
        rearmed.resolve();
        return;
      }
      gateway.reply(
        socket,
        request.id,
        request.method === "agent.wait"
          ? { runId: scope.runId, status: "timeout" }
          : { sessionId: "physical-session", messages: [] },
      );
    });
    const connection = await connect();
    const events = await baseline();
    gateway.socket().close();
    await connection.reconnect();
    const unavailable = await events.next();
    expect(unavailable.value).toMatchObject({
      type: "raw",
      data: {
        recovery: { status: "unavailable", reason: "run-state-unavailable" },
      },
    });
    expect(unavailable.value?.raw).toBeUndefined();
    await rearmed.promise;
    await events.return?.();
  });

  it.each(["queued", "pending-error"])(
    "backs off and rearms %s observations without settling",
    async (mode) => {
      const connection = await connect();
      const events = await baseline();
      let waits = 0;
      gateway.setRequestHandler((socket, request) => {
        if (request.method === "agent.wait") {
          gateway.reply(socket, request.id, {
            runId: scope.runId,
            ...(mode === "queued"
              ? { status: "pending" }
              : { status: "timeout", pendingError: true }),
          });
          if (++waits > 1) {
            gateway.sendEvent(socket, "probe.wait", { ...scope, waits });
          }
        } else {
          gateway.reply(socket, request.id, { sessionId: "physical-session", messages: [] });
          gateway.sendEvent(socket, "probe.history", scope);
        }
      });
      gateway.socket().close();
      await connection.reconnect();
      await expect(events.next()).resolves.toMatchObject({
        value: { raw: { event: "probe.history" } },
      });
      for (const count of [2, 3]) {
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(events.next()).resolves.toMatchObject({
          value: { raw: { event: "probe.wait" }, data: { waits: count } },
        });
      }
      await events.return?.();
      expect(waits).toBe(3);
    },
  );

  function handleAcceptedRuns(waited: string[]) {
    gateway.setRequestHandler((socket, request) => {
      if (request.method === "chat.send") {
        gateway.reply(socket, request.id, {
          runId: request.params.idempotencyKey,
          status: "started",
        });
      } else if (request.method === "sessions.messages.unsubscribe") {
        const key = request.params.key;
        gateway.reply(socket, request.id, {
          key:
            key === "review"
              ? `agent:${request.params.agentId === "ops" ? "ops" : "main"}:review`
              : key,
          subscribed: false,
        });
      } else if (request.method === "agent.wait") {
        waited.push(String(request.params.runId));
        gateway.reply(socket, request.id, {
          runId: request.params.runId,
          status: "ok",
          endedAt: 123,
          terminalReply: { disposition: "silent" },
        });
      } else {
        gateway.reply(socket, request.id, {});
      }
    });
  }

  it("releases 150 accepted runs before their first output without inferring owners for other addresses", async () => {
    const waited: string[] = [];
    handleAcceptedRuns(waited);
    const connection = await connect();
    for (let index = 0; index < 150; index++) {
      const target =
        index % 3 === 0
          ? { sessionKey: "review", agentId: "ops" }
          : { sessionKey: index % 3 === 1 ? scope.sessionKey : "review" };
      await oc.request("chat.send", {
        ...target,
        message: "hello",
        idempotencyKey: `run-${index}`,
      });
      await oc.request("sessions.messages.unsubscribe", {
        key: index % 6 === 0 ? "agent:ops:review" : target.sessionKey,
        ...(target.agentId ? { agentId: target.agentId } : {}),
      });
    }
    for (const [runId, address] of [
      ["default-canonical", { key: "agent:main:review" }],
      ["default-explicit", { key: "review", agentId: "ops" }],
    ] as const) {
      await oc.request("chat.send", {
        sessionKey: "review",
        message: "hello",
        idempotencyKey: runId,
      });
      await oc.request("sessions.messages.unsubscribe", address);
    }
    gateway.socket().close();
    await connection.reconnect();
    await oc.request("probe", {});
    expect(waited).toEqual(["default-canonical", "default-explicit"]);
  });

  it("keeps a newer acceptance when an earlier unsubscribe ACK finishes afterward with no text", async () => {
    const waited: string[] = [];
    handleAcceptedRuns(waited);
    const connection = await connect();
    const acknowledged = createDeferred();
    const release = createDeferred();
    const request = connection.transport.request.bind(connection.transport);
    vi.spyOn(connection.transport, "request").mockImplementation(
      async <T>(method: string, params?: unknown, options?: GatewayRequestOptions): Promise<T> => {
        const result = await request<T>(method, params, options);
        if (method === "sessions.messages.unsubscribe") {
          acknowledged.resolve();
          await release.promise;
        }
        return result;
      },
    );
    try {
      await oc.request("chat.send", {
        sessionKey: "review",
        agentId: "ops",
        message: "old",
        idempotencyKey: "old",
      });
      const unsubscribed = oc.request("sessions.messages.unsubscribe", {
        key: "review",
        agentId: "ops",
      });
      await acknowledged.promise;
      await oc.request("chat.send", {
        sessionKey: "review",
        agentId: "ops",
        message: "new",
        idempotencyKey: "new",
      });
      release.resolve();
      await unsubscribed;
      gateway.socket().close();
      await connection.reconnect();
      const events = oc.runEvents("new")[Symbol.asyncIterator]();
      await expect(events.next()).resolves.toMatchObject({
        value: {
          type: "run.completed",
          data: { outputText: "", recovery: { status: "recovered" } },
        },
      });
      expect(waited).toEqual(["new"]);
      await events.return?.();
    } finally {
      release.resolve();
    }
  });

  it.each(["ops", "main"])(
    "preserves another agent's global baseline when agent:%s:main collapses to global",
    async (owner) => {
      gateway.setRequestHandler((socket, request) => {
        gateway.reply(socket, request.id, { key: "global", subscribed: false });
      });
      await connect();
      const events = oc.runEvents("research-run")[Symbol.asyncIterator]();
      const first = events.next();
      const target = { runId: "research-run", sessionKey: "global", agentId: "research" };
      gateway.sendEvent(gateway.socket(), "agent", {
        ...target,
        stream: "assistant",
        data: { text: "research", delta: "research" },
      });
      await expect(first).resolves.toMatchObject({ value: { data: { text: "research" } } });
      await oc.request("sessions.messages.unsubscribe", { key: `agent:${owner}:main` });
      gateway.sendEvent(gateway.socket(), "agent", {
        ...target,
        stream: "assistant",
        data: { delta: " continues" },
      });
      await expect(events.next()).resolves.toMatchObject({
        value: {
          data: { text: "research continues", delta: " continues" },
        },
      });
      await events.return?.();
    },
  );
});
