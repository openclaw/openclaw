import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import {
  createChatEvent,
  createSessionAgentHarness,
  observeSettlement,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

const sessionId = "session-1";
const sessionKey = "agent:main:main";
const closeError = () => new Error("gateway closed (1006): connection lost");
const disconnected = "Gateway disconnected: 1006: connection lost";
const emptyReply = { status: "ok", terminalReply: { disposition: "empty" } };
const timeout = { status: "timeout" };
type RequestHandler = (params?: Record<string, unknown>) => unknown;

function harness(options: { send?: RequestHandler; wait?: RequestHandler } = {}) {
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({ sessionId, sessionKey, cwd: "/tmp" });
  const eventLedger = createTestAcpEventLedger();
  const recorded = createDeferred();
  const recordUserPrompt = eventLedger.recordUserPrompt.bind(eventLedger);
  eventLedger.recordUserPrompt = async (params) => {
    await recordUserPrompt(params);
    recorded.resolve();
  };
  const connection = createAcpConnection();
  const sessionUpdate = vi.fn<typeof connection.sessionUpdate>(async () => {});
  connection.sessionUpdate = sessionUpdate;
  let nextSend = createDeferred<string>();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      const runId = params?.idempotencyKey;
      if (typeof runId !== "string") {
        throw new Error("missing run id");
      }
      nextSend.resolve(runId);
      nextSend = createDeferred<string>();
      return options.send ? options.send(params) : new Promise<never>(() => {});
    }
    return method === "agent.wait" ? (options.wait?.(params) ?? {}) : {};
  });
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    {
      eventLedger,
      sessionStore,
    },
  );
  return {
    agent,
    request,
    sessionStore,
    eventLedger,
    recorded: recorded.promise,
    sessionUpdate,
    start(id = sessionId) {
      const sent = nextSend.promise;
      const result = promptAgent(agent, id);
      const settlement = observeSettlement(result);
      return { result, sent, settlement };
    },
  };
}

function reconnect(agent: ReturnType<typeof harness>["agent"]) {
  agent.handleGatewayDisconnect("1006: connection lost");
  agent.handleGatewayReconnect();
}

function finalEvent(runId: string, key = sessionKey) {
  return createChatEvent({ runId, sessionKey: key, seq: 1, state: "final" });
}

