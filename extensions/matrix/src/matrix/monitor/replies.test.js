import { beforeEach, describe, expect, it, vi } from "vitest";
const sendMessageMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "mx-1" }));
vi.mock("../send.js", () => ({
  sendMessageMatrix: (to, message, opts) => sendMessageMatrixMock(to, message, opts)
}));
import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";
describe("deliverMatrixReplies", () => {
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn(() => "code");
  const convertMarkdownTablesMock = vi.fn((text) => text);
  const resolveChunkModeMock = vi.fn(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text) => [text]);
  const runtimeStub = {
    config: {
      loadConfig: () => loadConfigMock()
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => resolveMarkdownTableModeMock(),
        convertMarkdownTables: (text) => convertMarkdownTablesMock(text),
        resolveChunkMode: () => resolveChunkModeMock(),
        chunkMarkdownTextWithMode: (text) => chunkMarkdownTextWithModeMock(text)
      }
    },
    logging: {
      shouldLogVerbose: () => false
    }
  };
  const runtimeEnv = {
    log: vi.fn(),
    error: vi.fn()
  };
  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
    chunkMarkdownTextWithModeMock.mockImplementation((text) => [text]);
  });
  it("keeps replyToId on first reply only when replyToMode=first", async () => {
    chunkMarkdownTextWithModeMock.mockImplementation((text) => text.split("|"));
    await deliverMatrixReplies({
      replies: [
        { text: "first-a|first-b", replyToId: "reply-1" },
        { text: "second", replyToId: "reply-2" }
      ],
      roomId: "room:1",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "first"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: void 0 })
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: void 0 })
    );
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: void 0, threadId: void 0 })
    );
  });
  it("keeps replyToId on every reply when replyToMode=all", async () => {
    await deliverMatrixReplies({
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-media",
          audioAsVoice: true
        },
        { text: "plain", replyToId: "reply-text" }
      ],
      roomId: "room:2",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "all"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]).toEqual([
      "room:2",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg", replyToId: "reply-media" })
    ]);
    expect(sendMessageMatrixMock.mock.calls[1]).toEqual([
      "room:2",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/b.jpg", replyToId: "reply-media" })
    ]);
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-text" })
    );
  });
  it("skips reasoning-only replies with Reasoning prefix", async () => {
    await deliverMatrixReplies({
      replies: [
        { text: "Reasoning:\nThe user wants X because Y.", replyToId: "r1" },
        { text: "Here is the answer.", replyToId: "r2" }
      ],
      roomId: "room:reason",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "first"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("Here is the answer.");
  });
  it("skips reasoning-only replies with thinking tags", async () => {
    await deliverMatrixReplies({
      replies: [
        { text: "<thinking>internal chain of thought</thinking>", replyToId: "r1" },
        { text: "  <think>more reasoning</think>  ", replyToId: "r2" },
        { text: "<antthinking>hidden</antthinking>", replyToId: "r3" },
        { text: "Visible reply", replyToId: "r4" }
      ],
      roomId: "room:tags",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "all"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("Visible reply");
  });
  it("delivers all replies when none are reasoning-only", async () => {
    await deliverMatrixReplies({
      replies: [
        { text: "First answer", replyToId: "r1" },
        { text: "Second answer", replyToId: "r2" }
      ],
      roomId: "room:normal",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "all"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
  });
  it("suppresses replyToId when threadId is set", async () => {
    chunkMarkdownTextWithModeMock.mockImplementation((text) => text.split("|"));
    await deliverMatrixReplies({
      replies: [{ text: "hello|thread", replyToId: "reply-thread" }],
      roomId: "room:3",
      client: {},
      runtime: runtimeEnv,
      textLimit: 4e3,
      replyToMode: "all",
      threadId: "thread-77"
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: void 0, threadId: "thread-77" })
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: void 0, threadId: "thread-77" })
    );
  });
});
