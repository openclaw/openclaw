// Telegram message deduplication tests
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendTelegramText } from "./delivery.send.js";

// Mock dependencies
vi.mock("node:crypto", () => ({
  default: {
    createHash: vi.fn(() => ({
      update: vi.fn(() => ({
        digest: vi.fn(() => "mock_hash_123"),
      })),
    })),
  },
}));

describe("Telegram Message Deduplication", () => {
  let mockBot: any;
  let mockRuntime: any;
  let mockChatId: string;
  let mockText: string;

  beforeEach(() => {
    // Mock Telegram bot
    mockBot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
    };

    // Mock runtime
    mockRuntime = {
      log: vi.fn(),
    };

    // Clear the dedup cache before each test
    const { sentMessages } = await import("./delivery.send.js");
    sentMessages?.clear?.();

    mockChatId = "123456";
    mockText = "Hello, world!";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should send the first message", async () => {
    await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining("telegram sendMessage ok")
    );
  });

  it("should skip duplicate messages within dedup window", async () => {
    // 第一次发送应该成功
    const messageId1 = await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);

    // 验证第一次发送
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(messageId1).toBe(1);

    // 第二次立即发送应该被跳过
    const messageId2 = await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);

    // 验证第二次发送被跳过（返回 -1）
    expect(messageId2).toBe(-1);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1); // 仍然只有1次
  });

  it("should allow same message after dedup window", async () => {
    // 第一次发送
    const messageId1 = await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);

    // 等待去重窗口过期（模拟时间流逝）
    // 注意：这需要修改 DEDUP_WINDOW_SECONDS 为 1 秒以加快测试
    await new Promise((resolve) => setTimeout(resolve, 11000));

    // 再次发送应该成功
    const messageId2 = await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(messageId1).toBe(1);
    expect(messageId2).toBe(2);
  });

  it("should not deduplicate different messages", async () => {
    const message1 = "Hello, world!";
    const message2 = "Hello, universe!";

    await sendTelegramText(mockBot, mockChatId, message1, mockRuntime);
    await sendTelegramText(mockBot, mockChatId, message2, mockRuntime);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("should not deduplicate messages to different chats", async () => {
    const chatId1 = "123456";
    const chatId2 = "789012";
    const text = "Same message";

    await sendTelegramText(mockBot, chatId1, text, mockRuntime);
    await sendTelegramText(mockBot, chatId2, text, mockRuntime);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("should handle edge case: empty text", async () => {
    const emptyText = "";

    await expect(
      sendTelegramText(mockBot, mockChatId, emptyText, mockRuntime)
    ).rejects.toThrow("empty");
  });

  it("should handle edge case: whitespace-only text", async () => {
    const whitespaceText = "   ";

    await expect(
      sendTelegramText(mockBot, mockChatId, whitespaceText, mockRuntime)
    ).rejects.toThrow("empty");
  });

  it("should cleanup old cache entries", async () => {
    // 发送一条消息
    await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);

    // 等待缓存过期（2 * 10秒 = 20秒）
    await new Promise((resolve) => setTimeout(resolve, 21000));

    // 再次发送应该成功（缓存已清理）
    const messageId = await sendTelegramText(mockBot, mockChatId, mockText, mockRuntime);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(messageId).toBe(2);
  });

  it("should handle concurrent duplicate sends", async () => {
    // 模拟并发发送相同的消息
    const promises = [
      sendTelegramText(mockBot, mockChatId, mockText, mockRuntime),
      sendTelegramText(mockBot, mockChatId, mockText, mockRuntime),
      sendTelegramText(mockBot, mockChatId, mockText, mockRuntime),
    ];

    const results = await Promise.all(promises);

    // 只有一个应该成功，其他应该被跳过
    const successfulSends = results.filter((r) => r !== -1);
    const skippedSends = results.filter((r) => r === -1);

    expect(successfulSends.length).toBe(1);
    expect(skippedSends.length).toBe(2);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
  });
});