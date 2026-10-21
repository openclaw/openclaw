import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import {
  compactEmbeddedRunForRecovery as compactForRecovery,
  createEmbeddedRunCompactionRuntime,
  type EmbeddedRunCompactionRecoveryInput,
} from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const admissions: PreparedAgentRunAdmission[] = [];
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
});
const completionMocks = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<typeof import("../simple-completion-runtime.js").acquireSimpleCompletionModelForAgent>(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));
const compactRuntimeMocks = vi.hoisted(() => ({
  compactEmbeddedAgentSessionOnDemand: vi.fn(),
}));

vi.mock("../simple-completion-runtime.js", () => completionMocks);
vi.mock("./compact.runtime.js", () => compactRuntimeMocks);

const baseRunParams = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  sessionFile: "agent:main:session-1",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} satisfies PreparedEmbeddedRunInput["runParams"];

const recoveryRequest = {
  tokenBudget: 200_000,
  trigger: "overflow",
  diagId: "diag-1",
  attempt: 1,
  maxAttempts: 3,
} satisfies Parameters<typeof compactForRecovery>[1];

function makeAttempt(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    terminal: { kind: "failed", source: "prompt", error: new Error("context overflow") },
    sessionIdUsed: "session-1",
    assistantTexts: [],
    ...overrides,
  });
}

function makeContextEngine(
  compact: ContextEngine["compact"] | ReturnType<typeof vi.fn> = vi.fn(),
  ownsCompaction = true,
): ContextEngine {
  return {
    info: { id: "test", name: "Test", ownsCompaction },
    ingest: vi.fn(),
    assemble: vi.fn(),
    compact,
  } as ContextEngine;
}

function makeRecoveryInput(
  overrides: Partial<EmbeddedRunCompactionRecoveryInput> = {},
): EmbeddedRunCompactionRecoveryInput {
  const runParams: EmbeddedRunCompactionRecoveryInput["runParams"] =
    overrides.runParams ?? baseRunParams;
  return {
    runParams,
    state: createEmbeddedRunContextRecoveryState(),
    assertRecoveryActive: vi.fn(),
    prepareRecoveryOwner: () => ({
      session: {
        id: runParams.sessionId,
        file: runParams.sessionFile ?? runParams.sessionKey ?? runParams.sessionId,
        target: {
          agentId: "main",
          sessionId: runParams.sessionId,
          sessionKey: runParams.sessionKey ?? baseRunParams.sessionKey,
          storePath: path.join(runParams.workspaceDir, "openclaw-agent.sqlite"),
        },
      },
      assertActive: composeSessionSourceAssertion([
        () => {
          runParams.abortSignal?.throwIfAborted();
          overrides.assertRecoveryActive?.();
        },
      ]),
      withTranscriptWrites: async <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
        signal?.throwIfAborted();
        return await run();
      },
    }),
    prepareRecoverySession: vi.fn<EmbeddedRunCompactionRecoveryInput["prepareRecoverySession"]>(),
    contextEngine: makeContextEngine(),
    genericCompactionRecoveryAllowed: true,
    attempt: makeAttempt(),
    runtimeAuthPlan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    },
    resolvedSessionKey: runParams.sessionKey ?? baseRunParams.sessionKey,
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    modelSelection: { provider: "openai", model: "gpt-5.5", authProfileIdSource: "auto" },
    harnessRuntime: "openclaw",
    thinkLevel: "off",
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: "openai",
        requestedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        promptTokenBudget: tokenBudget,
        degradedReason,
      }),
    onCompactionHookMessages: vi.fn(async () => {}),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: vi.fn<EmbeddedRunCompactionRecoveryInput["getActiveSession"]>(),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...overrides,
  };
}

function recover(
  input: Partial<EmbeddedRunCompactionRecoveryInput> = {},
  request: Partial<Parameters<typeof compactForRecovery>[1]> = {},
) {
  return compactForRecovery(makeRecoveryInput(input), { ...recoveryRequest, ...request });
}

