import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  DEFAULT_DISCORD_BOT_USER_ID,
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function createSelfMessageData(channelId = "ch-1") {
  return {
    author: { id: DEFAULT_DISCORD_BOT_USER_ID, bot: true },
    message: {
      id: "msg-self",
      author: { id: DEFAULT_DISCORD_BOT_USER_ID, bot: true },
      content: "hello from self",
      channel_id: channelId,
    },
    channel_id: channelId,
  };
}

/**
 * Covers the Phase 7 E2E harness bypass. The test bot shares its token with
 * the production gateway, which means a REST post by the harness returns as
 * a self MessageCreate event. The bypass lets that event through ONLY when
 * both `OPENCLAW_E2E_ALLOW_SELF_MESSAGES=1` and `NODE_ENV !== "production"`
 * hold, so real deployments keep the anti-self-reply invariant.
 */
describe("createDiscordMessageHandler self-filter E2E bypass", () => {
  const originalAllow = process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createDiscordPreflightContext(params.data.channel_id),
    );
  });

  afterEach(() => {
    if (originalAllow === undefined) {
      delete process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES;
    } else {
      process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = originalAllow;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("still drops self-messages when the bypass env is unset", async () => {
    delete process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES;
    process.env.NODE_ENV = "development";
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler(createSelfMessageData() as never, {} as never);
    await flushAsyncWork();
    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("still drops self-messages when the bypass env is '0'", async () => {
    process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = "0";
    process.env.NODE_ENV = "development";
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler(createSelfMessageData() as never, {} as never);
    await flushAsyncWork();
    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("still drops self-messages in production even with the bypass flag set", async () => {
    process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = "1";
    process.env.NODE_ENV = "production";
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler(createSelfMessageData() as never, {} as never);
    await flushAsyncWork();
    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("lets self-messages through when both env and NODE_ENV allow it", async () => {
    process.env.OPENCLAW_E2E_ALLOW_SELF_MESSAGES = "1";
    process.env.NODE_ENV = "test";
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler(createSelfMessageData() as never, {} as never);
    await flushAsyncWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });
});
