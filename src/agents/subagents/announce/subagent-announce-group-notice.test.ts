// Missing-reply notices close channel completions visibly without exposing
// the child result that the requester's own turns chose not to post.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.hoisted(() =>
  vi.fn(async (params: { onDeliveredPayload?: () => void }) => {
    params.onDeliveredPayload?.();
    return { deliveryStatus: "sent" as const };
  }),
);

vi.mock("./subagent-announce-delivery.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce-delivery.runtime.js")>()),
  sendSubagentAnnounceMessage: sendMessage,
}));

const { deliverMissingReplyGroupNotice } =
  await import("./subagent-announce-completion-delivery.js");

const slackThreadTarget = {
  deliver: true,
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
};

function deliverNotice(
  overrides: Partial<Parameters<typeof deliverMissingReplyGroupNotice>[0]> = {},
) {
  return deliverMissingReplyGroupNotice({
    cfg: {},
    requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    requesterAgentId: "main",
    directIdempotencyKey: "announce:requester-settle:batch",
    deliveryTarget: slackThreadTarget,
    ...overrides,
  });
}

beforeEach(() => {
  sendMessage.mockClear();
});

describe("deliverMissingReplyGroupNotice", () => {
  it("posts one content-free notice to the requester's channel thread", async () => {
    const delivery = await deliverNotice();

    expect(delivery).toMatchObject({ delivered: true, path: "direct" });
    expect(sendMessage).toHaveBeenCalledOnce();
    const sent = sendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "acct-1",
      threadId: "171.222",
      agentId: "main",
      conversationType: "channel",
      idempotencyKey: "announce:requester-settle:batch:group-notice",
    });
    expect(sent.content).toBe(
      "A delegated task finished, but its result was not posted here. Ask me for the result.",
    );
  });

  it.each([
    {
      name: "direct-message target",
      deliveryTarget: { ...slackThreadTarget, to: "user:U123", threadId: undefined },
    },
    { name: "undeliverable target", deliveryTarget: { deliver: false } },
    { name: "target without a destination", deliveryTarget: { deliver: true, channel: "slack" } },
  ])("does not send for a $name", async ({ deliveryTarget }) => {
    const delivery = await deliverNotice({
      requesterSessionKey: "agent:main:slack:direct:U123",
      deliveryTarget,
    });

    expect(delivery).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send after the completion owner changes", async () => {
    const delivery = await deliverNotice({ isSourceSessionEffectsAllowed: () => false });

    expect(delivery?.delivered).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
