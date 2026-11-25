import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover message handler.bot self filter plugin behavior.
import { describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  DEFAULT_DISCORD_BOT_USER_ID,
  createDiscordHandlerParams,
} from "./message-handler.test-helpers.js";

function createMessageData(authorId: string, channelId = "ch-1") {
  return {
    author: { id: authorId, bot: authorId === DEFAULT_DISCORD_BOT_USER_ID },
    message: {
      id: "msg-1",
      author: { id: authorId, bot: authorId === DEFAULT_DISCORD_BOT_USER_ID },
      content: "hello",
      channel_id: channelId,
    },
    channel_id: channelId,
  };
}

describe("createDiscordMessageHandler bot-self filter", () => {
  it("skips bot-own messages before the debounce queue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData(DEFAULT_DISCORD_BOT_USER_ID) as never, {} as never),
    ).resolves.toBeUndefined();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });
});
