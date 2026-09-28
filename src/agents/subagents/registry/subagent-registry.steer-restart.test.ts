// Subagent registry steer-restart tests cover replacing child runs after steer
// commands while preserving lifecycle hooks and completion delivery.

import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import * as gatewayCallRuntime from "../../../gateway/call.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";

const noop = () => {};
let lifecycleHandler:
  | ((evt: {
      stream?: string;
      runId: string;
      data?: {
        phase?: string;
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        error?: string;
        stopReason?: string;
      };
    }) => void)
  | undefined;

const sessionStore = vi.hoisted(
  () =>
    new Proxy<Record<string, { sessionId: string; lifecycleRevision: string; updatedAt: number }>>(
      {},
      {
        get(target, prop, receiver) {
          if (typeof prop !== "string" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return {
            sessionId: `sess-${prop}`,
            lifecycleRevision: `revision-${prop}`,
            updatedAt: 1,
          };
        },
      },
    ),
);

const gatewayCall = vi
  .spyOn(gatewayCallRuntime, "callGateway")
  .mockImplementation(async (request) => {
    if (request.method === "agent.wait") {
      return { status: "pending" };
    }
    return {};
  });
afterAll(() => gatewayCall.mockRestore());

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../../../config/sessions.js", () => {
  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  loadSessionEntryReadOnly: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  patchSessionEntryCore: async () => null,
}));

const announceSpy = vi.fn(
  async (_params: unknown): Promise<"delivered" | "retryable"> => "delivered",
);
const runSubagentEndedHookMock = vi.fn(async (_eventValue?: unknown, _ctx?: unknown) => {});
const emitSessionLifecycleEventMock = vi.hoisted(() => vi.fn());
const removeInternalSessionEffectsSessionMock = vi.fn(async (_target?: unknown) => {});

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

const requireRecord = createRequireRecord("record", "expected-label");

function requireSubagentEndedHookCall(runId: string): {
  event: Record<string, unknown>;
  ctx: Record<string, unknown>;
} {
  const call = runSubagentEndedHookMock.mock.calls.find((candidate) => {
    const ctx = candidate[1] as { runId?: string } | undefined;
    return ctx?.runId === runId;
  });
  if (!call) {
    throw new Error(`expected subagent_ended hook call for ${runId}`);
  }
  return {
    event: requireRecord(call[0], `${runId} subagent_ended event`),
    ctx: requireRecord(call[1], `${runId} subagent_ended context`),
  };
}

function requireSessionLifecycleEventCall(label: string): Record<string, unknown> {
  const call = emitSessionLifecycleEventMock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return requireRecord(call[0], label);
}

function requireFirstAnnounceCall(): Record<string, unknown> {
  const call = announceSpy.mock.calls[0];
  if (!call) {
    throw new Error("expected announce call");
  }
  return requireRecord(call[0], "announce params");
}

const noopContextEngine = {
  info: { id: "test-context-engine", name: "Test context engine" },
  ingest: async () => ({ ingested: false }),
  assemble: async () => ({ messages: [], estimatedTokens: 0 }),
  compact: async () => ({ ok: true, compacted: false }),
} satisfies ContextEngine;
vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../../../context-engine/init.js", () => ({ ensureContextEnginesInitialized: vi.fn() }));
vi.mock("../../../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(async () => noopContextEngine),
}));
vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return { loadAgentRuntimePluginRegistryHandle: vi.fn(() => createEmptyPluginRegistry()) };
});

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
  getGlobalPluginRegistry: vi.fn(() => null),
  hasGlobalHooks: vi.fn((hookName: string) => hookName === "subagent_ended"),
  initializeGlobalHookRunner: vi.fn(),
  resetGlobalHookRunner: vi.fn(),
}));

