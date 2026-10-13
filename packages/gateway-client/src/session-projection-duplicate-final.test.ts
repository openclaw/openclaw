import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

// Regression for #148297: selected finals can be persisted with stopReason "toolUse".
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

function terminalEvent(message = live) {
  return {
    type: "runTerminal" as const,
    runId: "announce:repro",
    status: "completed" as const,
    message,
  };
}

function laterToolMessage() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Checking another file." },
      { type: "toolCall", id: "read-next", name: "read", arguments: {} },
    ],
    stopReason: "toolUse",
    __openclaw: { id: "later-tool", seq: 218, runId: "announce:repro" },
  };
}

describe("session projection final-answer dedup", () => {
  it("keeps durable replay idempotent despite contradictory same-run history", () => {
    const later = laterToolMessage();
    let state = createSessionProjection(scope, [saved, later]);
    for (let replay = 0; replay < 2; replay += 1) {
      state = reduceSessionProjection(state, {
        type: "messagePersisted",
        message: structuredClone(saved),
      });
      expect(state.messages).toEqual([saved, later]);
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

  it.each(["history-first", "durable-second", "snapshot-second"] as const)(
    "restores a %s inferred final across repeated contradictory snapshots",
    (order) => {
      let state = createSessionProjection(scope);
      if (order === "history-first") {
        state = reconcileSessionProjectionSnapshot(state, [saved], scope);
      }
      state = reduceSessionProjection(state, terminalEvent());
      state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
      if (order === "durable-second") {
        state = reduceSessionProjection(state, { type: "messagePersisted", message: saved });
      } else if (order === "snapshot-second") {
        state = reconcileSessionProjectionSnapshot(state, [saved], scope);
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

  it.each(["durable-first", "live-first"])(
    "keeps different-content toolUse and live answers separate (%s)",
    (order) => {
      const different = {
        ...live,
        content: [{ type: "text" as const, text: "A different final answer" }],
      };
      let state = createSessionProjection(scope);
      if (order === "durable-first") {
        state = reconcileSessionProjectionSnapshot(state, [saved], scope);
        state = reduceSessionProjection(state, terminalEvent(different));
        state = projectLiveSessionMessage(state, different, { runId: "announce:repro" });
        expect(state.messages).toEqual([saved, different]);
      } else {
        const differentSaved = { ...saved, content: different.content };
        state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
        state = projectLiveSessionMessage(state, differentSaved, { runId: "announce:repro" });
        expect(state.messages).toHaveLength(2);
        expect(state.messages).toContain(live);
        expect(state.messages).toContain(differentSaved);
      }
    },
  );

  it.each(["live-first", "history-first"] as const)(
    "retains the live terminal with contradictory history (%s)",
    (order) => {
      const laterToolRow = laterToolMessage();
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
