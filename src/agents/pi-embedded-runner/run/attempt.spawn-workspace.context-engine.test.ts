import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemorySystemPromptAddition } from "../../../plugin-sdk/core.js";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../../../plugins/memory-state.js";
import {
  type AttemptContextEngine,
  assembleAttemptContextEngine,
  finalizeAttemptContextEngineTurn,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  cacheTtlEligibleModel,
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  expectCalledWithSessionKey,
  getHoisted,
  type MutableSession,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";

const hoisted = getHoisted();
const embeddedSessionId = "embedded-session";
const sessionFile = "/tmp/session.jsonl";
const seedMessage = { role: "user", content: "seed", timestamp: 1 } as AgentMessage;
const doneMessage = { role: "assistant", content: "done", timestamp: 2 } as unknown as AgentMessage;
type AfterTurnPromptCacheCall = { runtimeContext?: { promptCache?: Record<string, unknown> } };
type AfterTurnUnknownPromptCacheCall = { runtimeContext?: { promptCache?: unknown } };

function appendAssistantWithUsage(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}) {
  return async (session: MutableSession, _prompt: string, _options?: { images?: unknown[] }) => {
    session.messages = [
      ...session.messages,
      {
        role: "assistant",
        content: "done",
        timestamp: 2,
        usage,
      } as unknown as AgentMessage,
    ];
  };
}

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

async function runBootstrap(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof runAttemptContextEngineBootstrap>[0]> = {},
) {
  await runAttemptContextEngineBootstrap({
    hadSessionFile: true,
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    sessionFile,
    sessionManager: hoisted.sessionManager,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    warn: () => {},
    ...overrides,
  });
}

async function runAssemble(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof assembleAttemptContextEngine>[0]> = {},
) {
  return await assembleAttemptContextEngine({
    contextEngine,
    sessionId: embeddedSessionId,
    sessionKey,
    messages: [seedMessage],
    tokenBudget: 2048,
    modelId: "gpt-test",
    ...overrides,
  });
}

