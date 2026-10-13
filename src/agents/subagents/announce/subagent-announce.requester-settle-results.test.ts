import { describe, expect, it } from "vitest";
import {
  registryRuntimeMock,
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
});
