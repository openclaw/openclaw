import { describe, it, expect, beforeEach } from "vitest";
import {
  updateCache,
  getRecentTurns,
  clearCache,
  cacheSize,
  extractConversationTurns,
} from "./message-cache.js";

describe("message-cache", () => {
  beforeEach(() => {
    clearCache();
  });

  describe("extractConversationTurns", () => {
    it("pairs user messages with preceding assistant replies", () => {
      const history = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi! How can I help?" },
        { role: "user", content: "Delete those files" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([
        { user: "Hello", assistant: undefined },
        { user: "Delete those files", assistant: "Hi! How can I help?" },
      ]);
    });

    it("handles confirmation flow: assistant proposes, user confirms", () => {
      const history = [
        { role: "user", content: "Clean up temp files" },
        { role: "assistant", content: "I found 5 old temp files. Should I delete them?" },
        { role: "user", content: "Yes" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([
        { user: "Clean up temp files", assistant: undefined },
        {
          user: "Yes",
          assistant: "I found 5 old temp files. Should I delete them?",
        },
      ]);
    });

    it("merges multiple assistant messages before a user message", () => {
      const history = [
        { role: "assistant", content: "Let me check..." },
        { role: "assistant", content: "Found 5 old files. Should I delete them?" },
        { role: "user", content: "Yes" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([
        {
          user: "Yes",
          assistant: "Let me check...\nFound 5 old files. Should I delete them?",
        },
      ]);
    });

    it("handles user messages without preceding assistant", () => {
      const history = [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello world" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([{ user: "Hello world", assistant: undefined }]);
    });

    it("skips slash commands in user messages", () => {
      const history = [
        { role: "user", content: "/reset" },
        { role: "assistant", content: "Session reset." },
        { role: "user", content: "Hello" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([{ user: "Hello", assistant: "Session reset." }]);
    });

    it("preserves long assistant messages without truncation", () => {
      const longText = "x".repeat(2000);
      const history = [
        { role: "assistant", content: longText },
        { role: "user", content: "Ok" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns[0].assistant).toBe(longText);
    });

    it("preserves full merged content from multiple assistant messages", () => {
      const history = [
        { role: "assistant", content: "a".repeat(500) },
        { role: "assistant", content: "b".repeat(500) },
        { role: "user", content: "Ok" },
      ];

      const turns = extractConversationTurns(history);
      // Merged = 500 a's + \n + 500 b's = 1001 chars, fully preserved
      expect(turns[0].assistant).toBe("a".repeat(500) + "\n" + "b".repeat(500));
    });

    it("appends trailing assistant messages to last turn", () => {
      const history = [
        { role: "user", content: "用subagent来检查文件" },
        { role: "assistant", content: "好的，我来执行" },
        { role: "assistant", content: "接下来我要启动服务" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(1);
      expect(turns[0].user).toBe("用subagent来检查文件");
      // Both trailing assistant messages are appended to the last turn
      expect(turns[0].assistant).toContain("好的，我来执行");
      expect(turns[0].assistant).toContain("接下来我要启动服务");
    });

    it("appends trailing assistant messages after multiple turns", () => {
      const history = [
        { role: "assistant", content: "What can I help you with?" },
        { role: "user", content: "Check disk" },
        { role: "assistant", content: "Sure, checking..." },
        { role: "user", content: "Also clean up temp" },
        { role: "assistant", content: "I'll run df first" },
        { role: "assistant", content: "Now cleaning temp files" },
        { role: "assistant", content: "Found 5 files to delete" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(2);
      expect(turns[0].user).toBe("Check disk");
      expect(turns[0].assistant).toBe("What can I help you with?");
      expect(turns[1].user).toBe("Also clean up temp");
      // The last turn should have all 3 trailing assistant messages
      expect(turns[1].assistant).toContain("Sure, checking...");
      expect(turns[1].assistant).toContain("I'll run df first");
      expect(turns[1].assistant).toContain("Now cleaning temp files");
      expect(turns[1].assistant).toContain("Found 5 files to delete");
    });

    it("ignores trailing assistant messages when there are no turns", () => {
      const history = [
        { role: "assistant", content: "Hello" },
        { role: "assistant", content: "I'm doing something" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(0);
    });

    it("handles multimodal assistant content", () => {
      const history = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here is the result" },
            { type: "tool_use", id: "tool-1", name: "exec" },
          ],
        },
        { role: "user", content: "Thanks" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([{ user: "Thanks", assistant: "Here is the result" }]);
    });

    it("strips channel metadata from user messages", () => {
      const history = [
        {
          role: "user",
          content:
            'Conversation info (untrusted metadata):\n```json\n{"message_id": "1778"}\n```\n\n查看磁盘占用',
        },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([{ user: "查看磁盘占用", assistant: undefined }]);
    });

    it("resets assistant pairing after each user message", () => {
      const history = [
        { role: "assistant", content: "Reply A" },
        { role: "user", content: "Msg 1" },
        // No assistant reply between these two user messages
        { role: "user", content: "Msg 2" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([
        { user: "Msg 1", assistant: "Reply A" },
        { user: "Msg 2", assistant: undefined },
      ]);
    });
  });

  describe("updateCache + getRecentTurns", () => {
    it("extracts conversation turns from history", () => {
      const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "What is 2+2?" },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([
        { user: "Hello world", assistant: undefined },
        { user: "What is 2+2?", assistant: "Hi there!" },
      ]);
    });

    it("keeps only the last N turns", () => {
      const history = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Reply 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Reply 3" },
        { role: "user", content: "Message 4" },
        { role: "assistant", content: "Reply 4" },
        { role: "user", content: "Message 5" },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toHaveLength(3);
      expect(turns[0].user).toBe("Message 3");
      expect(turns[2].user).toBe("Message 5");
    });

    it("handles multimodal (array) content", () => {
      const history = [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "What is in this image?" },
          ],
        },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "What is in this image?", assistant: undefined }]);
    });

    it("skips slash commands", () => {
      const history = [
        { role: "user", content: "/reset" },
        { role: "user", content: "Hello" },
        { role: "user", content: "/new" },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Hello", assistant: undefined }]);
    });

    it("skips empty or whitespace-only content", () => {
      const history = [
        { role: "user", content: "" },
        { role: "user", content: "   " },
        { role: "user", content: "Valid message" },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Valid message", assistant: undefined }]);
    });

    it("handles non-message objects gracefully", () => {
      const history = [null, undefined, 42, "not an object", { role: "user", content: "Works" }];

      updateCache("session-1", history as unknown[], undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Works", assistant: undefined }]);
    });

    it("replaces old cache on update", () => {
      updateCache("session-1", [{ role: "user", content: "Old message" }], undefined, 3);
      updateCache("session-1", [{ role: "user", content: "New message" }], undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "New message", assistant: undefined }]);
    });

    it("appends currentPrompt as the latest turn", () => {
      const history = [
        { role: "user", content: "Previous message" },
        { role: "assistant", content: "Response" },
      ];

      updateCache("session-1", history, "Current user prompt", 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([
        { user: "Previous message", assistant: "Response" },
        { user: "Current user prompt" },
      ]);
    });

    it("currentPrompt appears AFTER history turns", () => {
      const history = [
        { role: "user", content: "Msg 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Msg 2" },
      ];

      updateCache("session-1", history, "Latest prompt", 5);

      const turns = getRecentTurns("session-1");
      expect(turns).toHaveLength(3);
      expect(turns[0]).toEqual({ user: "Msg 1", assistant: undefined });
      expect(turns[1]).toEqual({ user: "Msg 2", assistant: "Reply 1" });
      expect(turns[2]).toEqual({ user: "Latest prompt", assistant: undefined });
    });

    it("respects maxTurns limit including currentPrompt", () => {
      const history = [
        { role: "user", content: "Msg 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Msg 2" },
        { role: "assistant", content: "Reply 2" },
        { role: "user", content: "Msg 3" },
      ];

      updateCache("session-1", history, "Latest prompt", 3);

      const turns = getRecentTurns("session-1");
      // Should keep the 3 most recent turns
      expect(turns).toHaveLength(3);
      expect(turns[0].user).toBe("Msg 2");
      expect(turns[2].user).toBe("Latest prompt");
    });

    it("skips slash commands in currentPrompt", () => {
      updateCache("session-1", [], "/reset", 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([]);
    });

    it("skips empty currentPrompt", () => {
      updateCache("session-1", [{ role: "user", content: "Hello" }], "", 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Hello", assistant: undefined }]);
    });
  });

  describe("cache isolation", () => {
    it("keeps sessions isolated", () => {
      updateCache("session-a", [{ role: "user", content: "Message A" }], undefined, 3);
      updateCache("session-b", [{ role: "user", content: "Message B" }], undefined, 3);

      expect(getRecentTurns("session-a")).toEqual([{ user: "Message A", assistant: undefined }]);
      expect(getRecentTurns("session-b")).toEqual([{ user: "Message B", assistant: undefined }]);
    });

    it("returns empty array for unknown sessions", () => {
      expect(getRecentTurns("nonexistent")).toEqual([]);
    });
  });

  describe("cacheSize", () => {
    it("reports the correct size", () => {
      expect(cacheSize()).toBe(0);
      updateCache("s1", [{ role: "user", content: "hi" }], undefined, 3);
      expect(cacheSize()).toBe(1);
      updateCache("s2", [{ role: "user", content: "hi" }], undefined, 3);
      expect(cacheSize()).toBe(2);
    });
  });

  describe("clearCache", () => {
    it("empties the cache", () => {
      updateCache("s1", [{ role: "user", content: "hi" }], undefined, 3);
      clearCache();
      expect(cacheSize()).toBe(0);
      expect(getRecentTurns("s1")).toEqual([]);
    });
  });

  describe("channel metadata stripping", () => {
    it("strips Telegram conversation metadata from history messages", () => {
      const history = [
        {
          role: "user",
          content:
            'Conversation info (untrusted metadata):\n```json\n{"message_id": "1778", "sender_id": "8545994198", "sender": "8545994198"}\n```\n\n查看磁盘占用',
        },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "查看磁盘占用", assistant: undefined }]);
    });

    it("strips metadata from currentPrompt", () => {
      updateCache(
        "session-1",
        [],
        'Conversation info (untrusted metadata):\n```json\n{"message_id": "1800", "sender": "user123"}\n```\n\nHello world',
        3,
      );

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Hello world", assistant: undefined }]);
    });

    it("strips metadata from multimodal (array) content", () => {
      const history = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Conversation info (untrusted metadata):\n```json\n{"message_id": "42"}\n```\n\nDescribe this image',
            },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Describe this image", assistant: undefined }]);
    });

    it("handles messages with only metadata (no actual content)", () => {
      const history = [
        {
          role: "user",
          content: 'Conversation info (untrusted metadata):\n```json\n{"message_id": "1"}\n```',
        },
      ];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      // Should be empty since stripping metadata leaves nothing
      expect(turns).toEqual([]);
    });

    it("preserves messages without metadata", () => {
      const history = [{ role: "user", content: "Normal message without metadata" }];

      updateCache("session-1", history, undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Normal message without metadata", assistant: undefined }]);
    });

    it("strips multiple metadata blocks in one message", () => {
      const content =
        'Conversation info (untrusted metadata):\n```json\n{"a": 1}\n```\n\nSome text\n\nConversation info (untrusted metadata):\n```json\n{"b": 2}\n```\n\nActual message';

      updateCache("session-1", [{ role: "user", content }], undefined, 3);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Some text\n\nActual message", assistant: undefined }]);
    });

    it("skips currentPrompt that becomes a slash command after stripping", () => {
      updateCache(
        "session-1",
        [],
        'Conversation info (untrusted metadata):\n```json\n{"message_id": "1"}\n```\n\n/reset',
        3,
      );

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([]);
    });
  });
});
