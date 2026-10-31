import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import type { AcpAgentWaitResult } from "./translator.prompt-state.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

const sessionId = "session-1";
const sessionKey = "agent:main:main";
const closeError = () => new Error("gateway closed (1006): connection lost");
const throwClose = () => {
  throw closeError();
};
const disconnected = "Gateway disconnected: 1006: connection lost";
const emptyReply = { status: "ok", terminalReply: { disposition: "empty" } };
const timeout = { status: "timeout" };
type RequestHandler = (params?: Record<string, unknown>) => unknown;

function harness(
  options: {
    send?: RequestHandler;
    wait?: RequestHandler;
    history?: () => unknown;
    sessionKey?: string;
  } = {},
) {
  const eventLedger = createTestAcpEventLedger();
  const recorded = createDeferred();
  const recordUserPrompt = eventLedger.recordUserPrompt.bind(eventLedger);
  eventLedger.recordUserPrompt = async (params) => {
    await recordUserPrompt(params);
    recorded.resolve();
  };
  const h = createPromptScenario({
    eventLedger,
    sessionKey: options.sessionKey,
    send: options.send,
    request: (method, params) =>
      method === "agent.wait"
        ? (options.wait?.(params) ?? {})
        : method === "chat.history"
          ? (options.history?.() ?? {})
          : {},
  });
  return { ...h, eventLedger, recorded: recorded.promise };
}

function timedHarness(options: Parameters<typeof harness>[0] = {}) {
  vi.useFakeTimers();
  return harness(options);
}

async function start(h: ReturnType<typeof harness>) {
  const pending = h.start();
  return { ...pending, runId: await pending.sent };
}

function reconnect(agent: ReturnType<typeof harness>["agent"]) {
  agent.handleGatewayDisconnect("1006: connection lost");
  agent.handleGatewayReconnect();
}

async function expectNotice(h: ReturnType<typeof harness>, accepted: boolean) {
  const text = accepted
    ? "[OpenClaw interruption] The Gateway disconnected after accepting this message, so its final outcome is unknown. Check the session before retrying."
    : "[OpenClaw interruption] The Gateway disconnected before OpenClaw could confirm whether this message was accepted, so its final outcome is unknown. Check the session before retrying.";
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as const;
  expect(h.sessionUpdate).toHaveBeenCalledWith({ sessionId, update });
  const replay = await h.eventLedger.readReplay({ sessionId, sessionKey });
  expect(textChunks(replay.events).filter((chunk) => chunk === text)).toHaveLength(1);
}

afterEach(() => vi.useRealTimers());

it("reconciles provisional session keys for subsequent prompts", async () => {
  const h = harness({ sessionKey: "acp:session-1", send: () => ({}) });
  const first = await start(h);
  const canonical = "agent:main:acp:session-1";
  await h.chat(first.runId, {
    sessionKey: canonical,
    message: { content: [{ type: "text", text: "first" }] },
  });
  await expect(first.result).resolves.toEqual({ stopReason: "end_turn" });
  expect(h.sessionStore.getSession(sessionId)?.sessionKey).toBe(canonical);
  const second = await start(h);
  expect(h.request).toHaveBeenLastCalledWith(
    "chat.send",
    expect.objectContaining({ sessionKey: canonical }),
    { timeoutMs: null },
  );
  await h.finish(second, { sessionKey: canonical });
});

it("keeps prompts pending across transient disconnects until a live final", async () => {
  const h = harness();
  const prompt = await start(h);
  h.agent.handleGatewayDisconnect("1006: connection lost");
  await Promise.resolve();
  expect(prompt.settlement).not.toHaveBeenCalled();
  h.agent.handleGatewayReconnect();
  await h.finish(prompt);
});

it.each([true, false])(
  "makes disconnect notices durable at the grace deadline (accepted=%s)",
  async (accepted) => {
    const h = timedHarness({ send: accepted ? () => ({}) : throwClose, wait: throwClose });
    await h.eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
    const prompt = await start(h);
    if (accepted) {
      await h.recorded;
    }
    expect(prompt.settlement).not.toHaveBeenCalled();
    const recordStarted = createDeferred();
    const recordBlocked = createDeferred();
    const deliveryBlocked = createDeferred();
    const recordUpdate = h.eventLedger.recordUpdate.bind(h.eventLedger);
    h.eventLedger.recordUpdate = async (params) => {
      recordStarted.resolve();
      await recordBlocked.promise;
      await recordUpdate(params);
    };
    h.sessionUpdate.mockImplementation(() => deliveryBlocked.promise);
    try {
      h.agent.handleGatewayDisconnect("1006: connection lost");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(prompt.settlement).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await recordStarted.promise;
      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(prompt.settlement).not.toHaveBeenCalled();
      recordBlocked.resolve();
      await expect(prompt.result).rejects.toThrow(disconnected);
      await expectNotice(h, accepted);
    } finally {
      recordBlocked.resolve();
      deliveryBlocked.resolve();
    }
  },
);