async function finalizeTurn(
  sessionKey: string,
  contextEngine: AttemptContextEngine,
  overrides: Partial<Parameters<typeof finalizeAttemptContextEngineTurn>[0]> = {},
) {
  await finalizeAttemptContextEngineTurn({
    contextEngine,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    sessionIdUsed: embeddedSessionId,
    sessionKey,
    sessionFile,
    messagesSnapshot: [doneMessage],
    prePromptMessageCount: 0,
    tokenBudget: 2048,
    runtimeContext: {},
    runMaintenance: hoisted.runContextEngineMaintenanceMock,
    sessionManager: hoisted.sessionManager,
    warn: () => {},
    ...overrides,
  });
}

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const sessionKey = "agent:main:discord:channel:test-ctx-engine";
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    clearMemoryPluginState();
    vi.restoreAllMocks();
    await cleanupTempPaths(tempPaths);
  });

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});
    const contextEngine = createTestContextEngine({
      bootstrap,
      assemble,
      afterTurn,
    });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);
    await finalizeTurn(sessionKey, contextEngine);

    expectCalledWithSessionKey(bootstrap, sessionKey);
    expectCalledWithSessionKey(assemble, sessionKey);
    expectCalledWithSessionKey(afterTurn, sessionKey);
  });

  it("forwards modelId to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine);

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
      }),
    );
  });

  it("forwards availableTools and citationsMode to assemble", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const contextEngine = createTestContextEngine({ bootstrap, assemble });

    await runBootstrap(sessionKey, contextEngine);
    await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["memory_search", "wiki_search"]),
      citationsMode: "on",
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: new Set(["memory_search", "wiki_search"]),
        citationsMode: "on",
      }),
    );
  });

  it("lets non-legacy engines opt into the active memory prompt helper", async () => {
    registerMemoryPromptSection(({ availableTools, citationsMode }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return [
        "## Memory Recall",
        `tools=${[...availableTools].toSorted().join(",")}`,
        `citations=${citationsMode ?? "auto"}`,
        "",
      ];
    });

    const contextEngine = createTestContextEngine({
      assemble: async ({ messages, availableTools, citationsMode }) => ({
        messages,
        estimatedTokens: messages.length,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      }),
    });

    const result = await runAssemble(sessionKey, contextEngine, {
      availableTools: new Set(["wiki_search", "memory_search"]),
      citationsMode: "on",
    });

    expect(result).toMatchObject({
      estimatedTokens: 1,
      systemPromptAddition: "## Memory Recall\ntools=memory_search,wiki_search\ncitations=on",
    });
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expectCalledWithSessionKey(ingestBatch, sessionKey);
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingest }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });

  it("forwards silentExpected to the embedded subscription", async () => {
    const params = buildEmbeddedSubscriptionParams({
      session: {} as never,
      runId: "run-context-engine-forwarding",
      hookRunner: undefined,
      verboseLevel: undefined,
      reasoningMode: "off",
      toolResultFormat: undefined,
      shouldEmitToolResult: undefined,
      shouldEmitToolOutput: undefined,
      onToolResult: undefined,
      onReasoningStream: undefined,
      onReasoningEnd: undefined,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      blockReplyBreak: undefined,
      blockReplyChunking: undefined,
      onPartialReply: undefined,
      onAssistantMessageStart: undefined,
      onAgentEvent: undefined,
      enforceFinalTag: undefined,
      silentExpected: true,
      config: undefined,
      sessionKey,
      sessionId: embeddedSessionId,
      agentId: "main",
    });

    expect(params.silentExpected).toBe(true);
    expect(params.sessionKey).toBe(sessionKey);
  });

  it("skips maintenance when afterTurn fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, afterTurn }));

    expect(afterTurn).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("runs startup maintenance for existing sessions even without bootstrap()", async () => {
    const { assemble } = createContextEngineBootstrapAndAssemble();

    await runBootstrap(
      sessionKey,
      createTestContextEngine({
        assemble,
        maintain: async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
          reason: "test maintenance",
        }),
      }),
    );

    expect(hoisted.runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bootstrap" }),
    );
  });

  it("passes prompt-cache retention, last-call usage, and cache-touch metadata to afterTurn", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        afterTurn,
      },
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              contextPruning: {
                mode: "cache-ttl",
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        model: cacheTtlEligibleModel,
      },
      sessionPrompt: appendAssistantWithUsage({
        input: 10,
        output: 5,
        cacheRead: 40,
        cacheWrite: 2,
        total: 57,
      }),
      sessionKey,
      tempPaths,
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;

    expect(runtimeContext?.promptCache).toEqual(
      expect.objectContaining({
        retention: "short",
        lastCallUsage: {
          input: 10,
          output: 5,
          cacheRead: 40,
          cacheWrite: 2,
          total: 57,
        },
        lastCacheTouchAt: expect.any(Number),
      }),
    );
  });

  it("omits prompt-cache metadata from afterTurn when no cache data is available", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnUnknownPromptCacheCall) => {});

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        afterTurn,
      },
      sessionKey,
      tempPaths,
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;

    expect(runtimeContext?.promptCache).toBeUndefined();
  });

  it("does not reuse a prior turn's usage when the current attempt exits before a new assistant", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        afterTurn,
      },
      attemptOverrides: {
        config: {
          agents: {
            defaults: {
              contextPruning: {
                mode: "cache-ttl",
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        model: cacheTtlEligibleModel,
        contextTokenBudget: 1,
        prompt: "force-preflight-overflow",
      },
      sessionMessages: [
        seedMessage,
        {
          role: "assistant",
          content: "prior turn",
          timestamp: 2,
          usage: {
            input: 99,
            output: 7,
            cacheRead: 1234,
            total: 1340,
          },
        } as unknown as AgentMessage,
      ],
      sessionKey,
      tempPaths,
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const promptCache = afterTurnCall?.runtimeContext?.promptCache;

    expect(promptCache).toEqual(
      expect.objectContaining({
        retention: "short",
      }),
    );
    expect(promptCache?.lastCallUsage).toBeUndefined();
  });

  it("threads prompt-cache break observations into afterTurn", async () => {
    const afterTurn = vi.fn(async (_params: AfterTurnPromptCacheCall) => {});

    await finalizeTurn(sessionKey, createTestContextEngine({ afterTurn }), {
      runtimeContext: {
        promptCache: {
          observation: {
            broke: true,
            previousCacheRead: 5000,
            cacheRead: 2000,
            changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
          },
        },
      },
    });

    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    const runtimeContext = afterTurnCall?.runtimeContext;
    const observation = runtimeContext?.promptCache?.observation as
      | { broke?: boolean; previousCacheRead?: number; cacheRead?: number; changes?: unknown[] }
      | undefined;

    expect(observation).toEqual(
      expect.objectContaining({
        broke: true,
        previousCacheRead: 5000,
        cacheRead: 2000,
        changes: expect.arrayContaining([expect.objectContaining({ code: "systemPrompt" })]),
      }),
    );
  });

  it("skips maintenance when ingestBatch fails", async () => {
    const { bootstrap, assemble } = createContextEngineBootstrapAndAssemble();
    const ingestBatch = vi.fn(async () => {
      throw new Error("ingestBatch failed");
    });

    await finalizeTurn(sessionKey, createTestContextEngine({ bootstrap, assemble, ingestBatch }), {
      messagesSnapshot: [seedMessage, doneMessage],
      prePromptMessageCount: 1,
    });

    expect(ingestBatch).toHaveBeenCalled();
    expect(hoisted.runContextEngineMaintenanceMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn" }),
    );
  });

  it("releases the session lock even when teardown cleanup throws", async () => {
    const releaseMock = vi.fn(async () => {});
    const disposeMock = vi.fn();
    const flushMock = vi.fn(async () => {
      throw new Error("flush failed");
    });

    await cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: () => {},
      flushPendingToolResultsAfterIdle: flushMock,
      session: { agent: {}, dispose: disposeMock },
      sessionManager: hoisted.sessionManager,
      releaseWsSession: hoisted.releaseWsSessionMock,
      sessionId: embeddedSessionId,
      bundleLspRuntime: undefined,
      sessionLock: { release: releaseMock },
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session");
  });
});
