import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessages } from "../../config/sessions/session-accessor.transcript-turn.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

function turn(index: number, resultBytes = 0) {
  const id = `turn-${index}`;
  return [
    {
      eventId: `${id}-user`,
      message: { role: "user", content: `${id}: ${"x".repeat(256)}`, timestamp: index },
    },
    {
      eventId: `${id}-call`,
      message: makeAgentAssistantMessage({
        content: [{ type: "toolCall", id, name: "read", arguments: { path: "fixture.txt" } }],
        stopReason: "toolUse",
      }),
    },
    {
      eventId: `${id}-result`,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `receipt ${index}${"x".repeat(resultBytes)}` }],
        timestamp: index,
        isError: false,
      },
    },
  ];
}

it("keeps complete history prefixes across appends and restarts the window after compaction and reset", async () => {
  await withOpenClawTestState({ label: "model-context-prefix" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionId: "prefix",
      sessionKey: "agent:main:prefix",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessages(scope, {
      messages: Array.from({ length: 30 }, (_, index) => turn(index)).flat(),
    });
    const limits = { maxBytes: 16_384, maxEvents: 1000 };
    const read = async () =>
      (await SessionManager.openModelContextAsync(scope, { limits })).buildSessionContext();
    let previous = (await read()).messages;
    expect(previous.length).toBeLessThan(90);
    let consecutive = 1;
    let longest = 1;
    let steps = 0;
    for (let index = 30; index < 40; index++) {
      await appendTranscriptMessages(scope, { messages: turn(index) });
      // Each read creates a fresh detached manager: no process-local cutoff can supply stability.
      const current = (await read()).messages;
      expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(limits.maxBytes);
      expect(current[0]?.role).toBe("user");
      for (let offset = 0; offset < current.length; offset += 3) {
        const user = current[offset];
        const call = current[offset + 1];
        const result = current[offset + 2];
        expect(user?.role).toBe("user");
        expect(call?.role).toBe("assistant");
        expect(result?.role).toBe("toolResult");
        if (call?.role === "assistant" && result?.role === "toolResult") {
          expect(call.content).toContainEqual(expect.objectContaining({ id: result.toolCallId }));
        }
      }
      if (JSON.stringify(current[0]) === JSON.stringify(previous[0])) {
        expect(current.slice(0, previous.length)).toEqual(previous);
        longest = Math.max(longest, ++consecutive);
      } else {
        steps++;
        consecutive = 1;
      }
      previous = current;
    }
    expect(longest).toBeGreaterThanOrEqual(3);
    expect(steps).toBeGreaterThan(0);

    const source = await SessionManager.openAsync(scope);
    await source.appendCompactionAsync("Earlier turns summarized", "turn-39-user", 100);
    expect((await read()).messages).toEqual(source.buildSessionContext().messages);
    await source.appendResetBoundaryAsync("new");
    expect((await read()).messages).toEqual([]);
    await source.appendMessageAsync({ role: "user", content: "fresh start", timestamp: 40 });
    expect((await read()).messages).toEqual([
      { role: "user", content: "fresh start", timestamp: 40 },
    ]);
    await source.appendMessageAsync({ role: "user", content: "old".repeat(700), timestamp: 41 });
    await appendTranscriptMessages(scope, { messages: turn(42, 14_500) });
    // Headroom must not reject an atomic tool turn that fits the unchanged hard cap.
    expect((await read()).messages).toEqual(
      (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages.slice(-3),
    );
  });
});

it.each(
  [false, true].flatMap((incognito) =>
    (["append", "rewrite"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "reads the completed-turn snapshot across later $mutation (incognito=$incognito)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "completed-model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "completed-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-completed-context"
          : "agent:main:completed-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync({
        role: "user",
        content: "completed question",
        timestamp: 1,
      });
      await waitForSessionTranscriptProjection(scope);
      const terminal = await source.appendMessageWithTranscriptAnchorAsync(
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "completed answer" }],
          }),
          { __openclaw: { upstreamUserText: "synthetic-private-native-payload" } },
        ),
      );
      if (!terminal.anchor) {
        throw new Error("Missing completed-turn anchor");
      }
      const expected = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
      await source.appendMessageAsync({ role: "user", content: "later question", timestamp: 2 });
      const mutate = async () => {
        if (mutation === "rewrite") {
          await source.removeTrailingEntriesAsync((entry) => entry.type === "message");
        }
        await source.appendMessageAsync({ role: "user", content: "newest question", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi
            .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
            .mockImplementationOnce(async (...args) => {
              spy!.mockRestore();
              const result = await contextWorker.readSessionTranscriptModelContextInWorker(...args);
              await mutate();
              return result;
            });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { through: terminal.anchor });
        if (incognito) {
          await mutate();
        }
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow(/transcript|anchor/i);
        } else {
          const context = (await pending).buildSessionContext();
          expect(context).toEqual(expected);
          expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
          expect(source.buildSessionContext().messages.at(-1)).toMatchObject({
            content: "newest question",
          });
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);
