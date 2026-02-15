import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: { shouldLogVerbose: () => false },
    channel: {
      text: {
        chunkText: (text: string, limit: number) => {
          // Simple chunking for tests
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length ? chunks : [text];
        },
      },
    },
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  createReplyPrefixOptions: vi.fn(() => ({
    onModelSelected: vi.fn(),
    responsePrefix: undefined,
  })),
}));

const mockSendInfoflowMessage = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendInfoflowMessage: mockSendInfoflowMessage,
}));

import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInfoflowReplyDispatcher", () => {
  beforeEach(() => {
    mockSendInfoflowMessage.mockReset();
    mockSendInfoflowMessage.mockResolvedValue({ ok: true, messageId: "msg-1" });
  });

  it("returns dispatcherOptions with deliver and onError", () => {
    const result = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
    });

    expect(result.dispatcherOptions).toBeDefined();
    expect(typeof result.dispatcherOptions.deliver).toBe("function");
    expect(typeof result.dispatcherOptions.onError).toBe("function");
    expect(result.replyOptions).toBeDefined();
  });

  it("deliver sends message via sendInfoflowMessage", async () => {
    const statusSink = vi.fn();
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
      statusSink,
    });

    await dispatcherOptions.deliver({ text: "Hello world" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello world" }],
      accountId: "acc-1",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });

  it("deliver skips empty text", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
    });

    await dispatcherOptions.deliver({ text: "" });
    await dispatcherOptions.deliver({ text: "   " });

    expect(mockSendInfoflowMessage).not.toHaveBeenCalled();
  });

  it("deliver adds AT content for group messages (first chunk only)", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:12345",
      atOptions: { atUserIds: ["user1", "user2"] },
    });

    await dispatcherOptions.deliver({ text: "Hello" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:12345",
      contents: [
        { type: "markdown", content: "Hello" },
        { type: "at", content: "user1,user2" },
      ],
      accountId: "acc-1",
    });

    // Test atAll variant
    mockSendInfoflowMessage.mockClear();
    const { dispatcherOptions: opts2 } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:99999",
      atOptions: { atAll: true },
    });

    await opts2.deliver({ text: "Announcement" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:99999",
      contents: [
        { type: "markdown", content: "Announcement" },
        { type: "at", content: "all" },
      ],
      accountId: "acc-1",
    });
  });
});
