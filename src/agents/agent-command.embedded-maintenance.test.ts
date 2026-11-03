/** Tests proactive embedded maintenance and final-reply lifecycle safety. */
import { randomUUID } from "node:crypto";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.context.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  readCompactionLifecyclePhases as readLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
  COMPACTION_ERROR,
  GATEWAY_INGRESS_ARGS,
} from "./agent-command.compaction.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { waitForSessionMaintenance } from "./session-maintenance/coordinator.js";

const {
  appendTranscriptEvent,
  appendTranscriptMessage,
  createAgentRunRestartAbortError,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
  rotateAgentEventLifecycleGeneration,
} = compactionTestRuntime;

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

function makeEmbeddedResult(sessionId: string, text: string) {
  return makeResult({ sessionId, text, runner: "embedded", agentHarnessId: "openclaw" });
}

async function advanceWork(advanceClock: () => void) {
  advanceClock();
  const operation = getCurrentSessionControllerOwner();
  if (!operation) {
    throw new Error("Expected the simulated command or maintenance owner");
  }
  // The mocked model/checkpoint has completed work, not silently stalled.
  // Sample the real watchdog so its one-second timer cannot decide the test outcome.
  operation.watchdog.progress("semantic", "fixture:work_completed");
  await operation.watchdog.tick();
  operation.abortSignal.throwIfAborted();
}

