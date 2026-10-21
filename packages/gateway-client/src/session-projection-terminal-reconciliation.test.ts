import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot as reconcileSnapshot,
  reduceSessionProjection,
} from "./session-projection.js";
import {
  assistant as createAssistantMessage,
  primaryScope as scope,
  savedReply,
  savedUser,
  terminal as finishRun,
} from "./session-projection.test-support.js";

function projectTerminal(runId: string, message: unknown, cloneLive = false) {
  const state = finishRun(createSessionProjection(scope), { runId, message });
  return projectLiveSessionMessage(state, cloneLive ? structuredClone(message) : message, {
    runId,
  });
}

describe("terminal snapshot reconciliation", () => {
  it("adopts a durable answer when its live terminal also carries a status notice", () => {
    const runId = "fallback-status-run";
    const answer = "The workspace check is complete.";
    const user = savedUser("Check the workspace.", "fallback-user", 1, {
      idempotencyKey: `${runId}:user`,
    });
    const streamed = {
      ...createAssistantMessage(answer),
      openclawStreamFallback: {
        itemId: "fallback-answer-item",
        replacementText: answer,
        runId,
        source: "segment",
      },
    };
    const terminal = {
      role: "assistant",
      content: [
        { type: "text", text: "Model Fallback: backup/model", openclawStatusNotice: true },
        { type: "text", text: answer },
      ],
    };
    const durable = savedReply(answer, "fallback-answer", 2, { runId, runTerminal: true });
    let state = finishRun(createSessionProjection(scope, [user, streamed]), {
      runId,
      message: terminal,
    });
    state = projectLiveSessionMessage(state, terminal, { runId });

    expect(state.messages).toEqual([user, streamed, terminal]);
    expect(
      reduceSessionProjection(state, {
        type: "messagePersisted",
        message: durable,
        envelope: { runId },
      }).messages,
    ).toEqual([user, streamed, durable]);
  });

  it("promotes an unmarked same-run CLI terminal with a terminal stop reason", () => {
    const runId = "cli-run";
    const synthetic = createAssistantMessage("The CLI repair is complete.");
    const persisted = {
      ...savedReply("The CLI repair is complete.", "assistant-final", 4),
      api: "cli",
      idempotencyKey: `cli-assistant:${runId}`,
      stopReason: "stop",
    };
    const state = projectTerminal(runId, synthetic, true);

    expect(reconcileSnapshot(state, [persisted], scope).messages).toEqual([persisted]);
  });

  it("restores an inferred terminal when later history reveals a tool boundary", () => {
    const runId = "partial-history-run";
    const user = savedUser("Please inspect the repository.", "user-prompt", 1, {
      idempotencyKey: `${runId}:user`,
    });
    const synthetic = createAssistantMessage("Still working.");
    const earlier = savedReply("Still working.", "assistant-earlier", 2, { runId });
    const laterToolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking another file." },
        { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/index.ts" } },
      ],
      __openclaw: { id: "assistant-tool-boundary", seq: 3, runId },
    };
    let state = projectTerminal(runId, synthetic);
    state = reconcileSnapshot(state, [user, earlier], scope);
    expect(state.messages).toEqual([user, earlier]);

    expect(reconcileSnapshot(state, [user, earlier, laterToolBoundary], scope).messages).toEqual([
      user,
      earlier,
      laterToolBoundary,
      synthetic,
    ]);
  });

  it("does not restore a removed or filtered inferred terminal", () => {
    const runId = "retired-terminal-run";
    const user = {
      role: "user",
      content: "Finish the task.",
      __openclaw: { id: "user", seq: 1, runId },
    };
    const synthetic = createAssistantMessage("The task is complete.");
    const persisted = savedReply("The task is complete.", "final", 2, { runId });
    let state = projectTerminal(runId, synthetic);
    state = reconcileSnapshot(state, [user, persisted], scope);
    expect(state.messages).toEqual([user, persisted]);

    const removed = reconcileSnapshot(state, [user], scope);
    expect(removed.messages).toEqual([user]);
    expect(reconcileSnapshot(removed, [user], scope).messages).toEqual([user]);
    const filtered = reconcileSnapshot(state, [user, persisted], scope, {
      shouldIncludeMessage: (message) => message === user,
    });
    expect(filtered.messages).toEqual([user]);
    expect(reconcileSnapshot(filtered, [user], scope).messages).toEqual([user]);
  });

  it("retains an unsequenced terminal when multiple same-run rows have terminal content", () => {
    const runId = "ambiguous-run";
    const synthetic = createAssistantMessage("The repair is complete.");
    const first = savedReply("The repair is complete.", "assistant-first", 2, { runId });
    const second = savedReply("The repair is complete.", "assistant-second", 3, { runId });
    const state = projectTerminal(runId, synthetic);

    expect(reconcileSnapshot(state, [first, second], scope).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
  });
});
