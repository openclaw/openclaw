import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "mx-1" }));

vi.mock("../send.js", () => ({
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";

describe("deliverMatrixReplies", () => {
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn(() => "code");
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const resolveChunkModeMock = vi.fn(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => [text]);

  const runtimeStub = {
    config: {
      loadConfig: () => loadConfigMock(),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => resolveMarkdownTableModeMock(),
        convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
        resolveChunkMode: () => resolveChunkModeMock(),
        chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  it("keeps replyToId on first reply only when replyToMode=first", async () => {
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverMatrixReplies({
      replies: [
        { text: "first-a|first-b", replyToId: "reply-1" },
        { text: "second", replyToId: "reply-2" },
      ],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: undefined }),
    );
  });

  it("keeps replyToId on every reply when replyToMode=all", async () => {
    await deliverMatrixReplies({
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-media",
          audioAsVoice: true,
        },
        { text: "plain", replyToId: "reply-text" },
      ],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "all",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]).toEqual([
      "room:2",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg", replyToId: "reply-media" }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[1]).toEqual([
      "room:2",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/b.jpg", replyToId: "reply-media" }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-text" }),
    );
  });

  it("suppresses replyToId when threadId is set", async () => {
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverMatrixReplies({
      replies: [{ text: "hello|thread", replyToId: "reply-thread" }],
      roomId: "room:3",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "all",
      threadId: "thread-77",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
  });
});
