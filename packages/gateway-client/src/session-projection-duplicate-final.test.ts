import { expect, it } from "vitest";
import {
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionState,
} from "./session-projection.js";
import { assistant, projection, terminal } from "./session-projection.test-support.js";

// Regression for #148297: selected finals can be persisted with stopReason "toolUse".
const runId = "announce:repro";
const live = assistant("Selected answer");
const saved = {
  ...live,
  stopReason: "toolUse" as const,
  __openclaw: { id: "saved", seq: 217, runId },
};

const persist = (state: SessionProjectionState, message: unknown) =>
  reduceSessionProjection(state, { type: "messagePersisted", message });
const snapshot = (state: SessionProjectionState, messages: unknown[]) =>
  reconcileSessionProjectionSnapshot(state, messages, state.scope);
const announce = (state: SessionProjectionState, message = live) =>
  projectLiveSessionMessage(terminal(state, { runId, message }), message, { runId });

const laterToolMessage = () => ({
  role: "assistant",
  content: [
    { type: "text", text: "Checking another file." },
    { type: "toolCall", id: "read-next", name: "read", arguments: {} },
  ],
  stopReason: "toolUse",
  __openclaw: { id: "later-tool", seq: 218, runId },
});

it("keeps durable replay idempotent despite contradictory same-run history", () => {
  const later = laterToolMessage();
  let state = projection([saved, later]);
  for (let replay = 0; replay < 2; replay += 1) {
    state = persist(state, structuredClone(saved));
    expect(state.messages).toEqual([saved, later]);
  }
});

it.each(["history-first", "live-first", "persisted"])(
  "keeps contradictory history (%s)",
  (order) => {
    const later = laterToolMessage();
    let state = projection();
    if (order === "history-first") {
      state = snapshot(state, [saved, later]);
    }
    state = announce(state);
    if (order === "persisted") {
      state = persist(persist(state, later), saved);
    } else if (order === "live-first") {
      state = snapshot(state, [saved, later]);
    }
    expect(state.messages).toHaveLength(3);
    for (const message of [live, saved, later]) {
      expect(state.messages).toContain(message);
    }
  },
);

it.each(["history-first", "durable-second", "snapshot-second"] as const)(
  "restores a %s inferred final across repeated contradictory snapshots",
  (order) => {
    let state = projection();
    if (order === "history-first") {
      state = snapshot(state, [saved]);
    }
    state = announce(state);
    if (order === "durable-second") {
      state = persist(state, saved);
    } else if (order === "snapshot-second") {
      state = snapshot(state, [saved]);
    }
    expect(state.messages).toEqual([saved]);
    expect(state.runs[runId]?.inferredSnapshotTerminal?.entry.message).toBe(live);

    state = snapshot(state, [saved]);
    expect(state.messages).toEqual([saved]);
    const later = laterToolMessage();
    for (let refresh = 0; refresh < 2; refresh += 1) {
      state = snapshot(state, [saved, later]);
      expect(state.messages).toEqual([saved, later, live]);
    }
  },
);

it.each(["durable-first", "live-first"])(
  "keeps different-content toolUse and live answers separate (%s)",
  (order) => {
    const different = assistant("A different final answer");
    let state = projection();
    if (order === "durable-first") {
      state = announce(snapshot(state, [saved]), different);
      expect(state.messages).toEqual([saved, different]);
    } else {
      const differentSaved = { ...saved, content: different.content };
      state = projectLiveSessionMessage(state, live, { runId });
      state = projectLiveSessionMessage(state, differentSaved, { runId });
      expect(state.messages).toHaveLength(2);
      expect(state.messages).toContain(live);
      expect(state.messages).toContain(differentSaved);
    }
  },
);
