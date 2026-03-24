import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AttemptContextEngine,
  assembleAttemptContextEngine,
  finalizeAttemptContextEngineTurn,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  createContextEngineBootstrapAndAssemble,
  expectCalledWithSessionKey,
  getHoisted,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

function createTestContextEngine(params: Partial<AttemptContextEngine>): AttemptContextEngine {
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as AttemptContextEngine;
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const sessionKey = "agent:main:discord:channel:test-ctx-engine";

  beforeEach(() => {
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});
    const contextEngine = createTestContextEngine({
      bootstrap,
      assemble,
      afterTurn,
    });

    await runAttemptContextEngineBootstrap({
      hadSessionFile: true,
      contextEngine,
      sessionId: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      sessionManager: hoisted.sessionManager,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      warn: () => {},
    });
    await assembleAttemptContextEngine({
      contextEngine,
      sessionId: "embedded-session",
      sessionKey,
      messages: [{ role: "user", content: "seed", timestamp: 1 } as AgentMessage],
      tokenBudget: 2048,
      modelId: "gpt-test",
    });
    await finalizeAttemptContextEngineTurn({
      contextEngine,
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      messagesSnapshot: [
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ],
      prePromptMessageCount: 0,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      sessionManager: hoisted.sessionManager,
      warn: () => {},
    });

    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runAttemptContextEngineBootstrap({
      hadSessionFile: true,
      contextEngine,
      sessionId: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      sessionManager: hoisted.sessionManager,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      warn: () => {},
    });
    await assembleAttemptContextEngine({
      contextEngine,
      sessionId: "embedded-session",
      sessionKey,
      messages: [{ role: "user", content: "seed", timestamp: 1 } as AgentMessage],
      tokenBudget: 2048,
      modelId: "gpt-test",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    await finalizeAttemptContextEngineTurn({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        ingestBatch,
      }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      messagesSnapshot: [
        { role: "user", content: "seed", timestamp: 1 } as AgentMessage,
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ],
      prePromptMessageCount: 1,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      sessionManager: hoisted.sessionManager,
      warn: () => {},
    });

    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    await finalizeAttemptContextEngineTurn({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        ingest,
      }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      messagesSnapshot: [
        { role: "user", content: "seed", timestamp: 1 } as AgentMessage,
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ],
      prePromptMessageCount: 1,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      sessionManager: hoisted.sessionManager,
      warn: () => {},
    });

    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeAttemptContextEngineTurn({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        afterTurn,
      }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      messagesSnapshot: [
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ],
      prePromptMessageCount: 0,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      sessionManager: hoisted.sessionManager,
      warn: () => {},
    });

    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await runAttemptContextEngineBootstrap({
      hadSessionFile: true,
      contextEngine: createTestContextEngine({
        assemble,
        maintain: async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
          reason: "test maintenance",
        }),
      }),
      sessionId: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      sessionManager: hoisted.sessionManager,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      warn: () => {},
    });

    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    await finalizeAttemptContextEngineTurn({
      contextEngine: createTestContextEngine({
        bootstrap,
        assemble,
        ingestBatch,
      }),
      promptError: false,
      aborted: false,
      yieldAborted: false,
      sessionIdUsed: "embedded-session",
      sessionKey,
      sessionFile: "/tmp/session.jsonl",
      messagesSnapshot: [
        { role: "user", content: "seed", timestamp: 1 } as AgentMessage,
        { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage,
      ],
      prePromptMessageCount: 1,
      tokenBudget: 2048,
      runtimeContext: {},
      runMaintenance: hoisted.runContextEngineMaintenanceMock,
      sessionManager: hoisted.sessionManager,
      warn: () => {},
    });

    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });
});
