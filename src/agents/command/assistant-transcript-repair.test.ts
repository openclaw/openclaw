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

const mocks = vi.hoisted(() => ({
  appendExactAssistantMessage: vi.fn<AppendExactAssistantMessage>(),
  persistAgentSession: vi.fn<PersistAgentSession>(),
  warn: vi.fn(),
}));

vi.mock("./attempt-execution.shared.js", () => ({
  persistAgentSession: mocks.persistAgentSession,
}));

vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptAppendRuntime: async () => ({
    appendExactAssistantMessageToSessionTranscript: mocks.appendExactAssistantMessage,
  }),
}));

vi.mock("../harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: ({ message }: { message: unknown }) => message,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: mocks.warn }),
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
  mocks.appendExactAssistantMessage.mockResolvedValue(successfulAppend("message-1"));
  mocks.persistAgentSession.mockImplementation(async (params) => {
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
    const shouldPersist = mocks.persistAgentSession.mock.calls[0]?.[0].shouldPersist;
    expect(shouldPersist?.(makeEntry())).toBe(true);
    expect(shouldPersist?.(makeEntry({ sessionId: "replacement" }))).toBe(false);
    expect(shouldPersist?.(makeEntry({ abortedLastRun: true }))).toBe(false);
  });

  it("does not fail the completed turn when repair-record persistence fails", async () => {
    const { context } = makeContext();
    mocks.persistAgentSession.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(
      persistAssistantTranscriptRepairRecord({
        context,
        replyText: "recover me",
        runOwnedSessionId: "session-1",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("store unavailable"));
  });
});

describe("repairPendingAssistantTranscriptTurns", () => {
  it("replays every missing final in order before clearing the backlog", async () => {
    const { context, sessionStore } = makeContext([
      { ...repair("first"), provider: "openai", model: "gpt-5.5" },
      repair("second", "repair-2", 20),
    ]);
    mocks.appendExactAssistantMessage
      .mockResolvedValueOnce(successfulAppend("message-1"))
      .mockResolvedValueOnce(successfulAppend("message-2"));

    await repairPendingAssistantTranscriptTurns({ context });

    expect(mocks.appendExactAssistantMessage).toHaveBeenCalledTimes(2);
    expect(mocks.appendExactAssistantMessage.mock.calls.map(([params]) => params)).toEqual([
      expectedAppend("repair-1", "first", 10, "openai", "gpt-5.5"),
      expectedAppend("repair-2", "second", 20),
    ]);
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
  });

  it("keeps the backlog and blocks admission while an append is unavailable", async () => {
    const { context, sessionStore } = makeContext([repair()]);
    mocks.appendExactAssistantMessage.mockResolvedValueOnce({
      ok: false,
      reason: "transcript store unavailable",
    });

    await expect(repairPendingAssistantTranscriptTurns({ context })).rejects.toThrow(
      "pending transcript recovery",
    );

    expect(mocks.persistAgentSession).not.toHaveBeenCalled();
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toHaveLength(1);
  });

  it("drops a final blocked by before_message_write and clears the backlog", async () => {
    const { context, sessionStore } = makeContext([repair("blocked")]);
    mocks.appendExactAssistantMessage.mockResolvedValueOnce({
      ok: false,
      code: "blocked",
      reason: "blocked by before_message_write",
    });

    await repairPendingAssistantTranscriptTurns({ context });

    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
  });

  it("retries cleanup with the same append idempotency key", async () => {
    const { context, sessionStore } = makeContext([repair()]);
    mocks.persistAgentSession.mockRejectedValueOnce(new Error("cleanup unavailable"));

    await repairPendingAssistantTranscriptTurns({ context });
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toHaveLength(1);

    await repairPendingAssistantTranscriptTurns({ context });

    expect(
      mocks.appendExactAssistantMessage.mock.calls.map(([params]) => params.idempotencyKey),
    ).toEqual(["transcript-repair:repair-1", "transcript-repair:repair-1"]);
    expect(sessionStore[sessionKey]?.pendingTranscriptRepair).toBeUndefined();
  });

  it("does not clear repair state from a replacement session", async () => {
    const { context, sessionStore } = makeContext([repair()]);
    mocks.appendExactAssistantMessage.mockImplementationOnce(async () => {
      sessionStore[sessionKey] = makeEntry({ sessionId: "replacement" });
      return successfulAppend("message-1");
    });

    await repairPendingAssistantTranscriptTurns({ context });

    expect(mocks.persistAgentSession).not.toHaveBeenCalled();
    expect(sessionStore[sessionKey]?.sessionId).toBe("replacement");
  });
});
