// Discord tests cover message handler.bot self filter plugin behavior.
import { installIsolatedPluginStateDirForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The real handler commits fixed ids ("msg-1"/"ch-1") through the persistent
// replay guard; isolate the state dir per test so the commits cannot leak into
// other suites sharing the worker (--isolate=false safety).
let dedupeStateDir: ReturnType<typeof installIsolatedPluginStateDirForTests>;

beforeEach(() => {
  dedupeStateDir = installIsolatedPluginStateDirForTests();
});

afterEach(() => {
  dedupeStateDir.restore();
});

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

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

function createPreflightContext(channelId = "ch-1") {
  return createDiscordPreflightContext(channelId);
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

  it("enqueues non-bot messages for processing", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) => ({
        ...params,
        ...createPreflightContext(params.data.channel_id),
      }),
    );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData("user-456") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
