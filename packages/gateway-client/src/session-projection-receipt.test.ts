import { describe, expect, it } from "vitest";
import { createSessionProjection, reduceSessionProjection } from "./session-projection.js";

const runId = "run-current";
const text = "The saved partial reply should appear once.";
const partial = (metadata = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  __openclaw: metadata,
});
const saved = (id: string, seq: number, metadata = {}) => ({
  ...partial({ id, seq, runId, mirrorOrigin: "codex-app-server", idempotencyKey: id, ...metadata }),
  stopReason: "error",
});

describe("saved terminal assistant identity", () => {
  it("recovers an empty terminal only with its matching saved occurrence", () => {
    const empty = { ...partial({ runId, idempotencyKey: "selected" }), content: [] };
    let state = reduceSessionProjection(createSessionProjection(), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: empty,
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId,
      status: "completed",
      message: saved("other", 2),
    });
    expect(state.runs[runId]?.message).toBe(empty);
    const durable = saved("selected", 3);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId,
      status: "completed",
      message: durable,
    });
    expect(state.runs[runId]?.message).toBe(durable);
  });
  it.each(
    (["error", "timeout", "aborted", "completed"] as const).flatMap((status) =>
      (["error", "toolUse"] as const).map((stopReason) => ({ status, stopReason })),
    ),
  )(
    "reconciles $status with $stopReason by receipt in either order and across cursor/full replay",
    ({ status, stopReason }) => {
      for (const persistedFirst of [false, true]) {
        const terminal = partial({ runId, idempotencyKey: "saved-final" });
        // Persistence hooks may transform content and add media after streaming.
        const durable = {
          ...saved("saved-final", 2),
          stopReason,
          content: [
            { type: "text", text: "Saved transformed text" },
            { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
          ],
        };
        let state = createSessionProjection();
        if (persistedFirst) {
          state = reduceSessionProjection(state, { type: "messagePersisted", message: durable });
        }
        state = reduceSessionProjection(state, {
          type: "runTerminal",
          runId,
          status,
          message: terminal,
        });
        state = reduceSessionProjection(state, {
          type: "messagePersisted",
          message: terminal,
          runId,
        });
        if (!persistedFirst) {
          state = reduceSessionProjection(state, { type: "messagePersisted", message: durable });
        }
        expect(state.messages).toEqual([durable]);
        state = reduceSessionProjection(state, {
          type: "snapshotLoaded",
          messages: [structuredClone(durable)],
        });
        state = reduceSessionProjection(state, { type: "messagePersisted", message: durable });
        expect(state.messages).toEqual([durable]);
      }
    },
  );

  it("does not merge distinct saved occurrences, commentary, tools, or imported identity", () => {
    const first = saved("first", 1);
    const last = saved("last", 4);
    const tool = {
      ...saved("tool", 2),
      content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
    };
    const commentary = {
      ...saved("last", 4),
      openclawStreamFallback: { source: "segment", itemId: "commentary", runId },
    };
    const collision = saved("different-durable-id", 5, { idempotencyKey: "last" });
    const imported = saved("external", 6, {
      idempotencyKey: "last",
      importedFrom: "codex",
      cliSessionId: "cli",
      externalId: "external",
    });
    const history = [first, tool, last, commentary, collision, imported];
    let state = createSessionProjection({}, history);
    state = reduceSessionProjection(state, {
      type: "messagePersisted",
      message: partial({ runId, idempotencyKey: "first" }),
    });
    expect(state.messages).toEqual(history);
    state = reduceSessionProjection(state, {
      type: "messagePersisted",
      message: partial({ runId, idempotencyKey: "new-occurrence" }),
    });
    expect(state.messages).toHaveLength(history.length + 1);
  });

  it("keeps a receipt-less fallback provisional through cache and unrelated persistence", () => {
    const fallback = {
      ...partial(),
      openclawStreamFallback: { source: "current", runId, afterSequence: 3 },
    };
    let state = createSessionProjection({}, structuredClone([fallback]));
    expect(state.entries[0]).toMatchObject({
      live: true,
      pending: false,
      afterSequence: 3,
      identity: { runId },
    });
    const priorRun = saved("prior", 5, { runId: "run-prior", runTerminal: true });
    const beforeFence = saved("old-occurrence", 2, { runTerminal: true });
    const failedA = saved("failed-A", 6);
    const failedB = saved("failed-B", 7);
    for (const message of [priorRun, beforeFence, failedA, failedB]) {
      state = reduceSessionProjection(state, { type: "messagePersisted", message });
      expect(state.messages).toContainEqual(fallback);
    }
    state = reduceSessionProjection(state, {
      type: "snapshotLoaded",
      messages: [beforeFence, priorRun, failedA, failedB],
    });
    expect(state.messages).toContainEqual(fallback);
    const terminal = saved("selected-terminal", 8, { runTerminal: true });
    state = reduceSessionProjection(state, { type: "messagePersisted", message: terminal });
    expect(state.messages).not.toContainEqual(fallback);
    expect(state.messages).toEqual([beforeFence, priorRun, failedA, failedB, terminal]);
  });
});
