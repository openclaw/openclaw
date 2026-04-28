import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
}));

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
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
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
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      blocks: [
        expect.objectContaining({ type: "section" }),
        expect.objectContaining({
          type: "actions",
          elements: [
            expect.objectContaining({
              action_id: "openclaw:reply_button:1:1",
              style: "primary",
              value: "approve",
            }),
          ],
        }),
      ],
    });
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
});

describe("deliverReplies message_sending hook wiring", () => {
  beforeAll(async () => {
    ({ deliverReplies } = await import("./replies.js"));
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
  });

  function params(overrides?: Record<string, unknown>) {
    return {
      cfg: SLACK_TEST_CFG,
      replies: [{ text: "hello" }],
      target: "C123",
      token: "xoxb-test",
      runtime: { log: () => {}, error: () => {}, exit: () => {} },
      textLimit: 4000,
      replyToMode: "off" as const,
      replyThreadTs: "1712000000.000001",
      ...overrides,
    };
  }

  it("invokes message_sending once per reply with slack routing context", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending",
    );
    messageHookRunner.runMessageSending.mockResolvedValue(undefined);

    await deliverReplies(
      params({
        replies: [{ text: "first" }, { text: "second" }],
        accountId: "primary",
      }),
    );

    expect(messageHookRunner.runMessageSending).toHaveBeenCalledTimes(2);
    expect(messageHookRunner.runMessageSending).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "C123",
        content: "first",
        threadId: "1712000000.000001",
        metadata: expect.objectContaining({
          channel: "slack",
          accountId: "primary",
          threadTs: "1712000000.000001",
        }),
      }),
      expect.objectContaining({
        channelId: "slack",
        accountId: "primary",
        conversationId: "C123",
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("rewrites outgoing reply text when the hook returns new content", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending",
    );
    messageHookRunner.runMessageSending.mockResolvedValue({
      content: "<@U111> rewritten",
    });

    await deliverReplies(params({ replies: [{ text: "<@U222> hello" }] }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe("<@U111> rewritten");
  });

  it("skips delivery entirely when the hook cancels", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending",
    );
    messageHookRunner.runMessageSending.mockResolvedValue({ cancel: true });

    await deliverReplies(params());

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("short-circuits without touching the hook runner when no hooks are registered", async () => {
    messageHookRunner.hasHooks.mockReturnValue(false);

    await deliverReplies(params());

    expect(messageHookRunner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("fails open when the hook handler throws (delivery still happens)", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending",
    );
    messageHookRunner.runMessageSending.mockRejectedValueOnce(new Error("boom"));

    await deliverReplies(params());

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe("hello");
  });

  it("runs the hook for block-only replies and uses hook content for the send text", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending",
    );
    messageHookRunner.runMessageSending.mockResolvedValue({ content: "guarded text" });

    const blocks = [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "openclaw:reply_button",
            text: { type: "plain_text", text: "Option" },
            value: "opt",
          },
        ],
      },
    ];

    await deliverReplies(
      params({
        replies: [
          {
            text: "original",
            channelData: { slack: { blocks } },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toBe("guarded text");
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({ blocks });
  });
});