describe("compactEmbeddedRunForRecovery", () => {
  beforeEach(() => {
    compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand.mockReset();
    for (const mock of Object.values(completionMocks)) {
      mock.mockReset();
    }
  });

  it("carries locked model, auth, fallback, cache, and overflow facts into compaction", async () => {
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true as const,
      compacted: true as const,
      result: { summary: "compacted", tokensBefore: 150_000, tokensAfter: 80_000 },
    }));
    const promptCache = {
      retention: "short" as const,
      lastCallUsage: { input: 150_000, cacheRead: 32_000, total: 182_000 },
      observation: { broke: false, cacheRead: 32_000 },
      lastCacheTouchAt: 1_700_000_000_000,
    };
    const result = await recover(
      {
        runParams: {
          ...baseRunParams,
          trigger: "user",
          sandboxSessionKey: "global",
          sandboxAgentId: "main",
          modelSelectionLocked: true,
          modelFallbacksOverride: [],
        },
        contextEngine: makeContextEngine(compact),
        contextTokenBudget: 200_000,
        attempt: makeAttempt({ promptCache }),
        thinkLevel: "ultra",
        modelSelection: {
          provider: "openai",
          model: "gpt-5.5",
          authProfileId: "openai:work",
          authProfileIdSource: "user",
        },
      },
      { currentTokenCount: 277_403 },
    );

    expect(result.result).toMatchObject({ ok: true, compacted: true });
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-1",
      sessionKey: baseRunParams.sessionKey,
      currentTokenCount: 277_403,
      tokenBudget: 200_000,
      runtimeContext: {
        sandboxSessionKey: "global",
        sandboxAgentId: "main",
        trigger: "overflow",
        modelCallUrgency: "foreground",
        currentTokenCount: 277_403,
        provider: "openai",
        model: "gpt-5.5",
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
        authProfileId: "openai:work",
        promptCache,
      },
    });
  });

  it("lets delegated native timeout recovery use its progress-aware watchdog", async () => {
    vi.useFakeTimers();
    try {
      compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand.mockImplementationOnce(
        (params: { compactionTimeoutReset?: () => void }) =>
          new Promise((resolve) => {
            setTimeout(() => params.compactionTimeoutReset?.(), 900);
            setTimeout(() => resolve({ ok: true, compacted: false }), 1_100);
          }),
      );
      const pending = recover(
        {
          runParams: {
            ...baseRunParams,
            config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
          },
          contextEngine: makeContextEngine(delegateCompactionToRuntime, false),
        },
        { trigger: "timeout_recovery", diagId: "diag-timeout_recovery" },
      );
      const assertion = expect(pending).resolves.toMatchObject({
        result: { ok: true, compacted: false },
      });
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
      expect(compactRuntimeMocks.compactEmbeddedAgentSessionOnDemand).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trust the active run fallback during recovery compaction", async () => {
    const compact = vi.fn(async (params: { runtimeContext?: ContextEngineRuntimeContext }) => {
      await params.runtimeContext?.llm?.complete({
        messages: [{ role: "user", content: "summarize" }],
      });
      return { ok: true as const, compacted: false as const };
    });
    const contextEngine = makeContextEngine(compact);
    const runParams = {
      ...baseRunParams,
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      sessionKey: "legacy-session",
      sessionFile: "legacy-session",
    } satisfies PreparedEmbeddedRunInput["runParams"];

    await expect(
      recover(
        {
          runParams,
          contextEngine,
          resolvedSessionKey: "legacy-session",
        },
        { diagId: "diag-unbound" },
      ),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        compacted: false,
        reason: expect.stringContaining("not bound to an active session agent"),
      },
    });
    expect(completionMocks.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "failed-result"] as const)(
    "keeps committed context chronology when the backend is %s",
    async (outcome) => {
      const state = createEmbeddedRunContextRecoveryState();
      const requestBudget = {
        contextWindow: 32_768,
        reserveTokens: 8_192,
        fixedTokens: 4_000,
        pendingTokens: 100,
      };
      state.compactionRequestBudget = requestBudget;
      const controller = new AbortController();
      const error = new Error("backend settled after the committed replacement");
      const usageAccumulator = createUsageAccumulator();
      const compact = vi.fn<ContextEngine["compact"]>(async ({ runtimeContext }) => {
        const recorder = readCompactionAccountingRecorder(runtimeContext);
        expect(recorder?.requestBudget).toBe(requestBudget);
        expect(runtimeContext).not.toHaveProperty("requestBudget");
        recorder?.recordUsage?.({ input: 100, output: 50, total: 150 });
        recorder?.recordCompaction?.({
          tokensBefore: 120,
          tokensAfter: 40,
          compactionKind: "context-engine",
        });
        state.observeContextAccounting({ kind: "model", contextTokens: 20, successful: false });
        if (outcome === "failed") {
          throw error;
        }
        if (outcome === "cancelled") {
          controller.abort(error);
        }
        if (outcome === "failed-result") {
          return {
            ok: false,
            compacted: false,
            reason: error.message,
            result: {
              summary: "Unaccepted partial successor",
              tokensBefore: 100,
              tokensAfter: 70,
              sessionId: "unaccepted-successor",
            },
          };
        }
        return { ok: true, compacted: true, result: { tokensBefore: 100, tokensAfter: 70 } };
      });
      const input = makeRecoveryInput({
        state,
        usageAccumulator,
        runParams: { ...baseRunParams, abortSignal: controller.signal },
        contextEngine: makeContextEngine(compact, false),
      });
      const recovery = {
        ...recoveryRequest,
        tokenBudget: 100,
        diagId: "ordered-commit",
      };
      const pending = compactForRecovery(input, recovery);
      if (outcome === "cancelled") {
        await expect(pending).rejects.toBe(error);
      } else if (outcome === "failed-result") {
        const settled = await pending;
        const completedFact = { ok: false, compacted: true, reason: error.message };
        expect.soft(settled.result).toMatchObject(completedFact);
        expect.soft(settled.result.result).toBeUndefined();
        expect
          .soft(input.adoptCompactionTranscript)
          .toHaveBeenCalledExactlyOnceWith(completedFact, undefined);
      } else {
        await expect(pending).resolves.toMatchObject({ result: { ok: false } });
      }
      expect(compact).toHaveBeenCalledOnce();
      expect.soft(usageAccumulator).toMatchObject({ input: 100, output: 50, total: 150 });
      expect(state).toMatchObject({
        autoCompactionCount: 1,
        lastCompactionTokensAfter: 40,
        currentContextSnapshot: { tokens: 20 },
      });
    },
  );
});

