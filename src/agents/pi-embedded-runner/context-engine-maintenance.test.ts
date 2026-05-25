import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  enqueueCommandInLane,
  resetCommandQueueStateForTest,
} from "../../process/command-queue.js";
import * as commandQueueModule from "../../process/command-queue.js";
import { createQueuedTaskRun } from "../../tasks/task-executor.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import {
  getTaskById,
  listTasksForOwnerKey,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-registry.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { resolveSessionLane } from "./lanes.js";

const rewriteTranscriptEntriesInSessionManagerMock = vi.fn((_params?: unknown) => ({
  changed: true,
  bytesFreed: 77,
  rewrittenEntries: 1,
}));
const rewriteTranscriptEntriesInSessionFileMock = vi.fn(async (_params?: unknown) => ({
  changed: true,
  bytesFreed: 123,
  rewrittenEntries: 2,
}));
let buildContextEngineMaintenanceRuntimeContext: typeof import("./context-engine-maintenance.js").buildContextEngineMaintenanceRuntimeContext;
let cancelActiveDeferredTurnMaintenanceRunsForCliExit: typeof import("./context-engine-maintenance.js").cancelActiveDeferredTurnMaintenanceRunsForCliExit;
let createDeferredTurnMaintenanceAbortSignal: typeof import("./context-engine-maintenance.js").createDeferredTurnMaintenanceAbortSignal;
let resetDeferredTurnMaintenanceStateForTest: typeof import("./context-engine-maintenance.js").resetDeferredTurnMaintenanceStateForTest;
let runContextEngineMaintenance: typeof import("./context-engine-maintenance.js").runContextEngineMaintenance;
// Keep this literal aligned with the production module; tests use dynamic
// import reloading, so they cannot safely import the constant directly.
const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const DEFERRED_TURN_MAINTENANCE_CLI_EXIT_HOOK_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceCliExitHook",
);

async function flushAsyncWork(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 2_000,
  stepMs = 5,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await vi.advanceTimersByTimeAsync(stepMs);
      await flushAsyncWork();
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function firstMaintainParams(maintain: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return requireRecord(maintain.mock.calls[0]?.[0], "maintain params");
}

function expectRecordFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key]).toBe(value);
  }
}

function expectSystemEventContaining(sessionKey: string, text: string) {
  expect(peekSystemEvents(sessionKey).join("\n")).toContain(text);
}

vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({ llm: undefined }),
}));

vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionManager: (params: unknown) =>
    rewriteTranscriptEntriesInSessionManagerMock(params),
  rewriteTranscriptEntriesInSessionFile: (params: unknown) =>
    rewriteTranscriptEntriesInSessionFileMock(params),
}));

async function loadFreshContextEngineMaintenanceModuleForTest() {
  ({
    buildContextEngineMaintenanceRuntimeContext,
    cancelActiveDeferredTurnMaintenanceRunsForCliExit,
    createDeferredTurnMaintenanceAbortSignal,
    resetDeferredTurnMaintenanceStateForTest,
    runContextEngineMaintenance,
  } = await import("./context-engine-maintenance.js"));
  resetDeferredTurnMaintenanceStateForTest();
}