it("keeps accepted prompts pending when the deadline recheck times out", async () => {
  const h = timedHarness({ send: () => ({}), wait: () => timeout });
  const prompt = await start(h);
  await h.recorded;
  reconnect(h.agent);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(prompt.settlement).not.toHaveBeenCalled();
});

it("preserves a newer disconnect deadline during reconciliation", async () => {
  const waiting = createDeferred();
  const reply = createDeferred<typeof timeout>();
  const wait = vi
    .fn()
    .mockImplementationOnce(() => {
      waiting.resolve();
      return reply.promise;
    })
    .mockResolvedValue(timeout);
  const h = timedHarness({ send: () => ({}), wait });
  const prompt = await start(h);
  await h.recorded;
  reconnect(h.agent);
  await waiting.promise;
  h.agent.handleGatewayDisconnect("1006: second disconnect");
  reply.resolve(timeout);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(prompt.settlement).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(prompt.result).rejects.toThrow("Gateway disconnected: 1006: second disconnect");
});

it("isolates replacement disconnect handling from a cancelled send's late success", async () => {
  const firstSend = createDeferred();
  const send = vi.fn().mockReturnValueOnce(firstSend.promise).mockImplementation(throwClose);
  const h = timedHarness({ send, wait: () => timeout });
  const first = await start(h);
  const second = h.start();
  await expect(first.result).resolves.toEqual({ stopReason: "cancelled" });
  await second.sent;
  expect(h.request).toHaveBeenCalledWith(
    "chat.abort",
    expect.objectContaining({ sessionKey, runId: expect.any(String) }),
  );
  firstSend.resolve();
  await Promise.resolve();
  reconnect(h.agent);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(second.result).rejects.toThrow(disconnected);
});

it("finishes terminal prompts while rejecting stale pre-ack prompts", async () => {
  let waits = 0;
  const h = timedHarness({
    send: (params) => {
      if (params?.sessionKey === "agent:main:second") {
        throw closeError();
      }
      return {};
    },
    wait: (params) => (params?.runId === acceptedRunId && waits++ > 0 ? emptyReply : timeout),
  });
  h.sessionStore.createSession({
    sessionId: "session-2",
    sessionKey: "agent:main:second",
    cwd: "/tmp",
  });
  const accepted = await start(h);
  const acceptedRunId = accepted.runId;
  const preAck = h.start("session-2");
  await preAck.sent;
  await h.recorded;
  reconnect(h.agent);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(accepted.settlement).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(accepted.result).resolves.toEqual({ stopReason: "end_turn" });
  await expect(preAck.result).rejects.toThrow(disconnected);
});

it("ignores stale send errors while reconnect settlement is blocked", async () => {
  const send = createDeferred<never>();
  const delivery = createDeferred();
  const delivering = createDeferred();
  const h = harness({ send: () => send.promise, wait: () => emptyReply });
  h.sessionUpdate.mockImplementationOnce(() => {
    delivering.resolve();
    return delivery.promise;
  });
  h.agent.handleGatewayDisconnect("1006: connection lost");
  const prompt = await start(h);
  h.agent.handleGatewayReconnect();
  await delivering.promise;
  send.reject(closeError());
  await Promise.resolve();
  await Promise.resolve();
  expect(prompt.settlement).not.toHaveBeenCalled();
  delivery.resolve();
  await expect(prompt.result).resolves.toEqual({ stopReason: "end_turn" });
});

it("preserves a replacement when a stale send failure races disconnect rejection", async () => {
  const firstSend = createDeferred<never>();
  const send = vi.fn().mockReturnValueOnce(firstSend.promise).mockResolvedValue({});
  const h = timedHarness({ send, wait: throwClose });
  const first = await start(h);
  h.agent.handleGatewayDisconnect("1006: connection lost");
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(first.result).rejects.toThrow(disconnected);
  const second = await start(h);
  firstSend.reject(closeError());
  await Promise.resolve();
  expect(second.settlement).not.toHaveBeenCalled();
  await h.finish(second);
});

