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
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
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
  createMaintenanceSessionManagerOpenFixture,
  expectRecordFields,
  firstMaintainParams,
  loadContextEngineMaintenanceModuleForTest,
  requireRecord,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { resolveSessionLane } from "./lanes.js";

const rewriteTranscriptEntriesInSessionManagerMock = vi.fn((_params?: unknown) => ({
  changed: true,
  bytesFreed: 77,
  rewrittenEntries: 1,
}));
const sessionManagerFixture = createMaintenanceSessionManagerOpenFixture();
const sessionManagerOpenAsyncMock = sessionManagerFixture.openAsync;
const resolveSessionTranscriptRuntimeTargetMock = vi.fn(async (scope: Record<string, unknown>) => ({
  agentId: scope.agentId ?? "main",
  sessionId: scope.sessionId,
  sessionKey: scope.sessionKey,
  storePath: scope.storePath ?? resolveDefaultSessionStorePath("main"),
}));
let resetDeferredTurnMaintenanceStateForTest: typeof import("./context-engine-maintenance.test-support.js").resetDeferredTurnMaintenanceStateForTest;
let waitForSessionMaintenance: typeof import("../session-maintenance/coordinator.js").waitForSessionMaintenance;
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
    openAsync: (target: SessionTranscriptRuntimeTarget) => sessionManagerOpenAsyncMock(target),
  },
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  resolveSessionTranscriptRuntimeTarget: (scope: Record<string, unknown>) =>
    resolveSessionTranscriptRuntimeTargetMock(scope),
}));

vi.mock("../../config/sessions/session-cold-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-cold-storage.js")>()),
  restoreSessionColdTranscript: vi.fn(),
}));

const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
const rewritten = { changed: true, bytesFreed: 77, rewrittenEntries: 1 };

function makeEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  overrides: Partial<ContextEngine> = {},
): ContextEngine {
  return {
    info: { id: "test", name: "Test Engine" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
    ...overrides,
  };
}

function sessionParams(sessionId: string) {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    sessionFile: `/tmp/${sessionId === "session-1" ? "session" : sessionId}.jsonl`,
    reason: "turn" as const,
  };
}

function assistantReplacements() {
  return [
    {
      entryId: "entry-1",
      message: castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 2,
      }),
    },
  ];
}