describe("buildContextEngineMaintenanceRuntimeContext", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    resetSystemEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("adds a transcript rewrite helper that targets the current session file", async () => {
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      runtimeContext: { workspaceDir: "/tmp/workspace" },
    });

    expect(runtimeContext.workspaceDir).toBe("/tmp/workspace");
    if (!runtimeContext.rewriteTranscriptEntries) {
      throw new Error("expected transcript rewrite helper");
    }

    const result = await runtimeContext.rewriteTranscriptEntries({
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      changed: true,
      bytesFreed: 123,
      rewrittenEntries: 2,
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: undefined,
      request: {
        replacements: [
          { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
        ],
      },
    });
  });

  it("reuses the active session manager when one is provided", async () => {
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      sessionManager,
    });

    const result = await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });

    expect(result).toEqual({
      changed: true,
      bytesFreed: 77,
      rewrittenEntries: 1,
    });
    expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
      sessionManager,
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
  });

  it("wraps active session manager rewrites in the supplied lock", async () => {
    const events: string[] = [];
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];
    rewriteTranscriptEntriesInSessionManagerMock.mockImplementationOnce((_params?: unknown) => {
      events.push("rewrite");
      return {
        changed: true,
        bytesFreed: 77,
        rewrittenEntries: 1,
      };
    });
    const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      sessionManager,
      withSessionManagerRewriteLock: async (operation) => {
        events.push("lock-start");
        try {
          return await operation();
        } finally {
          events.push("lock-end");
        }
      },
    });

    await runtimeContext.rewriteTranscriptEntries?.({
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });

    expect(events).toEqual(["lock-start", "rewrite", "lock-end"]);
    expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
      sessionManager,
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
  });

  it("defers file rewrites onto the session lane when requested", async () => {
    vi.useFakeTimers();
    try {
      resetCommandQueueStateForTest();
      const sessionKey = "agent:main:session-rewrite-handoff";
      const sessionLane = resolveSessionLane(sessionKey);
      const events: string[] = [];
      let releaseForeground: (() => void) | undefined;
      const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
        events.push("foreground-start");
        await new Promise<void>((resolve) => {
          releaseForeground = resolve;
        });
        events.push("foreground-end");
      });
      await Promise.resolve();

      rewriteTranscriptEntriesInSessionFileMock.mockImplementationOnce(
        async (_params?: unknown) => {
          events.push("rewrite");
          return {
            changed: true,
            bytesFreed: 123,
            rewrittenEntries: 2,
          };
        },
      );

      const runtimeContext = buildContextEngineMaintenanceRuntimeContext({
        sessionId: "session-rewrite-handoff",
        sessionKey,
        sessionFile: "/tmp/session-rewrite-handoff.jsonl",
        deferTranscriptRewriteToSessionLane: true,
      });

      const rewritePromise = runtimeContext.rewriteTranscriptEntries?.({
        replacements: [
          { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
        ],
      });
      expect(rewritePromise?.then).toBeTypeOf("function");

      await flushAsyncWork();
      expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();

      if (!releaseForeground) {
        throw new Error("Expected foreground turn release callback to be initialized");
      }
      releaseForeground();
      await expect(rewritePromise!).resolves.toEqual({
        changed: true,
        bytesFreed: 123,
        rewrittenEntries: 2,
      });
      expect(events).toEqual(["foreground-start", "foreground-end", "rewrite"]);
      await foregroundTurn;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createDeferredTurnMaintenanceAbortSignal", () => {
  beforeEach(async () => {
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("registers a lightweight CLI-exit cleanup hook when the module is loaded", () => {
    const hookState = (
      globalThis as Record<PropertyKey, { cancelForCliExit?: unknown } | undefined>
    )[DEFERRED_TURN_MAINTENANCE_CLI_EXIT_HOOK_KEY];

    expect(hookState?.cancelForCliExit).toBe(cancelActiveDeferredTurnMaintenanceRunsForCliExit);
  });

  it("aborts on termination signals and unregisters listeners", () => {
    const listeners = new Map<string, Set<() => void>>();
    const kill = vi.fn();
    const processLike = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        const bucket = listeners.get(event) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(event, bucket);
        return this;
      },
      off(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(event)?.delete(listener);
        return this;
      },
      listenerCount(event: "SIGINT" | "SIGTERM") {
        return listeners.get(event)?.size ?? 0;
      },
      kill,
      pid: 4242,
    } as unknown as NonNullable<
      Parameters<typeof createDeferredTurnMaintenanceAbortSignal>[0]
    >["processLike"];

    const { abortSignal, dispose } = createDeferredTurnMaintenanceAbortSignal({ processLike });
    const second = createDeferredTurnMaintenanceAbortSignal({ processLike });
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(1);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(1);

    const sigtermListeners = Array.from(listeners.get("SIGTERM") ?? []);
    expect(sigtermListeners).toHaveLength(1);
    sigtermListeners[0]?.();

    expect(abortSignal?.aborted).toBe(true);
    expect(second.abortSignal?.aborted).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);

    dispose();
    second.dispose();
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });
});