it("does not let a stale disconnect deadline reject a newer prompt", async () => {
  const send = vi.fn().mockImplementationOnce(throwClose).mockResolvedValue({});
  const h = timedHarness({
    send,
    wait: (params) => (params?.runId === firstRunId ? timeout : { status: "ok" }),
  });
  const first = await start(h);
  const firstRunId = first.runId;
  reconnect(h.agent);
  await Promise.resolve();
  const second = h.start();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(second.settlement).not.toHaveBeenCalled();
});

const visibleReply = (text = "final answer", status: AcpAgentWaitResult["status"] = "ok") => ({
  status,
  terminalReply: { disposition: "visible" as const, text },
});
const textChunks = (events: { update: SessionUpdate }[]) =>
  events.flatMap(({ update }) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [],
  );

async function recoveryHarness(
  result: AcpAgentWaitResult = visibleReply(),
  historyText: string | null = result.terminalReply?.disposition === "visible"
    ? result.terminalReply.text
    : "",
) {
  const h = harness({
    send: () => ({}),
    wait: () => result,
    history: (): unknown => ({
      messages:
        historyText === null
          ? []
          : [
              {
                role: "assistant",
                content: historyText,
                __openclaw: { runId: h.runIds[0] },
              },
            ],
    }),
  });
  await h.eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
  const pending = await start(h);
  const runId = pending.runId;
  return {
    ...h,
    promptPromise: pending.result,
    chunks: () => textChunks(h.sessionUpdate.mock.calls.map(([n]) => n)),
    replay: async () =>
      textChunks((await h.eventLedger.readReplay({ sessionId, sessionKey })).events),
    reconnect: () => reconnect(h.agent),
    chat: (text: string, state: "delta" | "final" = "delta") =>
      h.chat(runId, {
        seq: state === "delta" ? 1 : 2,
        state,
        message: { content: [{ type: "text", text }] },
      }),
  };
}

it("recovers the full indented timeout reply once despite a racing final event", async () => {
  const prefix = "    " + "A".repeat(5_000);
  const full = prefix + "B".repeat(1_000) + "\n";
  const h = await recoveryHarness(visibleReply(full.slice(0, 4_096), "timeout"), full);
  await h.chat(prefix);
  const suffix = full.slice(prefix.length);
  const recordBlocked = createDeferred();
  const recordUpdate = h.eventLedger.recordUpdate.bind(h.eventLedger);
  h.eventLedger.recordUpdate = async (params) => {
    if (textChunks([params])[0] === suffix) {
      await recordBlocked.promise;
    }
    await recordUpdate(params);
  };
  h.reconnect();
  await vi.waitFor(() => expect(h.chunks()).toContain(suffix));
  const lateFinal = h.chat(full, "final");
  recordBlocked.resolve();
  await lateFinal;
  await expect(h.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  expect(h.chunks().join("")).toBe(full);
  expect((await h.replay()).join("")).toBe(full);
  expect(h.chunks().filter((text) => text === suffix)).toHaveLength(1);
});

it("reports missing authoritative history instead of settling with the terminal summary", async () => {
  const h = await recoveryHarness(visibleReply("summary"), null);
  h.reconnect();
  await expect(h.promptPromise).rejects.toThrow("Full reply recovery unavailable");
  expect(h.chunks()).toEqual([
    "[OpenClaw interruption] Full reply recovery unavailable (reply-not-found). Check the session history.",
  ]);
});

it.each([
  ["error", undefined, false],
  ["error", "length", false],
  ["error", "max_tokens", false],
  ["ok", undefined, true],
] as const)(
  "recovers %s replies (stopReason=%s, deliveryRejects=%s)",
  async (status, stopReason, deliveryRejects) => {
    const error = status === "error" ? "boom" : undefined;
    const h = await recoveryHarness({
      ...visibleReply("final answer", status),
      stopReason,
      error,
    });
    if (deliveryRejects) {
      h.connection.sessionUpdate = vi.fn().mockRejectedValue(new Error("client gone"));
    }
    h.reconnect();
    if (error && !stopReason) {
      await expect(h.promptPromise).rejects.toThrow(error);
    } else {
      await expect(h.promptPromise).resolves.toEqual({
        stopReason: stopReason ? "max_tokens" : "end_turn",
      });
    }
    const expected = ["final answer", ...(error ? [`[OpenClaw interruption] ${error}`] : [])];
    if (!deliveryRejects) {
      expect(h.chunks()).toEqual(expected);
    }
    expect(await h.replay()).toEqual(expected);
    expect(h.sessionStore.getSession(sessionId)).toMatchObject({
      activeRunId: null,
      abortController: null,
    });
  },
);
