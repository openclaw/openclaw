import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import {
  registryRuntimeMock,
  findTranscriptEventMock,
  sessionStore,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  deliverSpy,
  makeSettledChild,
  deliveredCallArg,
  REQUESTER,
  requesterSettleKey,
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
              ? {
                  required: true,
                  terminalReply: { disposition: "visible", text: "blocked fetch" },
                  resultText: "blocked fetch",
                }
              : {
                  required: true,
                  terminalReply: { disposition: "empty" },
                  resultText: null,
                  fallbackResultText: "stale output",
                },
        }),
    );
    const visibleChild = expectDefined(children[3], "visible child");
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    sessionStore[visibleChild.childSessionKey] = { sessionId: "child-3-session" };
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      const event = {
        type: "message",
        message: {
          role: "assistant",
          display: true,
          stopReason: "stop",
          content: [{ type: "text", text: "blocked fetch" }],
          __openclaw: { runId: visibleChild.runId },
        },
      };
      return sessionId === "child-3-session" && matchesTranscriptEvent(event, match)
        ? { event }
        : undefined;
    });

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
});
