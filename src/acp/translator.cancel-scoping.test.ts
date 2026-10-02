import type { AgentSideConnection, PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

const SESSION_KEY = "agent:main:shared";
const SESSION_ID = "session-1";

function promptRequest(sessionId = SESSION_ID, text = "hello"): PromptRequest {
  return { sessionId, prompt: [{ type: "text", text }], _meta: {} };
}

function chat(runId: string, payload: Record<string, unknown> = {}): EventFrame {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, seq: 1, state: "final", ...payload },
  };
}

function tool(runId: string, toolCallId = "tool-2"): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "tool",
      data: { phase: "start", name: "read_file", toolCallId, args: { path: "notes.txt" } },
    },
  };
}

function createHarness(
  options: { sessions?: string[]; accepted?: boolean; provenanceMode?: "meta" } = {},
) {
  const sentRunIds: string[] = [];
  const requestSpy = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === "chat.send") {
        const runId = expectDefined(params?.idempotencyKey as string | undefined, "Gateway run id");
        sentRunIds.push(runId);
        return options.accepted ? { runId, status: "started" } : new Promise<never>(() => {});
      }
      return {};
    },
  );
  const connection = createAcpConnection();
  const sessionUpdateSpy = vi.fn<AgentSideConnection["sessionUpdate"]>(async () => {});
  connection.sessionUpdate = sessionUpdateSpy;
  const sessionStore = createInMemorySessionStore();
  for (const sessionId of options.sessions ?? [SESSION_ID]) {
    sessionStore.createSession({ sessionId, sessionKey: SESSION_KEY, cwd: "/tmp" });
  }
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(requestSpy as GatewayClient["request"]),
    { sessionStore, provenanceMode: options.provenanceMode },
  );
  return { agent, requestSpy, sessionUpdateSpy, sessionStore, sentRunIds };
}

type Harness = ReturnType<typeof createHarness>;
type Pending = { promptPromise: Promise<PromptResponse>; runId: string };

function blockAbort(harness: Harness, first: Pending) {
  const settled = vi.fn();
  void first.promptPromise.then(settled);
  const started = createDeferred();
  const released = createDeferred();
  harness.requestSpy.mockImplementationOnce(async (method) => {
    expect(method).toBe("chat.abort");
    expect(settled).not.toHaveBeenCalled();
    started.resolve();
    await released.promise;
    return {};
  });
  return { started: started.promise, release: released.resolve };
}

async function start(harness: Harness, sessionId = SESSION_ID): Promise<Pending> {
  const before = harness.sentRunIds.length;
  const promptPromise = harness.agent.prompt(promptRequest(sessionId));
  await vi.waitFor(() => expect(harness.sentRunIds).toHaveLength(before + 1));
  return {
    promptPromise,
    runId: expectDefined(harness.sentRunIds[before], "submitted run id"),
  };
}

