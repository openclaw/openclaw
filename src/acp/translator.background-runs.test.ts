import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

// Regression coverage for issue #174849: gateway events for a session with no
// pending ACP prompt (e.g. a sessions_spawn completion waking the requester)
// must reach the ACP client as plain session/update notifications.

const SESSION_ID = "session-1";

async function createBackgroundHarness() {
  // An explicitly created ledger keeps delivery authority observable: replay
  // must contain exactly what the client received, before or after revocation.
  const eventLedger = createTestAcpEventLedger();
  const scenario = createPromptScenario({ eventLedger });
  const pending = await scenario.active();
  await scenario.chat(pending.runId, { stopReason: "stop" });
  await expect(pending.result).resolves.toEqual({ stopReason: "end_turn" });
  scenario.sessionUpdate.mockClear();
  let seq = 1;
  const send = (event: string, payload: Record<string, unknown>) =>
    scenario.event(event, { seq: seq++, ...payload });
  return {
    ...scenario,
    sessionId: SESSION_ID,
    eventLedger,
    promptRunId: pending.runId,
    promptPromise: pending.result,
    send,
  };
}

type EmittedUpdate = { sessionId: string; kind: string; text?: string; tool?: string };

function emitted(sessionUpdate: ReturnType<typeof vi.fn>): EmittedUpdate[] {
  return sessionUpdate.mock.calls.flatMap(([{ sessionId, update }]): EmittedUpdate[] => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return [{ sessionId, kind: update.sessionUpdate, text: update.content.text }];
      case "tool_call":
      case "tool_call_update":
        return [
          {
            sessionId,
            kind: update.sessionUpdate,
            tool: `${update.toolCallId}:${update.status}`,
          },
        ];
      default:
        return [];
    }
  });
}

describe("ACP background session updates between prompts", () => {
  it("forwards background chat text as session updates after the prompt settles", async () => {
    const h = await createBackgroundHarness();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-1",
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent" }] },
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-1",
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent finished: PINEAPPLE" }] },
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-1",
      state: "final",
      stopReason: "stop",
      message: { content: [{ type: "text", text: "Sub-agent finished: PINEAPPLE" }] },
    });
    expect(emitted(h.sessionUpdate)).toEqual([
      { sessionId: h.sessionId, kind: "agent_message_chunk", text: "Sub-agent" },
      {
        sessionId: h.sessionId,
        kind: "agent_message_chunk",
        text: " finished: PINEAPPLE",
      },
    ]);
  });

  it("does not replay settled prompt runs through a background context", async () => {
    const h = await createBackgroundHarness();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: h.promptRunId,
      state: "delta",
      message: { content: [{ type: "text", text: "late delta from the settled run" }] },
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: h.promptRunId,
      state: "final",
      stopReason: "stop",
    });
    expect(emitted(h.sessionUpdate)).toEqual([]);
  });

  it("ignores background events for sessions the bridge has not opened", async () => {
    const h = await createBackgroundHarness();
    await h.send("chat", {
      sessionKey: "agent:other:not-open",
      runId: "background-run-2",
      state: "delta",
      message: { content: [{ type: "text", text: "unrelated session" }] },
    });
    expect(emitted(h.sessionUpdate)).toEqual([]);
  });

  it("forwards background tool calls without settling a prompt", async () => {
    const h = await createBackgroundHarness();
    await h.send("agent", {
      sessionKey: h.sessionKey,
      runId: "background-run-3",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });
    await h.send("agent", {
      sessionKey: h.sessionKey,
      runId: "background-run-3",
      stream: "tool",
      data: { phase: "result", name: "read", toolCallId: "tool-1", result: "done" },
    });
    expect(emitted(h.sessionUpdate)).toEqual([
      { sessionId: h.sessionId, kind: "tool_call", tool: "tool-1:in_progress" },
      { sessionId: h.sessionId, kind: "tool_call_update", tool: "tool-1:completed" },
    ]);
    await expect(h.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("does not duplicate a background run's text when a late delta replays", async () => {
    const h = await createBackgroundHarness();
    const message = { content: [{ type: "text", text: "PINEAPPLE" }] };
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-4",
      state: "delta",
      message,
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-4",
      state: "final",
      stopReason: "stop",
      message,
    });
    h.sessionUpdate.mockClear();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-4",
      state: "delta",
      message,
    });
    expect(emitted(h.sessionUpdate)).toEqual([]);
  });

  it("suppresses a retained background run while a later prompt owns the session", async () => {
    const h = await createBackgroundHarness();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-5",
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent" }] },
    });
    expect(emitted(h.sessionUpdate)).toEqual([
      { sessionId: h.sessionId, kind: "agent_message_chunk", text: "Sub-agent" },
    ]);
    h.sessionUpdate.mockClear();

    // A prompt that starts after attachment owns the session: background
    // deltas for the retained run must not interleave into its stream.
    const secondPrompt = h.prompt();
    const secondRunId = await vi.waitFor(() => {
      expect(h.runIds.length).toBeGreaterThanOrEqual(2);
      return h.runIds[h.runIds.length - 1]!;
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-5",
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent finished: PINEAPPLE" }] },
    });
    expect(
      emitted(h.sessionUpdate).filter((update) => update.kind === "agent_message_chunk"),
    ).toEqual([]);

    // Once the prompt settles, background delivery resumes from the retained
    // context and only the unsent remainder is forwarded.
    await h.chat(secondRunId, { stopReason: "stop" });
    await expect(secondPrompt).resolves.toEqual({ stopReason: "end_turn" });
    h.sessionUpdate.mockClear();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-5",
      state: "final",
      stopReason: "stop",
      message: { content: [{ type: "text", text: "Sub-agent finished: PINEAPPLE" }] },
    });
    expect(emitted(h.sessionUpdate)).toEqual([
      {
        sessionId: h.sessionId,
        kind: "agent_message_chunk",
        text: " finished: PINEAPPLE",
      },
    ]);
  });

  it("revokes a retained background run when the session rebinds to another key", async () => {
    const h = await createBackgroundHarness();
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-6",
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent" }] },
    });
    h.sessionUpdate.mockClear();

    // session/resume or session/load can rebind the same session id to another
    // gateway key; the retained route must not keep delivery authority.
    h.sessionStore.createSession({
      sessionId: h.sessionId,
      sessionKey: "agent:main:other",
      cwd: "/tmp",
    });
    await h.send("chat", {
      sessionKey: h.sessionKey,
      runId: "background-run-6",
      state: "delta",
      message: { content: [{ type: "text", text: " stale" }] },
    });
    // Events under the new key cannot re-target the retained run either.
    await h.send("chat", {
      sessionKey: "agent:main:other",
      runId: "background-run-6",
      state: "delta",
      message: { content: [{ type: "text", text: " stale" }] },
    });
    expect(emitted(h.sessionUpdate)).toEqual([]);
  });

  it("routes background events through a session key reconciled during a prompt", async () => {
    const provisionalKey = "acp:session-9";
    const canonicalKey = "agent:main:acp:session-9";
    const eventLedger = createTestAcpEventLedger();
    const scenario = createPromptScenario({ eventLedger, sessionKey: provisionalKey });
    const pending = await scenario.active();
    // The Gateway settles the prompt under the canonical key, reconciling the
    // session binding through the store's key index.
    await scenario.event("chat", {
      sessionKey: canonicalKey,
      runId: pending.runId,
      seq: 1,
      state: "final",
      stopReason: "stop",
    });
    await expect(pending.result).resolves.toEqual({ stopReason: "end_turn" });
    scenario.sessionUpdate.mockClear();
    await scenario.event("chat", {
      sessionKey: canonicalKey,
      runId: "background-run-7",
      seq: 2,
      state: "delta",
      message: { content: [{ type: "text", text: "Sub-agent finished: PINEAPPLE" }] },
    });
    expect(emitted(scenario.sessionUpdate)).toEqual([
      {
        sessionId: SESSION_ID,
        kind: "agent_message_chunk",
        text: "Sub-agent finished: PINEAPPLE",
      },
    ]);
  });
});