vi.mock("../../../sessions/session-lifecycle-events.js", async (importOriginal) => {
  const { onSessionIdentityMutation } =
    await importOriginal<typeof import("../../../sessions/session-lifecycle-events.js")>();
  return { emitSessionLifecycleEvent: emitSessionLifecycleEventMock, onSessionIdentityMutation };
});

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: removeInternalSessionEffectsSessionMock,
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.test-helpers.js");
  type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];
  const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
  const MAIN_REQUESTER_DISPLAY_KEY = "main";

  beforeAll(async () => {
    mod = await import("./subagent-registry.test-helpers.js");
  });

  beforeEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(sessionStore)) {
      delete sessionStore[key];
    }
    lifecycleHandler = undefined;
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    removeInternalSessionEffectsSessionMock.mockClear();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };
  const createDeferredAnnounce = () => {
    const entered = createDeferred();
    const delivery = createDeferred<"delivered" | "retryable">();
    announceSpy.mockImplementationOnce(() => {
      entered.resolve();
      return delivery.promise;
    });
    return { entered: entered.promise, resolve: delivery.resolve };
  };

  const registerCompletionModeRun = (
    runId: string,
    childSessionKey: string,
    task: string,
    options: Partial<Pick<RegisterSubagentRunInput, "spawnMode">> = {},
  ) => {
    return registerRun({
      runId,
      childSessionKey,
      task,
      expectsCompletionMessage: true,
      requesterOrigin: {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
      },
      ...options,
    });
  };

  const registerRun = (
    params: {
      runId: string;
      childSessionKey: string;
      task: string;
      requesterSessionKey?: string;
      requesterDisplayKey?: string;
    } & Partial<
      Pick<RegisterSubagentRunInput, "spawnMode" | "requesterOrigin" | "expectsCompletionMessage">
    >,
  ) => {
    sessionStore[params.childSessionKey] = {
      sessionId: `sess-${params.childSessionKey}`,
      lifecycleRevision: `revision-${params.childSessionKey}`,
      updatedAt: 1,
    };
    return mod.registerSubagentRun({
      runId: params.runId,
      childSessionKey: params.childSessionKey,
      requesterSessionKey: params.requesterSessionKey ?? MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: params.requesterDisplayKey ?? MAIN_REQUESTER_DISPLAY_KEY,
      requesterOrigin: params.requesterOrigin,
      task: params.task,
      cleanup: "keep",
      spawnMode: params.spawnMode,
      expectsCompletionMessage: params.expectsCompletionMessage,
    });
  };

  const listMainRuns = () => mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);

  const emitLifecycleEnd = (
    runId: string,
    data: {
      startedAt?: number;
      endedAt?: number;
      aborted?: boolean;
      error?: string;
      stopReason?: string;
      terminalReply?: { disposition: "visible"; text: string } | { disposition: "empty" };
    } = {},
  ) => {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      data: {
        phase: "end",
        terminalReply: { disposition: "visible", text: "final completion reply" },
        ...data,
      },
    });
  };

  const replaceRunAfterSteer = (params: {
    previousRunId: string;
    nextRunId: string;
    fallback?: ReturnType<typeof listMainRuns>[number];
    transcriptTarget?: {
      agentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    };
    task?: string;
    lifecycleGeneration?: string;
    preserveFrozenResultFallback?: boolean;
  }) => {
    if (params.fallback && listMainRuns().includes(params.fallback)) {
      persistSubagentRunsToDiskOrThrow(subagentRuns, [params.previousRunId]);
    }
    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: params.previousRunId,
      nextRunId: params.nextRunId,
      fallback: params.fallback,
      transcriptTarget: params.transcriptTarget,
      task: params.task,
      lifecycleGeneration: params.lifecycleGeneration,
      preserveFrozenResultFallback: params.preserveFrozenResultFallback,
    });
    expect(replaced).toBe(true);

    const runs = listMainRuns();
    expect(runs).toHaveLength(1);
    const run = expectDefined(runs[0], "replacement run");
    expect(run.runId).toBe(params.nextRunId);
    return run;
  };

  afterEach(async () => {
    vi.useRealTimers();
    await settleSubagentRegistryPersistenceWork();
    announceSpy.mockReset();
    announceSpy.mockResolvedValue("delivered");
    runSubagentEndedHookMock.mockReset();
    runSubagentEndedHookMock.mockImplementation(async () => {});
    emitSessionLifecycleEventMock.mockReset();
    lifecycleHandler = undefined;
    removeInternalSessionEffectsSessionMock.mockClear();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("honors persisted steer suppression and only announces the replacement run", async () => {
    const settleRootWork = observeRootWork();
    try {
      await registerRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:steer",
        task: "initial task",
      });

      const previous = expectDefined(listMainRuns()[0], "registered run");
      expect(previous.runId).toBe("run-old");
      previous.suppressAnnounceReason = "steer-restart";

      emitLifecycleEnd("run-old");

      await settleSubagentRegistryPersistenceWork(() => settleRootWork(true));
      expect(announceSpy).not.toHaveBeenCalled();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      expect(emitSessionLifecycleEventMock).not.toHaveBeenCalled();

      replaceRunAfterSteer({
        previousRunId: "run-old",
        nextRunId: "run-new",
        fallback: previous,
      });

      emitLifecycleEnd("run-new");

      await settleSubagentRegistryPersistenceWork(() => settleRootWork(true));
      expect(announceSpy).toHaveBeenCalledTimes(1);
      const matchingCalls = runSubagentEndedHookMock.mock.calls.filter((call) => {
        const ctx = call[1] as { runId?: string } | undefined;
        return ctx?.runId === "run-new";
      });
      expect(matchingCalls).toHaveLength(1);
      const hookCall = requireSubagentEndedHookCall("run-new");
      expect(hookCall.event.runId).toBe("run-new");
      expect(hookCall.ctx.runId).toBe("run-new");

      const announce = requireFirstAnnounceCall();
      expect(announce.childRunId).toBe("run-new");
    } finally {
      await settleRootWork();
    }
  });

  it("defers subagent_ended hook for completion-mode runs until announce delivery resolves", async () => {
    const announce = createDeferredAnnounce();
    await registerCompletionModeRun(
      "run-completion-delayed",
      "agent:main:subagent:completion-delayed",
      "completion-mode task",
    );
    try {
      emitLifecycleEnd("run-completion-delayed");
      await announce.entered;
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      announce.resolve("delivered");
      await settleSubagentRegistryPersistenceWork();
      expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      const hookCall = requireSubagentEndedHookCall("run-completion-delayed");
      expect(hookCall.event.targetSessionKey).toBe("agent:main:subagent:completion-delayed");
      expect(hookCall.event.reason).toBe("subagent-complete");
      expect(hookCall.event.sendFarewell).toBe(true);
      expect(hookCall.ctx.runId).toBe("run-completion-delayed");
      expect(hookCall.ctx.requesterSessionKey).toBe(MAIN_REQUESTER_SESSION_KEY);
    } finally {
      announce.resolve("delivered");
    }
  });

  it("does not emit subagent_ended on completion for persistent session-mode runs", async () => {
    const announce = createDeferredAnnounce();
    await registerCompletionModeRun(
      "run-persistent-session",
      "agent:main:subagent:persistent-session",
      "persistent session task",
      { spawnMode: "session" },
    );
    try {
      emitLifecycleEnd("run-persistent-session");
      await announce.entered;
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      announce.resolve("delivered");
      await settleSubagentRegistryPersistenceWork();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      const run = listMainRuns()[0];
      expect(run?.runId).toBe("run-persistent-session");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
      expect(run?.endedHookEmittedAt).toBeUndefined();
    } finally {
      announce.resolve("delivered");
    }
  });

  it("clears terminal lifecycle state when replacing after steer restart", async () => {
    await registerRun({
      runId: "run-terminal-state-old",
      childSessionKey: "agent:main:subagent:terminal-state",
      task: "terminal state",
    });
    const previous = expectDefined(listMainRuns()[0], "registered run");
    const endedAt = Date.now();
    previous.endedHookEmittedAt = endedAt;
    previous.endedReason = "subagent-error";
    previous.terminalOwner = "interrupted-recovery";
    previous.execution = { status: "terminal", endedAt, outcome: { status: "error" } };
    previous.completion = { required: true, resultText: "stale completion", capturedAt: endedAt };
    previous.cleanupCompletedAt = endedAt;
    previous.cleanupHandled = true;
    previous.delivery = {
      status: "suspended",
      attemptCount: 2,
      lastAttemptAt: endedAt,
      enqueuedAt: endedAt,
      deliveredAt: endedAt,
      announcedAt: endedAt,
      lastDropReason: "sink_unavailable",
      lastError: "gateway request timeout for agent",
      payload: {
        childRunId: previous.runId,
        childSessionKey: previous.childSessionKey,
        requesterSessionKey: previous.requesterSessionKey,
        requesterDisplayKey: previous.requesterDisplayKey,
        task: previous.task,
        endedAt,
      },
      suspendedAt: endedAt,
      suspendedReason: "expiry",
    };

    const run = replaceRunAfterSteer({
      previousRunId: previous.runId,
      nextRunId: "run-terminal-state-new",
      fallback: previous,
      lifecycleGeneration: "test-generation",
    });
    expect(run.task).toBe(previous.task);
    expect(run.execution).toMatchObject({
      status: "running",
      lifecycleGeneration: "test-generation",
    });
    for (const key of [
      "endedHookEmittedAt",
      "endedReason",
      "terminalOwner",
      "cleanupCompletedAt",
    ] as const) {
      expect(run[key], key).toBeUndefined();
    }
    expect(run.execution.endedAt).toBeUndefined();
    expect(run.completion?.resultText).toBeUndefined();
    expect(run.completion?.capturedAt).toBeUndefined();
    expect(run.cleanupHandled).toBe(false);
    expect(run.delivery).toEqual({ status: "pending" });

    const settleRootWork = observeRootWork();
    try {
      emitLifecycleEnd(run.runId);
      await settleRootWork(true);
      const hookCall = requireSubagentEndedHookCall(run.runId);
      expect(hookCall.event.runId).toBe(run.runId);
      expect(hookCall.ctx.runId).toBe(run.runId);
      expect(requireSessionLifecycleEventCall("replacement lifecycle event")).toMatchObject({
        sessionKey: previous.childSessionKey,
        reason: "subagent-status",
      });
    } finally {
      await settleRootWork();
    }
  });

  it("updates task to the dispatched steer message when provided", async () => {
    // Restart recovery must redispatch the steer instruction, not the original task.
    await registerRun({
      runId: "run-steer-task-old",
      childSessionKey: "agent:main:subagent:steer-task",
      task: "original pre-steer task",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-steer-task-old");
    expect(previous?.taskRunId).toBe("run-steer-task-old");
    expect(previous?.generation).toBe(1);

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-steer-task-old",
        nextRunId: "run-steer-task-new",
        fallback: previous,
        task: "new steer instruction from user",
      }),
      'replaceRunAfterSteer({ previousRunId: "run-steer-task-old", nextRunId... test invariant',
    );

    expect(run.task).toBe("new steer instruction from user");
    expect(run.taskRunId).toBe("run-steer-task-old");
    expect(run.generation).toBe(2);
  });

  it("advances the generation from a fallback outside the live registry", async () => {
    await registerRun({
      runId: "run-fallback-generation-old",
      childSessionKey: "agent:main:subagent:fallback-generation",
      task: "restored replacement source",
    });
    const fallback = expectDefined(
      replaceRunAfterSteer({
        previousRunId: "run-fallback-generation-old",
        nextRunId: "run-fallback-generation-restored",
      }),
      "restored fallback run",
    );
    subagentRuns.delete(fallback.runId);

    const run = expectDefined(
      replaceRunAfterSteer({
        previousRunId: fallback.runId,
        nextRunId: "run-fallback-generation-new",
        fallback,
      }),
      'replaceRunAfterSteer({ previousRunId: fallback.runId, nextRunId: "run... test invariant',
    );

    expect(run.generation).toBe(3);
  });

  it("preserves cumulative session timing across steer replacement runs", async () => {
    await registerRun({
      runId: "run-runtime-old",
      childSessionKey: "agent:main:subagent:runtime",
      task: "keep timing stable",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-runtime-old");
    if (!previous) {
      throw new Error("missing previous run");
    }

    previous.execution.startedAt = 1_000;
    previous.sessionStartedAt = 1_000;
    previous.execution.endedAt = 121_000;
    previous.accumulatedRuntimeMs = 0;
    previous.execution.outcome = { status: "ok" };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);

    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-runtime-old",
      nextRunId: "run-runtime-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const next = listMainRuns().find((entry) => entry.runId === "run-runtime-new");
    if (next === undefined) {
      throw new Error("expected restarted run");
    }
    expect(mod.getSubagentSessionStartedAt(next)).toBe(1_000);
    expect(next.accumulatedRuntimeMs).toBe(120_000);

    if (!next.execution.startedAt) {
      throw new Error("missing next startedAt");
    }
    next.execution.endedAt = next.execution.startedAt + 30_000;
    expect(mod.getSubagentSessionRuntimeMs(next, next.execution.endedAt)).toBe(150_000);
  });

  it("rejects a replacement owned by a retired Gateway lifecycle", async () => {
    await registerRun({
      runId: "run-retired-generation-old",
      childSessionKey: "agent:main:subagent:retired-generation",
      task: "keep the current owner",
    });

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-retired-generation-old",
        nextRunId: "run-retired-generation-new",
        lifecycleGeneration: "retired-generation",
      }),
    ).toBe(false);
    expect(listMainRuns()).toEqual([
      expect.objectContaining({ runId: "run-retired-generation-old" }),
    ]);
  });

  it("rolls back a generation-owned replacement when persistence fails", async () => {
    await registerRun({
      runId: "run-generation-persist-old",
      childSessionKey: "agent:main:subagent:generation-persist",
      task: "preserve the source owner",
    });
    const database = openOpenClawStateDatabase().db;
    database.exec(`CREATE TEMP TRIGGER reject_generation_replacement
      BEFORE INSERT ON subagent_runs
      WHEN NEW.run_id = 'run-generation-persist-new'
      BEGIN SELECT RAISE(ABORT, 'replacement unavailable'); END`);
    try {
      expect(
        mod.replaceSubagentRunAfterSteerCore({
          previousRunId: "run-generation-persist-old",
          nextRunId: "run-generation-persist-new",
          lifecycleGeneration: "test-generation",
        }),
      ).toBe(false);
    } finally {
      database.exec("DROP TRIGGER reject_generation_replacement");
    }
    expect(listMainRuns()).toEqual([
      expect.objectContaining({ runId: "run-generation-persist-old" }),
    ]);
  });

  it("preserves frozen completion as fallback when replacing for wake continuation", async () => {
    await registerRun({
      runId: "run-wake-old",
      childSessionKey: "agent:main:subagent:wake",
      task: "wake result fallback",
    });

    const previous = listMainRuns()[0];
    expect(previous?.runId).toBe("run-wake-old");
    if (previous) {
      previous.completion = {
        required: true,
        resultText: "final summary before wake",
        capturedAt: 1234,
      };
      persistSubagentRunsToDiskOrThrow(subagentRuns, [previous.runId]);
    }

    const replaced = mod.replaceSubagentRunAfterSteerCore({
      previousRunId: "run-wake-old",
      nextRunId: "run-wake-new",
      fallback: previous,
      preserveFrozenResultFallback: true,
    });
    expect(replaced).toBe(true);

    const run = listMainRuns().find((entry) => entry.runId === "run-wake-new");
    if (!run) {
      throw new Error("expected wake replacement run");
    }
    expect(run.completion?.resultText).toBeUndefined();
    expect(run.completion?.fallbackResultText).toBe("final summary before wake");
    expect(run.completion?.fallbackCapturedAt).toBe(1234);
  });

  it("recovers announce cleanup when completion arrives after a kill marker", async () => {
    const childSessionKey = "agent:main:subagent:kill-race";
    await registerRun({
      runId: "run-kill-race",
      childSessionKey,
      task: "race test",
    });

    const activeRun = expectDefined(listMainRuns()[0], "registered run");
    activeRun.execution = {
      ...activeRun.execution,
      transcriptTarget: {
        agentId: "main",
        sessionId: "recovered-subagent",
        sessionKey: "agent:main:internal-session-effects:recovered-subagent",
        storePath: "/tmp/test-store",
      },
    };
    // Registration alone does not own an executor; the admitted transition has an owner test.
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
    expect(mod.markSubagentRunTerminated({ childSessionKey, reason: "manual kill" })).toBe(1);
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
    const killed = expectDefined(listMainRuns()[0], "provisional kill");
    expect(killed.suppressAnnounceReason).toBe("killed");
    expect(killed.execution.outcome?.status).toBe("error");
    expect(killed.execution.outcome?.error).toBe("manual kill");
    expect(killed.execution.outcome?.startedAt).toBeTypeOf("number");
    expect(killed.execution.outcome?.endedAt).toBeTypeOf("number");
    expect(killed.execution.outcome?.elapsedMs).toBeTypeOf("number");
    expect(killed.execution.outcome?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(killed.execution.outcome?.endedAt).toBeGreaterThanOrEqual(
      killed.execution.outcome?.startedAt ?? 0,
    );
    expect(killed.cleanupHandled).toBe(true);
    expect(killed.cleanupCompletedAt).toBeTypeOf("number");
    await flushAnnounce();
    expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
    expect(removeInternalSessionEffectsSessionMock).not.toHaveBeenCalled();

    emitLifecycleEnd("run-kill-race");
    await settleSubagentRegistryPersistenceWork();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = requireFirstAnnounceCall();
    expect(announce.childRunId).toBe("run-kill-race");

    const run = listMainRuns()[0];
    expect(run?.endedReason).toBe("subagent-complete");
    expect(run?.execution.outcome?.status).not.toBe("error");
    expect(run?.suppressAnnounceReason).toBeUndefined();
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    expect(runSubagentEndedHookMock).toHaveBeenCalledOnce();
    const hookCall = requireSubagentEndedHookCall("run-kill-race");
    expect(hookCall.event.reason).toBe("subagent-complete");
    expect(hookCall.event.outcome).toBe("ok");
    expect(hookCall.event.error).toBeUndefined();
  });

  it("retries deferred parent cleanup after a descendant announces", async () => {
    let parentAttempts = 0;
    announceSpy.mockImplementation(async (params: unknown) => {
      const typed = params as { childRunId?: string };
      if (typed.childRunId === "run-parent") {
        parentAttempts += 1;
        return parentAttempts >= 2 ? "delivered" : "retryable";
      }
      return "delivered";
    });

    await registerRun({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      task: "parent task",
    });
    await registerRun({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:parent:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "child task",
    });

    const settleRootWork = observeRootWork();
    try {
      emitLifecycleEnd("run-parent");
      await settleRootWork(true);
      const initialChildRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(countMatching(initialChildRunIds, (id) => id === "run-parent")).toBe(1);

      emitLifecycleEnd("run-child");
      await settleRootWork(true);
      {
        const childRunIds = announceSpy.mock.calls.map(
          (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
        );
        expect(countMatching(childRunIds, (id) => id === "run-parent")).toBe(2);
        expect(countMatching(childRunIds, (id) => id === "run-child")).toBe(1);
      }

      const childRunIds = announceSpy.mock.calls.map(
        (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
      );
      expect(countMatching(childRunIds, (id) => id === "run-parent")).toBe(2);
      expect(countMatching(childRunIds, (id) => id === "run-child")).toBe(1);
    } finally {
      await settleRootWork();
    }
  });

  it("retries completion delivery beyond three attempts and suspends at its deadline", async () => {
    {
      vi.useFakeTimers();
      const settleRootWork = observeRootWork();
      try {
        announceSpy.mockResolvedValue("retryable");

        await registerCompletionModeRun(
          "run-completion-retry",
          "agent:main:subagent:completion",
          "completion retry",
        );

        emitLifecycleEnd("run-completion-retry");

        await vi.advanceTimersByTimeAsync(0);
        await settleRootWork(true);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(listMainRuns()[0]?.delivery?.attemptCount).toBe(1);

        const retryWindowEnd = Date.now() + 5 * 60_000;
        while (Date.now() < retryWindowEnd) {
          const nextAttemptAt = expectDefined(
            listMainRuns()[0]?.delivery?.nextAttemptAt,
            "scheduled completion retry",
          );
          expect(nextAttemptAt).toBeGreaterThan(Date.now());
          await vi.advanceTimersByTimeAsync(Math.min(nextAttemptAt, retryWindowEnd) - Date.now());
          await settleRootWork(true);
        }
        expect(announceSpy.mock.calls.length).toBeGreaterThan(3);
        expect(listMainRuns()[0]?.delivery?.status).not.toBe("suspended");

        const deadlineAt = listMainRuns()[0]?.delivery?.deadlineAt;
        expect(deadlineAt).toBeTypeOf("number");
        vi.setSystemTime((deadlineAt ?? Date.now()) + 1);
        mod.resumeSubagentRun("run-completion-retry");
        await vi.advanceTimersByTimeAsync(0);
        await settleRootWork(true);
        const run = listMainRuns()[0];
        expect(run?.delivery?.status).toBe("suspended");
        expect(run?.delivery?.suspendedAt).toBeTypeOf("number");
        expect(run?.delivery?.suspendedReason).toBe("expiry");
        expect(run?.cleanupCompletedAt).toBeUndefined();
      } finally {
        vi.useRealTimers();
        await settleRootWork();
      }
    }
  });

  it("keeps completion cleanup pending while descendants are still active", async () => {
    announceSpy.mockResolvedValue("retryable");

    await registerCompletionModeRun(
      "run-parent-expiry",
      "agent:main:subagent:parent-expiry",
      "parent completion expiry",
    );
    await registerRun({
      runId: "run-child-active",
      childSessionKey: "agent:main:subagent:parent-expiry:subagent:child-active",
      requesterSessionKey: "agent:main:subagent:parent-expiry",
      requesterDisplayKey: "parent-expiry",
      task: "child still running",
    });

    emitLifecycleEnd("run-parent-expiry", {
      startedAt: Date.now() - 7 * 60_000,
      endedAt: Date.now() - 6 * 60_000,
    });

    await flushAnnounce();

    const parentHookCall = runSubagentEndedHookMock.mock.calls.find((call) => {
      const event = call[0] as { runId?: string; reason?: string };
      return event.runId === "run-parent-expiry" && event.reason === "subagent-complete";
    });
    expect(parentHookCall).toBeUndefined();
    const parent = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((entry) => entry.runId === "run-parent-expiry");
    expect(parent?.cleanupCompletedAt).toBeUndefined();
    expect(parent?.cleanupHandled).toBe(false);
  });
});
