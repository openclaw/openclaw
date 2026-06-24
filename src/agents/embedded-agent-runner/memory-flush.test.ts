import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { setAgentRunnerMemoryTestDeps } from "../../auto-reply/reply/agent-runner-memory.js";
import { writeTestSessionStore } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import { runEmbeddedPreAttemptMemoryFlushIfNeeded } from "./memory-flush.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

const runWithModelFallbackMock = vi.fn();
const runEmbeddedAgentMock = vi.fn();
const ensureMemoryFlushTargetFileMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();
const emitAgentEventMock = vi.fn();
const updateSessionEntryMock = vi.fn();

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
  updateSessionId: ReturnType<typeof vi.fn<ReplyOperation["updateSessionId"]>>;
};

function createReplyOperation(): TestReplyOperation {
  return {
    key: "test",
    sessionId: "session",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    phase: "queued",
    result: null,
    setPhase: vi.fn<ReplyOperation["setPhase"]>(),
    updateSessionId: vi.fn<ReplyOperation["updateSessionId"]>(),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    retainFailureUntilComplete: vi.fn(),
    complete: vi.fn(),
    completeThen: vi.fn((afterClear: () => void) => {
      afterClear();
    }),
    completeWithAfterClearBarrier: vi.fn(),
    fail: vi.fn(),
    abortByUser: vi.fn(),
    abortForRestart: vi.fn(),
  };
}

function createRunParams(params: {
  rootDir: string;
  storePath: string;
  replyOperation?: ReplyOperation;
  trigger?: RunEmbeddedAgentParams["trigger"];
}): RunEmbeddedAgentParams {
  return {
    sessionId: "session",
    sessionKey: "main",
    sessionFile: path.join(params.rootDir, "session.jsonl"),
    workspaceDir: params.rootDir,
    agentDir: path.join(params.rootDir, "agent"),
    agentId: "main",
    config: {
      session: { store: params.storePath },
      agents: { defaults: { compaction: { memoryFlush: {} } } },
    },
    prompt: "hello from embedded",
    transcriptPrompt: "hello from embedded",
    provider: "anthropic",
    model: "claude",
    trigger: params.trigger ?? "user",
    messageProvider: "whatsapp",
    messageTo: "+15551234567",
    chatType: "direct",
    timeoutMs: 1_000,
    runId: "run-1",
    replyOperation: params.replyOperation,
    verboseLevel: "off",
  } as unknown as RunEmbeddedAgentParams;
}

describe("embedded pre-attempt memory flush adapter", () => {
  const tempDirs: string[] = [];
  let rootDir = "";
  let storePath = "";

  beforeEach(() => {
    rootDir = makeTempDir(tempDirs, "openclaw-embedded-memory-unit-");
    storePath = path.join(rootDir, "sessions.json");
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    ensureMemoryFlushTargetFileMock.mockReset().mockResolvedValue(undefined);
    ensureSelectedAgentHarnessPluginMock.mockReset().mockResolvedValue(undefined);
    refreshQueuedFollowupSessionMock.mockReset();
    incrementCompactionCountMock.mockReset();
    emitAgentEventMock.mockReset();
    updateSessionEntryMock.mockReset().mockImplementation(async (_params, update) => {
      const current: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        totalTokensFresh: true,
        compactionCount: 1,
      };
      const patch = await update(current);
      return patch ? { ...current, ...patch } : current;
    });
    setAgentRunnerMemoryTestDeps({
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedAgent: runEmbeddedAgentMock as never,
      ensureMemoryFlushTargetFile: ensureMemoryFlushTargetFileMock as never,
      ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      updateSessionEntry: updateSessionEntryMock as never,
      registerAgentRunContext: vi.fn() as never,
      emitAgentEvent: emitAgentEventMock as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(() => {
    setAgentRunnerMemoryTestDeps();
    clearMemoryPluginState();
    cleanupTempDirs(tempDirs);
  });

  it("runs the existing memory flush machinery before an embedded attempt", async () => {
    const replyOperation = createReplyOperation();
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const runParams = createRunParams({ rootDir, storePath, replyOperation });

    const result = await runEmbeddedPreAttemptMemoryFlushIfNeeded({
      runParams,
      cfg: runParams.config!,
      sessionId: runParams.sessionId,
      sessionFile: runParams.sessionFile,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      agentDir: runParams.agentDir!,
      provider: "anthropic",
      model: "claude",
      contextWindowTokens: 100_000,
    });

    expect(result.sessionEntry?.sessionId).toBe("session");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedAgentMock.mock.calls[0]?.[0] as RunEmbeddedAgentParams;
    expect(flushCall.trigger).toBe("memory");
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.sessionKey).toBe("main");
    expect(flushCall.messageProvider).toBe("whatsapp");
    expect(ensureMemoryFlushTargetFileMock).toHaveBeenCalledWith({
      workspaceDir: rootDir,
      relativePath: "memory/2023-11-14.md",
    });
    expect(replyOperation.setPhase).toHaveBeenCalledWith("memory_flushing");
  });

  it("skips recursive memory-triggered embedded runs", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const runParams = createRunParams({
      rootDir,
      storePath,
      replyOperation: createReplyOperation(),
      trigger: "memory",
    });

    const result = await runEmbeddedPreAttemptMemoryFlushIfNeeded({
      runParams,
      cfg: runParams.config!,
      sessionId: runParams.sessionId,
      sessionFile: runParams.sessionFile,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      agentDir: runParams.agentDir!,
      provider: "anthropic",
      model: "claude",
      contextWindowTokens: 100_000,
    });

    expect(result.attempted).toBe(false);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips when no reply operation is available", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      compactionCount: 1,
    };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const runParams = createRunParams({ rootDir, storePath });

    const result = await runEmbeddedPreAttemptMemoryFlushIfNeeded({
      runParams,
      cfg: runParams.config!,
      sessionId: runParams.sessionId,
      sessionFile: runParams.sessionFile,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      agentDir: runParams.agentDir!,
      provider: "anthropic",
      model: "claude",
      contextWindowTokens: 100_000,
    });

    expect(result.attempted).toBe(false);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
