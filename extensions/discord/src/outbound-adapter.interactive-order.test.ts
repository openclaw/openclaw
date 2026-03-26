import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordOutboundHoisted,
  createDiscordSendModuleMock,
  createDiscordThreadBindingsModuleMock,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();

const sendModule = await import("./send.js");
const mockedSendModule = await createDiscordSendModuleMock(hoisted, async () => sendModule);
vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(mockedSendModule.sendMessageDiscord);
vi.spyOn(sendModule, "sendDiscordComponentMessage").mockImplementation(
  mockedSendModule.sendDiscordComponentMessage,
);
vi.spyOn(sendModule, "sendPollDiscord").mockImplementation(mockedSendModule.sendPollDiscord);
vi.spyOn(sendModule, "sendWebhookMessageDiscord").mockImplementation(
  mockedSendModule.sendWebhookMessageDiscord,
);

const threadBindingsModule = await import("./monitor/thread-bindings.js");
const mockedThreadBindingsModule = await createDiscordThreadBindingsModuleMock(
  hoisted,
  async () => threadBindingsModule,
);
vi.spyOn(threadBindingsModule, "getThreadBindingManager").mockImplementation(
  mockedThreadBindingsModule.getThreadBindingManager,
);

const { discordOutbound } = await import("./outbound-adapter.js");

describe("discordOutbound shared interactive ordering", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    hoisted.sendDiscordComponentMessageMock.mockResolvedValue({
      messageId: "msg-1",
      channelId: "123456",
    });
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
