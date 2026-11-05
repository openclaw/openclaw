import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordQueuePreflightContext,
} from "./message-handler.test-helpers.js";

function createTextMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [],
    },
  };
}

it("keeps replies to a different message out of an ordinary debounced batch", async () => {
  const params = createDiscordHandlerParams();
  params.cfg.messages = { inbound: { debounceMs: 20 } };
  preflightDiscordMessageMock.mockImplementation(
    async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
      ...createDiscordQueuePreflightContext(preflightParams.data.channel_id),
      message: preflightParams.data.message,
      messageText: preflightParams.data.message.content,
    }),
  );
  const handler = createDiscordMessageHandler(params);
  const ordinary = createTextMessageData("m-ordinary");
  const reply = createTextMessageData("m-other-bot-reply");
  Object.assign(reply.message, {
    messageReference: {
      type: 0,
      message_id: "m-other-bot",
      channel_id: reply.channel_id,
    },
    referencedMessage: {
      id: "m-other-bot",
      author: { id: "other-bot", bot: true },
    },
  });

  await handler(ordinary as never, {} as never);
  await handler(reply as never, {} as never);

  await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(2);
  expect(preflightDiscordMessageMock.mock.calls.map(([call]) => call)).toMatchObject([
    { data: { message: { content: "hello" } } },
    { data: { message: { content: "hello" } } },
  ]);
  expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
});
