import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { OpenClaw } from "./client.js";
import { GatewayClientTransport } from "./transport.js";
import { createSdkWebSocketServer, replySdkRequest } from "./transport.websocket.test-support.js";
import type { OpenClawEvent } from "./types.js";

let gateway: Awaited<ReturnType<typeof createSdkWebSocketServer>>;
let oc: OpenClaw;
let transport: GatewayClientTransport;
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
type Reply = (payload: unknown, ok?: boolean) => void;
type Socket = Parameters<typeof gateway.sendEvent>[0];
function respond(handler: (request: Request, reply: Reply, socket: Socket) => unknown) {
  gateway.setRequestHandler((socket, request) => {
    const reply: Reply = (payload, ok = true) => replySdkRequest(socket, request.id, payload, ok);
    const result = handler(request, reply, socket);
    if (result !== undefined) {
      reply(result);
    }
  });
}

function completionWait(history: (request: Request, reply: Reply) => unknown) {
  const waiting = createDeferred();
  respond((request, reply) => {
    if (request.method !== "agent.wait") {
      return history(request, reply);
    }
    if (request.params.timeoutMs === 0) {
      return runResult("timeout");
    }
    waiting.resolve();
    return undefined;
  });
  return waiting.promise;
}

const runResult = (status: string, fields: Record<string, unknown> = {}) => ({
  runId: scope.runId,
  status,
  ...fields,
});
const historyResult = (fields: Record<string, unknown>) => ({
  sessionId: "physical-session",
  ...fields,
});
const submit = (
  idempotencyKey: string,
  target: { sessionKey: string; agentId?: string } = { sessionKey: scope.sessionKey },
) => oc.request("chat.send", { ...target, message: "hello", idempotencyKey });

async function expectNext(events: AsyncIterator<OpenClawEvent>, value: unknown) {
  const next = await events.next();
  expect(next).toMatchObject({ value });
  return next.value;
}

async function expectRecovery(events: AsyncIterator<OpenClawEvent>, value: unknown) {
  expect((await expectNext(events, value))?.raw).toBeUndefined();
}

function createClient(options: ConstructorParameters<typeof GatewayClientTransport>[0] = {}) {
  transport = new GatewayClientTransport({ url: gateway.url, deviceIdentity: null, ...options });
  oc = new OpenClaw({ transport });
}

function createLiveClient(options: ConstructorParameters<typeof GatewayClientTransport>[0] = {}) {
  vi.useRealTimers();
  createClient(options);
}

