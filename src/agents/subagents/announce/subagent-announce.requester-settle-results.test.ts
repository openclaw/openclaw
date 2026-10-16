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
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled results", () => {
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
