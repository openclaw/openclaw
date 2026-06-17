// Transcript rewrite tests cover in-memory and persisted JSONL rewrites for
// tool-result externalization, labels, compaction markers, and write locks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
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
let rewriteTranscriptEntriesInRuntimeTranscript: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInRuntimeTranscript;
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

function getMessageContent(message: AgentMessage): unknown {
  return "content" in message ? message.content : undefined;
}

function createReadRewriteSession(options?: { tailAssistantText?: string }) {
  // Read rewrite fixtures include a suffix assistant turn so branch rewrites
  // must re-append downstream entries after replacing the tool result.
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

function requireValue<T>(value: T | undefined, label: string): T {
  // Fail with a labeled invariant instead of letting optional entries produce
  // weak assertions later in transcript-branch tests.
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

beforeAll(async () => {
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({
    rewriteTranscriptEntriesInRuntimeTranscript,
    rewriteTranscriptEntriesInSessionFile,
    rewriteTranscriptEntriesInSessionManager,
  } = await import("./transcript-rewrite.js"));
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

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);
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
    const summaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "summary entry",
    );
    sessionManager.appendLabelChange(summaryEntry.id, "bookmark");

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
    const rewrittenSummaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "rewritten summary entry",
    );
    expect(sessionManager.getLabel(rewrittenSummaryEntry.id)).toBe("bookmark");
    expect(sessionManager.getBranch().map((entry) => entry.type)).toContain("label");
  });

  it("remaps compaction keep markers when rewritten entries change ids", () => {
    // Re-appending entries changes ids; compaction records must follow the new
    // first-kept entry or future branch reconstruction points at stale ids.
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

    const keptAssistant = requireValue(keptAssistantEntry, "kept assistant entry");
    const compaction = requireValue(compactionEntry, "compaction entry");
    if (compaction.type !== "compaction") {
      throw new Error("expected compaction entry");
    }
    expect(compaction.firstKeptEntryId).toBe(keptAssistant.id);
    expect(compaction.firstKeptEntryId).not.toBe(keptAssistantEntryId);
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
    const replayedAssistant = branchMessages[2];
    if (!replayedAssistant || replayedAssistant.role !== "assistant") {
      throw new Error("expected rewritten suffix to replay the assistant summary");
    }
    expect(replayedAssistant.content).toEqual([{ type: "text", text: "summarized" }]);
  });
});

