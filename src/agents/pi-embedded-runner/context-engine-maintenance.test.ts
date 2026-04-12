import { beforeEach, describe, expect, it, vi } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  enqueueCommandInLane,
  resetCommandQueueStateForTest,
} from "../../process/command-queue.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import {
  getTaskById,
  listTasksForOwnerKey,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-registry.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
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
let runContextEngineMaintenance: typeof import("./context-engine-maintenance.js").runContextEngineMaintenance;
const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

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

vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionManager: (params: unknown) =>
    rewriteTranscriptEntriesInSessionManagerMock(params),
  rewriteTranscriptEntriesInSessionFile: (params: unknown) =>
    rewriteTranscriptEntriesInSessionFileMock(params),
}));

async function loadFreshContextEngineMaintenanceModuleForTest() {
  ({ buildContextEngineMaintenanceRuntimeContext, runContextEngineMaintenance } =
    await import("./context-engine-maintenance.js"));
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
    expect(typeof runtimeContext.rewriteTranscriptEntries).toBe("function");

    const result = await runtimeContext.rewriteTranscriptEntries?.({
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
    expect(maintain).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "/tmp/session.jsonl",
        runtimeContext: expect.objectContaining({
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
    const runtimeContext = (
      maintain.mock.calls[0]?.[0] as
        | { runtimeContext?: { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> } }
        | undefined
    )?.runtimeContext as
      | { rewriteTranscriptEntries?: (request: unknown) => Promise<unknown> }
      | undefined;
    expect(typeof runtimeContext?.rewriteTranscriptEntries).toBe("function");
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
        let releaseForeground!: () => void;
        const foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await new Promise<void>((resolve) => {
            releaseForeground = resolve;
          });
        });
        await Promise.resolve();

        const maintain = vi.fn(async (_params?: unknown) => ({
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

        const result = await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-1",
          sessionKey,
          sessionFile: "/tmp/session.jsonl",
          reason: "turn",
          runtimeContext: { workspaceDir: "/tmp/workspace" },
        });

        expect(result).toBeUndefined();
        expect(maintain).not.toHaveBeenCalled();

        const queuedTasks = listTasksForOwnerKey(sessionKey).filter(
          (task) => task.taskKind === TURN_MAINTENANCE_TASK_KIND,
        );
        expect(queuedTasks).toHaveLength(1);
        expect(queuedTasks[0]).toMatchObject({
          runtime: "acp",
          scopeKind: "session",
          ownerKey: sessionKey,
          requesterSessionKey: sessionKey,
          taskKind: TURN_MAINTENANCE_TASK_KIND,
          notifyPolicy: "silent",
          deliveryStatus: "pending",
        });

        releaseForeground();
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));
        expect(maintain.mock.calls[0]?.[0]).toMatchObject({
          sessionId: "session-1",
          sessionKey,
          sessionFile: "/tmp/session.jsonl",
          runtimeContext: expect.objectContaining({
            workspaceDir: "/tmp/workspace",
            allowDeferredCompactionExecution: true,
          }),
        });

        const completedTask = getTaskById(queuedTasks[0].taskId);
        expect(completedTask).toMatchObject({
          status: "succeeded",
          progressSummary: expect.stringContaining("Deferred maintenance completed"),
        });

        await foregroundTurn;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("coalesces repeated turn maintenance requests for the same session", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      try {
        resetCommandQueueStateForTest();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        const sessionKey = "agent:main:session-2";
        const sessionLane = resolveSessionLane(sessionKey);
        let releaseForeground!: () => void;
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

        releaseForeground();
        await waitForAssertion(() => expect(maintain).toHaveBeenCalledTimes(1));
        expect(getTaskById(queuedTasks[0].taskId)).toMatchObject({
          status: "succeeded",
        });

        await foregroundTurn;
      } finally {
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
        let releaseFirstForeground!: () => void;
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
        expect(peekSystemEvents(sessionKey)).toEqual([]);
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
        let releaseForeground!: () => void;
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
          expect(peekSystemEvents(sessionKey)).toEqual(
            expect.arrayContaining([
              expect.stringContaining("Background task update: Context engine turn maintenance."),
            ]),
          ),
        );

        releaseForeground();
        await waitForAssertion(() =>
          expect(peekSystemEvents(sessionKey)).toEqual(
            expect.arrayContaining([
              expect.stringContaining("Background task done: Context engine turn maintenance"),
            ]),
          ),
        );

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
          expect(peekSystemEvents(sessionKey)).toEqual(
            expect.arrayContaining([
              expect.stringContaining("Background task failed: Context engine turn maintenance"),
            ]),
          ),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
