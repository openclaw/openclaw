import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { OpenClaw } from "./client.js";
import { GatewayClientTransport } from "./transport.js";
import { createSdkWebSocketServer } from "./transport.websocket.test-support.js";
import type { OpenClawEvent } from "./types.js";

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

  function chat(state: string, text?: string, extra: Record<string, unknown> = {}) {
    return {
      ...scope,
      state,
      ...(text === undefined ? {} : { message: { role: "assistant", content: text } }),
      ...extra,
    };
  }

  function sendChat(state: string, text?: string, extra?: Record<string, unknown>) {
    gateway.sendEvent(gateway.socket(), "chat", chat(state, text, extra));
  }

  type Request = Parameters<NonNullable<Parameters<typeof gateway.setRequestHandler>[0]>>[1];
  function respond(handler: (request: Request) => unknown) {
    gateway.setRequestHandler((socket, request) => {
      gateway.reply(socket, request.id, handler(request));
    });
  }

  function completionWait(request: Request, waiting: { resolve: () => void }) {
    if (request.params.timeoutMs === 0) {
      return { runId: scope.runId, status: "timeout" };
    }
    waiting.resolve();
    return undefined;
  }

  async function expectNext(events: AsyncIterator<OpenClawEvent>, value: unknown) {
    await expect(events.next()).resolves.toMatchObject({ value });
  }

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
      aborted: aborted.promise,
      reconnect: async () => {
        await disconnected.promise;
        await vi.advanceTimersByTimeAsync(1_000);
        await reconnected.promise;
        expect(hellos).toBe(2);
      },
    };
  }

  async function baseline(): Promise<AsyncIterator<OpenClawEvent>> {
    const events = oc.runEvents(scope.runId)[Symbol.asyncIterator]();
    const first = events.next();
    sendChat("delta", "hello", { deltaText: "hello" });
    await expect(first).resolves.toMatchObject({ value: { data: { text: "hello" } } });
    return events;
  }

  it.each(["agent-lifecycle", "chat-delta", "accepted", "chat-final"])(
    "preserves the full terminal reply across a %s reconnect",
    async (mode) => {
      const outputText =
        mode === "accepted" ? "complete output" : `    ${"complete answer ".repeat(400)}\n`;
      const methods: string[] = [];
      respond((request) => {
        methods.push(request.method);
        return request.method === "chat.send"
          ? { runId: scope.runId, status: "started" }
          : request.method === "agent.wait"
            ? {
                runId: scope.runId,
                status: "ok",
                endedAt: 123,
                terminalReply:
                  mode === "accepted"
                    ? { text: "clipped summary" }
                    : { disposition: "visible", text: outputText.slice(0, 4_096) },
              }
            : {
                sessionId: "physical-session",
                messages: [
                  { role: "assistant", content: outputText, __openclaw: { runId: scope.runId } },
                ],
              };
      });
      const connection = await connect();
      if (mode === "accepted") {
        await oc.request("chat.send", {
          sessionKey: scope.sessionKey,
          message: "hello",
          idempotencyKey: scope.runId,
        });
      }
      const events =
        mode === "accepted" ? oc.runEvents(scope.runId)[Symbol.asyncIterator]() : await baseline();
      const terminal = mode === "accepted" ? undefined : events.next();
      const socket = gateway.socket();
      const sendGap = (event: string, payload: unknown, seq: number) => {
        socket.send(JSON.stringify({ type: "event", event, payload, seq }));
      };
      if (mode === "accepted") {
        socket.close();
      } else {
        sendGap(
          mode === "agent-lifecycle" ? "agent" : "chat",
          mode === "agent-lifecycle"
            ? { ...scope, stream: "lifecycle", data: { phase: "end" } }
            : mode === "chat-final"
              ? chat("final", outputText)
              : chat("delta", undefined, { deltaText: " lost suffix" }),
          3,
        );
        if (mode !== "chat-final") {
          sendGap("chat", chat("final", outputText), 4);
        }
      }
      const delivered = mode === "chat-final" ? await terminal : undefined;
      await connection.reconnect();
      const recovered = delivered ?? (await (terminal ?? events.next()));
      expect(recovered.value).toMatchObject({
        type: "run.completed",
        data: {
          outputText,
          ...(mode === "chat-final" ? {} : { recovery: { status: "recovered" } }),
        },
      });
      if (mode !== "chat-final") {
        expect(recovered.value?.raw).toBeUndefined();
      }
      expect(methods).toEqual(
        mode === "chat-final"
          ? []
          : [...(mode === "accepted" ? ["chat.send"] : []), "agent.wait", "chat.history"],
      );
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
          const result = completionWait(request, waiting);
          if (result) {
            gateway.reply(socket, request.id, result);
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
      if (mode === "newer-live-snapshot") {
        sendChat("delta", "hello newer", { deltaText: "hello newer" });
        await expectNext(events, { data: { text: "hello newer" } });
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
        await expectNext(events, {
          type: "raw",
          data: { recovery: { reason: "history-request-failed" } },
        });
      }
      if (mode !== "newer-live-snapshot") {
        sendChat("delta", "hello recovered", { deltaText: "hello recovered" });
        await expectNext(events, {
          data: { text: "hello recovered", delta: mode === "history" ? "" : " recovered" },
        });
      }
      const text = mode === "newer-live-snapshot" ? "hello newer suffix" : "hello recovered suffix";
      sendChat("delta", undefined, { deltaText: " suffix" });
      await expectNext(events, { data: { text, delta: " suffix" } });
      sendChat("final", text);
      await expectNext(events, { type: "run.completed", data: { outputText: text } });
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
          const result = completionWait(request, waiting);
          if (result) {
            gateway.reply(socket, request.id, result);
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

  it.each(["queued", "pending-error", "unavailable"])(
    "backs off and rearms %s observations without settling",
    async (mode) => {
      const connection = await connect();
      const events = await baseline();
      let waits = 0;
      const rearmed = createDeferred();
      gateway.setRequestHandler((socket, request) => {
        if (request.method === "agent.wait") {
          if (++waits === 3 && mode === "unavailable") {
            rearmed.resolve();
            return;
          }
          gateway.reply(socket, request.id, {
            runId: scope.runId,
            ...(mode === "queued"
              ? { status: "pending" }
              : { status: "timeout", ...(mode === "pending-error" ? { pendingError: true } : {}) }),
          });
          if (waits > 1 && mode !== "unavailable") {
            gateway.sendEvent(socket, "probe.wait", { ...scope, waits });
          }
        } else {
          gateway.reply(socket, request.id, { sessionId: "physical-session", messages: [] });
          if (mode !== "unavailable") {
            gateway.sendEvent(socket, "probe.history", scope);
          }
        }
      });
      gateway.socket().close();
      await connection.reconnect();
      if (mode === "unavailable") {
        const unavailable = await events.next();
        expect(unavailable.value).toMatchObject({
          type: "raw",
          data: { recovery: { status: "unavailable", reason: "run-state-unavailable" } },
        });
        expect(unavailable.value?.raw).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1_000);
        await rearmed.promise;
      } else {
        await expectNext(events, { raw: { event: "probe.history" } });
        for (const [count, delay] of [
          [2, 1_000],
          [3, 2_000],
        ] as const) {
          await vi.advanceTimersByTimeAsync(delay);
          await expectNext(events, { raw: { event: "probe.wait" }, data: { waits: count } });
        }
      }
      await events.return?.();
      expect(waits).toBe(3);
    },
  );

  it("releases 150 accepted runs before their first output without inferring owners for other addresses", async () => {
    const waited: string[] = [];
    respond((request) => {
      if (request.method === "chat.send") {
        return {
          runId: request.params.idempotencyKey,
          status: "started",
        };
      } else if (request.method === "sessions.messages.unsubscribe") {
        const key = request.params.key;
        return {
          key:
            key === "review"
              ? `agent:${request.params.agentId === "ops" ? "ops" : "main"}:review`
              : key,
          subscribed: false,
        };
      } else if (request.method === "agent.wait") {
        waited.push(String(request.params.runId));
        return {
          runId: request.params.runId,
          status: "ok",
          endedAt: 123,
          terminalReply: { disposition: "silent" },
        };
      }
      return {};
    });
    const connection = await connect();
    const targets = [
      { sessionKey: "review", agentId: "ops" },
      { sessionKey: scope.sessionKey },
      { sessionKey: "review" },
      { sessionKey: "global" },
      { sessionKey: "unknown" },
    ];
    for (const [caseIndex, target] of targets.entries()) {
      for (let index = 0; index < 30; index++) {
        await oc.request("chat.send", {
          ...target,
          message: "hello",
          idempotencyKey: `run-${caseIndex}-${index}`,
        });
        await oc.request("sessions.messages.unsubscribe", {
          key: caseIndex === 0 && index % 2 === 0 ? "agent:ops:review" : target.sessionKey,
          ...(target.agentId ? { agentId: target.agentId } : {}),
        });
      }
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

  it.each(["agent:ops:main", "agent:main:main", "global", "unknown"])(
    "preserves another agent's baseline when unsubscribing %s",
    async (key) => {
      const sessionKey = key === "unknown" ? "unknown" : "global";
      respond(() => ({ key: sessionKey, subscribed: false }));
      await connect();
      const events = oc.runEvents("research-run")[Symbol.asyncIterator]();
      const first = events.next();
      const target = { runId: "research-run", sessionKey, agentId: "research" };
      gateway.sendEvent(gateway.socket(), "agent", {
        ...target,
        stream: "assistant",
        data: { text: "research", delta: "research" },
      });
      await expect(first).resolves.toMatchObject({ value: { data: { text: "research" } } });
      await oc.request("sessions.messages.unsubscribe", { key });
      gateway.sendEvent(gateway.socket(), "agent", {
        ...target,
        stream: "assistant",
        data: { delta: " continues" },
      });
      await expectNext(events, { data: { text: "research continues", delta: " continues" } });
      await events.return?.();
    },
  );
});
