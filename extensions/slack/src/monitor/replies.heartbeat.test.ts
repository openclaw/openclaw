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

describe("deliverReplies HEARTBEAT_OK safety-net", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  it("strips messages that are exactly 'HEARTBEAT_OK'", async () => {
    await deliverReplies(baseParams({ replies: [{ text: "HEARTBEAT_OK" }] }));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("strips messages that are 'HEARTBEAT_OK' with surrounding whitespace", async () => {
    await deliverReplies(baseParams({ replies: [{ text: "  HEARTBEAT_OK  " }] }));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("strips HEARTBEAT_OK from messages with surrounding content", async () => {
    await deliverReplies(
      baseParams({ replies: [{ text: "HEARTBEAT_OK Here is some other text" }] }),
    );
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      expect.not.stringContaining("HEARTBEAT_OK"),
      expect.any(Object),
    );
  });

  it("does NOT strip normal messages containing the word 'heartbeat'", async () => {
    await deliverReplies(
      baseParams({ replies: [{ text: "The heartbeat check passed successfully" }] }),
    );
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "The heartbeat check passed successfully",
      expect.any(Object),
    );
  });

  it("does NOT strip normal messages", async () => {
    await deliverReplies(baseParams({ replies: [{ text: "Hello, how can I help?" }] }));
    expect(sendMock).toHaveBeenCalledWith("C123", "Hello, how can I help?", expect.any(Object));
  });

  it("skips block-path message entirely when HEARTBEAT_OK shouldSkip is true", async () => {
    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "HEARTBEAT_OK",
            channelData: {
              slack: {
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [{ type: "text", text: "HEARTBEAT_OK" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("delivers block-path message when text has HEARTBEAT_OK mixed with real content", async () => {
    await deliverReplies(
      baseParams({
        replies: [
          {
            text: "HEARTBEAT_OK Here is a real reply",
            channelData: {
              slack: {
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: "Here is a real reply" } },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      expect.not.stringContaining("HEARTBEAT_OK"),
      expect.objectContaining({ blocks: expect.any(Array) }),
    );
  });

  it("still delivers media when HEARTBEAT_OK text is stripped", async () => {
    await deliverReplies(
      baseParams({
        replies: [{ text: "HEARTBEAT_OK", mediaUrls: ["https://example.com/image.png"] }],
      }),
    );
    expect(sendMock).toHaveBeenCalled();
  });
});
