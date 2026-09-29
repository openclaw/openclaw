// A channel requester whose settle-wake turns all stay silent gets one visible
// missing-result notice; earlier attempts and other failures keep retrying.
import { describe, expect, it, vi } from "vitest";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  completeBatchSpy,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const noticeSpy = vi.hoisted(() =>
  vi.fn(async (_params: Record<string, unknown>) => ({
    delivered: true as const,
    path: "direct" as const,
  })),
);

vi.mock("./subagent-announce-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce-completion-delivery.js")>()),
  deliverMissingReplyGroupNotice: noticeSpy,
}));

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
};

const missingVisibleReply = {
  delivered: false,
  path: "direct",
  reason: "visible_reply_missing",
  error: "completion agent did not produce a visible reply",
} as const;

function listChildAtAttempt(attemptCount: number) {
  const child = makeSettledChild({
    runId: "run-b",
    completion: { required: true, resultText: "child findings" },
    requesterSettleWake: {
      status: "pending",
      attemptCount,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  return child;
}

describe("requester settle wake missing-reply group notice", () => {
  it("posts the notice once the final attempt still has no visible reply", async () => {
    listChildAtAttempt(2);
    noticeSpy.mockClear();
    deliverSpy.mockResolvedValueOnce(missingVisibleReply);

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ requesterOrigin: slackThreadOrigin })),
    ).resolves.toBe(false);

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0]?.[0]).toMatchObject({
      deliveryTarget: {
        deliver: true,
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
        threadId: "171.222",
      },
    });
    // The child result itself remains undelivered; the notice is only a trace.
    expect(completeBatchSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy.mock.calls[0]?.[2]).toMatchObject({
      delivered: false,
      reason: "visible_reply_missing",
    });
  });

  it("keeps retrying without a notice before the final attempt", async () => {
    listChildAtAttempt(0);
    noticeSpy.mockClear();
    deliverSpy.mockResolvedValueOnce(missingVisibleReply);

    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterOrigin: slackThreadOrigin }),
    );

    expect(noticeSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).not.toHaveBeenCalled();
  });

  it("does not post a notice for other final-attempt failures", async () => {
    listChildAtAttempt(2);
    noticeSpy.mockClear();
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      error: "gateway unavailable",
    });

    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterOrigin: slackThreadOrigin }),
    );

    expect(noticeSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenCalledOnce();
  });
});
