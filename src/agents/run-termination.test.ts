import { describe, expect, it } from "vitest";
import {
  createAgentRunRestartAbortError,
  isAbortedAgentStopReason,
  resolveAgentRunAbortLifecycleFields,
} from "./run-termination.js";

describe("resolveAgentRunAbortLifecycleFields", () => {
  it("classifies generic cancellation as aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("preserves timeout attribution", () => {
    const controller = new AbortController();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    controller.abort(timeout);

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "timeout",
    });
  });

  it("classifies managed restart cancellation", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "restart",
    });
  });

  it("treats restart as an aborted terminal reason", () => {
    expect(isAbortedAgentStopReason("aborted")).toBe(true);
    expect(isAbortedAgentStopReason("restart")).toBe(true);
    expect(isAbortedAgentStopReason("timeout")).toBe(false);
  });
});