async function expectNotice(h: ReturnType<typeof harness>, accepted: boolean) {
  const text = accepted
    ? "[OpenClaw interruption] The Gateway disconnected after accepting this message, so its final outcome is unknown. Check the session before retrying."
    : "[OpenClaw interruption] The Gateway disconnected before OpenClaw could confirm whether this message was accepted, so its final outcome is unknown. Check the session before retrying.";
  expect(h.sessionUpdate).toHaveBeenCalledWith({
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
  const replay = await h.eventLedger.readReplay({ sessionId, sessionKey });
  expect(
    replay.events.filter(
      ({ update }) =>
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text" &&
        update.content.text === text,
    ),
  ).toHaveLength(1);
}

afterEach(() => vi.useRealTimers());

describe("acp translator stop reason mapping", () => {
  it.each([
    { state: "error", stopReason: "end_turn", errorMessage: "gateway timeout" },
    { state: "aborted", stopReason: "cancelled", errorMessage: undefined },
  ])("maps $state to $stopReason", async ({ state, stopReason, errorMessage }) => {
    const h = harness();
    const prompt = h.start();
    await h.agent.handleGatewayEvent(
      createChatEvent({
        runId: await prompt.sent,
        sessionKey,
        seq: 1,
        state,
        errorMessage,
      }),
    );
    await expect(prompt.result).resolves.toEqual({ stopReason });
  });

  it("surfaces the abort cause before cancellation even when delivery rejects", async () => {
    const h = harness();
    const prompt = h.start();
    h.sessionUpdate.mockRejectedValueOnce(new Error("client gone"));
    await h.agent.handleGatewayEvent(
      createChatEvent({
        runId: await prompt.sent,
        sessionKey,
        seq: 1,
        state: "aborted",
        errorMessage: "Tool validation failed: command contains unsupported flag",
      }),
    );
    await expect(prompt.result).resolves.toEqual({ stopReason: "cancelled" });
    expect(h.sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "[OpenClaw interruption] Tool validation failed: command contains unsupported flag",
        },
      },
    });
    expect(h.sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.settlement.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("reconciles provisional session keys for subsequent prompts", async () => {
    let sent = createDeferred<string>();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.send" && typeof params?.idempotencyKey === "string") {
        sent.resolve(params.idempotencyKey);
      }
      return {};
    });
    const { agent, sessionStore } = createSessionAgentHarness(request as GatewayClient["request"], {
      sessionKey: "acp:session-1",
    });
    const first = promptAgent(agent);
    const canonical = "agent:main:acp:session-1";
    await agent.handleGatewayEvent(
      createChatEvent({
        runId: await sent.promise,
        sessionKey: canonical,
        seq: 1,
        state: "final",
        message: { content: [{ type: "text", text: "first" }] },
      }),
    );
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionStore.getSession(sessionId)?.sessionKey).toBe(canonical);
    sent = createDeferred<string>();
    const second = promptAgent(agent);
    const runId = await sent.promise;
    expect(request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({ sessionKey: canonical }),
      { timeoutMs: null },
    );
    await agent.handleGatewayEvent(finalEvent(runId, canonical));
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("keeps prompts pending across transient disconnects until a live final", async () => {
    const h = harness();
    const prompt = h.start();
    const runId = await prompt.sent;
    h.agent.handleGatewayDisconnect("1006: connection lost");
    await Promise.resolve();
    expect(prompt.settlement).not.toHaveBeenCalled();
    h.agent.handleGatewayReconnect();
    await h.agent.handleGatewayEvent(finalEvent(runId));
    await expect(prompt.result).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("makes disconnect notices durable without waiting for ACP delivery", async () => {
    vi.useFakeTimers();
    const h = harness({
      send: () => ({}),
      wait: () => {
        throw closeError();
      },
    });
    await h.eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
    const prompt = h.start();
    await h.recorded;
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
      await vi.advanceTimersByTimeAsync(5_000);
      await recordStarted.promise;
      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(prompt.settlement).not.toHaveBeenCalled();
      recordBlocked.resolve();
      await expect(prompt.result).rejects.toThrow(disconnected);
      await expectNotice(h, true);
    } finally {
      recordBlocked.resolve();
      deliveryBlocked.resolve();
    }
  });

  it("keeps pre-ack disconnects pending until the grace deadline", async () => {
    vi.useFakeTimers();
    const h = harness({
      send: () => {
        throw closeError();
      },
      wait: () => {
        throw closeError();
      },
    });
    await h.eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
    const prompt = h.start();
    await prompt.sent;
    expect(prompt.settlement).not.toHaveBeenCalled();
    h.agent.handleGatewayDisconnect("1006: connection lost");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(prompt.settlement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(prompt.result).rejects.toThrow(disconnected);
    await expectNotice(h, false);
  });

  it("keeps accepted prompts pending when the deadline recheck times out", async () => {
    vi.useFakeTimers();
    const h = harness({ send: () => ({}), wait: () => timeout });
    const prompt = h.start();
    await h.recorded;
    reconnect(h.agent);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prompt.settlement).not.toHaveBeenCalled();
  });

  it("preserves a newer disconnect deadline during reconciliation", async () => {
    vi.useFakeTimers();
    const waiting = createDeferred();
    const reply = createDeferred<typeof timeout>();
    const wait = vi
      .fn()
      .mockImplementationOnce(() => {
        waiting.resolve();
        return reply.promise;
      })
      .mockResolvedValue(timeout);
    const h = harness({ send: () => ({}), wait });
    const prompt = h.start();
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
    vi.useFakeTimers();
    const firstSend = createDeferred();
    const send = vi
      .fn()
      .mockReturnValueOnce(firstSend.promise)
      .mockImplementation(() => {
        throw closeError();
      });
    const h = harness({ send, wait: () => timeout });
    const first = h.start();
    await first.sent;
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
    vi.useFakeTimers();
    let waits = 0;
    const h = harness({
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
    const accepted = h.start();
    const acceptedRunId = await accepted.sent;
    const preAck = h.start("session-2");
    await preAck.sent;
    await h.recorded;
    reconnect(h.agent);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(accepted.settlement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(accepted.result).resolves.toEqual({ stopReason: "end_turn" });
    await expect(preAck.result).rejects.toThrow(disconnected);
    expect(
      h.request.mock.calls
        .filter(([method]) => method === "agent.wait")
        .map(([, params]) => params),
    ).toEqual(
      [acceptedRunId, await preAck.sent, acceptedRunId, await preAck.sent].map((runId) => ({
        runId,
        timeoutMs: 0,
      })),
    );
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
    const prompt = h.start();
    await prompt.sent;
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
    vi.useFakeTimers();
    const firstSend = createDeferred<never>();
    const send = vi.fn().mockReturnValueOnce(firstSend.promise).mockResolvedValue({});
    const h = harness({
      send,
      wait: () => {
        throw closeError();
      },
    });
    const first = h.start();
    await first.sent;
    h.agent.handleGatewayDisconnect("1006: connection lost");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first.result).rejects.toThrow(disconnected);
    const second = h.start();
    const runId = await second.sent;
    firstSend.reject(closeError());
    await Promise.resolve();
    expect(second.settlement).not.toHaveBeenCalled();
    await h.agent.handleGatewayEvent(finalEvent(runId));
    await expect(second.result).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("does not let a stale disconnect deadline reject a newer prompt", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw closeError();
      })
      .mockResolvedValue({});
    const h = harness({
      send,
      wait: (params) => (params?.runId === firstRunId ? timeout : { status: "ok" }),
    });
    const first = h.start();
    const firstRunId = await first.sent;
    reconnect(h.agent);
    await Promise.resolve();
    const second = h.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.settlement).not.toHaveBeenCalled();
  });
});