describe("runContextEngineMaintenance", () => {
  beforeEach(async () => {
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    rewriteTranscriptEntriesInSessionFileMock.mockClear();
    await loadFreshContextEngineMaintenanceModuleForTest();
  });

  it("passes a rewrite-capable runtime context into maintain()", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));

    const result = await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain,
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      reason: "turn",
      runtimeContext: { workspaceDir: "/tmp/workspace" },
    });

    expect(result).toEqual({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    });
    const maintainParams = firstMaintainParams(maintain);
    expectRecordFields(maintainParams, {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
    });
    expect(
      requireRecord(maintainParams.runtimeContext, "maintain runtime context").workspaceDir,
    ).toBe("/tmp/workspace");
    const runtimeContext = maintainParams.runtimeContext as
      | { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> }
      | undefined;
    if (!runtimeContext?.rewriteTranscriptEntries) {
      throw new Error("expected maintain runtime context rewrite helper");
    }
    const rewriteResult = await runtimeContext.rewriteTranscriptEntries({
      replacements: [
        { entryId: "entry-2", message: { role: "user", content: "hello", timestamp: 2 } },
      ],
    });
    expect(rewriteResult).toEqual({
      changed: true,
      bytesFreed: 123,
      rewrittenEntries: 2,
    });
  });

  it("forces background maintenance rewrites through the session file even when a session manager exists", async () => {
    const maintain = vi.fn(async (params?: unknown) => {
      await (
        params as { runtimeContext?: ContextEngineRuntimeContext } | undefined
      )?.runtimeContext?.rewriteTranscriptEntries?.({
        replacements: [
          {
            entryId: "entry-1",
            message: castAgentMessage({
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 2,
            }),
          },
        ],
      });
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      };
    });
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];

    await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test Engine", turnMaintenanceMode: "background" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain,
      },
      sessionId: "session-background-file-rewrite",
      sessionKey: "agent:main:session-background-file-rewrite",
      sessionFile: "/tmp/session-background-file-rewrite.jsonl",
      reason: "turn",
      executionMode: "background",
      sessionManager,
      config: { session: { writeLock: { acquireTimeoutMs: 75_000 } } },
    });

    expect(rewriteTranscriptEntriesInSessionManagerMock).not.toHaveBeenCalled();
    expect(rewriteTranscriptEntriesInSessionFileMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/session-background-file-rewrite.jsonl",
      sessionId: "session-background-file-rewrite",
      sessionKey: "agent:main:session-background-file-rewrite",
      config: { session: { writeLock: { acquireTimeoutMs: 75_000 } } },
      request: {
        replacements: [
          {
            entryId: "entry-1",
            message: castAgentMessage({
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 2,
            }),
          },
        ],
      },
    });
  });

  it("locks foreground maintenance rewrites that use the active session manager", async () => {
    const events: string[] = [];
    const maintain = vi.fn(async (params?: unknown) => {
      events.push("maintain-start");
      await (
        params as { runtimeContext?: ContextEngineRuntimeContext } | undefined
      )?.runtimeContext?.rewriteTranscriptEntries?.({
        replacements: [
          { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
        ],
      });
      events.push("maintain-end");
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      };
    });
    const sessionManager = { appendMessage: vi.fn() } as unknown as Parameters<
      typeof buildContextEngineMaintenanceRuntimeContext
    >[0]["sessionManager"];
    rewriteTranscriptEntriesInSessionManagerMock.mockImplementationOnce((_params?: unknown) => {
      events.push("rewrite");
      return {
        changed: true,
        bytesFreed: 77,
        rewrittenEntries: 1,
      };
    });

    await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain,
      },
      sessionId: "session-foreground-manager-rewrite",
      sessionKey: "agent:main:session-foreground-manager-rewrite",
      sessionFile: "/tmp/session-foreground-manager-rewrite.jsonl",
      reason: "turn",
      sessionManager,
      withSessionManagerRewriteLock: async (operation) => {
        events.push("lock-start");
        try {
          return await operation();
        } finally {
          events.push("lock-end");
        }
      },
    });

    expect(events).toEqual(["maintain-start", "lock-start", "rewrite", "lock-end", "maintain-end"]);
    expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
      sessionManager,
      replacements: [
        { entryId: "entry-1", message: { role: "user", content: "hi", timestamp: 1 } },
      ],
    });
    expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
  });

  it("defers turn maintenance to a hidden background task when enabled", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-1";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const maintain = vi.fn(async (params?: unknown) => {
          await (
            params as { runtimeContext?: ContextEngineRuntimeContext } | undefined
          )?.runtimeContext?.rewriteTranscriptEntries?.({
            replacements: [
              {
                entryId: "entry-1",
                message: castAgentMessage({
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  timestamp: 2,
                }),
              },
            ],
          });
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        const result = await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-1",
          sessionKey,
          sessionFile: "/tmp/session.jsonl",
          reason: "turn",
          runtimeContext: {
            workspaceDir: "/tmp/workspace",
            tokenBudget: 2048,
            currentTokenCount: 1536,
          },
          config: { session: { writeLock: { acquireTimeoutMs: 91_000 } } },
        });

        expect(result).toBeUndefined();
        expect(maintain).not.toHaveBeenCalled();

        const queuedTasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(queuedTasks).toHaveLength(1);
        const queuedTask = requireRecord(queuedTasks[0], "queued task");
        expectRecordFields(queuedTask, {
          runtime: "acp",
          scopeKind: "session",
          ownerKey: sessionKey,
          requesterSessionKey: sessionKey,
          taskKind: TURN_MAINTENANCE_TASK_KIND,
          notifyPolicy: "silent",
          deliveryStatus: "pending",
        });

        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));
        const maintainParams = firstMaintainParams(maintain);
        expectRecordFields(maintainParams, {
          sessionId: "session-1",
          sessionKey,
          sessionFile: "/tmp/session.jsonl",
        });
        expectRecordFields(requireRecord(maintainParams.runtimeContext, "runtime context"), {
          workspaceDir: "/tmp/workspace",
          allowDeferredCompactionExecution: true,
          tokenBudget: 2048,
          currentTokenCount: 1536,
        });
        expect(rewriteTranscriptEntriesInSessionFileMock).toHaveBeenCalledWith({
          sessionFile: "/tmp/session.jsonl",
          sessionId: "session-1",
          sessionKey,
          config: { session: { writeLock: { acquireTimeoutMs: 91_000 } } },
          request: {
            replacements: [
              {
                entryId: "entry-1",
                message: castAgentMessage({
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  timestamp: 2,
                }),
              },
            ],
          },
        });

        const completedTask = getTaskById(queuedTasks[0].taskId);
        const completedTaskRecord = requireRecord(completedTask, "completed task");
        expect(completedTaskRecord.status).toBe("succeeded");
        expect(String(completedTaskRecord.progressSummary)).toContain(
          "Deferred maintenance completed",
        );

        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("cancels queued deferred turn maintenance during short-lived CLI shutdown", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-cli-exit-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-cli-exit-queued";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-cli-exit-queued",
          sessionKey,
          sessionFile: "/tmp/session-cli-exit-queued.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });

        expect(deferredPromises).toHaveLength(1);
        await cancelActiveDeferredTurnMaintenanceRunsForCliExit();
        await deferredPromises[0];

        expect(maintain).not.toHaveBeenCalled();
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("cancelled");
        expect(String(tasks[0].terminalSummary)).toContain("cancelled during shutdown");

        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("aborts active deferred turn maintenance during short-lived CLI shutdown", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-cli-exit-", async () => {
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-cli-exit-active";
        let observedAbortSignal: AbortSignal | undefined;
        const maintain = vi.fn(
          async (params?: {
            sessionId?: string;
            sessionKey?: string;
            sessionFile?: string;
            runtimeContext?: ContextEngineRuntimeContext;
          }) => {
            expect(Object.keys(params ?? {}).toSorted()).toEqual([
              "runtimeContext",
              "sessionFile",
              "sessionId",
              "sessionKey",
            ]);
            observedAbortSignal = params?.runtimeContext?.abortSignal;
            await new Promise<void>((resolve) => {
              observedAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return {
              changed: false,
              bytesFreed: 0,
              rewrittenEntries: 0,
            };
          },
        );
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-cli-exit-active",
          sessionKey,
          sessionFile: "/tmp/session-cli-exit-active.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        await flushAsyncWork();
        expect(maintain).toHaveBeenCalledTimes(1);

        await cancelActiveDeferredTurnMaintenanceRunsForCliExit();
        await deferredPromises[0];

        expect(observedAbortSignal?.aborted).toBe(true);
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("cancelled");
      } finally {
        resetCommandQueueStateForTest();
      }
    });
  });

  it("blocks deferred transcript rewrites after short-lived CLI shutdown aborts maintenance", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-cli-exit-", async () => {
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        rewriteTranscriptEntriesInSessionFileMock.mockClear();

        const sessionKey = "agent:main:session-cli-exit-rewrite";
        let observedAbortSignal: AbortSignal | undefined;
        const maintain = vi.fn(
          async (params?: { runtimeContext?: ContextEngineRuntimeContext }) => {
            observedAbortSignal = params?.runtimeContext?.abortSignal;
            await new Promise<void>((resolve) => {
              observedAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            await expect(
              params?.runtimeContext?.rewriteTranscriptEntries?.({
                replacements: [
                  {
                    entryId: "entry-after-abort",
                    message: castAgentMessage({
                      role: "assistant",
                      content: [{ type: "text", text: "late rewrite" }],
                      timestamp: 3,
                    }),
                  },
                ],
              }),
            ).rejects.toThrow(/short-lived CLI command completed/);
            return {
              changed: false,
              bytesFreed: 0,
              rewrittenEntries: 0,
            };
          },
        );
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-cli-exit-rewrite",
          sessionKey,
          sessionFile: "/tmp/session-cli-exit-rewrite.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        await flushAsyncWork();
        expect(maintain).toHaveBeenCalledTimes(1);

        await cancelActiveDeferredTurnMaintenanceRunsForCliExit({ drainMs: 0 });
        await deferredPromises[0];

        expect(observedAbortSignal?.aborted).toBe(true);
        expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("cancelled");
      } finally {
        resetCommandQueueStateForTest();
      }
    });
  });

  it("blocks deferred transcript rewrites already queued behind the session lane", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-cli-exit-", async () => {
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        rewriteTranscriptEntriesInSessionFileMock.mockClear();

        const sessionKey = "agent:main:session-cli-exit-queued-rewrite";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        let foregroundTurn: Promise<void> | undefined;

        let observedAbortSignal: AbortSignal | undefined;
        let rewritePromise: Promise<unknown> | undefined;
        let resolveRewriteQueued!: () => void;
        const rewriteQueued = new Promise<void>((resolve) => {
          resolveRewriteQueued = resolve;
        });
        const maintain = vi.fn(
          async (params?: { runtimeContext?: ContextEngineRuntimeContext }) => {
            observedAbortSignal = params?.runtimeContext?.abortSignal;
            foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
              await new Promise<void>((resolve) => {
                releaseForeground = resolve;
              });
            });
            await flushAsyncWork();
            rewritePromise = params?.runtimeContext?.rewriteTranscriptEntries?.({
              replacements: [
                {
                  entryId: "entry-queued-before-abort",
                  message: castAgentMessage({
                    role: "assistant",
                    content: [{ type: "text", text: "queued rewrite" }],
                    timestamp: 4,
                  }),
                },
              ],
            });
            resolveRewriteQueued();
            await expect(rewritePromise).rejects.toThrow(/short-lived CLI command completed/);
            return {
              changed: false,
              bytesFreed: 0,
              rewrittenEntries: 0,
            };
          },
        );
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-cli-exit-queued-rewrite",
          sessionKey,
          sessionFile: "/tmp/session-cli-exit-queued-rewrite.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        await flushAsyncWork();
        expect(maintain).toHaveBeenCalledTimes(1);
        await Promise.race([
          rewriteQueued,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out waiting for queued rewrite")), 1_000),
          ),
        ]);
        expect(rewritePromise).toBeDefined();

        await cancelActiveDeferredTurnMaintenanceRunsForCliExit({ drainMs: 0 });
        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await foregroundTurn;
        await deferredPromises[0];

        expect(observedAbortSignal?.aborted).toBe(true);
        expect(rewriteTranscriptEntriesInSessionFileMock).not.toHaveBeenCalled();
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("cancelled");
      } finally {
        resetCommandQueueStateForTest();
      }
    });
  });

  it("clears host progress timers when active deferred maintenance ignores shutdown abort", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-cli-exit-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetSystemEventsForTest();

        const sessionKey = "agent:main:session-cli-exit-ignored-abort";
        const maintain = vi.fn(async () => await new Promise<never>(() => {}));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-cli-exit-ignored-abort",
          sessionKey,
          sessionFile: "/tmp/session-cli-exit-ignored-abort.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        await flushAsyncWork();
        expect(maintain).toHaveBeenCalledTimes(1);
        expect(deferredPromises).toHaveLength(1);
        const timerCountBeforeCancel = vi.getTimerCount();
        expect(timerCountBeforeCancel).toBeGreaterThan(0);

        const cancelPromise = cancelActiveDeferredTurnMaintenanceRunsForCliExit({ drainMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        await cancelPromise;

        await vi.advanceTimersByTimeAsync(11_000);
        expect(peekSystemEvents(sessionKey).join("\n")).not.toContain(
          "Deferred maintenance is still running.",
        );
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("lost");
        expect(String(tasks[0].error)).toContain("did not stop before CLI exit");
      } finally {
        vi.useRealTimers();
        resetCommandQueueStateForTest();
      }
    });
  });

  it("drops requested deferred maintenance reruns during short-lived CLI shutdown", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-rerun-cli-exit-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-rerun-cli-exit";
        let observedAbortSignal: AbortSignal | undefined;
        const maintain = vi.fn(
          async (params?: { runtimeContext?: ContextEngineRuntimeContext }) => {
            observedAbortSignal = params?.runtimeContext?.abortSignal;
            await new Promise<void>((resolve) => {
              observedAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return {
              changed: false,
              bytesFreed: 0,
              rewrittenEntries: 0,
            };
          },
        );

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rerun-cli-exit",
          sessionKey,
          sessionFile: "/tmp/session-rerun-cli-exit.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rerun-cli-exit",
          sessionKey,
          sessionFile: "/tmp/session-rerun-cli-exit.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        expect(deferredPromises).toHaveLength(2);
        let secondDeferredSettled = false;
        const secondDeferred = deferredPromises[1].then(() => {
          secondDeferredSettled = true;
        });

        await cancelActiveDeferredTurnMaintenanceRunsForCliExit();
        await Promise.all(deferredPromises);
        await secondDeferred;

        expect(observedAbortSignal?.aborted).toBe(true);
        expect(secondDeferredSettled).toBe(true);
        expect(maintain).toHaveBeenCalledTimes(1);
        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("cancelled");
      } finally {
        vi.useRealTimers();
        resetCommandQueueStateForTest();
      }
    });
  });

  it("coalesces repeated requests into one active run plus one follow-up run for the same session", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-2";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await Promise.all([
          runContextEngineMaintenance({
            contextEngine: backgroundEngine,
            sessionId: "session-2",
            sessionKey,
            sessionFile: "/tmp/session-2.jsonl",
            reason: "turn",
          }),
          runContextEngineMaintenance({
            contextEngine: backgroundEngine,
            sessionId: "session-2",
            sessionKey,
            sessionFile: "/tmp/session-2.jsonl",
            reason: "turn",
          }),
        ]);

        const queuedTasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(queuedTasks).toHaveLength(1);

        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(2));
        const completedTasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(completedTasks).toHaveLength(2);
        expect(completedTasks.every((task) => task.status === "succeeded")).toBe(true);

        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("queues a follow-up maintenance run when a new turn finishes during an active deferred run", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-rerun-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-rerun";
        let releaseFirstMaintenance: (() => void) | undefined;
        let releaseSecondMaintenance: (() => void) | undefined;
        let maintenanceCalls = 0;
        const maintain = vi.fn(async () => {
          maintenanceCalls += 1;
          if (maintenanceCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstMaintenance = resolve;
            });
          }
          if (maintenanceCalls === 2) {
            await new Promise<void>((resolve) => {
              releaseSecondMaintenance = resolve;
            });
          }
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
        const deferredPromises: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rerun",
          sessionKey,
          sessionFile: "/tmp/session-rerun.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });

        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rerun",
          sessionKey,
          sessionFile: "/tmp/session-rerun.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });
        expect(deferredPromises).toHaveLength(2);
        let secondDeferredSettled = false;
        const secondDeferred = deferredPromises[1].then(() => {
          secondDeferredSettled = true;
        });

        if (!releaseFirstMaintenance) {
          throw new Error("Expected first maintenance release callback to be initialized");
        }
        releaseFirstMaintenance();
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(secondDeferredSettled).toBe(false);

        if (!releaseSecondMaintenance) {
          throw new Error("Expected second maintenance release callback to be initialized");
        }
        releaseSecondMaintenance();
        await secondDeferred;
        expect(secondDeferredSettled).toBe(true);

        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(2);
        expect(tasks.every((task) => task.status === "succeeded")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("replaces legacy active maintenance tasks that are missing a runId", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-legacy";
        const legacyTask = createQueuedTaskRun({
          runtime: "acp",
          taskKind: TURN_MAINTENANCE_TASK_KIND,
          sourceId: TURN_MAINTENANCE_TASK_KIND,
          requesterSessionKey: sessionKey,
          ownerKey: sessionKey,
          scopeKind: "session",
          label: "Context engine turn maintenance",
          task: "Deferred context-engine maintenance after turn.",
          notifyPolicy: "silent",
          deliveryStatus: "pending",
          preferMetadata: true,
        });

        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-legacy",
          sessionKey,
          sessionFile: "/tmp/session-legacy.jsonl",
          reason: "turn",
        });

        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));

        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(2);
        const cancelledLegacyTask = requireRecord(getTaskById(legacyTask.taskId), "legacy task");
        expectRecordFields(cancelledLegacyTask, {
          status: "cancelled",
          notifyPolicy: "silent",
        });
        expect(
          tasks.some(
            (task) => typeof task.runId === "string" && task.runId.startsWith("turn-maint:"),
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("cancels the queued task when deferred scheduling is rejected", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const scheduleError = new Error("gateway draining");
      const enqueueSpy = vi
        .spyOn(commandQueueModule, "enqueueCommandInLane")
        .mockRejectedValue(scheduleError);
      try {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetCommandQueueStateForTest();

        const sessionKey = "agent:main:session-enqueue-reject";
        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-enqueue-reject",
          sessionKey,
          sessionFile: "/tmp/session-enqueue-reject.jsonl",
          reason: "turn",
        });
        await flushAsyncWork();

        const tasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(tasks).toHaveLength(1);
        const task = requireRecord(tasks[0], "cancelled task");
        expect(task.status).toBe("cancelled");
        expect(String(task.terminalSummary)).toContain("gateway draining");
        expect(maintain).not.toHaveBeenCalled();
      } finally {
        enqueueSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("lets foreground turns win while deferred maintenance is waiting", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-3";
        const sessionLane = resolveSessionLane(sessionKey);
        const events: string[] = [];
        let releaseFirstForeground: (() => void) | undefined;
        const firstForeground = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-1-start");
          await new Promise<void>((resolve) => {
            releaseFirstForeground = resolve;
          });
          events.push("foreground-1-end");
        });
        await Promise.resolve();

        const maintain = vi.fn(async () => {
          events.push("maintenance-start");
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-3",
          sessionKey,
          sessionFile: "/tmp/session-3.jsonl",
          reason: "turn",
        });

        const secondForeground = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-2-start");
          events.push("foreground-2-end");
        });

        if (!releaseFirstForeground) {
          throw new Error("Expected first foreground release callback to be initialized");
        }
        releaseFirstForeground();
        await waitForAssertion(() =>
          expect(events).toEqual([
            "foreground-1-start",
            "foreground-1-end",
            "foreground-2-start",
            "foreground-2-end",
            "maintenance-start",
          ]),
        );
        expect(maintain).toHaveBeenCalledTimes(1);

        await Promise.all([firstForeground, secondForeground]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("lets a foreground turn run before a deferred maintenance transcript rewrite", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-rewrite-priority";
        const sessionLane = resolveSessionLane(sessionKey);
        const events: string[] = [];
        let allowRewrite: (() => void) | undefined;
        const maintain = vi.fn(async (params?: unknown) => {
          events.push("maintenance-start");
          await new Promise<void>((resolve) => {
            allowRewrite = resolve;
          });
          events.push("maintenance-before-rewrite");
          await (
            params as { runtimeContext?: ContextEngineRuntimeContext }
          ).runtimeContext?.rewriteTranscriptEntries?.({
            replacements: [
              {
                entryId: "entry-1",
                message: castAgentMessage({
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  timestamp: 2,
                }),
              },
            ],
          });
          events.push("maintenance-after-rewrite");
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        rewriteTranscriptEntriesInSessionFileMock.mockImplementationOnce(
          async (_params?: unknown) => {
            events.push("rewrite");
            return {
              changed: true,
              bytesFreed: 123,
              rewrittenEntries: 2,
            };
          },
        );

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rewrite-priority",
          sessionKey,
          sessionFile: "/tmp/session-rewrite-priority.jsonl",
          reason: "turn",
        });

        await waitForAssertion(() => expect(events).toContain("maintenance-start"));

        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-start");
          events.push("foreground-end");
        });

        if (!allowRewrite) {
          throw new Error("Expected maintenance rewrite release callback to be initialized");
        }
        allowRewrite();

        await waitForAssertion(() =>
          expect(events).toEqual([
            "maintenance-start",
            "foreground-start",
            "foreground-end",
            "maintenance-before-rewrite",
            "rewrite",
            "maintenance-after-rewrite",
          ]),
        );

        expect(maintain).toHaveBeenCalledTimes(1);
        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps fast deferred maintenance silent for the user", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetSystemEventsForTest();
        const sendMessageMock = vi.fn();
        setTaskRegistryDeliveryRuntimeForTests({
          sendMessage: sendMessageMock,
        });

        const sessionKey = "agent:main:session-fast";
        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-fast",
          sessionKey,
          sessionFile: "/tmp/session-fast.jsonl",
          reason: "turn",
        });
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(peekSystemEvents(sessionKey)).toStrictEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("surfaces long-running deferred maintenance and completion via task updates", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetSystemEventsForTest();

        const sessionKey = "agent:main:session-long";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain,
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-long",
          sessionKey,
          sessionFile: "/tmp/session-long.jsonl",
          reason: "turn",
        });

        await vi.advanceTimersByTimeAsync(11_000);
        await waitForAssertion(() =>
          expectSystemEventContaining(
            sessionKey,
            "Background task update: Context engine turn maintenance.",
          ),
        );

        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await waitForAssertion(() =>
          expectSystemEventContaining(
            sessionKey,
            "Background task done: Context engine turn maintenance",
          ),
        );

        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("throttles deferred wait notices while the session lane stays busy", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetSystemEventsForTest();

        const sessionKey = "agent:main:session-throttle";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground: (() => void) | undefined;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain: vi.fn(async () => ({
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          })),
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-throttle",
          sessionKey,
          sessionFile: "/tmp/session-throttle.jsonl",
          reason: "turn",
        });

        await vi.advanceTimersByTimeAsync(11_000);
        await waitForAssertion(() =>
          expect(
            peekSystemEvents(sessionKey).filter((event) =>
              event.includes("Background task update: Context engine turn maintenance."),
            ),
          ).toHaveLength(1),
        );

        await vi.advanceTimersByTimeAsync(9_000);
        expect(
          peekSystemEvents(sessionKey).filter((event) =>
            event.includes("Background task update: Context engine turn maintenance."),
          ),
        ).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(
          peekSystemEvents(sessionKey).filter((event) =>
            event.includes("Background task update: Context engine turn maintenance."),
          ),
        ).toHaveLength(2);

        if (!releaseForeground) {
          throw new Error("Expected foreground turn release callback to be initialized");
        }
        releaseForeground();
        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("surfaces deferred maintenance failures even when they fail quickly", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        resetSystemEventsForTest();

        const sessionKey = "agent:main:session-fail";
        const backgroundEngine = {
          info: {
            id: "test",
            name: "Test Engine",
            turnMaintenanceMode: "background" as const,
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown[] }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain: vi.fn(async () => {
            throw new Error("maintenance exploded");
          }),
        } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-fail",
          sessionKey,
          sessionFile: "/tmp/session-fail.jsonl",
          reason: "turn",
        });
        await waitForAssertion(() =>
          expectSystemEventContaining(
            sessionKey,
            "Background task failed: Context engine turn maintenance",
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