describe("runContextEngineMaintenance", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    rewriteTranscriptEntriesInSessionManagerMock.mockClear();
    sessionManagerFixture.reset();
    resolveSessionTranscriptRuntimeTargetMock.mockClear();
    ({
      runContextEngineMaintenance,
      waitForSessionMaintenance,
      resetDeferredTurnMaintenanceStateForTest,
    } = await loadContextEngineMaintenanceModuleForTest());
  });

  it("passes a rewrite-capable runtime context into maintain()", async () => {
    await withStateDirEnv("openclaw-maintenance-runtime-context-", async () => {
      const sessionTarget = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      const maintain = vi.fn(async (_params?: unknown) => unchanged);

      const result = await runContextEngineMaintenance({
        contextEngine: makeEngine(maintain),
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionTarget,
        sessionFile: "/tmp/session.jsonl",
        reason: "turn",
        runtimeContext: { workspaceDir: "/tmp/workspace" },
      });

      expect(result).toEqual({ changed: false, bytesFreed: 0, rewrittenEntries: 0 });
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
      expect(rewriteResult).toEqual(rewritten);
      expect(sessionManagerOpenAsyncMock).toHaveBeenCalledWith(sessionTarget);
      expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
        sessionManager: sessionManagerFixture.current,
        replacements: [
          { entryId: "entry-2", message: { role: "user", content: "hello", timestamp: 2 } },
        ],
      });
    });
  });

  it("does not resolve or open a durable transcript when the rewrite owner rejects", async () => {
    const denied = new Error("detached recovery has no caller-owned transcript to rewrite");
    const withSessionManagerRewriteLock = vi.fn(async () => {
      throw denied;
    });
    let rewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
    await runContextEngineMaintenance({
      contextEngine: makeEngine(async ({ runtimeContext }) => {
        rewrite = runtimeContext?.rewriteTranscriptEntries;
        return unchanged;
      }),
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
    expect(resolveSessionTranscriptRuntimeTargetMock).not.toHaveBeenCalled();
    expect(sessionManagerOpenAsyncMock).not.toHaveBeenCalled();
    expect(rewriteTranscriptEntriesInSessionManagerMock).not.toHaveBeenCalled();
  });

  it.each(["restore", "hydrate"] as const)(
    "cancels a pending lazy transcript %s before rewriting",
    async (stage) => {
      const { executeContextEngineMaintenance } =
        await import("./context-engine-maintenance-execution.js");
      const coldStorage = await import("../../config/sessions/session-cold-storage.js");
      const { SessionManager } = await import("../sessions/index.js");
      const controller = new AbortController();
      const entered = createDeferred();
      const cancelled = new Error("maintenance cancelled during transcript read");
      const waitForAbort = async (signal?: AbortSignal): Promise<never> => {
        entered.resolve();
        if (!signal) {
          throw new Error("Transcript read is not cancellable");
        }
        return await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(cancelled), { once: true });
        });
      };
      const restore = vi.spyOn(coldStorage, "restoreSessionColdTranscript");
      const open = vi.spyOn(SessionManager, "openAsync");
      if (stage === "restore") {
        restore.mockImplementationOnce((_scope, _assert, _prepared, _guard, signal) =>
          waitForAbort(signal),
        );
      } else {
        open.mockImplementationOnce((_target, _cwd, _limits, signal) => waitForAbort(signal));
      }
      try {
        const pending = executeContextEngineMaintenance({
          contextEngine: makeEngine(async ({ runtimeContext }) =>
            runtimeContext!.rewriteTranscriptEntries!({
              replacements: [
                {
                  entryId: "entry-1",
                  message: { role: "user", content: "replacement", timestamp: 1 },
                },
              ],
            }),
          ),
          sessionId: "cancelled-session",
          sessionKey: "agent:main:cancelled-session",
          sessionFile: "agent:main:cancelled-session",
          reason: "compaction",
          executionMode: "foreground",
          abortSignal: controller.signal,
        });
        const rejected = expect(pending).rejects.toBe(cancelled);
        await entered.promise;
        controller.abort(cancelled);
        await rejected;
        expect(rewriteTranscriptEntriesInSessionManagerMock).not.toHaveBeenCalled();
      } finally {
        restore.mockRestore();
        open.mockRestore();
      }
    },
  );

  it("retires a deferred worker's retained rewrite capability after disposal and settlement", async () => {
    await withStateDirEnv("openclaw-retired-maintenance-rewrite-", async () => {
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
          contextEngine: makeEngine(
            async ({ runtimeContext }) => {
              rewrite = runtimeContext?.rewriteTranscriptEntries;
              activeRewriteResult = await rewrite?.(request);
              return rewritten;
            },
            {
              info: { id: "retained", name: "Retained rewrite", turnMaintenanceMode: "background" },
              dispose,
            },
          ),
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
        await waitForSessionMaintenance(sessionKey);

        expect(activeRewriteResult).toEqual({ changed: true, bytesFreed: 77, rewrittenEntries: 1 });
        expect(dispose).toHaveBeenCalledOnce();
        expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledOnce();
        expect(published).toHaveBeenCalledOnce();
        rewriteTranscriptEntriesInSessionManagerMock.mockClear();
        resolveSessionTranscriptRuntimeTargetMock.mockClear();
        sessionManagerOpenAsyncMock.mockClear();
        published.mockClear();

        await expect(
          expectDefined(rewrite, "retained rewrite capability")(request),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(resolveSessionTranscriptRuntimeTargetMock).not.toHaveBeenCalled();
        expect(sessionManagerOpenAsyncMock).not.toHaveBeenCalled();
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
        const sessionLane = resolveSessionLane(sessionKey);
        foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await releaseForeground.promise;
        });
        await Promise.resolve();

        const maintain = vi.fn(async (params?: unknown) => {
          await (
            params as { runtimeContext?: ContextEngineRuntimeContext } | undefined
          )?.runtimeContext?.rewriteTranscriptEntries?.({
            replacements: assistantReplacements(),
          });
          return unchanged;
        });

        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);

        const result = await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          ...sessionParams("session-1"),
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
        await waitForSessionMaintenance(sessionKey);
        expect(rewriteTranscriptEntriesInSessionManagerMock).toHaveBeenCalledWith({
          sessionManager: sessionManagerFixture.current,
          replacements: assistantReplacements(),
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
        await waitForSessionMaintenance(sessionKey);
      } finally {
        releaseForeground.resolve();
        await Promise.allSettled([waitForSessionMaintenance(sessionKey), foregroundTurn]);
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { name: "SIGTERM", trigger: () => process.emit("SIGTERM", "SIGTERM") },
    { name: "accepted restart drain", trigger: () => markGatewayDraining() },
  ])(
    "settles abort-waiting deferred maintenance during $name without rerun",
    async ({ trigger }) => {
      await withStateDirEnv("openclaw-turn-maintenance-abort-waiting-", async () => {
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
          return unchanged;
        });
        const secondMaintain = vi.fn(async () => unchanged);
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
        await registerLegacyContextEngine();
        const sharedEngineId = "shutdown-shared-engine";
        await registerContextEngineForOwner(
          sharedEngineId,
          () => firstEngine,
          `test:${sharedEngineId}`,
          {
            allowSameOwnerRefresh: true,
          },
        );
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
            ...sessionParams("session-abort-waiting"),
            onDeferredMaintenance: (promise) => {
              deferred = promise;
            },
          });
          const completion = expectDefined(deferred, "deferred maintenance completion");
          await Promise.race([firstEngine.started, completion]);
          expect(firstMaintain).toHaveBeenCalledTimes(1);

          await runContextEngineMaintenance({
            contextEngine: firstRerunResolution.configured.engine,
            ...sessionParams("session-abort-waiting"),
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          await runContextEngineMaintenance({
            contextEngine: secondEngine,
            ...sessionParams("session-abort-waiting"),
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          expect(firstEngine["dispose"]).not.toHaveBeenCalled();
          await runContextEngineMaintenance({
            contextEngine: finalRerunResolution.configured.engine,
            ...sessionParams("session-abort-waiting"),
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          await Promise.race([secondDisposed.promise, completion]);
          expect(secondEngine["dispose"]).toHaveBeenCalledTimes(1);

          trigger();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            waitForSessionMaintenance(sessionKey).then(() => true),
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
    { name: "SIGTERM", trigger: () => process.emit("SIGTERM", "SIGTERM") },
    { name: "accepted restart drain", trigger: () => markGatewayDraining() },
  ])("does not start queued deferred maintenance after $name", async ({ trigger }) => {
    await withStateDirEnv("openclaw-turn-maintenance-queued-abort-", async () => {
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
      const maintain = vi.fn(async () => unchanged);
      const engine = {
        ...createBackgroundMaintenanceEngine(maintain, "queued"),
        dispose: vi.fn(async () => {}),
      };
      let deferred: Promise<void> | undefined;

      try {
        await laneStarted.promise;
        await runContextEngineMaintenance({
          contextEngine: engine,
          ...sessionParams("session-queued-abort"),
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => {
            deferred = promise;
          },
        });

        trigger();
        releaseLane.resolve();
        await laneBlocker;
        await deferred;
        await waitForSessionMaintenance(sessionKey);

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
      let secondDeferredSettled = false;

      try {
        await runContextEngineMaintenance({
          contextEngine: firstEngine,
          ...sessionParams("session-owned-dispose"),
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => deferredPromises.push(promise),
        });

        await Promise.race([firstEngine.started, ...deferredPromises]);
        expect(events).toContain("maintain:first");

        await runContextEngineMaintenance({
          contextEngine: secondEngine,
          ...sessionParams("session-owned-dispose"),
          disposeDeferredContextEngineAfterMaintenance: true,
          onDeferredMaintenance: (promise) => deferredPromises.push(promise),
        });

        const secondDeferred = expectDefined(
          deferredPromises[1],
          "second maintenance completion",
        ).then(() => {
          secondDeferredSettled = true;
        });
        releaseFirstMaintenance.resolve();
        await Promise.race([secondEngine.started, ...deferredPromises]);
        expect(events).toContain("maintain:second");
        expect(secondEngine["dispose"]).not.toHaveBeenCalled();
        expect(secondDeferredSettled).toBe(false);

        releaseSecondMaintenance.resolve();
        await secondDeferred;
        expect(secondDeferredSettled).toBe(true);

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

  it("rejects coalesced deferred maintenance requests while gateway is draining", async () => {
    await withStateDirEnv("openclaw-turn-maintenance-draining-coalesced-", async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-draining-coalesced";
      const releaseMaintenance = createDeferred();
      try {
        const maintain = vi.fn(async () => {
          await releaseMaintenance.promise;
          return unchanged;
        });
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);
        const firstDeferred: Promise<void>[] = [];

        await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          ...sessionParams("session-draining-coalesced"),
          onDeferredMaintenance: (promise) => firstDeferred.push(promise),
        });
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);

        const onDeferredMaintenance = vi.fn();
        const onDeferredMaintenanceFailure = vi.fn();
        markGatewayDraining();
        const result = await runContextEngineMaintenance({
          contextEngine: backgroundEngine,
          ...sessionParams("session-draining-coalesced"),
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
        await Promise.allSettled([waitForSessionMaintenance(sessionKey)]);
        resetCommandQueueStateForTest();
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
        const sessionLane = resolveSessionLane(sessionKey);
        const events: string[] = [];
        const maintain = vi.fn(async (params?: unknown) => {
          events.push("maintenance-start");
          await allowRewrite.promise;
          events.push("maintenance-before-rewrite");
          await (
            params as { runtimeContext?: ContextEngineRuntimeContext }
          ).runtimeContext?.rewriteTranscriptEntries?.({
            replacements: assistantReplacements(),
          });
          events.push("maintenance-after-rewrite");
          return unchanged;
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
          ...sessionParams("session-rewrite-priority"),
        });

        await backgroundEngine.started;
        expect(events).toContain("maintenance-start");

        foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          events.push("foreground-before-read-checkpoint");
          await waitForSessionMaintenance(sessionKey);
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
        await Promise.allSettled([waitForSessionMaintenance(sessionKey), foregroundTurn]);
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
          ...sessionParams("session-fail"),
          onDeferredMaintenanceFailure,
        });
        await backgroundEngine.started;
        expect(maintain).toHaveBeenCalledTimes(1);
        process.emit("SIGTERM", "SIGTERM");
        await waitForSessionMaintenance(sessionKey);
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
