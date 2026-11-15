import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { completionReader, visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
import {
  registryRuntimeMock,
  findTranscriptEventMock as findEvent,
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

const { maybeWakeRequesterAfterAllChildrenSettled: wakeRequester } =
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
      ...[
        ["run-b", "network findings"],
        ["run-a", "social findings"],
      ].map(([runId, resultText]) =>
        makeSettledChild({ runId, completion: { required: true, resultText } }),
      ),
    ]);

    expect(await wakeRequester(wakeParams({ settledEntry: quietChild }))).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const call = deliveredCallArg();
    expect(call).toMatchObject({
      targetRequesterSessionKey: REQUESTER,
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: requesterSettleKey("run-a,run-b,run-quiet"),
    });
    expect(call.requireVisibleReply).toBeUndefined();
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
              ? visibleCompletion("blocked fetch")
              : {
                  required: true,
                  terminalReply: { disposition: "empty" },
                  resultText: null,
                  fallbackResultText: "stale output",
                },
        }),
    );
    const visible = expectDefined(children[3], "visible child");
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    sessionStore[visible.childSessionKey] = { sessionId: "child-3-session" };
    findEvent.mockImplementation(
      completionReader((id) => (id === "child-3-session" ? visible : undefined), "stop"),
    );

    expect(await wakeRequester(wakeParams({ settledEntry: children[5] }))).toBe(true);

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
