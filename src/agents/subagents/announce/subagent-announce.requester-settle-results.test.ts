import { describe, expect, it } from "vitest";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  sessionStore,
  registryRuntimeMock,
  findTranscriptEventMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  deliverSpy,
  makeSettledChild,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled results", () => {
  it("delivers the complete final source reply after a same-run silent terminal", async () => {
    const text = `${"<source-reply>".repeat(400)}required source reply tail`;
    const child = makeSettledChild({
      runId: "run-b",
      outcome: { status: "ok" },
      completion: {
        required: true,
        terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text }),
      },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    sessionStore[child.childSessionKey] = { sessionId: "source-reply-session" };
    const assistant = (runId: string, messageText: string) => ({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: messageText }],
        __openclaw: { runId },
      },
    });
    const sourceReply = assistant(child.runId, text);
    const events = [
      assistant("previous-run", "stale source reply"),
      {
        ...sourceReply,
        message: {
          ...sourceReply.message,
          openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
        },
      },
      assistant(child.runId, "NO_REPLY"),
      assistant("replacement-run", "unrelated source reply"),
    ];
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      expect(sessionId).toBe("source-reply-session");
      const event = events.findLast(match);
      return event === undefined ? undefined : { event };
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    const message = String(call.triggerMessage);
    expect(message).toContain(`${"&lt;source-reply&gt;".repeat(400)}required source reply tail`);
    expect(message).not.toContain("NO_REPLY");
    expect(message).not.toContain("stale source reply");
    expect(message).not.toContain("unrelated source reply");
    expect(call.steerMessage).toBe(message);
    expect(call.requireVisibleReply).toBe(true);
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-b"], 1, {
      delivered: true,
      path: "direct",
    });
  });
});