describe("rewriteTranscriptEntriesInSessionFile", () => {
  it("does not create session metadata for missing runtime transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-runtime-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{}\n", "utf8");

    const result = await rewriteTranscriptEntriesInRuntimeTranscript({
      scope: {
        agentId: "main",
        sessionId: "missing-session",
        sessionKey: "agent:main:missing",
        storePath,
      },
      request: { replacements: [] },
    });

    expect(result.changed).toBe(false);
    expect(await fs.readFile(storePath, "utf8")).toBe("{}\n");
  });

  it("rewrites runtime transcripts through scoped session identity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-runtime-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionManager = SessionManager.create(dir, dir);
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
    const sessionFile = requireString(sessionManager.getSessionFile(), "persisted session file");
    const resolvedSessionFile = await fs.realpath(sessionFile);
    const sessionId = path.basename(sessionFile, ".jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:test": {
          sessionFile,
          sessionId,
          updatedAt: 10,
        },
      }),
      "utf8",
    );
    const toolResultEntryId = entryIds[1];
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInRuntimeTranscript({
        scope: {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:test",
          storePath,
        },
        request: {
          replacements: [
            {
              entryId: toolResultEntryId,
              message: createToolResultReplacement("exec", "[runtime rewrite]", 2),
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({
        sessionFile: resolvedSessionFile,
        staleMs: 1_800_000,
        timeoutMs: 60_000,
        maxHoldMs: 300_000,
      });
      expect(acquireSessionWriteLockReleaseMock).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        agentId: "main",
        sessionFile: resolvedSessionFile,
        sessionKey: "agent:main:test",
      });

      const rewrittenSession = SessionManager.open(sessionFile);
      const branchMessages = getBranchMessages(rewrittenSession);
      expect(branchMessages.map((message) => message.role)).toEqual([
        "user",
        "toolResult",
        "assistant",
      ]);
      expect((branchMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
        { type: "text", text: "[runtime rewrite]" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("aborts under the write lock when the active suffix contains an unexpected entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-guard-"));
    const sessionManager = SessionManager.create(dir, dir);
    const entryIds = appendSessionMessages(sessionManager, [
      asAppendMessage({
        role: "user",
        content: "start",
        timestamp: 1,
      }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("source reply media"),
        timestamp: 2,
      }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("source reply text"),
        timestamp: 3,
      }),
      asAppendMessage({
        role: "user",
        content: "concurrent append",
        timestamp: 4,
      }),
    ]);
    const sessionFile = requireString(sessionManager.getSessionFile(), "persisted session file");
    const mediaEntryId = entryIds[1];
    const textEntryId = entryIds[2];
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        sessionKey: "agent:main:test",
        request: {
          allowedRewriteSuffixEntryIds: [mediaEntryId, textEntryId],
          replacements: [
            {
              entryId: mediaEntryId,
              message: asAppendMessage({
                role: "assistant",
                content: createTextContent("rewritten source reply media"),
                timestamp: 2,
              }) as AgentMessage,
            },
          ],
        },
      });

      expect(result).toMatchObject({
        changed: false,
        reason: "rewrite suffix guard failed",
      });
      expect(listener).not.toHaveBeenCalled();

      const unchangedSession = SessionManager.open(sessionFile);
      expect(getBranchMessages(unchangedSession).map(getMessageContent)).toEqual([
        "start",
        createTextContent("source reply media"),
        createTextContent("source reply text"),
        "concurrent append",
      ]);
    } finally {
      cleanup();
    }
  });

  it("rewrites a guarded side branch and restores the active navigation state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-side-"));
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-side-rewrite",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "active root", timestamp: 1 },
        },
        {
          type: "message",
          id: "side-mirror",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: {
            role: "assistant",
            content: createTextContent("source reply before rewrite"),
            timestamp: 2,
          },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-mirror",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "side-mirror",
          appendMode: "side",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const result = await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      sessionKey: "agent:main:test",
      request: {
        allowedRewriteSuffixEntryIds: ["side-mirror"],
        replacements: [
          {
            entryId: "side-mirror",
            message: asAppendMessage({
              role: "assistant",
              content: createTextContent("source reply after rewrite"),
              timestamp: 2,
            }) as AgentMessage,
          },
        ],
      },
    });

    expect(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
    const records = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            targetId?: string | null;
            appendParentId?: string | null;
            appendMode?: "side";
            message?: AgentMessage;
          },
      );
    const rewrittenSideEntry = records.findLast(
      (entry) =>
        entry.type === "message" &&
        JSON.stringify(entry.message).includes("source reply after rewrite"),
    );
    expect(rewrittenSideEntry).toMatchObject({ parentId: "active-root" });
    expect(records.at(-1)).toMatchObject({
      type: "leaf",
      parentId: rewrittenSideEntry?.id,
      targetId: "active-root",
      appendParentId: "side-mirror",
      appendMode: "side",
    });

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(getBranchMessages(reopened).map(getMessageContent)).toEqual(["active root"]);
    const nextId = reopened.appendMessage(
      asAppendMessage({ role: "user", content: "active continuation", timestamp: 3 }),
    );
    expect(reopened.getEntry(nextId)).toMatchObject({ parentId: "active-root" });
    expect(reopened.getEntry(nextId)).not.toHaveProperty("appendMode");
  });

  it("rejects a rewrite batch split across active and side branches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-mixed-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const records = [
      {
        type: "session",
        version: 3,
        id: "session-mixed-rewrite",
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        type: "message",
        id: "active-mirror",
        parentId: "root",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: createTextContent("active"), timestamp: 2 },
      },
      {
        type: "message",
        id: "side-mirror",
        parentId: "root",
        timestamp: "2026-06-15T00:00:03.000Z",
        message: { role: "assistant", content: createTextContent("side"), timestamp: 3 },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-mirror",
        timestamp: "2026-06-15T00:00:04.000Z",
        targetId: "active-mirror",
      },
    ];
    const original = records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fs.writeFile(sessionFile, original, "utf-8");

    const result = await rewriteTranscriptEntriesInSessionFile({
      sessionFile,
      sessionKey: "agent:main:test",
      request: {
        allowedRewriteSuffixEntryIds: ["active-mirror", "side-mirror"],
        replacements: [
          {
            entryId: "active-mirror",
            message: asAppendMessage({
              role: "assistant",
              content: createTextContent("active rewritten"),
              timestamp: 2,
            }) as AgentMessage,
          },
          {
            entryId: "side-mirror",
            message: asAppendMessage({
              role: "assistant",
              content: createTextContent("side rewritten"),
              timestamp: 3,
            }) as AgentMessage,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      changed: false,
      reason: "rewrite targets span multiple branches",
    });
    expect(await fs.readFile(sessionFile, "utf-8")).toBe(original);
  });

  it("emits transcript updates when the active branch changes without opening a manager", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-"));
    const sessionManager = SessionManager.create(dir, dir);
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
    const sessionFile = requireString(sessionManager.getSessionFile(), "persisted session file");
    const toolResultEntryId = entryIds[1];

    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for file rewrites");
    });
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
        staleMs: 1_800_000,
        timeoutMs: 60_000,
        maxHoldMs: 300_000,
      });
      expect(acquireSessionWriteLockReleaseMock).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile, sessionKey: "agent:main:test" });

      openSpy.mockRestore();
      const rewrittenSession = SessionManager.open(sessionFile);
      const rewrittenToolResult = getBranchMessages(rewrittenSession)[1] as Extract<
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
