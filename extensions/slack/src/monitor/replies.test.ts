import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

import { createSlackReplyDeliveryPlan, deliverReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

describe("deliverReplies identity passthrough", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconUrl: "https://example.com/icon.png" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ text: "caption", mediaUrls: ["https://example.com/img.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });

  it("delivers block-only replies through to sendMessageSlack", async () => {
    sendMock.mockResolvedValue(undefined);
    const blocks = [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button",
            text: { type: "plain_text", text: "Option A" },
            value: "reply_1_option_a",
          },
        ],
      },
    ];

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "",
            channelData: {
              slack: {
                blocks,
              },
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "",
      expect.objectContaining({
        blocks,
      }),
    );
  });
});

describe("createSlackReplyDeliveryPlan", () => {
  it("returns thread ts on every call in 'all' mode", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "all",
      incomingThreadTs: undefined,
      messageTs: "msg.1",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.nextThreadTs()).toBe("msg.1");
    plan.markSent();
    expect(plan.nextThreadTs()).toBe("msg.1");
    plan.markSent();
    expect(plan.nextThreadTs()).toBe("msg.1");
  });

  it("returns thread ts only on first call in 'first' mode", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "msg.1",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.nextThreadTs()).toBe("msg.1");
    plan.markSent();
    // Subsequent calls return undefined — this is the expected "first" behavior
    // across separate user messages. The block-streaming fix lives in dispatch.ts
    // where usedReplyThreadTs carries the thread ts across blocks within a single
    // agent turn.
    expect(plan.nextThreadTs()).toBeUndefined();
    expect(hasRepliedRef.value).toBe(true);
  });

  it("returns undefined in 'off' mode", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "off",
      incomingThreadTs: undefined,
      messageTs: "msg.1",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.nextThreadTs()).toBeUndefined();
  });
});
