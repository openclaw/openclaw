import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import { expectOversizedPromptRejected } from "./translator.bridge-test-helpers.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

function messageChunks(sessionUpdate: Mock): string[] {
  return sessionUpdate.mock.calls.flatMap(([{ update }]) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [],
  );
}

function assistantTranscript(runId: string, id: string, text: string, truncated?: true) {
  return {
    sessionKey: DEFAULT_SESSION_KEY,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      __openclaw: { runId, id, ...(truncated ? { truncated } : {}) },
    },
  };
}

describe("acp final chat snapshots", () => {
  it.each(["Hello", "A rewritten snapshot that is longer"])(
    "keeps the emitted answer baseline after %s",
    async (snapshot) => {
      const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
      for (const [state, text] of [
        ["delta", "Hello wide"],
        ["delta", snapshot],
        ["final", "Hello wide world"],
      ]) {
        await agent.handleGatewayEvent(
          createChatEvent({
            sessionKey: DEFAULT_SESSION_KEY,
            runId,
            state,
            message: { content: [{ type: "text", text }] },
          }),
        );
      }
      await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        sessionUpdate.mock.calls.flatMap(([{ update }]) => {
          if (update.sessionUpdate !== "agent_message_chunk") {
            return [];
          }
          expect(update.content.type).toBe("text");
          return update.content.type === "text" ? [update.content.text] : [];
        }),
      ).toEqual(["Hello wide", " world"]);
    },
  );

  it.each(["length", "max_tokens"])(
    "preserves partial text and reports %s as max_tokens",
    async (stopReason) => {
      const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
      const send = (payload: Record<string, unknown>) =>
        agent.handleGatewayEvent(
          createChatEvent({ sessionKey: DEFAULT_SESSION_KEY, runId, ...payload }),
        );
      await send({ state: "delta", message: { content: [{ type: "text", text: "Hello" }] } });
      await send({ state: "delta", deltaText: " wide" });
      expect(sessionUpdate).toHaveBeenCalledWith({
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " wide" } },
      });
      await send({
        state: "delta",
        message: { content: [{ type: "text", text: "Hello wide" }] },
      });
      await send({
        state: "final",
        stopReason,
        message: { content: [{ type: "text", text: "Hello wide world" }] },
      });
      await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
      expect(
        sessionUpdate.mock.calls.flatMap(([notification]) =>
          notification.update.sessionUpdate === "agent_message_chunk"
            ? [notification.update.content]
            : [],
        ),
      ).toEqual([
        { type: "text", text: "Hello" },
        { type: "text", text: " wide" },
        { type: "text", text: " world" },
      ]);
    },
  );
});

describe("acp session message transcript", () => {
  it("completes a reply whose chat final omits the published transcript text", async () => {
    const { event, chat, active, sessionUpdate } = createPromptScenario();
    const { result, runId } = await active();
    await chat(runId, { state: "delta", message: { content: [{ type: "text", text: "BRA" }] } });
    // Retirement of the committed live text, then the transcript copy.
    await chat(runId, { state: "delta", replace: true, deltaText: "", message: { content: [] } });
    await event("session.message", assistantTranscript(runId, "m1", "BRAVO"));
    await event("session.message", assistantTranscript(runId, "m1", "BRAVO"));
    await event("session.message", assistantTranscript("other-run", "m2", "BRAVO CHARLIE"));
    await chat(runId, { state: "final" });
    await expect(result).resolves.toEqual({ stopReason: "end_turn" });
    expect(messageChunks(sessionUpdate)).toEqual(["BRA", "VO"]);
  });

  it("joins the run's transcript messages and reads truncated ones in full", async () => {
    const { event, chat, active, request, sessionUpdate } = createPromptScenario({
      request: (method, params) =>
        method === "chat.message.get" && params?.messageId === "m2"
          ? { ok: true, message: assistantTranscript("run", "m2", "second part").message }
          : {},
    });
    const { result, runId } = await active();
    await event("session.message", assistantTranscript(runId, "m1", "first part"));
    // The final frame arrives while the truncated message's full read is in flight.
    const truncated = event(
      "session.message",
      assistantTranscript(runId, "m2", "second\n...", true),
    );
    await chat(runId, { state: "final" });
    await truncated;
    await expect(result).resolves.toEqual({ stopReason: "end_turn" });
    expect(messageChunks(sessionUpdate)).toEqual(["first part", "\n\nsecond part"]);
    expect(request).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: DEFAULT_SESSION_KEY,
      messageId: "m2",
    });
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
