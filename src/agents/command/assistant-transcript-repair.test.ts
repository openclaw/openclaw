import { beforeEach, describe, expect, it, vi } from "vitest";
import type { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  persistAssistantTranscriptRepairRecord,
  repairPendingAssistantTranscriptTurns,
} from "./assistant-transcript-repair.js";
import type { persistAgentSession } from "./attempt-execution.shared.js";

type AppendExactAssistantMessage = typeof appendExactAssistantMessageToSessionTranscript;
type PersistAgentSession = typeof persistAgentSession;

const { append, persist, warn } = vi.hoisted(() => ({
  append: vi.fn<AppendExactAssistantMessage>(),
  persist: vi.fn<PersistAgentSession>(),
  warn: vi.fn(),
}));

vi.mock("./attempt-execution.shared.js", () => ({
  persistAgentSession: persist,
}));

vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptAppendRuntime: async () => ({
    appendExactAssistantMessageToSessionTranscript: append,
  }),
}));

vi.mock("../harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: ({ message }: { message: unknown }) => message,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn }),
}));

const sessionKey = "agent:main:explicit:repair";
const storePath = "/tmp/sessions.json";

function makeEntry(
  overrides: Partial<SessionEntry> = {},
): SessionEntry & { sessionId: string; updatedAt: number } {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

function makeContext(pendingTranscriptRepair?: SessionEntry["pendingTranscriptRepair"]) {
  const entry = makeEntry({ pendingTranscriptRepair });
  const sessionStore = { [sessionKey]: entry };
  return {
    context: {
      sessionKey,
      sessionEntry: entry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      config: {},
    },
    sessionStore,
  };
}

function successfulAppend(messageId: string) {
  return {
    ok: true as const,
    target: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
    messageId,
  };
}

function repair(text = "missing", id = "repair-1", createdAt = 10) {
  return { id, text, createdAt };
}

function expectedAppend(
  id: string,
  text: string,
  timestamp: number,
  provider = "cli",
  model = "default",
) {
  return expect.objectContaining({
    idempotencyKey: `transcript-repair:${id}`,
    expectedSessionId: "session-1",
    updateMode: "file-only",
    message: expect.objectContaining({
      provider,
      model,
      timestamp,
      content: [{ type: "text", text }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  append.mockResolvedValue(successfulAppend("message-1"));
  persist.mockImplementation(async (params) => {
    const current = params.sessionStore[params.sessionKey];
    if (params.shouldPersist?.(current) === false) {
      return undefined;
    }
    params.sessionStore[params.sessionKey] = params.entry;
    return params.entry;
  });
});

describe("persistAssistantTranscriptRepairRecord", () => {
  it("appends a canonical record and fences it to the run-owned session", async () => {
    const existingRepair = { id: "repair-1", text: "first", createdAt: 1 };
    const { context, sessionStore } = makeContext([existingRepair]);

    await persistAssistantTranscriptRepairRecord({
      context,
      replyText: "second",
      provider: " openai ",
      model: " gpt-5.5 ",
      runOwnedSessionId: context.sessionEntry.sessionId,
    });

    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toEqual([
      existingRepair,
      {
        id: expect.any(String),
        text: "second",
        provider: "openai",
        model: "gpt-5.5",
        createdAt: expect.any(Number),
      },
    ]);
    const shouldPersist = persist.mock.calls[0]?.[0].shouldPersist;
    expect(shouldPersist?.(makeEntry())).toBe(true);
    expect(shouldPersist?.(makeEntry({ sessionId: "replacement" }))).toBe(false);
    expect(shouldPersist?.(makeEntry({ abortedLastRun: true }))).toBe(false);
  });

  it("does not fail the completed turn when repair-record persistence fails", async () => {
    const { context } = makeContext();
    persist.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(
      persistAssistantTranscriptRepairRecord({
        context,
        replyText: "recover me",
        runOwnedSessionId: "session-1",
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("store unavailable"));
  });
});

describe("repairPendingAssistantTranscriptTurns", () => {
  it("replays every missing final in order before clearing the backlog", async () => {
    const { context, sessionStore } = makeContext([
      { ...repair("first"), provider: "openai", model: "gpt-5.5" },
      repair("second", "repair-2", 20),
    ]);
    append
      .mockResolvedValueOnce(successfulAppend("message-1"))
      .mockResolvedValueOnce(successfulAppend("message-2"));

    await repairPendingAssistantTranscriptTurns({ context });

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls.map(([params]) => params)).toEqual([
      expectedAppend("repair-1", "first", 10, "openai", "gpt-5.5"),
      expectedAppend("repair-2", "second", 20),
    ]);
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
  });

  it.each([
    ["unavailable", undefined, "transcript store unavailable"],
    ["blocked", "blocked", "blocked by before_message_write"],
  ] as const)("handles an %s append result", async (_name, code, reason) => {
    const { context, sessionStore } = makeContext([repair(code ? "blocked" : "missing")]);
    append.mockResolvedValueOnce({ ok: false, ...(code ? { code } : {}), reason });
    const replay = repairPendingAssistantTranscriptTurns({ context });
    if (code) {
      await replay;
      expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
    } else {
      await expect(replay).rejects.toThrow("pending transcript recovery");
      expect(persist).not.toHaveBeenCalled();
      expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toHaveLength(1);
    }
  });

  it("retries cleanup with the same append idempotency key", async () => {
    const { context, sessionStore } = makeContext([repair()]);
    persist.mockRejectedValueOnce(new Error("cleanup unavailable"));

    await repairPendingAssistantTranscriptTurns({ context });
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toHaveLength(1);

    await repairPendingAssistantTranscriptTurns({ context });

    expect(append.mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
      "transcript-repair:repair-1",
      "transcript-repair:repair-1",
    ]);
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
  });

  it("does not clear repair state from a replacement session", async () => {
    const { context, sessionStore } = makeContext([repair()]);
    append.mockImplementationOnce(async () => {
      sessionStore[sessionKey] = makeEntry({ sessionId: "replacement" });
      return successfulAppend("message-1");
    });

    await repairPendingAssistantTranscriptTurns({ context });

    expect(persist).not.toHaveBeenCalled();
    expect(sessionStore[sessionKey]?.sessionId).toBe("replacement");
  });
});