describe("agentCommand embedded maintenance", () => {
  it("keeps the completed foreground budget when maintenance invokes a retired callback", async () => {
    const sessionId = "foreground-compaction-budget";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const foreground = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      fixedTokens: 4_000,
      pendingTokens: 100,
    };
    let retiredObserver: RunEmbeddedAgentInternalParams["onCompactionRequestBudget"];
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      retiredObserver = params.onCompactionRequestBudget;
      retiredObserver?.(foreground);
      return makeEmbeddedResult(sessionId, "done");
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      retiredObserver?.({
        contextWindow: 200_000,
        reserveTokens: 20_000,
        fixedTokens: 10,
        pendingTokens: 0,
      });
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });

    await agentCommand({ message: "continue", sessionId, sessionKey });
    await waitForSessionMaintenance(sessionKey);

    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({ compactionRequestBudget: { ...foreground, pendingTokens: 0 } }),
    );
    expect(foreground.pendingTokens).toBe(100);
  });

  it("schedules retained maintenance when terminal cleanup rejects", async () => {
    const sessionId = "maintenance-after-cleanup-rejection";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const cleanupError = new Error("terminal cleanup failed");
    let terminalDeliveryCalls = 0;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      params.onCompactionRequestBudget?.({
        contextWindow: 32_768,
        reserveTokens: 8_192,
        fixedTokens: 4_000,
        pendingTokens: 100,
      });
      return makeEmbeddedResult(sessionId, "done");
    });

    await expect(
      agentCommand({
        message: "continue",
        sessionId,
        sessionKey,
        beforeTerminalDelivery: async () => {
          terminalDeliveryCalls += 1;
          if (terminalDeliveryCalls === 2) {
            throw cleanupError;
          }
        },
      }),
    ).rejects.toBe(cleanupError);
    await waitForSessionMaintenance(sessionKey);

    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionRequestBudget: expect.objectContaining({ pendingTokens: 0 }),
      }),
    );
  });

  it.each([462_153, 600_000])(
    "shares the command allowance after %i ms of foreground work",
    async (foregroundMs) => {
      const startedAt = Date.now();
      let now = startedAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => now - startedAt);
      const sessionId = `maintenance-budget-${foregroundMs}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const text = "completed foreground answer";
      let flushTimeout: number | undefined;
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        await advanceWork(() => {
          now += foregroundMs;
        });
        return makeEmbeddedResult(sessionId, text);
      });
      state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
        flushTimeout = params.followupRun.run.timeoutMs;
        await advanceWork(() => {
          now = startedAt + 600_000;
        });
        return { sessionEntry: params.sessionEntry, outcome: "completed" };
      });
      try {
        await agentCommand({ message: "continue", sessionId, sessionKey, timeout: "600" });
        await waitForSessionMaintenance(sessionKey);
        expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(
          foregroundMs < 600_000 ? 1 : 0,
        );
        expect(flushTimeout).toBe(foregroundMs < 600_000 ? 600_000 - foregroundMs : undefined);
        expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
        expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
          expect.objectContaining({ payloads: [{ text }] }),
        );
        expect(readLifecyclePhases()).toContain("end");
        expect(readLifecyclePhases()).not.toContain("error");
      } finally {
        await waitForSessionMaintenance(sessionKey);
        clock.mockRestore();
        monotonicClock.mockRestore();
      }
    },
  );

  it("keeps the maintenance allowance when the wall clock steps back", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const sessionId = "maintenance-clock-rewind";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    let flushTimeout: number | undefined;
    let compactionTimeout: number | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      await vi.advanceTimersByTimeAsync(400);
      return makeEmbeddedResult(sessionId, "answer after clock rewind");
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushTimeout = params.followupRun.run.timeoutMs;
      vi.setSystemTime(Date.now() - 600_000);
      await vi.advanceTimersByTimeAsync(200);
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    state.runSessionCompactionIfNeededMock.mockImplementationOnce(async (params) => {
      compactionTimeout = params.followupRun.run.timeoutMs;
      return params.sessionEntry;
    });
    try {
      await agentCommand({ message: "continue", sessionId, sessionKey, timeout: "1" });
      await waitForSessionMaintenance(sessionKey);
      expect(flushTimeout).toBe(600);
      expect(compactionTimeout).toBe(400);
    } finally {
      await waitForSessionMaintenance(sessionKey);
      vi.useRealTimers();
    }
  });

  it("drains expired maintenance without changing the completed reply", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const sessionId = "maintenance-expiry";
    const successorSessionId = "maintenance-expiry-successor";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const storePath = requireStorePath();
    const text = "answer survives maintenance expiry";
    const caller = new AbortController();
    let flushTimeout: number | undefined;
    let compactionTimeout: number | undefined;
    let maintenanceSignal: AbortSignal | undefined;
    let cleanupFinished = false;
    const onSessionIdChanged = vi.fn();
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      await vi.advanceTimersByTimeAsync(400);
      return makeEmbeddedResult(sessionId, text);
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushTimeout = params.followupRun.run.timeoutMs;
      await vi.advanceTimersByTimeAsync(200);
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    state.runSessionCompactionIfNeededMock.mockImplementationOnce(async (params) => {
      compactionTimeout = params.followupRun.run.timeoutMs;
      maintenanceSignal = params.abortSignal;
      const successor = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        lifecycleRevision: randomUUID(),
        compactionCount: (params.sessionEntry?.compactionCount ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry({ sessionKey, storePath }, successor);
      if (params.sessionStore) {
        params.sessionStore[sessionKey] = successor;
      }
      params.onCompactionCommitted?.({
        sessionId: successorSessionId,
        sessionFile: sessionKey,
        sessionTarget: { agentId: "main", sessionId: successorSessionId, sessionKey, storePath },
        entry: successor,
        previousSessionId: sessionId,
      });
      try {
        await vi.advanceTimersByTimeAsync(400);
        maintenanceSignal?.throwIfAborted();
        return successor;
      } finally {
        await Promise.resolve();
        cleanupFinished = true;
      }
    });
    state.deliverAgentCommandResultMock.mockImplementationOnce(
      async (params: { result: EmbeddedAgentRunResult }) => ({
        ...params.result,
        deliverySucceeded: true,
      }),
    );
    try {
      const result = await agentCommand({
        message: "continue",
        sessionId,
        sessionKey,
        timeout: "1",
        abortSignal: caller.signal,
        onSessionIdChanged,
      });
      expect(result).toMatchObject({
        meta: { agentMeta: { sessionId } },
      });
      await waitForSessionMaintenance(sessionKey);
      expect(flushTimeout).toBe(600);
      expect(compactionTimeout).toBe(400);
      expect(maintenanceSignal?.aborted).toBe(true);
      expect(maintenanceSignal?.reason).toMatchObject({ name: "AbortError" });
      expect(caller.signal.aborted).toBe(false);
      expect(cleanupFinished).toBe(true);
      expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(successorSessionId);
      expect(onSessionIdChanged).not.toHaveBeenCalled();
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text }],
          sessionEntry: expect.objectContaining({ sessionId }),
        }),
      );
      expect(readLifecyclePhases()).toContain("end");
      expect(readLifecyclePhases()).not.toContain("error");
    } finally {
      await waitForSessionMaintenance(sessionKey);
      vi.useRealTimers();
    }
  });

  it("preserves unlimited command maintenance after a long foreground turn", async () => {
    const startedAt = Date.now();
    let now = startedAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => now - startedAt);
    const sessionId = "maintenance-unlimited";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    let flushTimeout: number | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      await advanceWork(() => {
        now += 1_200_000;
      });
      return makeEmbeddedResult(sessionId, "unlimited answer");
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushTimeout = params.followupRun.run.timeoutMs;
      await advanceWork(() => {
        now += 600_000;
      });
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    try {
      await agentCommand({ message: "continue", sessionId, sessionKey, timeout: "0" });
      await waitForSessionMaintenance(sessionKey);
      expect(flushTimeout).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
        expect.objectContaining({
          followupRun: expect.objectContaining({
            run: expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
          }),
        }),
      );
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    } finally {
      await waitForSessionMaintenance(sessionKey);
      clock.mockRestore();
      monotonicClock.mockRestore();
    }
  });

  it("compacts persisted embedded turns after final delivery with memory flush disabled", async () => {
    const storePath = requireStorePath();
    const sessionId = "embedded-proactive-compaction";
    const successorSessionId = "embedded-proactive-successor";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const model = "gpt-5.6-luna";
    const text = "answer generated before proactive compaction";
    let maintenanceParams: Parameters<typeof state.runSessionCompactionIfNeededMock>[0] | undefined;
    let storedBeforeMaintenance: SessionEntry | undefined;
    let maintenanceAuthorized: boolean | undefined;
    state.cfg = {
      ...state.cfg,
      agents: {
        defaults: {
          model: { primary: `openai/${model}` },
          models: { [`openai/${model}`]: {} },
          compaction: { mode: "safeguard", memoryFlush: { enabled: false } },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test",
            api: "openai-responses",
            models: [
              {
                id: model,
                name: "GPT-5.6 Luna",
                reasoning: false,
                input: ["text"],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, updatedAt: Date.now(), compactionCount: 4 },
    );
    const lastCallUsage = {
      input: 3,
      output: 26,
      cacheRead: 904_813,
      cacheWrite: 53,
      total: 904_895,
    };
    const completed = makeResult({ sessionId, text, runner: "embedded" });
    completed.meta.agentMeta = {
      sessionId,
      provider: "openai",
      model,
      agentHarnessId: "openclaw",
      contextTokens: 922_000,
      promptTokens: 904_869,
      usage: lastCallUsage,
      lastCallUsage,
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      if (!params.userTurnTranscriptRecorder) {
        throw new Error("missing embedded user-turn transcript recorder");
      }
      await params.userTurnTranscriptRecorder.persistApproved();
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: "openai",
            model,
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              ...lastCallUsage,
              totalTokens: lastCallUsage.total,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          cwd: state.workspaceDir,
        },
      );
      await appendTranscriptEvent(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          type: "custom",
          customType: "openclaw:bootstrap-context:full",
          data: { runId: "embedded-run" },
        },
      );
      params.onSuccessfulAuthProfile?.({
        authProfileId: "openai:completed",
        authProfileIdSource: "user",
      });
      return completed;
    });
    state.runSessionCompactionIfNeededMock.mockImplementation(async (params) => {
      maintenanceParams = params;
      storedBeforeMaintenance = findStoredSessionEntry(sessionKey);
      maintenanceAuthorized = params.authorize?.();
      if (!params.sessionEntry || !params.sessionStore) {
        throw new Error("compaction fixture needs a persisted session");
      }
      const successor: SessionEntry = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        compactionCount: 5,
        totalTokens: 12_000,
        totalTokensFresh: true,
      };
      await replaceSessionEntry({ sessionKey, storePath }, successor);
      params.sessionStore[sessionKey] = successor;
      return successor;
    });

    await agentCommandFromGatewayIngress(
      {
        message: "Recall the marker.",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
    );

    await waitForSessionMaintenance(sessionKey);
    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      storePath,
    })) as Array<{
      type?: unknown;
      customType?: unknown;
      message?: { role?: unknown; api?: unknown };
    }>;
    const assistantEvents = events.filter(
      (event) => event.type === "message" && event.message?.role === "assistant",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents.filter((event) => event.message?.api === "cli")).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "custom" && event.customType === "openclaw:bootstrap-context:full",
      ),
    ).toHaveLength(1);
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledOnce();
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({ totalTokens: lastCallUsage.total }),
      }),
    );
    expect(storedBeforeMaintenance).toMatchObject({
      totalTokens: lastCallUsage.total,
      inputTokens: lastCallUsage.input,
      outputTokens: lastCallUsage.output,
      cacheRead: lastCallUsage.cacheRead,
      cacheWrite: lastCallUsage.cacheWrite,
    });
    expect(storedBeforeMaintenance?.pendingFinalDelivery).toBeUndefined();
    expect(maintenanceParams).toMatchObject({
      agentHarnessId: "openclaw",
      promptForEstimate: "",
      followupRun: {
        run: {
          sessionId,
          provider: "openai",
          model,
          senderIsOwner: false,
          authProfileId: "openai:completed",
          authProfileIdSource: "user",
        },
      },
    });
    expect(maintenanceAuthorized).toBe(true);
    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          meta: expect.objectContaining({
            agentMeta: expect.objectContaining({
              sessionId,
              promptTokens: 904_869,
              usage: lastCallUsage,
              lastCallUsage,
            }),
          }),
        }),
      }),
    );
    expect(state.deliveryFreshEntries.at(-1)?.sessionId).toBe(sessionId);
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      sessionId: successorSessionId,
      totalTokens: 12_000,
      totalTokensFresh: true,
      inputTokens: lastCallUsage.input,
      outputTokens: lastCallUsage.output,
      cacheRead: lastCallUsage.cacheRead,
      cacheWrite: lastCallUsage.cacheWrite,
    });
    expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
  });

  it.each([
    {
      retry: "model context",
      replaceWriter: false,
      initialTokens: 42,
      currentContextSnapshot: { tokens: 95_000 },
    },
    {
      retry: "model context",
      replaceWriter: true,
      initialTokens: 42,
      currentContextSnapshot: { tokens: 95_000 },
    },
    {
      retry: "custody only after unknown compaction",
      replaceWriter: false,
      initialTokens: undefined,
      currentContextSnapshot: undefined,
    },
  ])(
    "keeps count-zero retry $retry on its retained writer (replacement=$replaceWriter)",
    async ({ replaceWriter, initialTokens, currentContextSnapshot }) => {
      const sessionId = "retry-context-owner";
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const storePath = requireStorePath();
      let retainedWriter: string | undefined;
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        const target = params.sessionTarget;
        const entry = target ? loadSessionEntry(target) : undefined;
        if (!target || !entry) {
          throw new Error("expected the first candidate owner");
        }
        retainedWriter = entry.activeWriterRunId;
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: initialTokens },
          target: {
            ...target,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
        });
        throw new LiveSessionModelSwitchError({
          provider: params.providerOverride,
          model: params.modelOverride,
          authProfileId: "switched-profile",
          authProfileIdSource: "user",
        });
      });
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        const target = params.sessionTarget;
        if (!target) {
          throw new Error("expected the retry target");
        }
        if (replaceWriter) {
          await patchSessionEntryCore(target, () => ({
            activeWriterRunId: "replacement-writer",
            compactionCount: 7,
            totalTokens: 777,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          }));
        }
        const entry = loadSessionEntry(target);
        if (!entry) {
          throw new Error("expected the retry owner");
        }
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          ...(currentContextSnapshot ? { currentContextSnapshot } : {}),
          target: {
            ...target,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
        });
        const result = makeResult({ sessionId, text: "retry answer", runner: "embedded" });
        if (!currentContextSnapshot) {
          const usage = { input: 95_000, output: 10 };
          result.meta.agentMeta = {
            ...result.meta.agentMeta!,
            promptTokens: 95_000,
            usage,
            lastCallUsage: usage,
          };
        }
        return result;
      });

      await agentCommand({ message: "continue", sessionId, sessionKey });

      expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
      const stored = findStoredSessionEntry(sessionKey);
      expect(stored).toMatchObject({
        sessionId,
        compactionCount: replaceWriter ? 7 : 1,
        totalTokensFresh: replaceWriter || currentContextSnapshot !== undefined,
      });
      expect(stored?.totalTokens).toBe(replaceWriter ? 777 : currentContextSnapshot?.tokens);
      if (!currentContextSnapshot) {
        expect(stored).toMatchObject({ inputTokens: 95_000, outputTokens: 10 });
      }
      expect(loadSessionEntry({ sessionKey, storePath })?.activeWriterRunId).toBe(
        replaceWriter ? "replacement-writer" : retainedWriter,
      );
    },
  );

  const excludedEmbeddedRuns: Array<{
    name: string;
    opts?: Partial<Parameters<typeof agentCommand>[0]>;
    agentHarnessId?: string;
    meta?: Partial<EmbeddedAgentRunResult["meta"]>;
    observeAuth?: boolean;
    enabled?: boolean;
  }> = [
    { name: "native harness ownership", agentHarnessId: "codex" },
    { name: "an unavailable auth selection", observeAuth: false },
    { name: "disabled proactive compaction", enabled: false },
  ];
  it.each(excludedEmbeddedRuns)("does not add command compaction for $name", async (testCase) => {
    const sessionId = "excluded-embedded-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.cfg = {
      ...state.cfg,
      agents: {
        ...state.cfg?.agents,
        defaults: {
          ...state.cfg?.agents?.defaults,
          compaction: { enabled: testCase.enabled, memoryFlush: { enabled: false } },
        },
      },
    };
    const completed = makeResult({
      sessionId,
      text: "completed answer",
      runner: "embedded",
      agentHarnessId: testCase.agentHarnessId ?? "openclaw",
    });
    completed.meta = { ...completed.meta, ...testCase.meta };
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      if (testCase.observeAuth !== false) {
        params.onSuccessfulAuthProfile?.({});
      }
      return completed;
    });

    await agentCommand({ message: "continue", sessionId, sessionKey, ...testCase.opts });
    await waitForSessionMaintenance(sessionKey);

    expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    if (testCase.observeAuth === false) {
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    }
  });

  it.each(
    (
      [
        ["restart-during-compaction", "reply awaiting transport before restart"],
        ["restart-after-successful-compaction", "reply awaiting transport after compaction"],
        ["stale-during-compaction", "reply retained by its original gateway lifecycle"],
      ] as const
    ).map(([phase, text]) => ({ phase, text })),
  )("does not deliver or clear the pending CLI final for $phase", async ({ phase, text }) => {
    const runner = "cli";
    const sessionId = `${runner}-${phase}`;
    const restart = phase !== "stale-during-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const abortController = new AbortController();
    let pendingFinalDelivery: SessionEntry["pendingFinalDelivery"];
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      return makeResult({ sessionId, text, runner, agentHarnessId: "openclaw" });
    });
    const compact = async (params: { sessionEntry?: SessionEntry }) => {
      pendingFinalDelivery = params.sessionEntry?.pendingFinalDelivery;
      expect(pendingFinalDelivery).toEqual({
        kind: "transport-only",
        intentId: expect.any(String),
        deliveries: [{ id: expect.any(String), state: "prepared" }],
        createdAt: expect.any(Number),
        context: { channel: "discord", to: "discord:dm:123", accountId: "main" },
      });
      expect(pendingFinalDelivery?.intentId).not.toBe("");
      expect(pendingFinalDelivery?.deliveries?.[0]?.id).not.toBe("");
      if (restart) {
        abortController.abort(createAgentRunRestartAbortError());
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      if (phase === "restart-after-successful-compaction") {
        return params.sessionEntry;
      }
      throw new Error(COMPACTION_ERROR);
    };
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(compact);

    await expect(
      agentCommand({
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toEqual(pendingFinalDelivery);
  });

  it("preserves the completed embedded reply when background maintenance loses its lifecycle", async () => {
    const runner = "embedded";
    const sessionId = `${runner}-background-lifecycle`;
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "completed before maintenance retired";
    let entryBeforeRotation: SessionEntry | undefined;
    let maintenanceSignal: AbortSignal | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      return makeResult({ sessionId, text, runner, agentHarnessId: "openclaw" });
    });
    const compact = async (params: { sessionEntry?: SessionEntry; abortSignal?: AbortSignal }) => {
      entryBeforeRotation = params.sessionEntry;
      maintenanceSignal = params.abortSignal;
      rotateAgentEventLifecycleGeneration();
      params.abortSignal?.throwIfAborted();
      throw new Error("retired maintenance unexpectedly remained active");
    };
    state.runSessionCompactionIfNeededMock.mockImplementationOnce(compact);

    await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });
    await waitForSessionMaintenance(sessionKey);

    expect(entryBeforeRotation?.pendingFinalDelivery).toBeUndefined();
    expect(maintenanceSignal?.aborted).toBe(true);
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
    expect(readLifecyclePhases()).toContain("end");
    expect(readLifecyclePhases()).not.toContain("error");
  });

  it.each([
    { runner: "cli", expiry: false },
    { runner: "embedded", expiry: false },
    { runner: "cli", expiry: true },
  ] as const)(
    "preserves $runner local maintenance failure policy (expiry: $expiry)",
    async ({ runner, expiry }) => {
      const sessionId = `${runner}-background-failure-${expiry}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      if (expiry) {
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      }
      try {
        state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
          params.onSuccessfulAuthProfile?.({});
          return makeResult({ sessionId, text: "local final", runner, agentHarnessId: "openclaw" });
        });
        const compact =
          runner === "embedded"
            ? state.runSessionCompactionIfNeededMock
            : state.runCliTurnCompactionLifecycleMock;
        if (expiry) {
          state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
            await vi.advanceTimersByTimeAsync(1_000);
            params.abortSignal?.throwIfAborted();
            throw new Error(COMPACTION_ERROR);
          });
        } else {
          compact.mockRejectedValueOnce(new Error(COMPACTION_ERROR));
        }

        const command = agentCommand({
          message: "local model run",
          sessionId,
          sessionKey,
          json: true,
          deliver: false,
          ...(expiry ? { timeout: "1" } : {}),
        });
        if (runner === "cli" && !expiry) {
          await expect(command).rejects.toThrow("Summarization failed: Connection error");
          expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
        } else {
          await command;
          await waitForSessionMaintenance(sessionKey);
          expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
            expect.objectContaining({
              opts: expect.objectContaining({ json: true, deliver: false }),
              payloads: [{ text: "local final" }],
            }),
          );
          expect(readLifecyclePhases()).toContain("end");
          expect(readLifecyclePhases()).not.toContain("error");
        }
        expect(compact).toHaveBeenCalledOnce();
        expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
      } finally {
        await waitForSessionMaintenance(sessionKey);
        if (expiry) {
          vi.useRealTimers();
        }
      }
    },
  );
});
