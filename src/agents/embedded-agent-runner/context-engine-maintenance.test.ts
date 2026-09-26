// Coverage for deferred context-engine maintenance and transcript rewrite hooks.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { registerLegacyContextEngine } from "../../context-engine/legacy.registration.js";
import {
  registerContextEngineForOwner,
  resolveLogicalTurnContextEngines,
} from "../../context-engine/registry.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import * as commandQueueModule from "../../process/command-queue.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  markGatewayDraining,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createBackgroundMaintenanceEngine,
  expectRecordFields,
  firstMaintainParams,
  requireRecord,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { resolveSessionLane } from "./lanes.js";

const rewriteTranscriptEntriesInSessionManagerMock = vi.fn((_params?: unknown) => ({
  changed: true,
  bytesFreed: 77,
  rewrittenEntries: 1,
}));
let openedSessionManager: { getSessionTarget: () => SessionTranscriptRuntimeTarget } | undefined;
const sessionManagerOpenMock = vi.fn((target: SessionTranscriptRuntimeTarget) => {
  openedSessionManager = { getSessionTarget: () => target };
  return openedSessionManager;
});
const resolveRuntimeTranscriptReadTargetMock = vi.fn(async (scope: Record<string, unknown>) => ({
  agentId: scope.agentId ?? "main",
  sessionId: scope.sessionId,
  sessionKey: scope.sessionKey,
  storePath: scope.storePath ?? resolveDefaultSessionStorePath("main"),
}));
let resetDeferredTurnMaintenanceStateForTest: typeof import("./context-engine-maintenance.test-support.js").resetDeferredTurnMaintenanceStateForTest;
let waitForDeferredTurnMaintenanceForSession: typeof import("./context-engine-maintenance.js").waitForDeferredTurnMaintenanceForSession;
let runContextEngineMaintenance: typeof import("./context-engine-maintenance.js").runContextEngineMaintenance;

vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({ llm: undefined }),
}));

vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionManager: (params: unknown) =>
    rewriteTranscriptEntriesInSessionManagerMock(params),
}));

vi.mock("../sessions/index.js", () => ({
  SessionManager: {
    open: (target: SessionTranscriptRuntimeTarget) => sessionManagerOpenMock(target),
  },
}));

vi.mock("./transcript-runtime-state.js", () => ({
  resolveRuntimeTranscriptReadTarget: (scope: Record<string, unknown>) =>
    resolveRuntimeTranscriptReadTargetMock(scope),
}));

async function loadContextEngineMaintenanceModuleForTest() {
  // Import once and reset the owned singleton state between cases.
  ({ runContextEngineMaintenance, waitForDeferredTurnMaintenanceForSession } =
    await import("./context-engine-maintenance.js"));
  ({ resetDeferredTurnMaintenanceStateForTest } =
    await import("./context-engine-maintenance.test-support.js"));
  resetDeferredTurnMaintenanceStateForTest();
}