// Chunk delivery awaits the client notification and its ledger record, so
// session closure, reassignment, or a newly started prompt during that await
// must revoke delivery authority before the remaining snapshot is emitted.
async function startBlockedThoughtDelivery(
  h: Awaited<ReturnType<typeof createBackgroundHarness>>,
  runId: string,
) {
  const thoughtDelivered = createDeferred();
  let sessionUpdateCalls = 0;
  h.sessionUpdate.mockImplementation(async () => {
    if (++sessionUpdateCalls === 1) {
      await thoughtDelivered.promise;
    }
  });
  const delivery = h.send("chat", {
    sessionKey: h.sessionKey,
    runId,
    state: "delta",
    message: {
      content: [
        { type: "thinking", thinking: "thinking about the reply" },
        { type: "text", text: "Sub-agent finished: PINEAPPLE" },
      ],
    },
  });
  // Wait until the thought chunk delivery is suspended inside the emit await.
  await vi.waitFor(() => {
    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
  });
  return { thoughtDelivered, delivery };
}

async function expectTextNeverDelivered(
  h: Awaited<ReturnType<typeof createBackgroundHarness>>,
  delivery: Promise<void>,
) {
  await delivery;
  const deliveredTexts = h.sessionUpdate.mock.calls.flatMap(([{ update }]): string[] => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      return [update.content.text];
    }
    return [];
  });
  expect(deliveredTexts).toEqual([]);
  const replay = await h.eventLedger.readReplayBySessionId({ sessionId: h.sessionId });
  const recordedTexts = replay.events.flatMap(({ update }): string[] => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      return [update.content.text];
    }
    return [];
  });
  expect(recordedTexts).toEqual([]);
}

describe("ACP background delivery authority across awaited chunks", () => {
  it("stops the remaining text when the session closes during thought delivery", async () => {
    const h = await createBackgroundHarness();
    const { thoughtDelivered, delivery } = await startBlockedThoughtDelivery(h, "background-run-8");
    await h.agent.closeSession({ sessionId: h.sessionId });
    thoughtDelivered.resolve();
    await expectTextNeverDelivered(h, delivery);
  });

  it("stops the remaining text when the session rebinds during thought delivery", async () => {
    const h = await createBackgroundHarness();
    const { thoughtDelivered, delivery } = await startBlockedThoughtDelivery(h, "background-run-9");
    // session/resume or session/load can rebind the same session id to
    // another gateway key while the thought chunk is still being delivered.
    h.sessionStore.createSession({
      sessionId: h.sessionId,
      sessionKey: "agent:main:other",
      cwd: "/tmp",
    });
    thoughtDelivered.resolve();
    await expectTextNeverDelivered(h, delivery);
  });

  it("stops the remaining text while a later prompt owns the session", async () => {
    const h = await createBackgroundHarness();
    const { thoughtDelivered, delivery } = await startBlockedThoughtDelivery(
      h,
      "background-run-10",
    );
    const secondPrompt = h.prompt();
    await vi.waitFor(() => {
      expect(h.runIds.length).toBeGreaterThanOrEqual(2);
    });
    thoughtDelivered.resolve();
    await expectTextNeverDelivered(h, delivery);
    const secondRunId = h.runIds[h.runIds.length - 1]!;
    await h.chat(secondRunId, { stopReason: "stop" });
    await expect(secondPrompt).resolves.toEqual({ stopReason: "end_turn" });
  });
});
