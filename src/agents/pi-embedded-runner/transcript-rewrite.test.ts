import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const acquireSessionWriteLockReleaseMock = vi.hoisted(() => vi.fn(async () => {}));
const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ release: acquireSessionWriteLockReleaseMock })),
);

vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: (params: unknown) => acquireSessionWriteLockMock(params),
}));

let rewriteTranscriptEntriesInSessionFile: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionFile;
let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
let installSessionToolResultGuard: typeof import("../session-tool-result-guard.js").installSessionToolResultGuard;

async function loadFreshTranscriptRewriteModuleForTest() {
  vi.resetModules();
  vi.doMock("../session-write-lock.js", () => ({
    acquireSessionWriteLock: (params: unknown) => acquireSessionWriteLockMock(params),
  }));
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInSessionFile, rewriteTranscriptEntriesInSessionManager } =
    await import("./transcript-rewrite.js"));
}

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function getBranchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

beforeEach(async () => {
  acquireSessionWriteLockMock.mockClear();
  acquireSessionWriteLockReleaseMock.mockClear();
  await loadFreshTranscriptRewriteModuleForTest();
});

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it("branches from the first replaced message and re-appends the remaining suffix", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "read file",
        timestamp: 1,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(8_000) }],
        isError: false,
        timestamp: 3,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "summarized" }],
        timestamp: 4,
      }),
    );

    const toolResultEntry = sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(toolResultEntry).toBeDefined();

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntry!.id,
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "[externalized file_123]" }],
            isError: false,
            timestamp: 3,
          },
        },
      ],
    });

    expect(result).toMatchObject({
      changed: true,
      rewrittenEntries: 1,
    });
    expect(result.bytesFreed).toBeGreaterThan(0);

    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const rewrittenToolResult = branchMessages[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(rewrittenToolResult.content).toEqual([
      { type: "text", text: "[externalized file_123]" },
    ]);
  });

  it("preserves active-branch labels after rewritten entries are re-appended", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "read file",
        timestamp: 1,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    );
    const toolResultEntryId = sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(8_000) }],
        isError: false,
        timestamp: 3,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "summarized" }],
        timestamp: 4,
      }),
    );

    const summaryEntry = sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some((part) => part.type === "text" && part.text === "summarized"),
      );
    expect(summaryEntry).toBeDefined();
    sessionManager.appendLabelChange(summaryEntry!.id, "bookmark");

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "[externalized file_123]" }],
            isError: false,
            timestamp: 3,
          },
        },
      ],
    });

    expect(result.changed).toBe(true);
    const rewrittenSummaryEntry = sessionManager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some((part) => part.type === "text" && part.text === "summarized"),
      );
    expect(rewrittenSummaryEntry).toBeDefined();
    expect(sessionManager.getLabel(rewrittenSummaryEntry!.id)).toBe("bookmark");
    expect(sessionManager.getBranch().some((entry) => entry.type === "label")).toBe(true);
  });

  it("remaps compaction keep markers when rewritten entries change ids", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "read file",
        timestamp: 1,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    );
    const toolResultEntryId = sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(8_000) }],
        isError: false,
        timestamp: 3,
      }),
    );
    const keptAssistantEntryId = sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "keep me" }],
        timestamp: 4,
      }),
    );
    sessionManager.appendCompaction("summary", keptAssistantEntryId, 123);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "[externalized file_123]" }],
            isError: false,
            timestamp: 3,
          },
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branch = sessionManager.getBranch();
    const keptAssistantEntry = branch.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === "keep me"),
    );
    const compactionEntry = branch.find((entry) => entry.type === "compaction");

    expect(keptAssistantEntry).toBeDefined();
    expect(compactionEntry).toBeDefined();
    expect(compactionEntry?.firstKeptEntryId).toBe(keptAssistantEntry?.id);
    expect(compactionEntry?.firstKeptEntryId).not.toBe(keptAssistantEntryId);
  });

  it("bypasses persistence hooks when replaying rewritten messages", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "run tool",
        timestamp: 1,
      }),
    );
    const toolResultEntryId = sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "before rewrite" }],
        isError: false,
        timestamp: 2,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "summarized" }],
        timestamp: 3,
      }),
    );
    installSessionToolResultGuard(sessionManager, {
      transformToolResultForPersistence: (message) => ({
        ...(message as Extract<AgentMessage, { role: "toolResult" }>),
        content: [{ type: "text", text: "[hook transformed]" }],
      }),
      beforeMessageWriteHook: ({ message }) =>
        message.role === "assistant" ? { block: true } : undefined,
    });

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "exec",
            content: [{ type: "text", text: "[exact replacement]" }],
            isError: false,
            timestamp: 2,
          },
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
    expect((branchMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
      { type: "text", text: "[exact replacement]" },
    ]);
    expect(branchMessages[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "summarized" }],
    });
  });
});

describe("rewriteTranscriptEntriesInSessionFile", () => {
  it("emits transcript updates when the active branch changes", async () => {
    const sessionFile = "/tmp/session.jsonl";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "run tool",
        timestamp: 1,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "y".repeat(6_000) }],
        isError: false,
        timestamp: 2,
      }),
    );

    const toolResultEntry = sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(toolResultEntry).toBeDefined();

    const openSpy = vi
      .spyOn(SessionManager, "open")
      .mockReturnValue(sessionManager as unknown as ReturnType<typeof SessionManager.open>);
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        sessionKey: "agent:main:test",
        request: {
          replacements: [
            {
              entryId: toolResultEntry!.id,
              message: {
                role: "toolResult",
                toolCallId: "call_1",
                toolName: "exec",
                content: [{ type: "text", text: "[file_ref:file_abc]" }],
                isError: false,
                timestamp: 2,
              },
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({
        sessionFile,
      });
      expect(acquireSessionWriteLockReleaseMock).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile });

      const rewrittenToolResult = getBranchMessages(sessionManager)[1] as Extract<
        AgentMessage,
        { role: "toolResult" }
      >;
      expect(rewrittenToolResult.content).toEqual([{ type: "text", text: "[file_ref:file_abc]" }]);
    } finally {
      cleanup();
      openSpy.mockRestore();
    }
  });
});
