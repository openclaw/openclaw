import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionWriteLockModuleMock } from "../../test-utils/session-write-lock-module-mock.js";

const acquireSessionWriteLockReleaseMock = vi.hoisted(() => vi.fn(async () => {}));
const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ release: acquireSessionWriteLockReleaseMock })),
);

vi.mock("../session-write-lock.js", () =>
  buildSessionWriteLockModuleMock(
    () => vi.importActual<typeof import("../session-write-lock.js")>("../session-write-lock.js"),
    (params) => acquireSessionWriteLockMock(params),
  ),
);

let rewriteTranscriptEntriesInSessionFile: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionFile;
let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
let installSessionToolResultGuard: typeof import("../session-tool-result-guard.js").installSessionToolResultGuard;

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

function appendSessionMessages(
  sessionManager: SessionManager,
  messages: AppendMessage[],
): string[] {
  return messages.map((message) => sessionManager.appendMessage(message));
}

function createTextContent(text: string) {
  return [{ type: "text", text }];
}

function createReadRewriteSession(options?: { tailAssistantText?: string }) {
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "read file",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: createTextContent("x".repeat(8_000)),
      isError: false,
      timestamp: 3,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent(options?.tailAssistantText ?? "summarized"),
      timestamp: 4,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[2],
    tailAssistantEntryId: entryIds[3],
  };
}

function createExecRewriteSession() {
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "run tool",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: createTextContent("before rewrite"),
      isError: false,
      timestamp: 2,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent("summarized"),
      timestamp: 3,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[1],
  };
}

function createToolResultReplacement(toolName: string, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName,
    content: createTextContent(text),
    isError: false,
    timestamp,
  } as AgentMessage;
}

function findAssistantEntryByText(sessionManager: SessionManager, text: string) {
  return sessionManager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === text),
    );
}

beforeAll(async () => {
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInSessionFile, rewriteTranscriptEntriesInSessionManager } =
    await import("./transcript-rewrite.js"));
});

