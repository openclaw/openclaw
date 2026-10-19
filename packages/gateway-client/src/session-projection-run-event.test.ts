import { assert, describe, expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjectionRunEvent,
  type SessionProjectionScope,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

describe("session projection Gateway run events", () => {
  it("clears an existing diagnostic when the terminal owner suppresses its notice", () => {
    const failed = reduceSessionProjectionRunEvent(createSessionProjection(scope), {
      runId: "internal-run",
      state: "error",
      errorMessage: "No answer was returned",
    });
    assert(failed);
    const suppressed = reduceSessionProjectionRunEvent(failed.projection, {
      runId: "internal-run",
      state: "error",
      errorMessage: "No answer was returned",
      suppressErrorNotice: true,
    });
    assert(suppressed);
    expect(suppressed.currentRun).toMatchObject({ status: "error", suppressErrorNotice: true });
    expect(suppressed.currentRun?.errorMessage).toBeUndefined();
    expect(
      reduceSessionProjectionRunEvent(suppressed.projection, {
        runId: "internal-run",
        state: "error",
        errorMessage: "No answer was returned",
      })?.currentRun?.errorMessage,
    ).toBeUndefined();
  });

  it("reconstructs append-only output without losing rich content or duplicating snapshot text", () => {
    let projection = createSessionProjection(scope);
    const canvas = { type: "canvas", id: "canvas-1" };
    const metadata = { media: [{ id: "image-1" }] };
    const snapshot = {
      role: "assistant",
      content: [{ type: "text", text: "hello " }, canvas],
      __openclaw: metadata,
    };
    for (const event of [
      { message: snapshot, deltaText: "hello ", text: "hello " },
      { deltaText: " world\n", text: "hello  world\n" },
      { deltaText: "reset", replace: true, text: "reset" },
      { deltaText: "", replace: true, text: "" },
      { deltaText: "done", text: "done" },
    ]) {
      const transition = reduceSessionProjectionRunEvent(projection, {
        ...event,
        runId: "shared-run",
        state: "delta",
      });
      if (!transition) {
        throw new Error("Expected a chat run projection");
      }
      projection = transition.projection;
      expect(transition.currentRun?.message).toEqual({
        ...snapshot,
        content: [{ type: "text", text: event.text }, canvas],
      });
    }
    expect(snapshot.content[0]).toEqual({ type: "text", text: "hello " });
    const final = { role: "assistant", content: "done!" };
    expect(
      reduceSessionProjectionRunEvent(projection, {
        runId: "shared-run",
        state: "final",
        message: final,
      })?.currentRun?.message,
    ).toBe(final);
  });

  it("does not invent a baseline from an orphan append", () => {
    expect(
      reduceSessionProjectionRunEvent(createSessionProjection(scope), {
        runId: "shared-run",
        state: "delta",
        deltaText: "missing prefix",
      })?.currentRun?.message,
    ).toBeUndefined();
  });

  it.each([
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 11, resumes: false },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 13, resumes: true },
    { terminalSeq: 10, repeatedSeq: 12, deltaSeq: undefined, resumes: false },
    { terminalSeq: undefined, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
  ])("requires newer run-event order before resuming an error: %j", (scenario) => {
    let projection = createSessionProjection(scope);
    const message = { role: "assistant", content: [], stopReason: "error" };
    for (const event of [
      { state: "delta", seq: 8 },
      { state: "error", seq: scenario.terminalSeq, message },
      { state: "error", seq: scenario.repeatedSeq, message },
    ]) {
      const result = reduceSessionProjectionRunEvent(projection, {
        ...event,
        runId: "shared-run",
        errorMessage: "provider unavailable",
      });
      if (!result) {
        throw new Error("Expected a run projection");
      }
      projection = result.projection;
    }
    const delta = {
      runId: "shared-run",
      state: "delta",
      seq: scenario.deltaSeq,
      message: { role: "assistant", content: "resumed output" },
    };
    const resumed = reduceSessionProjectionRunEvent(projection, delta);
    expect(resumed?.currentRun?.status).toBe(scenario.resumes ? "streaming" : "error");
    if (!scenario.resumes) {
      expect(resumed?.projection).toBe(projection);
      expect(resumed?.currentRun?.message).toBe(message);
      expect(resumed?.currentRun?.errorMessage).toBe("provider unavailable");
    }
  });

  it.each([
    {
      name: "yielded end turn",
      event: { state: "final", yielded: true, stopReason: "end_turn" },
      status: "yielded",
    },
    {
      name: "message-owned error",
      event: {
        state: "final",
        message: { role: "assistant", content: "failure", stopReason: "error" },
      },
      status: "error",
    },
    {
      name: "provider timeout",
      event: { state: "error", errorKind: "timeout" },
      status: "timeout",
    },
    { name: "aborted run", event: { state: "aborted" }, status: "aborted" },
  ])("normalizes a $name identically for browser and TUI", ({ event, status }) => {
    const result = reduceSessionProjectionRunEvent(
      createSessionProjection(scope),
      { ...event, runId: "shared-run" },
      scope,
    );
    expect(result?.previousRun).toBeUndefined();
    expect(result?.currentRun?.status).toBe(status);
    expect(result?.projection.runs["shared-run"]?.status).toBe(status);
  });

  it.each(["status"])("rejects non-run Gateway event state %j", (state) => {
    expect(
      reduceSessionProjectionRunEvent(createSessionProjection(scope), {
        runId: "shared-run",
        state,
      }),
    ).toBeNull();
  });
});
