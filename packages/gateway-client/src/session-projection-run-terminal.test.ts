import { describe, expect, it } from "vitest";
import {
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjection as reduce,
} from "./session-projection.js";
import {
  assistant as reply,
  projection,
  terminal,
  savedReply,
} from "./session-projection.test-support.js";

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
    const failed = terminal(projection(), {
      status: "error",
      seq: 10,
      errorMessage: "provider rate limit",
      message: { role: "assistant", content, stopReason: "error" },
    });
    const resumed = reduce(failed, {
      type: "runDelta",
      seq: 11,
      runId: "run-1",
      message: reply("I"),
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
    const failed = terminal(projection(), {
      status: "error",
      seq: 10,
      errorMessage: "provider rate limit",
      message: { role: "assistant", content, stopReason: "error" },
    });
    expect(
      reduce(failed, {
        type: "runDelta",
        seq: 11,
        runId: "run-1",
        message: reply("late stream"),
      }),
    ).toBe(failed);
  });

  it("upgrades an identified empty completed final exactly once without reopening the run", () => {
    const emptyMessage = savedReply("", "assistant-final", 7);
    const deliveredMessage = savedReply("eventual final", "assistant-final", 7);
    let state = terminal(projection(), { message: emptyMessage });
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], emptyMessage)).toBe(false);
    const mismatchedMessage = savedReply("wrong final", "different-assistant-final", 7);
    state = terminal(state, { message: mismatchedMessage });
    expect(state.runs["run-1"]?.message).toBe(emptyMessage);
    state = terminal(state, { message: deliveredMessage });

    expect(state.runs["run-1"]).toMatchObject({ status: "completed", message: deliveredMessage });
    const laterFinal = reply("later distinct final");
    const laterEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: laterFinal,
    } as const;
    const acceptedLaterFinal = reduce(state, laterEvent);
    expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
    expect(hasSessionProjectionAcceptedFinal(acceptedLaterFinal.runs["run-1"], laterFinal)).toBe(
      true,
    );
    expect(reduce(acceptedLaterFinal, laterEvent)).toBe(acceptedLaterFinal);
  });

  it("recovers a sequence-identified empty final when persisted metadata adds an ID", () => {
    const emptyMessage = reply("", { seq: 7 });
    const deliveredMessage = savedReply("eventual final", "assistant-final", 7);
    let state = terminal(projection(), { message: emptyMessage });
    state = terminal(state, { message: deliveredMessage });

    expect(state.runs["run-1"]?.message).toBe(deliveredMessage);
  });

  it("remembers distinct recovered finals after an initial message-less error", () => {
    const first = savedReply("first recovered final", "recovered-a", 7);
    const second = savedReply("second recovered final", "recovered-b", 8);
    let state = terminal(projection(), {
      status: "error",
      errorKind: "provider_error",
      errorMessage: "original diagnostic",
    });
    state = terminal(state, { message: first });
    const secondEvent = {
      type: "runTerminal",
      runId: "run-1",
      status: "completed",
      message: second,
    } as const;
    state = reduce(state, secondEvent);

    expect(state.runs["run-1"]).toMatchObject({
      status: "error",
      message: first,
      errorMessage: "original diagnostic",
    });
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
    expect(reduce(state, secondEvent)).toBe(state);
  });

  it("ignores whitespace diagnostics and accepts one meaningful late provider error", () => {
    const emptyError = terminal(projection(), {
      runId: "empty-error",
      status: "error",
      errorMessage: " \n\t ",
    });
    expect(emptyError.runs["empty-error"]?.errorMessage).toBeUndefined();
    const delivered = savedReply("delivered final", "delivered-assistant", 7);
    let state = terminal(projection(), { message: delivered });
    const completed = state;
    state = terminal(state, {
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
    state = reduce(state, actionableError);

    expect(state.runs["run-1"]).toMatchObject({
      status: "completed",
      message: delivered,
      errorKind: "provider_error",
      errorMessage: "provider rejected request",
    });
    expect(reduce(state, actionableError)).toBe(state);
  });

  it("retains a newly completed live stream ahead of older terminal diagnostics", () => {
    let state = reduce(projection(), {
      type: "runDelta",
      runId: "active-first",
      message: reply("stream"),
    });
    for (let index = 0; index < 199; index += 1) {
      state = terminal(state, {
        runId: `older-${index}`,
        status: "completed",
      });
    }
    state = terminal(state, { runId: "active-first", status: "completed" });
    state = terminal(state, { runId: "newest", status: "completed" });

    expect(Object.keys(state.runs)).toHaveLength(150);
    expect(state.runs["older-0"]).toBeUndefined();
    expect(state.runs["active-first"]?.status).toBe("completed");
    expect(state.runs.newest?.status).toBe("completed");
  });

  it("protects every concurrent active stream when terminal retention reaches its soft cap", () => {
    let state = projection();
    for (let index = 0; index < 205; index += 1) {
      state = reduce(state, {
        type: "runDelta",
        runId: `active-${index}`,
      });
    }

    expect(Object.keys(state.runs)).toHaveLength(205);
    expect(state.runs["active-0"]?.status).toBe("streaming");
    expect(state.runs["active-204"]?.status).toBe("streaming");
  });
});