beforeEach(() => {
  acquireSessionWriteLockMock.mockClear();
  acquireSessionWriteLockReleaseMock.mockClear();
});

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it("branches from the first replaced message and re-appends the remaining suffix", () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
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
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();
    const summaryEntry = findAssistantEntryByText(sessionManager, "summarized");
    expect(summaryEntry).toBeDefined();
    sessionManager.appendLabelChange(summaryEntry!.id, "bookmark");

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
        },
      ],
    });

    expect(result.changed).toBe(true);
    const rewrittenSummaryEntry = findAssistantEntryByText(sessionManager, "summarized");
    expect(rewrittenSummaryEntry).toBeDefined();
    expect(sessionManager.getLabel(rewrittenSummaryEntry!.id)).toBe("bookmark");
    expect(sessionManager.getBranch().some((entry) => entry.type === "label")).toBe(true);
  });

  it("remaps compaction keep markers when rewritten entries change ids", () => {
    const {
      sessionManager,
      toolResultEntryId,
      tailAssistantEntryId: keptAssistantEntryId,
    } = createReadRewriteSession({ tailAssistantText: "keep me" });
    sessionManager.appendCompaction("summary", keptAssistantEntryId, 123);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
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
    const { sessionManager, toolResultEntryId } = createExecRewriteSession();
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
          message: createToolResultReplacement("exec", "[exact replacement]", 2),
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
    const { sessionManager, toolResultEntryId } = createExecRewriteSession();

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
              entryId: toolResultEntryId,
              message: createToolResultReplacement("exec", "[file_ref:file_abc]", 2),
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

// Regression suite for issue #66443 (refs #69208): overflow recovery / replay
// must not persist duplicate role=user messages, cloned compaction entries, or
// repeated openclaw:bootstrap-context:full custom entries to the session JSONL.
describe("rewriteTranscriptEntriesInSessionManager — #66443 dedupe invariant", () => {
  function getBranchEntries(sessionManager: SessionManager) {
    return sessionManager.getBranch();
  }

  function countMessagesByRole(sessionManager: SessionManager, role: AgentMessage["role"]): number {
    return getBranchMessages(sessionManager).filter((m) => m.role === role).length;
  }

  it("dedupes a polluted suffix: duplicate role=user messages collapse to one", () => {
    const sessionManager = SessionManager.inMemory();
    // Pollution pattern from the issue: the same user prompt re-appended N times
    // by a previous (buggy) recovery pass.
    const heartbeatPrompt = "Read HEARTBEAT.md if it exists (workspace context)...";
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 1 }),
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 2 }),
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 3 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("ack"),
        timestamp: 4,
      }),
    ]);

    // Rewrite the first user entry in place to force the suffix replay (which
    // is where the dedupe pass runs). Replacement is byte-equal so the user
    // intent is preserved.
    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: heartbeatPrompt, timestamp: 1 } as AgentMessage,
        },
      ],
    });

    expect(result.changed).toBe(true);
    expect(countMessagesByRole(sessionManager, "user")).toBe(1);
    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(branchMessages[0]).toMatchObject({ role: "user", content: heartbeatPrompt });
  });

  it("preserves distinct user messages with the same role", () => {
    // Two user messages with same content but different timestamps and metadata
    // are separate logical entries; we dedupe on (role + content), so they
    // collapse. This documents the chosen invariant: identity = role + content.
    // Distinct content with the same role must NOT collapse.
    const sessionManager = SessionManager.inMemory();
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: "first", timestamp: 1 }),
      asAppendMessage({ role: "user", content: "second", timestamp: 2 }),
      asAppendMessage({ role: "user", content: "third", timestamp: 3 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("ok"),
        timestamp: 4,
      }),
    ]);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: "first", timestamp: 1 } as AgentMessage,
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual([
      "first",
      "second",
      "third",
      "assistant",
    ]);
  });

  it("dedupes repeated openclaw:bootstrap-context:full custom entries", () => {
    const sessionManager = SessionManager.inMemory();
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: "hi", timestamp: 1 }),
    ]);
    const bootstrapData = { foo: "bar", n: 42 };
    sessionManager.appendCustomEntry("openclaw:bootstrap-context:full", bootstrapData);
    sessionManager.appendCustomEntry("openclaw:bootstrap-context:full", bootstrapData);
    sessionManager.appendCustomEntry("openclaw:bootstrap-context:full", bootstrapData);
    appendSessionMessages(sessionManager, [
      asAppendMessage({
        role: "assistant",
        content: createTextContent("done"),
        timestamp: 5,
      }),
    ]);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: "hi", timestamp: 1 } as AgentMessage,
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branch = getBranchEntries(sessionManager);
    const bootstrapEntries = branch.filter(
      (e) => e.type === "custom" && e.customType === "openclaw:bootstrap-context:full",
    );
    expect(bootstrapEntries.length).toBe(1);
  });

  it("dedupes cloned compaction entries (same summary + tokensBefore + firstKeptEntryId)", () => {
    const sessionManager = SessionManager.inMemory();
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: "anchor", timestamp: 1 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("kept"),
        timestamp: 2,
      }),
    ]);
    const keptId = ids[1];
    // Issue evidence: 12 cloned compactions written in rapid succession.
    sessionManager.appendCompaction("summary-A", keptId, 9000);
    sessionManager.appendCompaction("summary-A", keptId, 9000);
    sessionManager.appendCompaction("summary-A", keptId, 9000);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: "anchor", timestamp: 1 } as AgentMessage,
        },
      ],
    });

    expect(result.changed).toBe(true);
    const compactions = getBranchEntries(sessionManager).filter((e) => e.type === "compaction");
    expect(compactions.length).toBe(1);
    expect(compactions[0]).toMatchObject({ summary: "summary-A", tokensBefore: 9000 });
  });

  it("clean session with no duplicates is unchanged (no false positives)", () => {
    const sessionManager = SessionManager.inMemory();
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: "a", timestamp: 1 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("b"),
        timestamp: 2,
      }),
      asAppendMessage({ role: "user", content: "c", timestamp: 3 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("d"),
        timestamp: 4,
      }),
    ]);
    const before = getBranchMessages(sessionManager).map((m) => JSON.stringify(m));

    rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: "a", timestamp: 1 } as AgentMessage,
        },
      ],
    });

    const after = getBranchMessages(sessionManager).map((m) => JSON.stringify(m));
    expect(after).toEqual(before);
  });

  it("preserves order: first occurrence wins across [a, b, a, c, b]", () => {
    const sessionManager = SessionManager.inMemory();
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: "a", timestamp: 1 }),
      asAppendMessage({ role: "user", content: "b", timestamp: 2 }),
      asAppendMessage({ role: "user", content: "a", timestamp: 3 }),
      asAppendMessage({ role: "user", content: "c", timestamp: 4 }),
      asAppendMessage({ role: "user", content: "b", timestamp: 5 }),
    ]);

    rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: ids[0],
          message: { role: "user", content: "a", timestamp: 1 } as AgentMessage,
        },
      ],
    });

    const contents = getBranchMessages(sessionManager).map(
      (m) => (m as { content?: unknown }).content,
    );
    expect(contents).toEqual(["a", "b", "c"]);
  });
});

describe("rewriteTranscriptEntriesInSessionFile — #66443 integration", () => {
  it("collapses duplicate role=user entries when overflow recovery replays a polluted branch", async () => {
    const sessionFile = "/tmp/session-66443.jsonl";
    const sessionManager = SessionManager.inMemory();
    const heartbeatPrompt = "Read HEARTBEAT.md if it exists (workspace context)...";
    const ids = appendSessionMessages(sessionManager, [
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 1 }),
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 2 }),
      asAppendMessage({ role: "user", content: heartbeatPrompt, timestamp: 3 }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("ack"),
        timestamp: 4,
      }),
    ]);
    sessionManager.appendCustomEntry("openclaw:bootstrap-context:full", { hash: "deadbeef" });
    sessionManager.appendCustomEntry("openclaw:bootstrap-context:full", { hash: "deadbeef" });

    const openSpy = vi
      .spyOn(SessionManager, "open")
      .mockReturnValue(sessionManager as unknown as ReturnType<typeof SessionManager.open>);

    try {
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        sessionKey: "agent:main:main:heartbeat",
        request: {
          replacements: [
            {
              entryId: ids[0],
              message: { role: "user", content: heartbeatPrompt, timestamp: 1 } as AgentMessage,
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      const userMessages = getBranchMessages(sessionManager).filter((m) => m.role === "user");
      expect(userMessages.length).toBe(1);
      const bootstrapEntries = sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "openclaw:bootstrap-context:full");
      expect(bootstrapEntries.length).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});