describe("runContextEngineMaintenance", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    openedSessionManager = undefined;
    sessionManagerOpenMock.mockClear();
    resolveRuntimeTranscriptReadTargetMock.mockClear();
    await loadContextEngineMaintenanceModuleForTest();
  });

  it("passes a rewrite-capable runtime context into maintain()", async () => {
    await withStateDirEnv("openclaw-maintenance-runtime-context-", async () => {
      const sessionTarget = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: resolveDefaultSessionStorePath("main"),
      };
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
        sessionTarget,
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
        sessionTarget,
        sessionFile: "/tmp/session.jsonl",
      });
      expect(maintainParams.abortSignal).toBeUndefined();
      const maintainRuntimeContext = requireRecord(
        maintainParams.runtimeContext,
        "maintain runtime context",
      );
      expect(maintainRuntimeContext.workspaceDir).toBe("/tmp/workspace");
      expect(maintainRuntimeContext.sessionTarget).toEqual(sessionTarget);
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
        bytesFreed: 77,
        rewrittenEntries: 1,
      });
      expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionTarget);
      expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
        sessionManager: openedSessionManager,
        replacements: [
          { entryId: "entry-2", message: { role: "user", content: "hello", timestamp: 2 } },
        ],
      });
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
    const sessionManager = {
      appendMessage: vi.fn(),
      getSessionTarget: () => undefined,
    } as unknown as Parameters<typeof runContextEngineMaintenance>[0]["sessionManager"];
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
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("does not resolve or open a durable transcript when the rewrite owner rejects", async () => {
    const denied = new Error("detached recovery has no caller-owned transcript to rewrite");
    const withSessionManagerRewriteLock = vi.fn(async () => {
      throw denied;
    });
    let rewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
    await runContextEngineMaintenance({
      contextEngine: {
        info: { id: "test", name: "Test Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain: async ({ runtimeContext }) => {
          rewrite = runtimeContext?.rewriteTranscriptEntries;
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        },
      },
      sessionId: "detached-session",
      sessionKey: "agent:main:detached-session",
      sessionFile: "agent:main:detached-session",
      reason: "compaction",
      withSessionManagerRewriteLock,
    });
    if (!rewrite) {
      throw new Error("expected the host-owned rewrite capability");
    }

    await expect(
      rewrite({
        replacements: [
          { entryId: "entry-1", message: { role: "user", content: "replacement", timestamp: 1 } },
        ],
      }),
    ).rejects.toBe(denied);

    expect(withSessionManagerRewriteLock).toHaveBeenCalledOnce();
    expect(resolveRuntimeTranscriptReadTargetMock).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    expect(rewriteTranscriptEntriesInSessionManagerMock).not.toHaveBeenCalled();
  });

  it("retires a deferred worker's retained rewrite capability after disposal and settlement", async () => {
    await withStateDirEnv("openclaw-retired-maintenance-rewrite-", async () => {
      resetCommandQueueStateForTest();
      const sessionKey = "agent:main:retained-maintenance-rewrite";
      const published = vi.fn();
      const unsubscribe = onSessionTranscriptUpdate((event) => {
        if (event.sessionKey === sessionKey) {
          published(event);
        }
      });
      const dispose = vi.fn(async () => {});
      let rewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
      let activeRewriteResult: unknown;
      let deferred: Promise<void> | undefined;
      const request = {
        replacements: [
          {
            entryId: "entry-1",
            message: castAgentMessage({ role: "user", content: "updated", timestamp: 1 }),
          },
        ],
      };
      try {
        await runContextEngineMaintenance({
          contextEngine: {
            info: { id: "retained", name: "Retained rewrite", turnMaintenanceMode: "background" },
            ingest: async () => ({ ingested: true }),
            assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
            compact: async () => ({ ok: true, compacted: false }),
            maintain: async ({ runtimeContext }) => {
              rewrite = runtimeContext?.rewriteTranscriptEntries;
              activeRewriteResult = await rewrite?.(request);
              return { changed: true, bytesFreed: 77, rewrittenEntries: 1 };
            },
            dispose,
          },
          sessionId: "retained-maintenance-rewrite",
          sessionKey,
          sessionFile: sessionKey,
          reason: "turn",
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (work) => {
            deferred = work;
          },
        });
        await expectDefined(deferred, "deferred maintenance completion");
        await waitForDeferredTurnMaintenanceForSession(sessionKey);

        expect(activeRewriteResult).toEqual({ changed: true, bytesFreed: 77, rewrittenEntries: 1 });
        expect(dispose).toHaveBeenCalledOnce();
        expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledOnce();
        expect(published).toHaveBeenCalledOnce();
        rewriteTranscriptEntriesInSessionManagerMock.mockClear();
        resolveRuntimeTranscriptReadTargetMock.mockClear();
        sessionManagerOpenMock.mockClear();
        published.mockClear();

        await expect(
          expectDefined(rewrite, "retained rewrite capability")(request),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(resolveRuntimeTranscriptReadTargetMock).not.toHaveBeenCalled();
        expect(sessionManagerOpenMock).not.toHaveBeenCalled();
        expect(rewriteTranscriptEntriesInSessionManagerMock).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
      } finally {
        await Promise.allSettled(deferred ? [deferred] : []);
        unsubscribe();
      }
    });
  });

  it("defers turn maintenance without blocking the foreground lane", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-1";
      const releaseForeground = createDeferred();
      let foregroundTurn: Promise<void> | undefined;
      try {
        resetCommandQueueStateForTest();

        const sessionLane = resolveSessionLane(sessionKey);
        foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await releaseForeground.promise;
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

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

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
          config: {},
        });

        expect(result).toBeUndefined();
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
        expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
          sessionManager: openedSessionManager,
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

        releaseForeground.resolve();
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

        await foregroundTurn;
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
      } finally {
        releaseForeground.resolve();
        await Promise.allSettled([
          waitForDeferredTurnMaintenanceForSession(sessionKey),
          foregroundTurn,
        ]);
        vi.useRealTimers();
      }
    });
  });

  it("coalesces repeated requests into one active run plus one follow-up run for the same session", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-2";
      const releaseMaintenance = createDeferred();
      try {
        resetCommandQueueStateForTest();

        let maintenanceCalls = 0;
        const maintain = vi.fn(async () => {
          maintenanceCalls += 1;
          if (maintenanceCalls === 1) {
            await releaseMaintenance.promise;
          }
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-2",
          sessionKey,
          sessionFile: "/tmp/session-2.jsonl",
          reason: "turn",
        });
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);
        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-2",
          sessionKey,
          sessionFile: "/tmp/session-2.jsonl",
          reason: "turn",
        });

        releaseMaintenance.resolve();
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
        expect(maintain).toHaveBeenCalledTimes(2);
      } finally {
        releaseMaintenance.resolve();
        await Promise.allSettled([waitForDeferredTurnMaintenanceForSession(sessionKey)]);
        vi.useRealTimers();
      }
    });
  });

  it("queues a follow-up maintenance run when a new turn finishes during an active deferred run", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-rerun-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-rerun";
      const releaseFirstMaintenance = createDeferred();
      const releaseSecondMaintenance = createDeferred();
      try {
        resetCommandQueueStateForTest();

        const secondMaintenanceStarted = createDeferred();
        let maintenanceCalls = 0;
        const maintain = vi.fn(async () => {
          maintenanceCalls += 1;
          if (maintenanceCalls === 1) {
            await releaseFirstMaintenance.promise;
          }
          if (maintenanceCalls === 2) {
            secondMaintenanceStarted.resolve();
            await releaseSecondMaintenance.promise;
          }
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);
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

        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);

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
        const secondDeferred = expectDefined(
          deferredPromises[1],
          "deferredPromises[1] test invariant",
        ).then(() => {
          secondDeferredSettled = true;
        });

        releaseFirstMaintenance.resolve();
        await Promise.race([secondMaintenanceStarted.promise, secondDeferred]);
        expect(maintain).toHaveBeenCalledTimes(2);
        expect(secondDeferredSettled).toBe(false);

        releaseSecondMaintenance.resolve();
        await secondDeferred;
        expect(secondDeferredSettled).toBe(true);
      } finally {
        releaseFirstMaintenance.resolve();
        releaseSecondMaintenance.resolve();
        await Promise.allSettled([waitForDeferredTurnMaintenanceForSession(sessionKey)]);
        vi.useRealTimers();
      }
    });
  });

  it.each([
    {
      name: "SIGTERM",
      trigger: () => process.emit("SIGTERM", "SIGTERM"),
    },
    {
      name: "accepted restart drain",
      trigger: () => markGatewayDraining(),
    },
  ])(
    "settles abort-waiting deferred maintenance during $name without rerun",
    async ({ trigger }) => {
      await withStateDirEnv("openclaw-turn-maintenance-abort-waiting-", async () => {
        resetCommandQueueStateForTest();

        const sessionKey = "agent:main:session-abort-waiting";
        const lane = `context-engine-turn-maintenance:${sessionKey}`;
        const keepProcessAlive = () => {};
        process.on("SIGTERM", keepProcessAlive);

        const releaseFirstMaintenance = createDeferred();
        let observedSignal: AbortSignal | undefined;
        const firstMaintain = vi.fn(async (rawParams?: unknown) => {
          const signal = (rawParams as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          observedSignal = signal;
          const onAbort = () => {
            releaseFirstMaintenance.reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error("maintenance aborted", { cause: signal?.reason }),
            );
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            if (signal?.aborted) {
              onAbort();
            }
            await releaseFirstMaintenance.promise;
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });
        const secondMaintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const createOwnedEngine = (
          id: string,
          maintain: typeof firstMaintain | typeof secondMaintain,
        ) => ({
          ...createBackgroundMaintenanceEngine(maintain, id),
          dispose: vi.fn(async () => {}),
        });
        const firstEngine = createOwnedEngine("first", firstMaintain);
        const secondEngine = createOwnedEngine("second", secondMaintain);
        const secondDisposed = createDeferred();
        secondEngine.dispose.mockImplementation(async () => {
          secondDisposed.resolve();
        });
        registerLegacyContextEngine();
        const sharedEngineId = "shutdown-shared-engine";
        registerContextEngineForOwner(sharedEngineId, () => firstEngine, `test:${sharedEngineId}`, {
          allowSameOwnerRefresh: true,
        });
        const contextEngineConfig = {
          plugins: { slots: { contextEngine: sharedEngineId } },
        };
        const firstResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);
        const firstRerunResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);
        const finalRerunResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);
        let deferred: Promise<void> | undefined;

        try {
          expect(firstResolution.configured.engine).not.toBe(
            firstRerunResolution.configured.engine,
          );
          expect(firstRerunResolution.configured.engine).not.toBe(
            finalRerunResolution.configured.engine,
          );
          await runContextEngineMaintenance({
            contextEngine: firstResolution.configured.engine,
            sessionId: "session-abort-waiting",
            sessionKey,
            sessionFile: "/tmp/session-abort-waiting.jsonl",
            reason: "turn",
            onDeferredMaintenance: (promise) => {
              deferred = promise;
            },
          });
          const completion = expectDefined(deferred, "deferred maintenance completion");
          await Promise.race([firstEngine.started, completion]);
          expect(firstMaintain).toHaveBeenCalledTimes(1);

          await runContextEngineMaintenance({
            contextEngine: firstRerunResolution.configured.engine,
            sessionId: "session-abort-waiting",
            sessionKey,
            sessionFile: "/tmp/session-abort-waiting.jsonl",
            reason: "turn",
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          await runContextEngineMaintenance({
            contextEngine: secondEngine,
            sessionId: "session-abort-waiting",
            sessionKey,
            sessionFile: "/tmp/session-abort-waiting.jsonl",
            reason: "turn",
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          expect(firstEngine["dispose"]).not.toHaveBeenCalled();
          await runContextEngineMaintenance({
            contextEngine: finalRerunResolution.configured.engine,
            sessionId: "session-abort-waiting",
            sessionKey,
            sessionFile: "/tmp/session-abort-waiting.jsonl",
            reason: "turn",
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          await Promise.race([secondDisposed.promise, completion]);
          expect(secondEngine["dispose"]).toHaveBeenCalledTimes(1);

          trigger();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            waitForDeferredTurnMaintenanceForSession(sessionKey).then(() => true),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), 500);
            }),
          ]);
          if (timeout) {
            clearTimeout(timeout);
          }

          expect(settled).toBe(true);
          expect(observedSignal?.aborted).toBe(true);
          expect(firstMaintain).toHaveBeenCalledTimes(1);
          expect(secondMaintain).not.toHaveBeenCalled();
          expect(firstEngine["dispose"]).toHaveBeenCalledTimes(1);
          expect(secondEngine["dispose"]).toHaveBeenCalledTimes(1);
          expect(getCommandLaneSnapshot(lane)).toMatchObject({
            activeCount: 0,
            queuedCount: 0,
          });
        } finally {
          trigger();
          releaseFirstMaintenance.resolve();
          await Promise.allSettled(deferred ? [deferred] : []);
          await Promise.allSettled([
            firstResolution.fallback.engine.dispose?.(),
            firstRerunResolution.fallback.engine.dispose?.(),
            finalRerunResolution.fallback.engine.dispose?.(),
          ]);
          process.off("SIGTERM", keepProcessAlive);
          resetDeferredTurnMaintenanceStateForTest();
        }
      });
    },
  );

  it.each([
    {
      name: "SIGTERM",
      trigger: () => process.emit("SIGTERM", "SIGTERM"),
    },
    {
      name: "accepted restart drain",
      trigger: () => markGatewayDraining(),
    },
  ])("does not start queued deferred maintenance after $name", async ({ trigger }) => {
    await withStateDirEnv("openclaw-turn-maintenance-queued-abort-", async () => {
      resetCommandQueueStateForTest();

      const sessionKey = "agent:main:session-queued-abort";
      const lane = `context-engine-turn-maintenance:${sessionKey}`;
      const releaseLane = createDeferred();
      const laneStarted = createDeferred();
      const laneBlocker = enqueueCommandInLane(lane, async () => {
        laneStarted.resolve();
        await releaseLane.promise;
      });

      const keepProcessAlive = () => {};
      process.on("SIGTERM", keepProcessAlive);
      const maintain = vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }));
      const engine = {
        info: {
          id: "queued",
          name: "Queued Engine",
          turnMaintenanceMode: "background" as const,
        },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }: { messages: unknown[] }) => ({
          messages,
          estimatedTokens: 0,
        }),
        compact: async () => ({ ok: true, compacted: false }),
        maintain,
        dispose: vi.fn(async () => {}),
      } as NonNullable<Parameters<typeof runContextEngineMaintenance>[0]["contextEngine"]>;
      let deferred: Promise<void> | undefined;

      try {
        await laneStarted.promise;
        await runContextEngineMaintenance({
          contextEngine: engine,
          sessionId: "session-queued-abort",
          sessionKey,
          sessionFile: "/tmp/session-queued-abort.jsonl",
          reason: "turn",
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => {
            deferred = promise;
          },
        });

        trigger();
        releaseLane.resolve();
        await laneBlocker;
        await deferred;
        await waitForDeferredTurnMaintenanceForSession(sessionKey);

        expect(maintain).not.toHaveBeenCalled();
        expect(engine["dispose"]).toHaveBeenCalledTimes(1);
        expect(getCommandLaneSnapshot(lane)).toMatchObject({
          activeCount: 0,
          queuedCount: 0,
        });
      } finally {
        releaseLane.resolve();
        await Promise.allSettled([laneBlocker, ...(deferred ? [deferred] : [])]);
        process.off("SIGTERM", keepProcessAlive);
        resetDeferredTurnMaintenanceStateForTest();
      }
    });
  });

  it("disposes owned deferred engines only after their maintenance run finishes", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-dispose-", async () => {
      resetCommandQueueStateForTest();
      const sessionKey = "agent:main:session-owned-dispose";
      const events: string[] = [];
      const releaseFirstMaintenance = createDeferred();
      const releaseSecondMaintenance = createDeferred();

      const createBackgroundEngine = (id: "first" | "second") => ({
        ...createBackgroundMaintenanceEngine(async () => {
          events.push(`maintain:${id}`);
          await (id === "first" ? releaseFirstMaintenance : releaseSecondMaintenance).promise;
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        }, id),
        dispose: vi.fn(async () => {
          events.push(`dispose:${id}`);
        }),
      });

      const firstEngine = createBackgroundEngine("first");
      const secondEngine = createBackgroundEngine("second");
      const deferredPromises: Promise<void>[] = [];

      try {
        await runContextEngineMaintenance({
          contextEngine: firstEngine,
          sessionId: "session-owned-dispose",
          sessionKey,
          sessionFile: "/tmp/session-owned-dispose.jsonl",
          reason: "turn",
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });

        await Promise.race([firstEngine.started, ...deferredPromises]);
        expect(events).toContain("maintain:first");

        await runContextEngineMaintenance({
          contextEngine: secondEngine,
          sessionId: "session-owned-dispose",
          sessionKey,
          sessionFile: "/tmp/session-owned-dispose.jsonl",
          reason: "turn",
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => {
            deferredPromises.push(promise);
          },
        });

        releaseFirstMaintenance.resolve();
        await Promise.race([secondEngine.started, ...deferredPromises]);
        expect(events).toContain("maintain:second");
        expect(secondEngine["dispose"]).not.toHaveBeenCalled();

        releaseSecondMaintenance.resolve();
        await deferredPromises[1];

        expect(firstEngine["dispose"]).toHaveBeenCalledTimes(1);
        expect(secondEngine["dispose"]).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
          "maintain:first",
          "dispose:first",
          "maintain:second",
          "dispose:second",
        ]);
      } finally {
        releaseFirstMaintenance.resolve();
        releaseSecondMaintenance.resolve();
        await Promise.allSettled(deferredPromises);
      }
    });
  });

  it("reports deferred maintenance schedule failure while gateway is draining", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-draining-", async () => {
      resetCommandQueueStateForTest();

      const sessionKey = "agent:main:session-draining";
      const maintain = vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }));
      const onDeferredMaintenance = vi.fn();
      const onDeferredMaintenanceFailure = vi.fn();
      const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

      markGatewayDraining();
      const result = await runContextEngineMaintenance({
        contextEngine: backgroundEngine,
        sessionId: "session-draining",
        sessionKey,
        sessionFile: "/tmp/session-draining.jsonl",
        reason: "turn",
        onDeferredMaintenance,
        onDeferredMaintenanceFailure,
      });

      expect(result).toBeUndefined();
      expect(onDeferredMaintenance).not.toHaveBeenCalled();
      expect(onDeferredMaintenanceFailure).toHaveBeenCalledOnce();
      expect(onDeferredMaintenanceFailure.mock.calls[0]?.[0]).toHaveProperty(
        "name",
        "GatewayDrainingError",
      );
      expect(maintain).not.toHaveBeenCalled();
    });
  });

  it("rejects coalesced deferred maintenance requests while gateway is draining", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-draining-coalesced-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-draining-coalesced";
      const releaseMaintenance = createDeferred();
      try {
        resetCommandQueueStateForTest();

        const maintain = vi.fn(async () => {
          await releaseMaintenance.promise;
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
          };
        });
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);
        const firstDeferred: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-draining-coalesced",
          sessionKey,
          sessionFile: "/tmp/session-draining-coalesced.jsonl",
          reason: "turn",
          onDeferredMaintenance: (promise) => {
            firstDeferred.push(promise);
          },
        });
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);

        const onDeferredMaintenance = vi.fn();
        const onDeferredMaintenanceFailure = vi.fn();
        markGatewayDraining();
        const result = await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-draining-coalesced",
          sessionKey,
          sessionFile: "/tmp/session-draining-coalesced.jsonl",
          reason: "turn",
          onDeferredMaintenance,
          onDeferredMaintenanceFailure,
        });

        expect(result).toBeUndefined();
        expect(onDeferredMaintenance).not.toHaveBeenCalled();
        expect(onDeferredMaintenanceFailure).toHaveBeenCalledOnce();
        expect(onDeferredMaintenanceFailure.mock.calls[0]?.[0]).toHaveProperty(
          "name",
          "GatewayDrainingError",
        );
        expect(maintain).toHaveBeenCalledTimes(1);

        releaseMaintenance.resolve();
        await firstDeferred[0];
      } finally {
        releaseMaintenance.resolve();
        await Promise.allSettled([waitForDeferredTurnMaintenanceForSession(sessionKey)]);
        resetCommandQueueStateForTest();
        vi.useRealTimers();
      }
    });
  });

  it("releases maintenance when deferred scheduling is rejected", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const scheduleError = new Error("gateway draining");
      const enqueueSpy = vi
        .spyOn(commandQueueModule, "enqueueCommandInLane")
        .mockRejectedValue(scheduleError);
      try {
        resetCommandQueueStateForTest();

        const sessionKey = "agent:main:session-enqueue-reject";
        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-enqueue-reject",
          sessionKey,
          sessionFile: "/tmp/session-enqueue-reject.jsonl",
          reason: "turn",
        });
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
        expect(maintain).not.toHaveBeenCalled();
      } finally {
        enqueueSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("starts deferred maintenance while the foreground session lane stays busy", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-3";
      const releaseFirstForeground = createDeferred();
      let firstForeground: Promise<void> | undefined;
      let secondForeground: Promise<void> | undefined;
      try {
        resetCommandQueueStateForTest();

        const sessionLane = resolveSessionLane(sessionKey);
        const events: string[] = [];
        firstForeground = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-1-start");
          await releaseFirstForeground.promise;
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

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-3",
          sessionKey,
          sessionFile: "/tmp/session-3.jsonl",
          reason: "turn",
        });

        secondForeground = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-2-start");
          events.push("foreground-2-end");
        });

        await backgroundEngine.started;
        expect(events).toEqual(["foreground-1-start", "maintenance-start"]);
        expect(maintain).toHaveBeenCalledTimes(1);
        await waitForDeferredTurnMaintenanceForSession(sessionKey);

        releaseFirstForeground.resolve();
        await Promise.all([firstForeground, secondForeground]);
        expect(events).toEqual([
          "foreground-1-start",
          "maintenance-start",
          "foreground-1-end",
          "foreground-2-start",
          "foreground-2-end",
        ]);
      } finally {
        releaseFirstForeground.resolve();
        await Promise.allSettled([
          waitForDeferredTurnMaintenanceForSession(sessionKey),
          firstForeground,
          secondForeground,
        ]);
        vi.useRealTimers();
      }
    });
  });

  it("waits at the same-session read checkpoint before deferred maintenance rewrites", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-rewrite-priority";
      const allowRewrite = createDeferred();
      let foregroundTurn: Promise<void> | undefined;
      try {
        resetCommandQueueStateForTest();

        const sessionLane = resolveSessionLane(sessionKey);
        const events: string[] = [];
        const maintain = vi.fn(async (params?: unknown) => {
          events.push("maintenance-start");
          await allowRewrite.promise;
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

        rewriteTranscriptEntriesInSessionManagerMock.mockImplementationOnce((_params?: unknown) => {
          events.push("rewrite");
          return {
            changed: true,
            bytesFreed: 123,
            rewrittenEntries: 2,
          };
        });

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-rewrite-priority",
          sessionKey,
          sessionFile: "/tmp/session-rewrite-priority.jsonl",
          reason: "turn",
        });

        await backgroundEngine.started;
        expect(events).toContain("maintenance-start");

        foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-before-read-checkpoint");
          await waitForDeferredTurnMaintenanceForSession(sessionKey);
          events.push("foreground-read");
        });

        allowRewrite.resolve();
        await foregroundTurn;
        expect(events).toEqual([
          "maintenance-start",
          "foreground-before-read-checkpoint",
          "maintenance-before-rewrite",
          "rewrite",
          "maintenance-after-rewrite",
          "foreground-read",
        ]);

        expect(maintain).toHaveBeenCalledTimes(1);
      } finally {
        allowRewrite.resolve();
        await Promise.allSettled([
          waitForDeferredTurnMaintenanceForSession(sessionKey),
          foregroundTurn,
        ]);
        vi.useRealTimers();
      }
    });
  });

  it("keeps fast deferred maintenance silent for the user", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-fast";
      try {
        resetCommandQueueStateForTest();
        resetSystemEventsForTest();

        const maintain = vi.fn(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-fast",
          sessionKey,
          sessionFile: "/tmp/session-fast.jsonl",
          reason: "turn",
        });
        await backgroundEngine.started;
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
        expect(maintain).toHaveBeenCalledTimes(1);
        expect(peekSystemEvents(sessionKey)).toStrictEqual([]);
      } finally {
        await Promise.allSettled([waitForDeferredTurnMaintenanceForSession(sessionKey)]);
        vi.useRealTimers();
      }
    });
  });

  it("surfaces unrelated maintenance failures during shutdown", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-", async () => {
      vi.useFakeTimers();
      const keepProcessAlive = () => {};
      process.on("SIGTERM", keepProcessAlive);
      try {
        resetCommandQueueStateForTest();
        resetSystemEventsForTest();

        const sessionKey = "agent:main:session-fail";
        const onDeferredMaintenanceFailure = vi.fn();
        const maintain = vi.fn(async (rawParams?: unknown) => {
          const signal = (rawParams as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          if (!signal) {
            throw new Error("expected deferred maintenance abort signal");
          }
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              signal.removeEventListener("abort", onAbort);
              reject(new Error("maintenance cleanup failed"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
            }
          });
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        });
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          sessionId: "session-fail",
          sessionKey,
          sessionFile: "/tmp/session-fail.jsonl",
          reason: "turn",
          onDeferredMaintenanceFailure,
        });
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);
        process.emit("SIGTERM", "SIGTERM");
        await waitForDeferredTurnMaintenanceForSession(sessionKey);
        expect(onDeferredMaintenanceFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: "maintenance cleanup failed" }),
        );
      } finally {
        process.off("SIGTERM", keepProcessAlive);
        resetDeferredTurnMaintenanceStateForTest();
        vi.useRealTimers();
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
