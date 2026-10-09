import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createAssistantMessage(text: string, metadata?: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

function projectTerminal(runId: string, message: unknown, cloneLive = false) {
  const state = reduceSessionProjection(createSessionProjection(scope), {
    type: "runTerminal",
    runId,
    status: "completed",
    message,
  });
  return projectLiveSessionMessage(state, cloneLive ? structuredClone(message) : message, {
    runId,
  });
}

describe("terminal snapshot reconciliation", () => {
  it("adopts a durable answer when its live terminal also carries a status notice", () => {
    const runId = "fallback-status-run";
    const answer = "The workspace check is complete.";
    const user = {
      role: "user",
      content: [{ type: "text", text: "Check the workspace." }],
      __openclaw: { id: "fallback-user", seq: 1, idempotencyKey: `${runId}:user` },
    };
    const streamed = {
      role: "assistant",
      content: [{ type: "text", text: answer }],
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
    const durable = createAssistantMessage(answer, {
      id: "fallback-answer",
      seq: 2,
      runId,
      runTerminal: true,
    });
    let state = createSessionProjection(scope, [user, streamed]);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId,
      status: "completed",
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
      role: "assistant",
      api: "cli",
      content: [{ text: "The CLI repair is complete.", type: "text" }],
      idempotencyKey: `cli-assistant:${runId}`,
      stopReason: "stop",
      __openclaw: { id: "assistant-final", seq: 4 },
    };
    const state = projectTerminal(runId, synthetic, true);

    expect(reconcileSessionProjectionSnapshot(state, [persisted], scope).messages).toEqual([
      persisted,
    ]);
  });

  it("restores an inferred terminal when later history reveals a tool boundary", () => {
    const runId = "partial-history-run";
    const user = {
      role: "user",
      content: [{ text: "Please inspect the repository.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const synthetic = createAssistantMessage("Still working.");
    const earlier = createAssistantMessage("Still working.", {
      id: "assistant-earlier",
      seq: 2,
      runId,
    });
    const laterToolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking another file." },
        { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/index.ts" } },
      ],
      __openclaw: { id: "assistant-tool-boundary", seq: 3, runId },
    };
    let state = projectTerminal(runId, synthetic);
    state = reconcileSessionProjectionSnapshot(state, [user, earlier], scope);
    expect(state.messages).toEqual([user, earlier]);

    expect(
      reconcileSessionProjectionSnapshot(state, [user, earlier, laterToolBoundary], scope).messages,
    ).toEqual([user, earlier, laterToolBoundary, synthetic]);
  });

  it.each(["inferred"])("does not restore a removed or filtered %s terminal", (evidence) => {
    const runId = "retired-terminal-run";
    const user = {
      role: "user",
      content: "Finish the task.",
      __openclaw: { id: "user", seq: 1, runId },
    };
    const synthetic = createAssistantMessage("The task is complete.");
    const persisted = {
      ...createAssistantMessage("The task is complete.", {
        id: "final",
        seq: 2,
        runId,
        ...(evidence === "runTerminal" ? { runTerminal: true } : {}),
      }),
      ...(evidence === "stopReason" ? { stopReason: "stop" } : {}),
    };
    let state = projectTerminal(runId, synthetic);
    state = reconcileSessionProjectionSnapshot(state, [user, persisted], scope);
    expect(state.messages).toEqual([user, persisted]);

    const removed = reconcileSessionProjectionSnapshot(state, [user], scope);
    expect(removed.messages).toEqual([user]);
    expect(reconcileSessionProjectionSnapshot(removed, [user], scope).messages).toEqual([user]);
    const filtered = reconcileSessionProjectionSnapshot(state, [user, persisted], scope, {
      shouldIncludeMessage: (message) => message === user,
    });
    expect(filtered.messages).toEqual([user]);
    expect(reconcileSessionProjectionSnapshot(filtered, [user], scope).messages).toEqual([user]);
  });

  it("retains an unsequenced terminal when multiple same-run rows have terminal content", () => {
    const runId = "ambiguous-run";
    const synthetic = createAssistantMessage("The repair is complete.");
    const first = createAssistantMessage("The repair is complete.", {
      id: "assistant-first",
      seq: 2,
      runId,
    });
    const second = createAssistantMessage("The repair is complete.", {
      id: "assistant-second",
      seq: 3,
      runId,
    });
    const state = projectTerminal(runId, synthetic);

    expect(reconcileSessionProjectionSnapshot(state, [first, second], scope).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
  });
});
