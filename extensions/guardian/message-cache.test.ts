import { describe, it, expect, beforeEach } from "vitest";
import {
  updateCache,
  getRecentTurns,
  getAllTurns,
  getSummary,
  updateSummary,
  markSummaryInProgress,
  markSummaryComplete,
  isSummaryInProgress,
  isSystemTrigger,
  getAgentSystemPrompt,
  setAgentSystemPrompt,
  hasSession,
  getTotalTurns,
  clearCache,
  cacheSize,
  extractConversationTurns,
} from "./message-cache.js";

const NO_FILTER = new Set<string>();

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

    it("appends trailing assistant messages to last turn", () => {
      const history = [
        { role: "user", content: "Check files" },
        { role: "assistant", content: "OK, executing" },
        { role: "assistant", content: "Now starting service" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(1);
      expect(turns[0].user).toBe("Check files");
      expect(turns[0].assistant).toContain("OK, executing");
      expect(turns[0].assistant).toContain("Now starting service");
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
            'Conversation info (untrusted metadata):\n```json\n{"message_id": "1778"}\n```\n\nCheck disk',
        },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([{ user: "Check disk", assistant: undefined }]);
    });

    it("resets assistant pairing after each user message", () => {
      const history = [
        { role: "assistant", content: "Reply A" },
        { role: "user", content: "Msg 1" },
        { role: "user", content: "Msg 2" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toEqual([
        { user: "Msg 1", assistant: "Reply A" },
        { user: "Msg 2", assistant: undefined },
      ]);
    });
  });

  describe("extractConversationTurns — toolResult handling", () => {
    it("includes toolResult messages as [tool: name] in assistant context", () => {
      const history = [
        { role: "user", content: "Deploy my project" },
        { role: "assistant", content: "Let me check your memory" },
        {
          role: "toolResult",
          toolName: "memory_search",
          content: [{ type: "text", text: "User prefers make build for deployment" }],
        },
        { role: "assistant", content: "I'll run make build" },
        { role: "user", content: "Yes go ahead" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(2);
      expect(turns[1].assistant).toContain("[tool: memory_search]");
      expect(turns[1].assistant).toContain("User prefers make build");
      expect(turns[1].assistant).toContain("I'll run make build");
    });

    it("handles toolResult with string content", () => {
      const history = [
        { role: "user", content: "Read the file" },
        {
          role: "toolResult",
          toolName: "read",
          content: "file contents here",
        },
        { role: "user", content: "Thanks" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns[1].assistant).toContain("[tool: read] file contents here");
    });

    it("handles toolResult with empty content", () => {
      const history = [
        { role: "user", content: "Test" },
        { role: "toolResult", toolName: "read", content: "" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(1);
      // Empty tool result should not add anything
      expect(turns[0].assistant).toBeUndefined();
    });

    it("handles toolResult with missing toolName", () => {
      const history = [
        { role: "user", content: "Test" },
        { role: "toolResult", content: "some result" },
      ];

      const turns = extractConversationTurns(history);
      expect(turns[0].assistant).toContain("[tool: unknown_tool]");
    });

    it("attaches trailing toolResults to last turn", () => {
      const history = [
        { role: "user", content: "Run something" },
        { role: "assistant", content: "Executing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: "command output here",
        },
      ];

      const turns = extractConversationTurns(history);
      expect(turns).toHaveLength(1);
      expect(turns[0].assistant).toContain("Executing");
      expect(turns[0].assistant).toContain("[tool: exec] command output here");
    });
  });

  describe("extractConversationTurns — context_tools filtering", () => {
    it("filters out tool results not in context_tools allowlist", () => {
      const contextTools = new Set(["memory_search"]);
      const history = [
        { role: "user", content: "Do things" },
        { role: "toolResult", toolName: "write_file", content: "wrote file" },
        { role: "toolResult", toolName: "memory_search", content: "memory result" },
        { role: "user", content: "ok" },
      ];

      const turns = extractConversationTurns(history, contextTools);
      expect(turns[1].assistant).toContain("[tool: memory_search]");
      expect(turns[1].assistant).not.toContain("write_file");
    });

    it("empty context_tools set includes all tool results", () => {
      const contextTools = new Set<string>();
      const history = [
        { role: "user", content: "Test" },
        { role: "toolResult", toolName: "write_file", content: "wrote file" },
      ];

      const turns = extractConversationTurns(history, contextTools);
      expect(turns[0].assistant).toContain("[tool: write_file]");
    });

    it("undefined context_tools includes all tool results", () => {
      const history = [
        { role: "user", content: "Test" },
        { role: "toolResult", toolName: "write_file", content: "wrote file" },
      ];

      const turns = extractConversationTurns(history, undefined);
      expect(turns[0].assistant).toContain("[tool: write_file]");
    });

    it("context_tools filtering is case-insensitive", () => {
      const contextTools = new Set(["memory_search"]);
      const history = [
        { role: "user", content: "Test" },
        { role: "toolResult", toolName: "Memory_Search", content: "result" },
      ];

      // toolName "Memory_Search" lowercased = "memory_search" which IS in the set
      const turns = extractConversationTurns(history, contextTools);
      expect(turns[0].assistant).toContain("[tool: Memory_Search]");
    });
  });

  describe("updateCache + getRecentTurns (lazy extraction)", () => {
    it("extracts conversation turns from history lazily", () => {
      const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "What is 2+2?" },
      ];

      updateCache("session-1", history, undefined, 3, NO_FILTER);

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

      updateCache("session-1", history, undefined, 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toHaveLength(3);
      expect(turns[0].user).toBe("Message 3");
      expect(turns[2].user).toBe("Message 5");
    });

    it("appends currentPrompt as the latest turn", () => {
      const history = [
        { role: "user", content: "Previous message" },
        { role: "assistant", content: "Response" },
      ];

      updateCache("session-1", history, "Current user prompt", 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([
        { user: "Previous message", assistant: "Response" },
        { user: "Current user prompt" },
      ]);
    });

    it("skips slash commands in currentPrompt", () => {
      updateCache("session-1", [], "/reset", 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([]);
    });

    it("skips empty currentPrompt", () => {
      updateCache("session-1", [{ role: "user", content: "Hello" }], "", 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Hello", assistant: undefined }]);
    });

    it("sees tool results added to live array after updateCache", () => {
      const history: unknown[] = [
        { role: "user", content: "Deploy my project" },
        { role: "assistant", content: "Let me search memory" },
      ];

      updateCache("session-1", history, undefined, 5, NO_FILTER);

      // Simulate agent loop adding toolResult after llm_input
      history.push({
        role: "toolResult",
        toolName: "memory_search",
        content: "User prefers make build",
      });
      history.push({
        role: "assistant",
        content: "Found deployment steps",
      });

      const turns = getRecentTurns("session-1");
      expect(turns).toHaveLength(1);
      expect(turns[0].assistant).toContain("[tool: memory_search]");
      expect(turns[0].assistant).toContain("Found deployment steps");
    });

    it("handles non-message objects gracefully", () => {
      const history = [null, undefined, 42, "not an object", { role: "user", content: "Works" }];

      updateCache("session-1", history as unknown[], undefined, 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Works", assistant: undefined }]);
    });

    it("replaces old cache on update but preserves summary", () => {
      updateCache("session-1", [{ role: "user", content: "Old message" }], undefined, 3, NO_FILTER);
      updateSummary("session-1", "User was working on deployment");

      updateCache("session-1", [{ role: "user", content: "New message" }], undefined, 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "New message", assistant: undefined }]);
      expect(getSummary("session-1")).toBe("User was working on deployment");
    });
  });

  describe("getAllTurns", () => {
    it("returns all turns without slicing", () => {
      const history = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Reply 2" },
        { role: "user", content: "Message 3" },
      ];

      updateCache("session-1", history, "Current prompt", 2, NO_FILTER);

      const allTurns = getAllTurns("session-1");
      expect(allTurns).toHaveLength(4); // 3 from history + 1 current prompt

      const recentTurns = getRecentTurns("session-1");
      expect(recentTurns).toHaveLength(2); // only last 2
    });
  });

  describe("summary storage", () => {
    it("stores and retrieves summary", () => {
      updateCache("session-1", [{ role: "user", content: "Test" }], undefined, 3, NO_FILTER);

      expect(getSummary("session-1")).toBeUndefined();

      updateSummary("session-1", "User is deploying a web app");
      expect(getSummary("session-1")).toBe("User is deploying a web app");
    });

    it("returns undefined for unknown session", () => {
      expect(getSummary("nonexistent")).toBeUndefined();
    });

    it("tracks summary in-progress state", () => {
      updateCache("session-1", [{ role: "user", content: "Test" }], undefined, 3, NO_FILTER);

      expect(isSummaryInProgress("session-1")).toBe(false);

      markSummaryInProgress("session-1");
      expect(isSummaryInProgress("session-1")).toBe(true);

      updateSummary("session-1", "Summary text");
      expect(isSummaryInProgress("session-1")).toBe(false);
    });

    it("markSummaryComplete resets in-progress without requiring a summary value", () => {
      updateCache("session-1", [{ role: "user", content: "Test" }], undefined, 3, NO_FILTER);

      markSummaryInProgress("session-1");
      expect(isSummaryInProgress("session-1")).toBe(true);

      markSummaryComplete("session-1");
      expect(isSummaryInProgress("session-1")).toBe(false);
      // Summary should remain undefined (not set by markSummaryComplete)
      expect(getSummary("session-1")).toBeUndefined();
    });

    it("preserves summary across cache updates", () => {
      updateCache("session-1", [{ role: "user", content: "Msg 1" }], undefined, 3, NO_FILTER);
      updateSummary("session-1", "Initial summary");

      updateCache("session-1", [{ role: "user", content: "Msg 2" }], undefined, 3, NO_FILTER);
      expect(getSummary("session-1")).toBe("Initial summary");
    });
  });

  describe("getTotalTurns", () => {
    it("counts total user messages including currentPrompt", () => {
      const history = [
        { role: "user", content: "Msg 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Msg 2" },
      ];

      const total = updateCache("session-1", history, "Current", 3, NO_FILTER);
      expect(total).toBe(3);
      expect(getTotalTurns("session-1")).toBe(3);
    });

    it("returns 0 for unknown session", () => {
      expect(getTotalTurns("nonexistent")).toBe(0);
    });
  });

  describe("isSystemTrigger", () => {
    it("detects heartbeat prompts", () => {
      updateCache("s1", [], "heartbeat", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);
    });

    it("detects heartbeat variants", () => {
      updateCache("s1", [], "HEARTBEAT_OK", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);

      updateCache("s2", [], "heartbeat_check", 3, NO_FILTER);
      expect(isSystemTrigger("s2")).toBe(true);
    });

    it("detects cron triggers", () => {
      updateCache("s1", [], "/cron daily-report", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);

      updateCache("s2", [], "[cron] generate pdf", 3, NO_FILTER);
      expect(isSystemTrigger("s2")).toBe(true);
    });

    it("detects ping/pong/health check", () => {
      updateCache("s1", [], "ping", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);

      updateCache("s2", [], "health_check", 3, NO_FILTER);
      expect(isSystemTrigger("s2")).toBe(true);
    });

    it("returns false for normal user messages", () => {
      updateCache("s1", [], "Write a report", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(false);
    });

    it("returns false for undefined/empty prompts", () => {
      updateCache("s1", [], undefined, 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(false);

      updateCache("s2", [], "", 3, NO_FILTER);
      expect(isSystemTrigger("s2")).toBe(false);
    });

    it("detects the real heartbeat prompt (contains HEARTBEAT_OK)", () => {
      const realPrompt =
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
      updateCache("s1", [], realPrompt, 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);
    });

    it("detects heartbeat prompts mentioning HEARTBEAT.md", () => {
      updateCache("s1", [], "Check HEARTBEAT.md for tasks", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);
    });

    it("returns false for unknown sessions", () => {
      expect(isSystemTrigger("nonexistent")).toBe(false);
    });

    it("preserves isSystemTrigger when subsequent llm_input has no prompt", () => {
      // Heartbeat fires with prompt → isSystemTrigger=true
      updateCache("s1", [], "heartbeat", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);

      // Agent loop continues without prompt (tool result processed) → should preserve true
      updateCache("s1", [{ role: "user", content: "heartbeat" }], undefined, 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);
    });

    it("resets isSystemTrigger when a real user message arrives", () => {
      updateCache("s1", [], "heartbeat", 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(true);

      // Real user message arrives → should reset to false
      updateCache(
        "s1",
        [{ role: "user", content: "heartbeat" }],
        "Deploy my project",
        3,
        NO_FILTER,
      );
      expect(isSystemTrigger("s1")).toBe(false);
    });

    it("does not inherit system trigger from a different session's history", () => {
      // Fresh session with no prompt → should be false (not inherited)
      updateCache("s1", [], undefined, 3, NO_FILTER);
      expect(isSystemTrigger("s1")).toBe(false);
    });
  });

  describe("getRecentTurns filters system turns", () => {
    it("filters out heartbeat turns from recent context", () => {
      const history = [
        { role: "user", content: "Hello, help me with code" },
        { role: "assistant", content: [{ type: "text", text: "Sure!" }] },
        { role: "user", content: "HEARTBEAT_OK" },
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
        { role: "user", content: "Now fix the bug" },
      ];
      updateCache("s1", history, undefined, 10, NO_FILTER);
      const turns = getRecentTurns("s1");
      // The "HEARTBEAT_OK" user turn is filtered out.
      // "Sure!" was paired with the heartbeat turn so it's also dropped.
      // "HEARTBEAT_OK" assistant reply gets attached to "Now fix the bug".
      expect(turns).toEqual([
        { user: "Hello, help me with code", assistant: undefined },
        { user: "Now fix the bug", assistant: "HEARTBEAT_OK" },
      ]);
    });

    it("filters out real heartbeat prompt turns", () => {
      const heartbeatPrompt =
        "Read HEARTBEAT.md if it exists (workspace context). If nothing needs attention, reply HEARTBEAT_OK.";
      const history = [
        { role: "user", content: "Deploy the app" },
        { role: "assistant", content: [{ type: "text", text: "Deploying..." }] },
        { role: "user", content: heartbeatPrompt },
      ];
      updateCache("s1", history, undefined, 10, NO_FILTER);
      const turns = getRecentTurns("s1");
      // "Deploying..." was paired with the heartbeat turn, so it's dropped
      expect(turns).toEqual([{ user: "Deploy the app", assistant: undefined }]);
    });

    it("filters ping/pong turns", () => {
      const history = [
        { role: "user", content: "ok" },
        { role: "user", content: "Do something" },
      ];
      updateCache("s1", history, undefined, 10, NO_FILTER);
      const turns = getRecentTurns("s1");
      expect(turns).toEqual([{ user: "Do something", assistant: undefined }]);
    });
  });

  describe("cache isolation", () => {
    it("keeps sessions isolated", () => {
      updateCache("session-a", [{ role: "user", content: "Message A" }], undefined, 3, NO_FILTER);
      updateCache("session-b", [{ role: "user", content: "Message B" }], undefined, 3, NO_FILTER);

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
      updateCache("s1", [{ role: "user", content: "hi" }], undefined, 3, NO_FILTER);
      expect(cacheSize()).toBe(1);
      updateCache("s2", [{ role: "user", content: "hi" }], undefined, 3, NO_FILTER);
      expect(cacheSize()).toBe(2);
    });
  });

  describe("clearCache", () => {
    it("empties the cache", () => {
      updateCache("s1", [{ role: "user", content: "hi" }], undefined, 3, NO_FILTER);
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
            'Conversation info (untrusted metadata):\n```json\n{"message_id": "1778"}\n```\n\nCheck disk',
        },
      ];

      updateCache("session-1", history, undefined, 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Check disk", assistant: undefined }]);
    });

    it("strips metadata from currentPrompt", () => {
      updateCache(
        "session-1",
        [],
        'Conversation info (untrusted metadata):\n```json\n{"message_id": "1800"}\n```\n\nHello world',
        3,
        NO_FILTER,
      );

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([{ user: "Hello world", assistant: undefined }]);
    });

    it("handles messages with only metadata (no actual content)", () => {
      const history = [
        {
          role: "user",
          content: 'Conversation info (untrusted metadata):\n```json\n{"message_id": "1"}\n```',
        },
      ];

      updateCache("session-1", history, undefined, 3, NO_FILTER);

      const turns = getRecentTurns("session-1");
      expect(turns).toEqual([]);
    });
  });

  describe("agentSystemPrompt", () => {
    it("starts as undefined for new sessions", () => {
      updateCache("s1", [{ role: "user", content: "test" }], undefined, 3, NO_FILTER);
      expect(getAgentSystemPrompt("s1")).toBeUndefined();
    });

    it("is set via setAgentSystemPrompt", () => {
      updateCache("s1", [{ role: "user", content: "test" }], undefined, 3, NO_FILTER);
      setAgentSystemPrompt("s1", "You are a helpful assistant.");
      expect(getAgentSystemPrompt("s1")).toBe("You are a helpful assistant.");
    });

    it("is not overwritten on subsequent setAgentSystemPrompt calls", () => {
      updateCache("s1", [{ role: "user", content: "test" }], undefined, 3, NO_FILTER);
      setAgentSystemPrompt("s1", "First system prompt");
      setAgentSystemPrompt("s1", "Second system prompt");
      expect(getAgentSystemPrompt("s1")).toBe("First system prompt");
    });

    it("persists across updateCache calls", () => {
      updateCache("s1", [{ role: "user", content: "msg1" }], undefined, 3, NO_FILTER);
      setAgentSystemPrompt("s1", "Cached prompt");
      updateCache("s1", [{ role: "user", content: "msg2" }], undefined, 3, NO_FILTER);
      expect(getAgentSystemPrompt("s1")).toBe("Cached prompt");
    });

    it("returns undefined for unknown sessions", () => {
      expect(getAgentSystemPrompt("nonexistent")).toBeUndefined();
    });
  });

  describe("hasSession", () => {
    it("returns true for existing sessions", () => {
      updateCache("s1", [{ role: "user", content: "test" }], undefined, 3, NO_FILTER);
      expect(hasSession("s1")).toBe(true);
    });

    it("returns false for unknown sessions", () => {
      expect(hasSession("nonexistent")).toBe(false);
    });

    it("returns false after clearCache", () => {
      updateCache("s1", [{ role: "user", content: "test" }], undefined, 3, NO_FILTER);
      clearCache();
      expect(hasSession("s1")).toBe(false);
    });
  });
});
