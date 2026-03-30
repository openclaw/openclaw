import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createSlackOutboundPayloadHarness } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  return createSlackOutboundPayloadHarness(params);
}

describe("slackOutbound sendPayload", () => {
  it("forwards Slack blocks from channelData", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Fallback summary",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "Fallback summary",
      expect.objectContaining({
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-1" });
  });

  it("accepts blocks encoded as JSON strings in Slack channelData", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        channelData: {
          slack: {
            blocks: '[{"type":"section","text":{"type":"mrkdwn","text":"hello"}}]',
          },
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledWith(
      to,
      "",
      expect.objectContaining({
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }],
      }),
    );
  });

  it("rejects invalid Slack blocks from channelData", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        channelData: {
          slack: {
            blocks: {},
          },
        },
      },
    });

    await expect(run()).rejects.toThrow(/blocks must be an array/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends media before a separate interactive blocks message", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Approval required",
        mediaUrl: "https://example.com/image.png",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
      sendResults: [{ messageId: "sl-media" }, { messageId: "sl-controls" }],
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      to,
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
      }),
    );
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      to,
      "Approval required",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "actions",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-controls" });
  });

  it("redacts exec approval command details from Slack text when buttons are present", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Approval required.\n\nPending command:\n```sh\nfind . -path '*save_draft.py'\n```",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "/approve 123 allow-once" }],
            },
          ],
        },
        channelData: {
          execApproval: {
            approvalId: "123",
            approvalSlug: "123",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "Approval required. Use the buttons below.",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "actions",
          }),
        ],
      }),
    );
  });

  it("fails when merged Slack blocks exceed the platform limit", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        channelData: {
          slack: {
            blocks: Array.from({ length: 50 }, () => ({ type: "divider" })),
          },
        },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
            },
          ],
        },
      },
    });

    await expect(run()).rejects.toThrow(/Slack blocks cannot exceed 50 items/i);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
