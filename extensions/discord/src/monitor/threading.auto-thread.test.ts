import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { maybeCreateDiscordAutoThread } from "./threading.js";
type AutoThreadParams = Parameters<typeof maybeCreateDiscordAutoThread>[0];

const { generateThreadTitleMock } = vi.hoisted(() => ({
  generateThreadTitleMock: vi.fn(),
}));

vi.mock("./thread-title.js", () => ({
  generateThreadTitle: generateThreadTitleMock,
}));

const postMock = vi.fn();
const getMock = vi.fn();
const patchMock = vi.fn();
const mockClient = {
  rest: { post: postMock, get: getMock, patch: patchMock },
} as unknown as AutoThreadParams["client"];
const mockMessage = {
  id: "1001",
  timestamp: "123",
} as unknown as AutoThreadParams["message"];

function createBaseParams(overrides: Partial<AutoThreadParams> = {}): AutoThreadParams {
  return {
    client: mockClient,
    message: mockMessage,
    messageChannelId: "text1",
    channel: "discord",
    agentId: "main",
    isGuildMessage: true,
    channelConfig: { allowed: true, autoThread: true },
    channelType: ChannelType.GuildText,
    baseText: "test",
    combinedBody: "test",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function expectRestBodyField(mock: typeof postMock, field: string, expected: unknown) {
  expect(mock.mock.calls[0]).toEqual([
    expect.any(String),
    expect.objectContaining({ body: expect.objectContaining({ [field]: expected }) }),
  ]);
}

function generatedParams(overrides: Partial<AutoThreadParams> = {}) {
  return createBaseParams({
    channelConfig: {
      allowed: true,
      autoThread: true,
      autoThreadName: "generated",
      autoArchiveDuration: "10080",
    },
    cfg: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
    ...overrides,
  });
}

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  patchMock.mockReset();
  generateThreadTitleMock.mockReset();
});

function mockThreadCreation() {
  postMock.mockResolvedValueOnce({ id: "thread1" });
  getMock.mockResolvedValueOnce({});
}

describe("maybeCreateDiscordAutoThread", () => {
  it("skips auto-thread for unsupported stage voice channels", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({ channelType: ChannelType.GuildStageVoice }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it.each(["existing-thread", undefined])(
    "handles bot-authored messages with thread %s",
    async (threadId) => {
      getMock.mockResolvedValueOnce(threadId ? { thread: { id: threadId } } : {});
      const result = await maybeCreateDiscordAutoThread(
        createBaseParams({
          message: Object.assign({}, mockMessage, {
            author: { bot: true },
          }) as AutoThreadParams["message"],
        }),
      );

      expect(result).toBe(threadId);
      expect(postMock).not.toHaveBeenCalled();
    },
  );
  it("renames created thread when generated mode is enabled", async () => {
    mockThreadCreation();
    patchMock.mockResolvedValueOnce({});
    generateThreadTitleMock.mockResolvedValueOnce("Deploy rollout summary");

    const result = await maybeCreateDiscordAutoThread(
      generatedParams({
        baseText: "Need help with deploy rollout",
        combinedBody: "Need help with deploy rollout",
        channelName: "openclaw",
        channelDescription: "OpenClaw development coordination and release planning",
      }),
    );
    expect(result).toBe("thread1");
    expectRestBodyField(postMock, "name", "Need help with deploy rollout");
    expectRestBodyField(postMock, "auto_archive_duration", 10080);
    await flushAsyncWork();
    expect(generateThreadTitleMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      messageText: "Need help with deploy rollout",
      channelName: "openclaw",
      channelDescription: "OpenClaw development coordination and release planning",
    });
    expectRestBodyField(patchMock, "name", "Deploy rollout summary");
  });

  it("does not block thread creation while title summary is pending", async () => {
    mockThreadCreation();
    patchMock.mockResolvedValueOnce({});
    const title = createDeferred<string | null>();
    generateThreadTitleMock.mockReturnValueOnce(title.promise);

    const result = await maybeCreateDiscordAutoThread(generatedParams());
    expect(result).toBe("thread1");
    expect(patchMock).not.toHaveBeenCalled();

    title.resolve("Async summary");
    await flushAsyncWork();
    expect(patchMock).toHaveBeenCalled();
  });

  it("uses title model override from the created thread", async () => {
    mockThreadCreation();
    patchMock.mockResolvedValueOnce({});
    generateThreadTitleMock.mockResolvedValueOnce("Deploy rollout summary");

    const cfg = {
      ...generatedParams().cfg,
      channels: { modelByChannel: { discord: { thread1: "openai/gpt-4.1-mini" } } },
    } satisfies OpenClawConfig;
    await maybeCreateDiscordAutoThread(generatedParams({ cfg }));

    await flushAsyncWork();
    expect(generateThreadTitleMock.mock.calls[0]?.[0]).toMatchObject({
      modelRef: "openai/gpt-4.1-mini",
    });
  });

  it("does not rename when generated title sanitizes to fallback thread name", async () => {
    mockThreadCreation();
    generateThreadTitleMock.mockResolvedValueOnce("<@123456789012345678> <#987654321098765432>");

    const result = await maybeCreateDiscordAutoThread(
      generatedParams({
        baseText: "Need help with deploy rollout",
        combinedBody: "Need help with deploy rollout",
      }),
    );

    expect(result).toBe("thread1");
    await flushAsyncWork();
    expect(patchMock).not.toHaveBeenCalled();
  });
});
