import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const primaryScope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createMessage(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

/** Run-scoped terminal state: final acceptance, late diagnostics, and retention. */
describe("session run terminal bookkeeping", () => {
  it.each([
    { content: [{ type: "input_text", text: "provider rate limit" }] },
    { content: [{ type: "thinking", thinking: "Internal reasoning" }] },
    { content: [{ type: "text", text: "[assistant turn failed before producing content]" }] },
    {
      content: [
        { type: "text", text: "⚠️ Error: provider" },
        { type: "text", text: "rate limit" },
      ],
    },
    {
      content: [
        { type: "text", text: "⚠️ Error: The agent run failed" },
        { type: "text", text: "before producing a reply." },
      ],
    },
  ])("reopens a pure error projection when the same run resumes streaming: %j", ({ content }) => {
    const failed = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      seq: 10,
      errorMessage: "provider rate limit",
      message: { role: "assistant", content, stopReason: "error" },
    });
    const resumed = reduceSessionProjection(failed, {
      type: "runDelta",
      seq: 11,
      runId: "run-1",
      message: createMessage("assistant", "I"),
    });
    expect(resumed.runs["run-1"]).toMatchObject({ status: "streaming" });
    expect(resumed.runs["run-1"]?.errorMessage).toBeUndefined();
    expect(resumed.runs["run-1"]?.stopReason).toBeUndefined();
  });

  it.each([
    { content: [{ type: "text", text: "Useful partial reply." }] },
    {
      content: [
        { type: "thinking", thinking: "Internal reasoning" },
        { type: "image", source: "synthetic-image" },
      ],
    },
  ])("preserves useful failed-run content on a late delta: %j", ({ content }) => {
    const failed = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      seq: 10,
      errorMessage: "provider rate limit",
      message: { role: "assistant", content, stopReason: "error" },
    });
    expect(
      reduceSessionProjection(failed, {
        type: "runDelta",
        seq: 11,
        runId: "run-1",
        message: createMessage("assistant", "late stream"),
      }),
    ).toBe(failed);
  });

  it("upgrades an identified empty completed final exactly once without reopening the run", () => {
    const emptyMessage = createMessage("assistant", "", { id: "assistant-final", seq: 7 });
    const deliveredMessage = createMessage("assistant", "eventual final", {
      id: "assistant-final",
      seq: 7,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: emptyMessage,
    });
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], emptyMessage)).toBe(false);
    const mismatchedMessage = createMessage("assistant", "wrong final", {
      id: "different-assistant-final",
      seq: 7,
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: mismatchedMessage,
    });
    expect(state.runs["run-1"]?.message).toBe(emptyMessage);
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: deliveredMessage,
    });

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: deliveredMessage,
    });
    const laterFinal = createMessage("assistant", "later distinct final");
    const laterEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: laterFinal,
    } as const;
    const acceptedLaterFinal = reduceSessionProjection(state, laterEvent);
    expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
    expect(hasSessionProjectionAcceptedFinal(acceptedLaterFinal.runs["run-1"], laterFinal)).toBe(
      true,
    );
    expect(reduceSessionProjection(acceptedLaterFinal, laterEvent)).toBe(acceptedLaterFinal);
  });

  it("recovers a sequence-identified empty final when persisted metadata adds an ID", () => {
    const emptyMessage = createMessage("assistant", "", { seq: 7 });
    const deliveredMessage = createMessage("assistant", "eventual final", {
      id: "assistant-final",
      seq: 7,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: emptyMessage,
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: deliveredMessage,
    });

    expect(state.runs["run-1"]?.message).toBe(deliveredMessage);
  });

  it("remembers distinct recovered finals after an initial message-less error", () => {
    const first = createMessage("assistant", "first recovered final", {
      id: "recovered-a",
      seq: 7,
    });
    const second = createMessage("assistant", "second recovered final", {
      id: "recovered-b",
      seq: 8,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "original diagnostic",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: first,
    });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduceSessionProjection(state, secondEvent);

    expect(state.runs["run-1"]).toMatchObject({
      status: "error",
      message: first,
      errorMessage: "original diagnostic",
    });
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduceSessionProjection(state, secondEvent)).toBe(state);
  });

  it("ignores whitespace diagnostics and accepts one meaningful late provider error", () => {
    const emptyError = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "empty-error",
      status: "error",
      errorMessage: " \n\t ",
    });
    expect(emptyError.runs["empty-error"]?.errorMessage).toBeUndefined();
    const delivered = createMessage("assistant", "delivered final", {
      id: "delivered-assistant",
      seq: 7,
    });
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: delivered,
    });
    const completed = state;
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  \n\t ",
    });
    expect(state).toBe(completed);

    const actionableError = {
      type: "runTerminal",
      runId: "run-1",
      status: "error",
      errorKind: "provider_error",
      errorMessage: "  provider rejected request  ",
    } as const;
    state = reduceSessionProjection(state, actionableError);

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: delivered,
      errorKind: "provider_error",
      errorMessage: "provider rejected request",
    });
    expect(reduceSessionProjection(state, actionableError)).toBe(state);
  });

  it("retains a newly completed live stream ahead of older terminal diagnostics", () => {
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "runDelta",
      runId: "active-first",
      message: createMessage("assistant", "stream"),
    });
    for (let index = 0; index < 199; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runTerminal",
        runId: `older-${index}`,
        status: "completed",
      });
    }
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "active-first",
      status: "completed",
    });
    state = reduceSessionProjection(state, {
      type: "runTerminal",
      runId: "newest",
      status: "completed",
    });

    expect(Object.keys(state.runs)).toHaveLength(150);
    expect(state.runs["older-0"]).toBeUndefined();
    expect(state.runs["active-first"]?.status).toBe("completed");
    expect(state.runs.newest?.status).toBe("completed");
  });

  it("protects every concurrent active stream when terminal retention reaches its soft cap", () => {
    let state = createSessionProjection(primaryScope);
    for (let index = 0; index < 205; index += 1) {
      state = reduceSessionProjection(state, {
        type: "runDelta",
        runId: `active-${index}`,
      });
    }

    expect(Object.keys(state.runs)).toHaveLength(205);
    expect(state.runs["active-0"]?.status).toBe("streaming");
    expect(state.runs["active-204"]?.status).toBe("streaming");
  });
});
