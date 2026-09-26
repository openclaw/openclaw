import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

/**
 * Regression test for https://github.com/openclaw/openclaw/issues/148297
 *
 * A durable selected final answer persisted with stopReason "toolUse" must
 * reconcile with the same run's unkeyed live final into one row. Distinct
 * same-text messages from different runs remain distinct.
 */
const scope: SessionProjectionScope = {
  sessionKey: "agent:main:repro",
  sessionId: "repro",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

const live = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Selected answer" }],
};

const saved = {
  ...live,
  stopReason: "toolUse" as const,
  __openclaw: { id: "saved", seq: 217, runId: "announce:repro" },
};

function terminalEvent() {
  return {
    type: "runTerminal" as const,
    runId: "announce:repro",
    status: "completed" as const,
    message: live,
  };
}

function laterToolMessage() {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "read-next", name: "read", arguments: {} }],
    stopReason: "toolUse",
    __openclaw: { id: "later-tool", seq: 218, runId: "announce:repro" },
  };
}

describe("session projection final-answer dedup", () => {
  it.each([true, false])("keeps durable replay idempotent (run ownership: %s)", (owned) => {
    const durable = {
      ...saved,
      __openclaw: { id: "saved", seq: 217, ...(owned ? { runId: "announce:repro" } : {}) },
    };
    const later = laterToolMessage();
    let state = createSessionProjection(scope, [durable, later]);
    for (let replay = 0; replay < 2; replay += 1) {
      state = reduceSessionProjection(state, {
        type: "messagePersisted",
        message: structuredClone(durable),
      });
      expect(state.messages).toEqual([durable, later]);
    }
  });

  it("keeps the live final when the earlier durable row arrives after a later tool row", () => {
    const later = laterToolMessage();
    let state = reduceSessionProjection(createSessionProjection(scope), terminalEvent());
    state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
    state = reduceSessionProjection(state, { type: "messagePersisted", message: later });
    state = reduceSessionProjection(state, { type: "messagePersisted", message: saved });

    expect(state.messages).toHaveLength(3);
    expect(state.messages).toContain(live);
    expect(state.messages).toContain(saved);
    expect(state.messages).toContain(later);
  });

  it.each(["constructor-first", "history-first", "durable-second"] as const)(
    "restores a %s inferred final across repeated contradictory snapshots",
    (order) => {
      let state = createSessionProjection(scope, order === "constructor-first" ? [saved] : []);
      if (order === "history-first") {
        state = reconcileSessionProjectionSnapshot(state, [saved], scope);
      }
      state = reduceSessionProjection(state, terminalEvent());
      state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
      if (order === "durable-second") {
        state = reduceSessionProjection(state, { type: "messagePersisted", message: saved });
      }
      expect(state.messages).toEqual([saved]);
      expect(state.runs["announce:repro"]?.inferredSnapshotTerminal?.entry.message).toBe(live);

      state = reconcileSessionProjectionSnapshot(state, [saved], scope);
      expect(state.messages).toEqual([saved]);
      const later = laterToolMessage();
      for (let refresh = 0; refresh < 2; refresh += 1) {
        state = reconcileSessionProjectionSnapshot(state, [saved, later], scope);
        expect(state.messages).toEqual([saved, later, live]);
      }
    },
  );

  it("reconciles a toolUse-persisted final with the live final (live first)", () => {
    let state = createSessionProjection(scope);
    state = reduceSessionProjection(state, terminalEvent());
    state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
    state = reconcileSessionProjectionSnapshot(state, [saved], scope);

    expect(state.messages).toHaveLength(1);
  });

  it("keeps distinct same-text messages from different runs distinct", () => {
    const otherSaved = {
      ...saved,
      __openclaw: { id: "other", seq: 218, runId: "announce:other" },
    };
    let state = createSessionProjection(scope);
    state = reconcileSessionProjectionSnapshot(state, [saved, otherSaved], scope);

    expect(state.messages).toHaveLength(2);
  });

  it("does not let a toolUse-persisted row adopt a different live answer", () => {
    const differentLive = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A different final answer" }],
    };
    let state = createSessionProjection(scope);
    state = reconcileSessionProjectionSnapshot(state, [saved], scope);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "announce:repro",
      status: "completed",
      message: differentLive,
    });
    state = projectLiveSessionMessage(state, differentLive, { runId: "announce:repro" });

    // The durable "Selected answer" and the live "A different final answer"
    // are distinct answers and must both remain visible.
    expect(state.messages).toHaveLength(2);
  });

  it("does not let a different-content toolUse-persisted row replace a live answer", () => {
    const differentSaved = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A different persisted answer" }],
      stopReason: "toolUse" as const,
      __openclaw: { id: "saved-other", seq: 217, runId: "announce:repro" },
    };
    let state = createSessionProjection(scope);
    state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });

    // The durable row arrives second with different content: both rows stay,
    // as they did before the relaxation.
    state = projectLiveSessionMessage(state, differentSaved, { runId: "announce:repro" });

    expect(state.messages).toHaveLength(2);
  });

  it.each(["live-first", "history-first"] as const)(
    "retains the live terminal with contradictory history (%s)",
    (order) => {
      const laterToolRow = {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Checking another file." },
          {
            type: "toolCall" as const,
            id: "read-2",
            name: "read",
            arguments: { path: "src/index.ts" },
          },
        ],
        stopReason: "toolUse" as const,
        __openclaw: { id: "assistant-tool-boundary", seq: 218, runId: "announce:repro" },
      };
      let state = createSessionProjection(scope);
      if (order === "history-first") {
        state = reconcileSessionProjectionSnapshot(state, [saved, laterToolRow], scope);
      }
      state = reduceSessionProjection(state, terminalEvent());
      state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
      if (order === "live-first") {
        state = reconcileSessionProjectionSnapshot(state, [saved, laterToolRow], scope);
      }

      // A later same-run tool row disproves the earlier row's final-answer inference.
      expect(state.messages).toHaveLength(3);
      expect(state.messages).toContain(live);
    },
  );
});