async function connect() {
  const disconnected = createDeferred();
  const reconnected = createDeferred();
  const aborted = createDeferred();
  let hellos = 0;
  createClient({
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
  await oc.connect();
  return {
    aborted: aborted.promise,
    reconnect: async (close = true) => {
      if (close) {
        gateway.socket().close();
      }
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

it.each(["chat-delta", "accepted", "chat-final"])(
  "preserves the full terminal reply across a %s reconnect",
  async (mode) => {
    const accepted = mode === "accepted",
      delivered = mode === "chat-final";
    const outputText = accepted ? "complete output" : `    ${"complete answer ".repeat(400)}\n`;
    const terminalReply = accepted
      ? { text: "clipped summary" }
      : { disposition: "visible", text: outputText.slice(0, 4_096) };
    const methods: string[] = [];
    respond((request) => {
      methods.push(request.method);
      if (request.method === "chat.send") {
        return runResult("started");
      }
      if (request.method === "agent.wait") {
        return runResult("ok", { endedAt: 123, terminalReply });
      }
      return historyResult({
        messages: [{ role: "assistant", content: outputText, __openclaw: { runId: scope.runId } }],
      });
    });
    const connection = await connect();
    if (accepted) {
      await submit(scope.runId);
    }
    const events = accepted ? oc.runEvents(scope.runId)[Symbol.asyncIterator]() : await baseline();
    const terminal = accepted ? undefined : events.next();
    const socket = gateway.socket();
    const sendGap = (event: string, payload: unknown, seq: number) => {
      socket.send(JSON.stringify({ type: "event", event, payload, seq }));
    };
    if (accepted) {
      socket.close();
    } else {
      const payload = delivered
        ? chat("final", outputText)
        : chat("delta", undefined, { deltaText: " lost suffix" });
      sendGap("chat", payload, 3);
      if (!delivered) {
        sendGap("chat", chat("final", outputText), 4);
      }
    }
    const beforeReconnect = delivered ? await terminal : undefined;
    await connection.reconnect(false);
    const recovered = beforeReconnect ?? (await (terminal ?? events.next()));
    expect(recovered.value).toMatchObject({
      type: "run.completed",
      data: {
        outputText,
        ...(delivered ? {} : { recovery: { status: "recovered" } }),
      },
    });
    if (!delivered) {
      expect(recovered.value?.raw).toBeUndefined();
    }
    expect(methods).toEqual(
      delivered ? [] : [...(accepted ? ["chat.send"] : []), "agent.wait", "chat.history"],
    );
    await events.return?.();
  },
);

function assistant(
  socket: Socket,
  target: { runId: string; sessionKey: string; agentId?: string },
  data: { text?: string; delta: string },
) {
  gateway.sendEvent(socket, "agent", { agentId: "main", ...target, stream: "assistant", data });
}

it("bounds replay after 150 confirmed session unsubscribe cycles", async () => {
  createLiveClient();
  let runIndex = 0;
  respond((request, _reply, socket) => {
    const key = request.params.key;
    if (typeof key !== "string") {
      throw new Error("Expected a session key");
    }
    const canonicalKey = key === "global" ? key : `agent:main:${key}`;
    if (
      !["sessions.messages.subscribe", "sessions.messages.unsubscribe"].includes(request.method)
    ) {
      throw new Error(`Unexpected request: ${request.method}`);
    }
    const subscribed = request.method === "sessions.messages.subscribe";
    const target = { runId: `run-${runIndex}`, sessionKey: canonicalKey };
    const data = subscribed ? { text: "prefix", delta: "prefix" } : { delta: " tail" };
    gateway.sendEvent(socket, "chat", {
      ...target,
      agentId: "main",
      state: "delta",
      deltaText: data.delta,
      ...(data.text ? { message: { role: "assistant", content: data.text } } : {}),
    });
    assistant(socket, target, data);
    if (!subscribed) {
      gateway.sendEvent(socket, "board.changed", {});
      runIndex++;
    }
    return { subscribed, key: canonicalKey };
  });
  await oc.connect();
  for (let index = 0; index < 150; index += 1) {
    const key = index % 2 === 0 ? "global" : `session-${index}`;
    await oc.request("sessions.messages.subscribe", { key, agentId: "main" });
    await oc.request("sessions.messages.unsubscribe", { key, agentId: "main" });
  }
  const recent = oc.runEvents("run-50")[Symbol.asyncIterator]();
  await expectNext(recent, { data: { text: "prefix" } });
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
  createLiveClient();
  const target = { runId: "run", sessionKey: "global" };
  respond((request, reply, socket) => {
    if (request.method === "sessions.messages.subscribe") {
      assistant(socket, target, { text: "old", delta: "" });
      return { subscribed: true, key: "global" };
    }
    reply({ code: "UNAVAILABLE", message: "unsubscribe rejected" }, false);
    return undefined;
  });
  const address = { key: "global", agentId: "main" };
  await oc.request("sessions.messages.subscribe", address);
  const iterator = oc.runEvents("run")[Symbol.asyncIterator]();
  await expectNext(iterator, { data: { text: "old" } });
  await expect(oc.request("sessions.messages.unsubscribe", address)).rejects.toThrow(
    "unsubscribe rejected",
  );
  assistant(gateway.socket(), target, { delta: " tail" });
  await expectNext(iterator, { data: { text: "old tail" } });
});

it("keeps healthy concurrent event readers alive when another subscriber fails", async () => {
  createLiveClient({ requestTimeoutMs: 2_000 });
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
  for (const seq of [1, 2]) {
    gateway.sendEvent(gateway.socket(), "chat", {
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
  const normalizedSecond = await expectNext(normalized, {
    type: "assistant.delta",
    data: { text: "hello world", delta: " world" },
  });
  expect(normalizedSecond?.raw?.payload).not.toHaveProperty("message");
});

it.each(["history", "newer-live-snapshot", "failed-history"])(
  "rearms completion and continues chat suffixes after %s recovery",
  async (mode) => {
    const history = createDeferred<() => void>();
    const waiting = completionWait((_request, reply) => {
      history.resolve(() => {
        if (mode === "failed-history") {
          reply({ code: "UNAVAILABLE", message: "history unavailable" }, false);
        } else {
          reply(historyResult({ inFlightRun: { runId: scope.runId, text: "hello recovered" } }));
        }
      });
    });
    const connection = await connect();
    const events = await baseline();
    await connection.reconnect();
    const resolveHistory = await history.promise;
    if (mode === "newer-live-snapshot") {
      sendChat("delta", "hello newer", { deltaText: "hello newer" });
      await expectNext(events, { data: { text: "hello newer" } });
    }
    resolveHistory();
    await waiting;
    if (mode === "history") {
      await expectRecovery(events, {
        type: "assistant.delta",
        data: { text: "hello recovered", replace: true, recovery: { projection: "chat" } },
      });
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
    const waiting = completionWait(() =>
      historyResult({ sessionInfo: { activeRunIds: [scope.runId] } }),
    );
    const connection = await connect();
    const events = await baseline();
    const pending = events.next();
    await connection.reconnect();
    await waiting;
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
    respond((request, reply, socket) => {
      if (request.method === "agent.wait") {
        if (++waits === 3 && mode === "unavailable") {
          rearmed.resolve();
          return;
        }
        reply(
          runResult(
            mode === "queued" ? "pending" : "timeout",
            mode === "pending-error" ? { pendingError: true } : {},
          ),
        );
        if (waits > 1 && mode !== "unavailable") {
          gateway.sendEvent(socket, "probe.wait", { ...scope, waits });
        }
      } else {
        reply(historyResult({ messages: [] }));
        if (mode !== "unavailable") {
          gateway.sendEvent(socket, "probe.history", scope);
        }
      }
    });
    await connection.reconnect();
    if (mode === "unavailable") {
      await expectRecovery(events, {
        type: "raw",
        data: { recovery: { status: "unavailable", reason: "run-state-unavailable" } },
      });
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
      return runResult("started", { runId: request.params.idempotencyKey });
    } else if (request.method === "sessions.messages.unsubscribe") {
      const key = request.params.key;
      const owner = request.params.agentId === "ops" ? "ops" : "main";
      return { key: key === "review" ? `agent:${owner}:review` : key, subscribed: false };
    } else if (request.method === "agent.wait") {
      waited.push(String(request.params.runId));
      return runResult("ok", {
        runId: request.params.runId,
        endedAt: 123,
        terminalReply: { disposition: "silent" },
      });
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
      await submit(`run-${caseIndex}-${index}`, target);
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
    await submit(runId, { sessionKey: "review" });
    await oc.request("sessions.messages.unsubscribe", address);
  }
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
    assistant(gateway.socket(), target, { text: "research", delta: "research" });
    await expect(first).resolves.toMatchObject({ value: { data: { text: "research" } } });
    await oc.request("sessions.messages.unsubscribe", { key });
    assistant(gateway.socket(), target, { delta: " continues" });
    await expectNext(events, { data: { text: "research continues", delta: " continues" } });
    await events.return?.();
  },
);
