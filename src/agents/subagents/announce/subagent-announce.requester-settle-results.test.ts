import { describe, expect, it } from "vitest";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  registryRuntimeMock,
  sessionStore,
  findTranscriptEventMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  requesterSettleKey,
  deliverSpy,
  completeBatchSpy,
  makeSettledChild,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled results", () => {
  it("wakes the requester once with a batch-stable idempotency key when the fan-out drains", async () => {
    const quietChild = makeSettledChild({
      runId: "run-quiet",
      requesterTurnRunId: "quiet-cancellation-owner",
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: { status: "not_required" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      quietChild,
      makeSettledChild({
        runId: "run-b",
        completion: { required: true, resultText: "network findings" },
      }),
      makeSettledChild({
        runId: "run-a",
        completion: { required: true, resultText: "social findings" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: quietChild }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const call = deliveredCallArg();
    expect(call.targetRequesterSessionKey).toBe(REQUESTER);
    expect(call.requesterIsSubagent).toBe(false);
    expect(call.expectsCompletionMessage).toBe(false);
    expect(call.requireDirectDelivery).toBe(true);
    expect(call.requireVisibleReply).toBeUndefined();
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b,run-quiet"));
    expect(quietChild.requesterTurnRunId).toBe("quiet-cancellation-owner");
    const message = String(call.triggerMessage);
    expect(message).toContain("settled");
    expect(message).toContain("social findings");
    expect(message).toContain("network findings");
    expect(message).not.toContain("NO_REPLY");
    expect(message).toContain("continue any unfinished work");
  });

  it("includes all six child outcomes when a successful completion has no output", async () => {
    const children = (["ok", "timeout", "timeout", "ok", "timeout", "timeout"] as const).map(
      (status, index) =>
        makeSettledChild({
          runId: `run-${index}`,
          label: `child ${index}`,
          outcome: { status },
          completion:
            index === 3
              ? { required: true, resultText: "blocked fetch" }
              : {
                  required: true,
                  terminalReply: { disposition: "empty" },
                  resultText: null,
                  fallbackResultText: "stale output",
                },
        }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[5] })),
    ).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const message = String(deliveredCallArg().triggerMessage);
    const results = Array.from(
      message.matchAll(
        /Child task[^\n]*\n<prompt-data>\n([^\n]+)\n<\/prompt-data>\nstatus: ([^\n]+)\nChild result[^\n]*\n<prompt-data>\n([^\n]+)\n<\/prompt-data>/g,
      ),
      (match) => match.slice(1),
    );
    expect(results).toEqual([
      ["child 0", "ok", "(no output)"],
      ["child 1", "timeout", "(no output)"],
      ["child 2", "timeout", "(no output)"],
      ["child 3", "ok", "blocked fetch"],
      ["child 4", "timeout", "(no output)"],
      ["child 5", "timeout", "(no output)"],
    ]);
    expect(message).not.toContain("stale output");
  });

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
      const event = events.findLast((candidate) => matchesTranscriptEvent(candidate, match));
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
    expect(call.requireVisibleReply).toBe(true);
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-b"], 1, {
      delivered: true,
      path: "direct",
    });
  });
});