describe("createEmbeddedRunCompactionRuntime", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  async function createRuntime(sessionTarget?: ContextEngineSessionTarget) {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeCompaction: vi.fn(async () => undefined),
      runAfterCompaction: vi.fn(async () => undefined),
    };
    const onAgentEvent = vi.fn(async () => undefined);
    const currentTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(
        tempDirs.make("openclaw-overflow-compaction-session-"),
        "openclaw-agent.sqlite",
      ),
    };
    const admission = prepareSystemAgentRunAdmission(
      {},
      baseRunParams.runId,
      "main",
      "compaction-hook-test",
    );
    admissions.push(admission);
    const admittedRunContext = await admission.admit("embedded");
    const runParams = {
      ...baseRunParams,
      onAgentEvent,
      admittedRunContext,
      sessionTarget: currentTarget,
      sessionManager: SessionManager.inMemory(baseRunParams.workspaceDir),
    };
    const sessionPromptState = await createEmbeddedRunSessionPromptState({
      runParams,
      sessionAgentId: "main",
      resolvedSessionKey: baseRunParams.sessionKey,
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      onInterrupt: () => {},
    });
    const runtime = createEmbeddedRunCompactionRuntime({
      runParams,
      contextEngine: makeContextEngine(),
      hookRunner: hookRunner as never,
      hookContext: {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
      },
      sessionPromptState,
    });
    const compactResult = {
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: "rotated-session",
        sessionTarget,
      },
    };
    return { compactResult, hookRunner, onAgentEvent, runtime, sessionPromptState, currentTarget };
  }

  it("adopts a partial successor target and fires hooks against the rotated transcript", async () => {
    const { runtime, compactResult, sessionPromptState, currentTarget, hookRunner } =
      await createRuntime({
        sessionKey: "agent:main:session-1",
        threadId: "thread-hint",
      });

    await runtime.runOwnsCompactionBeforeHook("overflow recovery");
    const previousSessionId = await runtime.adoptCompactionTranscript(compactResult);

    expect(previousSessionId).toBe("session-1");
    expect(sessionPromptState.sessionTarget).toEqual({
      ...currentTarget,
      sessionId: "rotated-session",
      threadId: "thread-hint",
    });
    expect(sessionPromptState.sessionId).toBe("rotated-session");
    expect(sessionPromptState.committedCompactionSuccessor).toBeUndefined();
    await runtime.runOwnsCompactionAfterHook("overflow recovery", compactResult, previousSessionId);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: baseRunParams.sessionKey },
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenCount: 50,
        previousSessionId: "session-1",
        sessionFile: baseRunParams.sessionKey,
      }),
      expect.objectContaining({ sessionId: "rotated-session" }),
    );
  });

  it("retires MCP predecessors when an in-memory compaction rotates identity", async () => {
    const fixture = await createRuntime();
    const { getOrCreateSessionMcpRuntime, getSessionMcpRuntimeTestManager, unopenedMcpConfig } =
      await import("../agent-bundle-mcp-manager.test-support.js");
    const { setSessionMcpRuntimeScheduler } = await import("../agent-bundle-mcp-manager-api.js");
    const scheduler = createTestGatewayScheduler();
    onTestFinished(() => scheduler.stop());
    await setSessionMcpRuntimeScheduler(scheduler);
    const manager = getSessionMcpRuntimeTestManager();
    const create = (sessionId: string) =>
      getOrCreateSessionMcpRuntime({
        sessionId,
        sessionKey: fixture.currentTarget.sessionKey,
        workspaceDir: path.dirname(fixture.currentTarget.storePath),
        cfg: unopenedMcpConfig,
        manifestRegistry: { plugins: [] },
      });
    try {
      await create(fixture.currentTarget.sessionId);
      const successor = await create("rotated-session");
      await fixture.runtime.adoptCompactionTranscript(fixture.compactResult);
      expect(manager.peekSession({ sessionId: fixture.currentTarget.sessionId })).toBeUndefined();
      expect(manager.peekSession({ sessionId: successor.sessionId })).toBe(successor);
    } finally {
      await manager.disposeAll();
    }
  });

  it("forwards non-empty compaction hook messages as agent events", async () => {
    const fixture = await createRuntime();

    await fixture.runtime.onCompactionHookMessages({
      phase: "after",
      messages: ["", "Compaction complete"],
    });

    expect(fixture.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: {
        phase: "end",
        completed: true,
        messages: ["Compaction complete"],
      },
      sessionKey: "agent:main:session-1",
    });
  });
});
