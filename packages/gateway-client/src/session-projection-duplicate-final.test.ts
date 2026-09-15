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

describe("session projection final-answer dedup", () => {
  it("reconciles a toolUse-persisted final with the live final (live first)", () => {
    let state = createSessionProjection(scope);
    state = reduceSessionProjection(state, terminalEvent());
    state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });
    state = reconcileSessionProjectionSnapshot(state, [saved], scope);

    expect(state.messages).toHaveLength(1);
  });

  it("reconciles a toolUse-persisted final with the live final (history first)", () => {
    let state = createSessionProjection(scope);
    state = reconcileSessionProjectionSnapshot(state, [saved], scope);
    state = reduceSessionProjection(state, terminalEvent());
    state = projectLiveSessionMessage(state, live, { runId: "announce:repro" });

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
});
