import { beforeEach, expect, it, vi } from "vitest";
import type { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  persistAssistantTranscriptRepairRecord,
  repairPendingAssistantTranscriptTurns,
} from "./assistant-transcript-repair.js";
import type { persistAgentSession } from "./attempt-execution.shared.js";

const { append, persist, warn } = vi.hoisted(() => ({
  append: vi.fn<typeof appendExactAssistantMessageToSessionTranscript>(),
  persist: vi.fn<typeof persistAgentSession>(),
  warn: vi.fn(),
}));

// mock-isolation: Keep the agent execution runtime out of this transcript-repair fixture.
vi.mock("./attempt-execution.shared.js", () => ({ persistAgentSession: persist }));

// mock-isolation: Supply only the owned append boundary without loading transcript workers.
vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptAppendRuntime: async () => ({
    appendExactAssistantMessageToSessionTranscript: append,
  }),
}));

vi.mock("../harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: ({ message }: { message: unknown }) => message,
}));

// mock-isolation: Capture repair warnings without installing global logging state.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn }),
}));

const sessionKey = "agent:main:explicit:repair";
const storePath = "/tmp/sessions.json";
const baseContext = { sessionKey, storePath, sessionAgentId: "main", config: {} };

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

function setup(pendingTranscriptRepair?: SessionEntry["pendingTranscriptRepair"]) {
  const entry = makeEntry({ pendingTranscriptRepair });
  const sessionStore = { [sessionKey]: entry };
  const context = { ...baseContext, sessionEntry: entry, sessionStore };
  return {
    sessionStore,
    pending: () => sessionStore[sessionKey]?.pendingTranscriptRepair,
    replay: () => repairPendingAssistantTranscriptTurns({ context }),
    record: (replyText: string, metadata: { provider?: string; model?: string } = {}) =>
      persistAssistantTranscriptRepairRecord({
        context,
        replyText,
        runOwnedSessionId: entry.sessionId,
        ...metadata,
      }),
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

function expectedAppend(id: string, message: Record<string, unknown>) {
  return expect.objectContaining({
    idempotencyKey: `transcript-repair:${id}`,
    expectedSessionId: "session-1",
    updateMode: "file-only",
    message: expect.objectContaining(message),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  append.mockResolvedValue(successfulAppend("message-1"));
  persist.mockImplementation(async (params) => {
    if (params.shouldPersist?.(params.sessionStore[params.sessionKey]) !== false) {
      params.sessionStore[params.sessionKey] = params.entry;
      return params.entry;
    }
    return undefined;
  });
});

it("appends a canonical record and fences it to the run-owned session", async () => {
  const existingRepair = { id: "repair-1", text: "first", createdAt: 1 };
  const fixture = setup([existingRepair]);
  await fixture.record("second", { provider: " openai ", model: " gpt-5.5 " });

  expect(fixture.pending()).toEqual([
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
  const fixture = setup();
  persist.mockRejectedValueOnce(new Error("store unavailable"));

  await expect(fixture.record("recover me")).resolves.toBeUndefined();

  expect(warn).toHaveBeenCalledWith(expect.stringContaining("store unavailable"));
});

it("replays every missing final in order before clearing the backlog", async () => {
  const fixture = setup([
    { ...repair("first"), provider: "openai", model: "gpt-5.5" },
    repair("second", "repair-2", 20),
  ]);
  append
    .mockResolvedValueOnce(successfulAppend("message-1"))
    .mockResolvedValueOnce(successfulAppend("message-2"));

  await fixture.replay();

  expect(append.mock.calls.map(([params]) => params)).toEqual([
    expectedAppend("repair-1", {
      provider: "openai",
      model: "gpt-5.5",
      timestamp: 10,
      content: [{ type: "text", text: "first" }],
    }),
    expectedAppend("repair-2", {
      provider: "cli",
      model: "default",
      timestamp: 20,
      content: [{ type: "text", text: "second" }],
    }),
  ]);
  expect(fixture.pending()).toBeUndefined();
});

it.each([
  ["unavailable", undefined, "transcript store unavailable"],
  ["blocked", "blocked", "blocked by before_message_write"],
] as const)("handles an %s append result", async (_name, code, reason) => {
  const fixture = setup([repair(code ? "blocked" : "missing")]);
  append.mockResolvedValueOnce({ ok: false, ...(code ? { code } : {}), reason });
  const replay = fixture.replay();
  if (code) {
    await replay;
    expect(fixture.pending()).toBeUndefined();
  } else {
    await expect(replay).rejects.toThrow("pending transcript recovery");
    expect(persist).not.toHaveBeenCalled();
    expect(fixture.pending()).toHaveLength(1);
  }
});

it("retries cleanup with the same append idempotency key", async () => {
  const fixture = setup([repair()]);
  persist.mockRejectedValueOnce(new Error("cleanup unavailable"));

  await fixture.replay();
  expect(fixture.pending()).toHaveLength(1);

  await fixture.replay();

  expect(append.mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
    "transcript-repair:repair-1",
    "transcript-repair:repair-1",
  ]);
  expect(fixture.pending()).toBeUndefined();
});

it("does not clear repair state from a replacement session", async () => {
  const fixture = setup([repair()]);
  append.mockImplementationOnce(async () => {
    fixture.sessionStore[sessionKey] = makeEntry({ sessionId: "replacement" });
    return successfulAppend("message-1");
  });

  await fixture.replay();

  expect(persist).not.toHaveBeenCalled();
  expect(fixture.sessionStore[sessionKey]?.sessionId).toBe("replacement");
});
