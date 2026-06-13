// Slack tests cover replies plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const triggerInternalHookMock = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook: triggerInternalHookMock,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

let deliverReplies: typeof import("./replies.js").deliverReplies;
let createSlackReplyDeliveryPlan: typeof import("./replies.js").createSlackReplyDeliveryPlan;
let resolveDeliveredSlackReplyThreadTs: typeof import("./replies.js").resolveDeliveredSlackReplyThreadTs;
let resolveSlackThreadTs: typeof import("./replies.js").resolveSlackThreadTs;
import { deliverSlackSlashReplies } from "./replies.js";

const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

function baseParams(overrides?: Record<string, unknown>) {
  return {
    cfg: SLACK_TEST_CFG,
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

function requireSendCall(index = 0) {
  const call = sendMock.mock.calls[index] as [string, string, Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error(`sendMessageSlack call ${index} missing`);
  }
  return call;
}

describe("deliverReplies identity passthrough", () => {
  beforeAll(async () => {
    ({
      createSlackReplyDeliveryPlan,
      deliverReplies,
      resolveDeliveredSlackReplyThreadTs,
      resolveSlackThreadTs,
    } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    expect(options.identity).toBe(identity);
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
    const options = requireSendCall()[2];
    expect(options.identity).toBe(identity);
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    expect(options).not.toHaveProperty("identity");
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
    const [target, text, options] = requireSendCall();
    expect(target).toBe("C123");
    expect(text).toBe("");
    expect(options.blocks).toStrictEqual(blocks);
  });

  it("renders interactive replies into Slack blocks during delivery", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "Choose",
            interactive: {
              blocks: [
                { type: "text", text: "Choose" },
                {
                  type: "buttons",
                  buttons: [{ label: "Approve", value: "approve", style: "primary" }],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const options = requireSendCall()[2];
    const blocks = options.blocks as Array<{
      type?: string;
      elements?: Array<{ action_id?: string; style?: string; value?: string }>;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("section");
    expect(blocks[1]?.type).toBe("actions");
    expect(blocks[1]?.elements).toHaveLength(1);
    expect(blocks[1]?.elements?.[0]?.action_id).toBe("openclaw:reply_button:1:1");
    expect(blocks[1]?.elements?.[0]?.style).toBe("primary");
    expect(blocks[1]?.elements?.[0]?.value).toBe("approve");
  });

  it("rejects replies when merged Slack blocks exceed the platform limit", async () => {
    sendMock.mockResolvedValue(undefined);

    await expect(
      deliverReplies(
        baseParams({
          replies: [
            {
              text: "Choose",
              channelData: {
                slack: {
                  blocks: Array.from({ length: 50 }, () => ({ type: "divider" })),
                },
              },
              interactive: {
                blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Slack blocks cannot exceed 50 items/i);
  });
});

describe("resolveDeliveredSlackReplyThreadTs", () => {
  beforeAll(async () => {
    ({ resolveDeliveredSlackReplyThreadTs } = await import("./replies.js"));
  });

  it("prefers explicit reply targets when reply tags are enabled", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "first",
        payloadReplyToId: "explicit-thread",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("explicit-thread");
  });

  it("ignores explicit reply tags when replyToMode is off", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "off",
        payloadReplyToId: "explicit-thread",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("planned-thread");
  });

  it("falls back to the planned reply thread when no explicit reply tag exists", () => {
    expect(
      resolveDeliveredSlackReplyThreadTs({
        replyToMode: "batched",
        replyThreadTs: "planned-thread",
      }),
    ).toBe("planned-thread");
  });
});

describe("resolveSlackThreadTs fallback classification", () => {
  const threadTs = "1234567890.123456";
  const messageTs = "9999999999.999999";

  it("keeps legacy thread-stickiness for genuine replies when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        replyToMode: "off",
        incomingThreadTs: threadTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBe(threadTs);
  });

  it("respects replyToMode for auto-created top-level thread_ts when callers omit isThreadReply", () => {
    expect(
      resolveSlackThreadTs({
        replyToMode: "off",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBeUndefined();

    expect(
      resolveSlackThreadTs({
        replyToMode: "first",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: false,
      }),
    ).toBe(messageTs);

    expect(
      resolveSlackThreadTs({
        replyToMode: "batched",
        incomingThreadTs: messageTs,
        messageTs,
        hasReplied: true,
      }),
    ).toBeUndefined();
  });
});

describe("createSlackReplyDeliveryPlan", () => {
  it("lets draft previews inspect first thread targets without consuming them", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "9999999999.999999",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(hasRepliedRef.value).toBe(false);

    plan.markSent();

    expect(hasRepliedRef.value).toBe(true);
    expect(plan.peekThreadTs()).toBeUndefined();
    expect(plan.nextThreadTs()).toBeUndefined();
  });
});

describe("deliverSlackSlashReplies chunking", () => {
  it("keeps a 4205-character reply in a single slash response by default", async () => {
    const respond = vi.fn(async () => undefined);
    const text = "a".repeat(4205);

    await deliverSlackSlashReplies({
      replies: [{ text }],
      respond,
      ephemeral: true,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text,
      response_type: "ephemeral",
    });
  });

  it("sends block-only slash replies instead of dropping them", async () => {
    const respond = vi.fn(async () => undefined);
    const blocks = [{ type: "divider" }];

    await deliverSlackSlashReplies({
      replies: [
        {
          channelData: {
            slack: {
              blocks,
            },
          },
        },
      ],
      respond,
      ephemeral: false,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: "",
      blocks,
      response_type: "in_channel",
    });
  });

  it("suppresses reasoning payloads in slash replies", async () => {
    const respond = vi.fn(async () => undefined);

    await deliverSlackSlashReplies({
      replies: [{ text: "Let me think...", isReasoning: true }, { text: "final answer" }],
      respond,
      ephemeral: false,
      textLimit: 8000,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: "final answer",
      response_type: "in_channel",
    });
  });
});

describe("deliverReplies reasoning suppression", () => {
  beforeAll(async () => {
    ({ deliverReplies } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
  });

  it("suppresses reasoning payloads and delivers only non-reasoning replies", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [{ text: "Reasoning:\n_hidden_", isReasoning: true }, { text: "visible answer" }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const [, text] = requireSendCall();
    expect(text).toBe("visible answer");
  });

  it("delivers nothing when all payloads are reasoning", async () => {
    sendMock.mockResolvedValue(undefined);

    await deliverReplies(
      baseParams({
        replies: [
          { text: "Let me think about this...", isReasoning: true },
          { text: "I need to consider...", isReasoning: true },
        ],
      }),
    );

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("deliverReplies message_sent hook", () => {
  beforeAll(async () => {
    ({ deliverReplies } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSent.mockReset();
    triggerInternalHookMock.mockReset();
  });

  it("emits message_sent with the delivered Slack message id after a text reply", async () => {
    messageHookRunner.hasHooks.mockImplementation((name) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "1700000000.000100", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "shipped" }],
        sessionKeyForInternalHooks: "agent:main:slack:channel:c123",
        runId: "run-1",
      }),
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C123",
        content: "shipped",
        success: true,
        messageId: "1700000000.000100",
        sessionKey: "agent:main:slack:channel:c123",
        runId: "run-1",
      }),
      expect.objectContaining({
        channelId: "slack",
        conversationId: "C123",
        messageId: "1700000000.000100",
        sessionKey: "agent:main:slack:channel:c123",
        runId: "run-1",
      }),
    );
  });

  it("emits message_sent with success=false when text delivery throws", async () => {
    messageHookRunner.hasHooks.mockImplementation((name) => name === "message_sent");
    sendMock.mockRejectedValue(new Error("channel_not_found"));

    await expect(deliverReplies(baseParams({ replies: [{ text: "boom" }] }))).rejects.toThrow(
      /channel_not_found/,
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C123",
        content: "boom",
        success: false,
        error: expect.stringContaining("channel_not_found"),
      }),
      expect.objectContaining({ channelId: "slack" }),
    );
  });

  it("does not emit the plugin hook when no listener observes message_sent", async () => {
    sendMock.mockResolvedValue({ messageId: "1700000000.000101", channelId: "C123" });

    await deliverReplies(baseParams({ replies: [{ text: "quiet" }] }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
  });

  it("fires the internal message:sent hook when only a session key is supplied", async () => {
    sendMock.mockResolvedValue({ messageId: "1700000000.000102", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "internal" }],
        sessionKeyForInternalHooks: "agent:main:slack:channel:c123",
      }),
    );

    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
    expect(triggerInternalHookMock).toHaveBeenCalledOnce();
  });

  it("threads group context into the internal message:sent hook", async () => {
    sendMock.mockResolvedValue({ messageId: "1700000000.000103", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "group reply" }],
        sessionKeyForInternalHooks: "agent:main:slack:channel:c123",
        mirrorIsGroup: true,
        mirrorGroupId: "C123",
      }),
    );

    expect(triggerInternalHookMock).toHaveBeenCalledOnce();
    expect(triggerInternalHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ isGroup: true, groupId: "C123" }),
      }),
    );
  });

  it("emits message_sent for block-only replies with the delivered Slack id", async () => {
    messageHookRunner.hasHooks.mockImplementation((name) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "1700000000.000104", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "",
            channelData: {
              slack: {
                blocks: [{ type: "divider" }],
              },
            },
          },
        ],
      }),
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        messageId: "1700000000.000104",
      }),
      expect.anything(),
    );
  });

  it("emits message_sent for media replies with the delivered Slack id", async () => {
    messageHookRunner.hasHooks.mockImplementation((name) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "1700000000.000105", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "caption", mediaUrls: ["https://example.com/image.png"] }],
      }),
    );

    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "caption",
        success: true,
        messageId: "1700000000.000105",
      }),
      expect.objectContaining({ channelId: "slack" }),
    );
  });

  it("keeps the caption as message_sent content for multi-media replies", async () => {
    messageHookRunner.hasHooks.mockImplementation((name) => name === "message_sent");
    sendMock
      .mockResolvedValueOnce({ messageId: "1700000000.000106", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "1700000000.000107", channelId: "C123" });

    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "caption",
            mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(requireSendCall(0)[1]).toBe("caption");
    expect(requireSendCall(1)[1]).toBe("");
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "caption",
        success: true,
        messageId: "1700000000.000107",
      }),
      expect.objectContaining({ channelId: "slack" }),
    );
  });
});
