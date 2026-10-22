import { expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjection,
  type SessionProjectionState,
} from "./session-projection.js";
import { assistant, terminal } from "./session-projection.test-support.js";

const runId = "run-current";
const partial = (metadata = {}) => assistant("Saved partial reply", metadata);
const saved = (id: string, seq: number, metadata = {}) => ({
  ...partial({ id, seq, runId, mirrorOrigin: "codex-app-server", idempotencyKey: id, ...metadata }),
  stopReason: "error",
});
const persist = (state: SessionProjectionState, message: unknown, envelopeRunId?: string) =>
  reduceSessionProjection(state, { type: "messagePersisted", message, runId: envelopeRunId });
const snapshot = (state: SessionProjectionState, messages: unknown[]) =>
  reduceSessionProjection(state, { type: "snapshotLoaded", messages });

it("recovers an empty terminal only with its matching saved occurrence", () => {
  const empty = { ...partial({ runId, idempotencyKey: "selected" }), content: [] };
  let state = terminal(createSessionProjection(), { runId, message: empty });
  state = terminal(state, { runId, message: saved("other", 2) });
  expect(state.runs[runId]?.message).toBe(empty);
  const durable = saved("selected", 3);
  state = terminal(state, { runId, message: durable });
  expect(state.runs[runId]?.message).toBe(durable);
});
it.each([
  { status: "error", stopReason: "error" },
  { status: "completed", stopReason: "toolUse" },
] as const)("reconciles $status/$stopReason by receipt", ({ status, stopReason }) => {
  for (const persistedFirst of [false, true]) {
    const live = partial({ runId, idempotencyKey: "saved-final" });
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
      state = persist(state, durable);
    }
    state = terminal(state, { runId, message: live, status });
    state = persist(state, live, runId);
    if (!persistedFirst) {
      state = persist(state, durable);
    }
    expect(state.messages).toEqual([durable]);
    state = snapshot(state, [structuredClone(durable)]);
    state = persist(state, durable);
    expect(state.messages).toEqual([durable]);
  }
});

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
  state = persist(state, partial({ runId, idempotencyKey: "first" }));
  expect(state.messages).toEqual(history);
  state = persist(state, partial({ runId, idempotencyKey: "new-occurrence" }));
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
    state = persist(state, message);
    expect(state.messages).toContainEqual(fallback);
  }
  state = snapshot(state, [beforeFence, priorRun, failedA, failedB]);
  expect(state.messages).toContainEqual(fallback);
  const savedTerminal = saved("selected-terminal", 8, { runTerminal: true });
  state = persist(state, savedTerminal);
  expect(state.messages).toEqual([beforeFence, priorRun, failedA, failedB, savedTerminal]);
});
