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

describe("terminal snapshot reconciliation", () => {
  it("promotes the actual terminal when history contains an earlier same-run tool boundary", () => {
    const runId = "tool-heavy-run";
    const toolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the repository." },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "AGENTS.md" } },
      ],
      __openclaw: { id: "assistant-tool-boundary", seq: 2, runId },
    };
    const synthetic = createAssistantMessage("The repair is complete.");
    const persisted = {
      role: "assistant",
      content: [{ text: "The repair is complete.", type: "text" }],
      __openclaw: { id: "assistant-final", seq: 4, runId, runTerminal: true },
    };
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });

    expect(
      reconcileSessionProjectionSnapshot(state, [toolBoundary, persisted], scope).messages,
    ).toEqual([toolBoundary, persisted]);
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
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });

    expect(reconcileSessionProjectionSnapshot(state, [persisted], scope).messages).toEqual([
      persisted,
    ]);
  });

  it("promotes a trailing unmarked terminal after the durable same-run user turn", () => {
    const runId = "browser-run";
    const user = {
      role: "user",
      content: [{ text: "Please finish the repair.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const synthetic = createAssistantMessage("The browser repair is complete.");
    const persisted = createAssistantMessage("The browser repair is complete.", {
      id: "assistant-final",
      seq: 2,
      runId,
    });
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });

    expect(reconcileSessionProjectionSnapshot(state, [user, persisted], scope).messages).toEqual([
      user,
      persisted,
    ]);
  });

  it("promotes equivalent string and block terminal content", () => {
    const runId = "string-terminal-run";
    const user = {
      role: "user",
      content: [{ text: "Please finish the repair.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const persisted = createAssistantMessage("The repair is complete.", {
      id: "assistant-final",
      seq: 2,
      runId,
    });
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: "The repair is complete.",
    });
    state = projectLiveSessionMessage(state, "The repair is complete.", { runId });

    expect(reconcileSessionProjectionSnapshot(state, [user, persisted], scope).messages).toEqual([
      user,
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
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });
    state = reconcileSessionProjectionSnapshot(state, [user, earlier], scope);
    expect(state.messages).toEqual([user, earlier]);

    expect(
      reconcileSessionProjectionSnapshot(state, [user, earlier, laterToolBoundary], scope).messages,
    ).toEqual([user, earlier, laterToolBoundary, synthetic]);
  });

  it.each(["inferred", "runTerminal", "stopReason"])(
    "does not restore a removed or filtered %s terminal",
    (evidence) => {
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
      let state = reduceSessionProjection(createSessionProjection(scope), {
        type: "runTerminal",
        runId,
        status: "completed",
        message: synthetic,
      });
      state = projectLiveSessionMessage(state, synthetic, { runId });
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
    },
  );

  it("retains an unsequenced terminal when matching content precedes a later tool boundary", () => {
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
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });

    expect(
      reconcileSessionProjectionSnapshot(state, [user, earlier, laterToolBoundary], scope).messages,
    ).toEqual([user, earlier, laterToolBoundary, synthetic]);
  });

  it("retains an unsequenced terminal when partial history has one unmarked same-content row", () => {
    const runId = "partial-tool-history-run";
    const synthetic = createAssistantMessage("The repair is complete.");
    const earlier = createAssistantMessage("The repair is complete.", {
      id: "assistant-earlier",
      seq: 2,
      runId,
    });
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });

    expect(reconcileSessionProjectionSnapshot(state, [earlier], scope).messages).toEqual([
      earlier,
      synthetic,
    ]);
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
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });

    expect(reconcileSessionProjectionSnapshot(state, [first, second], scope).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
  });
});

