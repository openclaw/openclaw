import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { abortEmbeddedAgentRun } from "./runs.js";
import { testing } from "./runs.test-support.js";

describe("embedded-agent runner stuck recovery", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("passes stuck recovery abort reasons through reply-run fallback", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-reply-run",
      resetTriggered: false,
    });
    const cancel = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(abortEmbeddedAgentRun("session-reply-run", { reason: "stuck_recovery" })).toBe(true);

    expect(cancel).toHaveBeenCalledWith("stuck_recovery");
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_stuck_recovery" });
  });
});