async function finish(harness: Harness, pending: Pending, seq = 1) {
  await harness.agent.handleGatewayEvent(chat(pending.runId, { seq }));
  await expect(pending.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
}

function expectAbort(harness: Harness, runId: string) {
  expect(harness.requestSpy).toHaveBeenCalledWith("chat.abort", { sessionKey: SESSION_KEY, runId });
}

describe("acp translator cancel and run scoping", () => {
  it("closes a replacement while its prior abort is pending and removes the session", async () => {
    const harness = createHarness();
    const first = await start(harness);
    const abort = blockAbort(harness, first);
    const replacement = harness.agent.prompt(promptRequest());
    await abort.started;
    const closed = harness.agent.closeSession({ sessionId: SESSION_ID, _meta: {} });
    expectAbort(harness, first.runId);
    expect(harness.sentRunIds).toEqual([first.runId]);
    abort.release();
    await expect(closed).resolves.toEqual({});
    expect(harness.sentRunIds).toEqual([first.runId]);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.sessionStore.getSession(SESSION_ID)).toBeUndefined();
  });

  it("settles shutdown when a superseded prompt's abort never returns", async () => {
    const harness = createHarness();
    const first = await start(harness);
    harness.requestSpy.mockImplementationOnce(async (method) => {
      expect(method).toBe("chat.abort");
      return new Promise<never>(() => {});
    });
    const replacement = harness.agent.prompt(promptRequest());
    await vi.waitFor(() => expectAbort(harness, first.runId));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      harness.agent.shutdown().then(() => "closed"),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("still pending"), 25);
      }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe("closed");
    expect(harness.sentRunIds).toEqual([first.runId]);
    await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("closes an admitted prompt when shutdown interrupts its blocked final snapshot", async () => {
    const harness = createHarness({ accepted: true });
    const pending = await start(harness);
    const started = createDeferred();
    const snapshot = createDeferred<Record<string, unknown>>();
    harness.requestSpy.mockImplementation(async (method) => {
      if (method === "sessions.list") {
        started.resolve();
        return snapshot.promise;
      }
      return {};
    });
    const terminalEvent = harness.agent.handleGatewayEvent(chat(pending.runId));
    await started.promise;
    const settled = vi.fn();
    const shutdown = harness.agent.shutdown().then(settled);
    try {
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      snapshot.resolve({ sessions: [] });
      await terminalEvent;
      await shutdown;
    }
  });

  it("closes every queued overlapping admission when cancellation wins the blocked abort", async () => {
    const harness = createHarness();
    const first = await start(harness);
    const abort = blockAbort(harness, first);
    const second = harness.agent.prompt(promptRequest());
    await abort.started;
    const third = harness.agent.prompt(promptRequest());
    const cancellation = harness.agent.cancel({ sessionId: SESSION_ID });
    abort.release();
    await cancellation;
    expect(harness.sentRunIds).toEqual([first.runId]);
    for (const prompt of [first.promptPromise, second, third]) {
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    }
  });

  it("submits only the latest of three overlapping prompts after the active abort settles", async () => {
    const harness = createHarness({ accepted: true });
    const first = await start(harness);
    const abort = blockAbort(harness, first);
    const second = harness.agent.prompt(promptRequest(SESSION_ID, "second"));
    await abort.started;
    const third = harness.agent.prompt(promptRequest(SESSION_ID, "third"));
    await Promise.resolve();
    expectAbort(harness, first.runId);
    expect(harness.sentRunIds).toEqual([first.runId]);
    abort.release();
    await vi.waitFor(() => expect(harness.sentRunIds).toHaveLength(2));
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.requestSpy.mock.calls.map(([method]) => method)).toEqual([
      "chat.send",
      "chat.abort",
      "chat.send",
    ]);
    expect(
      harness.requestSpy.mock.calls
        .filter(([method]) => method === "chat.send")
        .map(([, params]) => params?.message),
    ).toEqual(["[Working directory: /tmp]\n\nhello", "[Working directory: /tmp]\n\nthird"]);
    const runId = expectDefined(harness.sentRunIds[1], "latest admitted run");
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(runId);
    await finish(harness, { promptPromise: third, runId });
  });

  it("does not replay a superseded prompt after its delayed provenance rejection", async () => {
    const harness = createHarness({ provenanceMode: "meta" });
    const firstSend = createDeferred<Record<string, unknown>>();
    harness.requestSpy.mockImplementation(async (method, params) => {
      if (method !== "chat.send") {
        return {};
      }
      harness.sentRunIds.push(
        expectDefined(params?.idempotencyKey as string | undefined, "Gateway run id"),
      );
      return harness.sentRunIds.length === 1 ? firstSend.promise : new Promise<never>(() => {});
    });
    const first = await start(harness);
    const replacement = await start(harness);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    firstSend.reject(
      Object.assign(new Error("system provenance fields require admin scope"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.sentRunIds).toEqual([first.runId, replacement.runId]);
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await finish(harness, replacement);
  });

  it("does not let a stale cancel completion remove a newer prompt", async () => {
    const harness = createHarness();
    const first = await start(harness);
    const abort = blockAbort(harness, first);
    const cancellation = harness.agent.cancel({ sessionId: SESSION_ID });
    await abort.started;
    const replacement = await start(harness);
    abort.release();
    await cancellation;
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await finish(harness, replacement);
  });

  it("cancel uses pending runId when there is no active run", async () => {
    const harness = createHarness();
    const pending = await start(harness);
    harness.sessionStore.clearActiveRun(SESSION_ID);
    await harness.agent.cancel({ sessionId: SESSION_ID });
    expectAbort(harness, pending.runId);
    await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("cancel from an idle session does not abort another session sharing its key", async () => {
    const harness = createHarness({ sessions: [SESSION_ID, "session-2"] });
    const pending = await start(harness, "session-2");
    await harness.agent.cancel({ sessionId: SESSION_ID });
    expect(harness.requestSpy.mock.calls.filter(([method]) => method === "chat.abort")).toEqual([]);
    expect(harness.sessionStore.getSession("session-2")?.activeRunId).toBe(pending.runId);
    await finish(harness, pending);
  });

  it("projects gateway thinking blocks into hidden ACP thought chunks", async () => {
    const harness = createHarness();
    const pending = await start(harness);
    harness.sessionUpdateSpy.mockClear();
    await harness.agent.handleGatewayEvent(
      chat(pending.runId, {
        state: "delta",
        message: {
          content: [
            { type: "thinking", thinking: "Internal loop about NO_REPLY" },
            { type: "text", text: "Final visible reply" },
          ],
        },
      }),
    );
    for (const [index, sessionUpdate, text] of [
      [1, "agent_thought_chunk", "Internal loop about NO_REPLY"],
      [2, "agent_message_chunk", "Final visible reply"],
    ] as const) {
      expect(harness.sessionUpdateSpy).toHaveBeenNthCalledWith(
        index,
        expect.objectContaining({
          sessionId: SESSION_ID,
          update: { sessionUpdate, content: { type: "text", text } },
        }),
      );
    }
    await finish(harness, pending, 2);
  });

  it("drops stale text from a final snapshot after replacement during thought delivery", async () => {
    const harness = createHarness();
    const first = await start(harness);
    const started = createDeferred();
    const released = createDeferred();
    harness.sessionUpdateSpy.mockImplementationOnce(async () => {
      started.resolve();
      await released.promise;
    });
    const staleSnapshot = harness.agent.handleGatewayEvent(
      chat(first.runId, {
        message: {
          content: [
            { type: "thinking", thinking: "old hidden thought" },
            { type: "text", text: "old visible response" },
          ],
        },
      }),
    );
    await started.promise;
    const replacement = await start(harness);
    released.resolve();
    await staleSnapshot;
    expect(
      harness.sessionUpdateSpy.mock.calls.filter(
        ([payload]) => payload.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toEqual([]);
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await finish(harness, replacement, 2);
  });

  it("routes only matching run events when session keys are shared", async () => {
    const harness = createHarness({ sessions: [SESSION_ID, "session-2"] });
    const first = await start(harness);
    const second = await start(harness, "session-2");
    harness.sessionUpdateSpy.mockClear();
    await harness.agent.handleGatewayEvent(chat("run-other"));
    await harness.agent.handleGatewayEvent(tool("run-other"));
    expect(harness.sessionUpdateSpy).not.toHaveBeenCalled();
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
    expect(harness.sessionStore.getSession("session-2")?.activeRunId).toBe(second.runId);
    await harness.agent.handleGatewayEvent(tool(second.runId));
    expect(harness.sessionUpdateSpy).toHaveBeenCalledTimes(1);
    expect(harness.sessionUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-2",
        update: expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          status: "in_progress",
        }),
      }),
    );
    await finish(harness, second, 2);
    expect(harness.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
    await finish(harness, first, 3);
  });
});