describe("live terminal reconciliation", () => {
  it("resolves a live replay against several same-run rows when one row carries terminal evidence", () => {
    const runId = "duplicate-run";
    const user = {
      role: "user",
      content: [{ text: "Answer with a color.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const toolCall = createAssistantMessage("[toolCall]", { id: "assistant-tool", seq: 2, runId });
    const reply = createAssistantMessage("answered with red", {
      id: "assistant-reply",
      seq: 5,
      runId,
    });
    const replay = createAssistantMessage("answered with red");

    const state = projectLiveSessionMessage(
      createSessionProjection(scope, [user, toolCall, reply]),
      replay,
      { runId },
    );

    expect(state.messages).toEqual([user, toolCall, reply]);
  });

  it("retains the live unsequenced terminal when history with a later tool boundary arrives first", () => {
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
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = reconcileSessionProjectionSnapshot(state, [user, earlier, laterToolBoundary], scope);
    expect(state.messages).toEqual([user, earlier, laterToolBoundary]);

    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });

    expect(state.messages).toEqual([user, earlier, laterToolBoundary, synthetic]);
  });

  it("restores a suppressed replay when later history contradicts its position match", () => {
    const runId = "position-recovery-run";
    const user = {
      role: "user",
      content: [{ text: "Please inspect the repository.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const toolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the repository." },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "AGENTS.md" } },
      ],
      __openclaw: { id: "assistant-tool-boundary", seq: 2, runId },
    };
    const synthetic = createAssistantMessage("Still working.");
    const unmarkedReply = createAssistantMessage("Still working.", {
      id: "assistant-unmarked",
      seq: 3,
      runId,
    });
    const laterToolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking another file." },
        { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/index.ts" } },
      ],
      __openclaw: { id: "assistant-tool-boundary-2", seq: 4, runId },
    };
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = reconcileSessionProjectionSnapshot(state, [user, toolBoundary, unmarkedReply], scope);
    expect(state.messages).toEqual([user, toolBoundary, unmarkedReply]);

    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });
    expect(state.messages).toEqual([user, toolBoundary, unmarkedReply]);

    expect(
      reconcileSessionProjectionSnapshot(
        state,
        [user, toolBoundary, unmarkedReply, laterToolBoundary],
        scope,
      ).messages,
    ).toEqual([user, toolBoundary, unmarkedReply, laterToolBoundary, synthetic]);
  });

  it("keeps a same-caption reply with a distinct attachment and still deduplicates exact replays", () => {
    const runId = "attachment-run";
    const attachment = (data: string) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    });
    const user = {
      role: "user",
      content: [{ text: "Export the chart.", type: "text" }],
      __openclaw: { id: "user-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const summary = createAssistantMessage("Chart exported.", {
      id: "assistant-summary",
      seq: 2,
      runId,
    });
    const captioned = {
      role: "assistant",
      content: [{ type: "text", text: "Result" }, attachment("chart-a")],
      __openclaw: { id: "assistant-captioned", seq: 3, runId },
    };
    const replay = {
      role: "assistant",
      content: [{ type: "text", text: "Result" }, attachment("chart-a")],
    };
    const distinct = {
      role: "assistant",
      content: [{ type: "text", text: "Result" }, attachment("chart-b")],
    };

    let state = projectLiveSessionMessage(
      createSessionProjection(scope, [user, summary, captioned]),
      replay,
      { runId },
    );
    expect(state.messages).toEqual([user, summary, captioned]);

    state = projectLiveSessionMessage(state, distinct, { runId });
    expect(state.messages).toEqual([user, summary, captioned, distinct]);

    const mediaCaptioned = createAssistantMessage("Result", {
      id: "assistant-media",
      seq: 3,
      runId,
      media: [{ type: "image", url: "chart-a" }],
    });
    const mediaDistinct = createAssistantMessage("Result", {
      media: [{ type: "image", url: "chart-b" }],
    });
    const mediaState = createSessionProjection(scope, [user, summary, mediaCaptioned]);
    expect(projectLiveSessionMessage(mediaState, mediaDistinct, { runId }).messages).toEqual([
      user,
      summary,
      mediaCaptioned,
      mediaDistinct,
    ]);
  });
});
