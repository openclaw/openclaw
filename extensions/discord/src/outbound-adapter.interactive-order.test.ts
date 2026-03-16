import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendDiscordComponentMessageMock: vi.fn(),
  sendMessageDiscordMock: vi.fn(),
  sendPollDiscordMock: vi.fn(),
  sendWebhookMessageDiscordMock: vi.fn(),
  getThreadBindingManagerMock: vi.fn(),
}));

vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
    ...actual,
    sendDiscordComponentMessage: (...args: unknown[]) =>
      hoisted.sendDiscordComponentMessageMock(...args),
    sendMessageDiscord: (...args: unknown[]) => hoisted.sendMessageDiscordMock(...args),
    sendPollDiscord: (...args: unknown[]) => hoisted.sendPollDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) =>
      hoisted.sendWebhookMessageDiscordMock(...args),
  };
});

vi.mock("./monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: (...args: unknown[]) => hoisted.getThreadBindingManagerMock(...args),
  };
});

const { discordOutbound } = await import("./outbound-adapter.js");

describe("discordOutbound shared interactive ordering", () => {
  beforeEach(() => {
    hoisted.sendDiscordComponentMessageMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "123456",
    });
    hoisted.sendMessageDiscordMock.mockReset();
    hoisted.sendPollDiscordMock.mockReset();
    hoisted.sendWebhookMessageDiscordMock.mockReset();
    hoisted.getThreadBindingManagerMock.mockReset().mockReturnValue(null);
  });

  it("keeps shared text blocks in authored order without hoisting fallback text", async () => {
    const result = await discordOutbound.sendPayload!({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        interactive: {
          blocks: [
            { type: "text", text: "First" },
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
            { type: "text", text: "Last" },
          ],
        },
      },
    });

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      {
        blocks: [
          { type: "text", text: "First" },
          {
            type: "actions",
            buttons: [{ label: "Approve", style: "secondary", callbackData: "approve" }],
          },
          { type: "text", text: "Last" },
        ],
      },
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "123456",
    });
  });
});
