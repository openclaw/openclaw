import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

import { deliverReplies } from "./replies.js";

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

  it("merges interactive blocks into delivery when payload has interactive field", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "Pick one",
            interactive: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    { label: "Yes", value: "yes" },
                    { label: "No", value: "no" },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const sentBlocks = sendMock.mock.calls[0][2].blocks;
    expect(sentBlocks).toHaveLength(1);
    expect(sentBlocks[0].type).toBe("actions");
    expect(sentBlocks[0].elements).toHaveLength(2);
    expect(sentBlocks[0].elements[0].type).toBe("button");
    expect(sentBlocks[0].elements[0].value).toBe("yes");
    expect(sentBlocks[0].elements[1].value).toBe("no");
  });

  it("merges channelData blocks with interactive blocks", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "context",
            channelData: {
              slack: {
                blocks: [{ type: "divider" }],
              },
            },
            interactive: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Go", value: "go" }],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    const sentBlocks = sendMock.mock.calls[0][2].blocks;
    expect(sentBlocks).toHaveLength(2);
    expect(sentBlocks[0].type).toBe("divider");
    expect(sentBlocks[1].type).toBe("actions");
  });

  it("delivers text-only reply when no blocks or interactive", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(
      baseParams({
        replies: [{ text: "just text" }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("blocks");
  });
});
