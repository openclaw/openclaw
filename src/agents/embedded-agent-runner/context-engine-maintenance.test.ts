import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { expectCallCount as expectCalls } from "../../test-utils/mock-call-assertions.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createBackgroundMaintenanceEngine,
  createMaintenanceEngine as makeEngine,
  createMaintenanceSessionManagerOpenFixture,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";

const rewriteMock = vi.fn((_params?: unknown) => ({
  changed: true,
  bytesFreed: 77,
  rewrittenEntries: 1,
}));
const sessionManagerFixture = createMaintenanceSessionManagerOpenFixture();
const openMock = sessionManagerFixture.openAsync;
const resolveTargetMock = vi.fn(async (scope: Record<string, unknown>) => ({
  agentId: scope.agentId ?? "main",
  sessionId: scope.sessionId,
  sessionKey: scope.sessionKey,
  storePath: scope.storePath ?? resolveDefaultSessionStorePath("main"),
}));

vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({ llm: undefined }),
}));

// mock-isolation: Maintenance assertions control transcript writes through rewriteMock.
vi.mock("./transcript-rewrite.js", () => ({
  rewriteTranscriptEntriesInSessionManager: (params: unknown) => rewriteMock(params),
}));

// mock-isolation: Use the in-memory session fixture instead of opening real transcript files.
vi.mock("../sessions/index.js", () => ({
  SessionManager: {
    openAsync: (target: SessionTranscriptRuntimeTarget) => openMock(target),
  },
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  resolveSessionTranscriptRuntimeTarget: (scope: Record<string, unknown>) =>
    resolveTargetMock(scope),
}));

vi.mock("../../config/sessions/session-cold-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-cold-storage.js")>()),
  restoreSessionColdTranscript: vi.fn(),
}));

const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
const rewritten = { changed: true, bytesFreed: 77, rewrittenEntries: 1 };
const keepProcessAlive = () => {};
type Maintain = NonNullable<ContextEngine["maintain"]>;
type MaintenanceParams = Parameters<typeof runContextEngineMaintenance>[0];

function backgroundSession(sessionId: string) {
  const params = sessionParams(sessionId);
  const pending: Promise<void>[] = [];
  return {
    sessionKey: params.sessionKey,
    pending,
    run(contextEngine: ContextEngine, overrides: Partial<MaintenanceParams> = {}) {
      return runContextEngineMaintenance({
        ...params,
        contextEngine,
        onDeferredMaintenance: (work) => pending.push(work),
        ...overrides,
      });
    },
  };
}

const inState = (run: () => Promise<void>) => () => withStateDirEnv("openclaw-maintenance-", run);

function sessionParams(sessionId: string) {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    sessionFile: `/tmp/${sessionId === "session-1" ? "session" : sessionId}.jsonl`,
    reason: "turn" as const,
  };
}

function rewriteRequest() {
  return {
    replacements: [
      {
        entryId: "entry-1",
        message: castAgentMessage({ role: "user", content: "updated", timestamp: 1 }),
      },
    ],
  };
}

function assistantReplacements() {
  return [
    {
      entryId: "entry-1",
      message: castAgentMessage({ role: "assistant", content: "done", timestamp: 2 }),
    },
  ];
}

describe("runContextEngineMaintenance", () => {
  beforeEach(() => {
    vi.useRealTimers();
    process.on("SIGTERM", keepProcessAlive);
    resetCommandQueueStateForTest();
    rewriteMock.mockClear();
    sessionManagerFixture.reset();
    resolveTargetMock.mockClear();
  });

  afterEach(() => {
    process.off("SIGTERM", keepProcessAlive);
    vi.useRealTimers();
  });

  it(
    "passes a rewrite-capable runtime context into maintain()",
    inState(async () => {
      const sessionTarget = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      const maintain = vi.fn<Maintain>(async () => unchanged);
      const result = await runContextEngineMaintenance({
        contextEngine: makeEngine(maintain),
        ...sessionParams("session-1"),
        sessionTarget,
        runtimeContext: { workspaceDir: "/tmp/workspace" },
      });

      expect(result).toEqual(unchanged);
      const params = expectDefined(maintain.mock.calls[0]?.[0], "maintain params");
      expect(params).toMatchObject({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: "/tmp/session.jsonl",
        runtimeContext: { workspaceDir: "/tmp/workspace" },
      });
      expect(params.sessionTarget).toBe(sessionTarget);
      expect(params.runtimeContext?.sessionTarget).toEqual(sessionTarget);
      const rewriteResult = await expectDefined(
        params.runtimeContext?.rewriteTranscriptEntries,
        "runtime rewrite helper",
      )(rewriteRequest());
      expect(rewriteResult).toEqual(rewritten);
    }),
  );

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
      ...sessionParams("detached-session"),
      sessionFile: "agent:main:detached-session",
      reason: "compaction",
      withSessionManagerRewriteLock,
    });
    if (!rewrite) {
      throw new Error("expected the host-owned rewrite capability");
    }

    await expect(rewrite(rewriteRequest())).rejects.toBe(denied);
    expectCalls(1, withSessionManagerRewriteLock);
    expectCalls(0, resolveTargetMock, openMock, rewriteMock);
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
            runtimeContext!.rewriteTranscriptEntries!(rewriteRequest()),
          ),
          ...sessionParams("cancelled-session"),
          sessionFile: "agent:main:cancelled-session",
          reason: "compaction",
          executionMode: "foreground",
          abortSignal: controller.signal,
        });
        const rejected = expect(pending).rejects.toBe(cancelled);
        await entered.promise;
        controller.abort(cancelled);
        await rejected;
        expect(rewriteMock).not.toHaveBeenCalled();
      } finally {
        restore.mockRestore();
        open.mockRestore();
      }
    },
  );

  it(
    "retires a deferred worker's retained rewrite capability after disposal and settlement",
    inState(async () => {
      const f = backgroundSession("retained-maintenance-rewrite");
      const { sessionKey } = f;
      const published = vi.fn();
      const unsubscribe = onSessionTranscriptUpdate((event) => {
        if (event.sessionKey === sessionKey) {
          published(event);
        }
      });
      const dispose = vi.fn(async () => {});
      let rewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
      let activeRewriteResult: unknown;
      const request = rewriteRequest();
      try {
        await f.run(
          makeEngine(
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
          { sessionFile: sessionKey, disposeDeferredContextEngineAfterMaintenance: true },
        );
        await expectDefined(f.pending[0], "deferred maintenance completion");
        await waitForSessionMaintenance(sessionKey);

        expect(activeRewriteResult).toEqual(rewritten);
        expectCalls(1, dispose, rewriteMock, published);
        rewriteMock.mockClear();
        resolveTargetMock.mockClear();
        openMock.mockClear();
        published.mockClear();
        await expect(
          expectDefined(rewrite, "retained rewrite capability")(request),
        ).rejects.toMatchObject({ name: "AbortError" });
        expectCalls(0, resolveTargetMock, openMock, rewriteMock, published);
      } finally {
        await Promise.allSettled(f.pending);
        unsubscribe();
      }
    }),
  );

  it(
    "defers turn maintenance without blocking the foreground lane",
    inState(async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-1";
      const releaseForeground = createDeferred();
      let foregroundTurn: Promise<void> | undefined;
      try {
        const sessionLane = `test:foreground-turn:${sessionKey}`;
        foregroundTurn = enqueueCommandInLane(sessionLane, async () => {
          await releaseForeground.promise;
        });
        await Promise.resolve();
        const maintain = vi.fn<Maintain>(async ({ runtimeContext }) => {
          await runtimeContext?.rewriteTranscriptEntries?.({
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
        await waitForSessionMaintenance(sessionKey);
        expect(rewriteMock).toHaveBeenCalledWith({
          sessionManager: sessionManagerFixture.current,
          replacements: assistantReplacements(),
        });

        releaseForeground.resolve();
        expect(maintain.mock.calls[0]?.[0].runtimeContext).toMatchObject({
          workspaceDir: "/tmp/workspace",
          allowDeferredCompactionExecution: true,
          tokenBudget: 2048,
          currentTokenCount: 1536,
        });
        await foregroundTurn;
      } finally {
        releaseForeground.resolve();
        await Promise.allSettled([waitForSessionMaintenance(sessionKey), foregroundTurn]);
      }
    }),
  );

  it.each([
    { name: "SIGTERM", trigger: () => process.emit("SIGTERM", "SIGTERM") },
    { name: "accepted restart drain", trigger: () => markGatewayDraining() },
  ])(
    "settles abort-waiting deferred maintenance during $name without rerun",
    async ({ trigger }) => {
      await withStateDirEnv("openclaw-turn-maintenance-abort-waiting-", async () => {
        const f = backgroundSession("session-abort-waiting");
        const { sessionKey } = f;
        const lane = `context-engine-turn-maintenance:${sessionKey}`;
        const releaseFirstMaintenance = createDeferred();
        let observedSignal: AbortSignal | undefined;
        const firstMaintain = vi.fn<Maintain>(async ({ abortSignal: signal }) => {
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
        const createOwnedEngine = (id: string, maintain: Maintain) => ({
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
          { allowSameOwnerRefresh: true },
        );
        const contextEngineConfig = { plugins: { slots: { contextEngine: sharedEngineId } } };
        const firstResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);
        const firstRerunResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);
        const finalRerunResolution = await resolveLogicalTurnContextEngines(contextEngineConfig);

        try {
          expect(firstResolution.configured.engine).not.toBe(
            firstRerunResolution.configured.engine,
          );
          expect(firstRerunResolution.configured.engine).not.toBe(
            finalRerunResolution.configured.engine,
          );
          await f.run(firstResolution.configured.engine);
          const completion = expectDefined(f.pending[0], "deferred maintenance completion");
          await Promise.race([firstEngine.started, completion]);
          await f.run(firstRerunResolution.configured.engine, {
            disposeDeferredContextEngineAfterMaintenance: true,
          });
          await f.run(secondEngine, { disposeDeferredContextEngineAfterMaintenance: true });
          expect(firstEngine["dispose"]).not.toHaveBeenCalled();
          await f.run(finalRerunResolution.configured.engine, {
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
          expectCalls(1, firstMaintain);
          expectCalls(0, secondMaintain);
          expectCalls(1, firstEngine["dispose"], secondEngine["dispose"]);
          expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
        } finally {
          trigger();
          releaseFirstMaintenance.resolve();
          await Promise.allSettled(f.pending);
          await Promise.allSettled([
            firstResolution.fallback.engine.dispose?.(),
            firstRerunResolution.fallback.engine.dispose?.(),
            finalRerunResolution.fallback.engine.dispose?.(),
          ]);
        }
      });
    },
  );

  it.each([
    { name: "SIGTERM", trigger: () => process.emit("SIGTERM", "SIGTERM") },
    { name: "accepted restart drain", trigger: () => markGatewayDraining() },
  ])("does not start queued deferred maintenance after $name", async ({ trigger }) => {
    await withStateDirEnv("openclaw-turn-maintenance-queued-abort-", async () => {
      const f = backgroundSession("session-queued-abort");
      const { sessionKey } = f;
      const lane = `context-engine-turn-maintenance:${sessionKey}`;
      const releaseLane = createDeferred();
      const laneStarted = createDeferred();
      const laneBlocker = enqueueCommandInLane(lane, async () => {
        laneStarted.resolve();
        await releaseLane.promise;
      });
      const maintain = vi.fn(async () => unchanged);
      const engine = {
        ...createBackgroundMaintenanceEngine(maintain, "queued"),
        dispose: vi.fn(async () => {}),
      };

      try {
        await laneStarted.promise;
        await f.run(engine, { disposeDeferredContextEngineAfterMaintenance: true });

        trigger();
        releaseLane.resolve();
        await laneBlocker;
        await f.pending[0];
        await waitForSessionMaintenance(sessionKey);
        expectCalls(0, maintain);
        expectCalls(1, engine["dispose"]);
        expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
      } finally {
        releaseLane.resolve();
        await Promise.allSettled([laneBlocker, ...f.pending]);
      }
    });
  });

  it(
    "disposes owned deferred engines only after their maintenance run finishes",
    inState(async () => {
      const f = backgroundSession("session-owned-dispose");
      const events: string[] = [];
      const releaseFirstMaintenance = createDeferred();
      const releaseSecondMaintenance = createDeferred();
      const createBackgroundEngine = (id: "first" | "second") => ({
        ...createBackgroundMaintenanceEngine(async () => {
          events.push(`maintain:${id}`);
          await (id === "first" ? releaseFirstMaintenance : releaseSecondMaintenance).promise;
          return unchanged;
        }, id),
        dispose: vi.fn(async () => {
          events.push(`dispose:${id}`);
        }),
      });
      const firstEngine = createBackgroundEngine("first");
      const secondEngine = createBackgroundEngine("second");
      let secondDeferredSettled = false;

      try {
        await f.run(firstEngine, { disposeDeferredContextEngineAfterMaintenance: true });
        await Promise.race([firstEngine.started, ...f.pending]);
        expect(events).toContain("maintain:first");
        await f.run(secondEngine, { disposeDeferredContextEngineAfterMaintenance: true });
        const secondDeferred = expectDefined(f.pending[1], "second maintenance completion").then(
          () => {
            secondDeferredSettled = true;
          },
        );
        releaseFirstMaintenance.resolve();
        await Promise.race([secondEngine.started, ...f.pending]);
        expect(events).toContain("maintain:second");
        expect(secondEngine["dispose"]).not.toHaveBeenCalled();
        expect(secondDeferredSettled).toBe(false);

        releaseSecondMaintenance.resolve();
        await secondDeferred;
        expect(secondDeferredSettled).toBe(true);
        expectCalls(1, firstEngine["dispose"], secondEngine["dispose"]);
        expect(events).toEqual([
          "maintain:first",
          "dispose:first",
          "maintain:second",
          "dispose:second",
        ]);
      } finally {
        releaseFirstMaintenance.resolve();
        releaseSecondMaintenance.resolve();
        await Promise.allSettled(f.pending);
      }
    }),
  );

  it(
    "rejects coalesced deferred maintenance requests while gateway is draining",
    inState(async () => {
      vi.useFakeTimers();
      const f = backgroundSession("session-draining-coalesced");
      const { sessionKey } = f;
      const releaseMaintenance = createDeferred();
      try {
        const maintain = vi.fn(async () => {
          await releaseMaintenance.promise;
          return unchanged;
        });
        const backgroundEngine = createBackgroundMaintenanceEngine(maintain);
        await f.run(backgroundEngine);
        await backgroundEngine.started;
        const onDeferredMaintenance = vi.fn();
        const onDeferredMaintenanceFailure = vi.fn();
        markGatewayDraining();
        const result = await f.run(backgroundEngine, {
          onDeferredMaintenance,
          onDeferredMaintenanceFailure,
        });

        expect(result).toBeUndefined();
        expectCalls(0, onDeferredMaintenance);
        expectCalls(1, onDeferredMaintenanceFailure);
        expect(onDeferredMaintenanceFailure.mock.calls[0]?.[0]).toHaveProperty(
          "name",
          "GatewayDrainingError",
        );

        releaseMaintenance.resolve();
        await f.pending[0];
        expect(maintain).toHaveBeenCalledTimes(1);
      } finally {
        releaseMaintenance.resolve();
        await Promise.allSettled([waitForSessionMaintenance(sessionKey)]);
        resetCommandQueueStateForTest();
      }
    }),
  );

  it(
    "waits at the same-session read checkpoint before deferred maintenance rewrites",
    inState(async () => {
      vi.useFakeTimers();
      const sessionKey = "agent:main:session-rewrite-priority";
      const allowRewrite = createDeferred();
      let foregroundTurn: Promise<void> | undefined;
      try {
        const sessionLane = `test:foreground-turn:${sessionKey}`;
        const events: string[] = [];
        const maintain = vi.fn<Maintain>(async ({ runtimeContext }) => {
          events.push("maintenance-start");
          await allowRewrite.promise;
          events.push("maintenance-before-rewrite");
          await runtimeContext?.rewriteTranscriptEntries?.({
            replacements: assistantReplacements(),
          });
          events.push("maintenance-after-rewrite");
          return unchanged;
        });

        rewriteMock.mockImplementationOnce((_params?: unknown) => {
          events.push("rewrite");
          return { changed: true, bytesFreed: 123, rewrittenEntries: 2 };
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
      } finally {
        allowRewrite.resolve();
        await Promise.allSettled([waitForSessionMaintenance(sessionKey), foregroundTurn]);
      }
    }),
  );

  it(
    "surfaces unrelated maintenance failures during shutdown",
    inState(async () => {
      vi.useFakeTimers();
      resetSystemEventsForTest();
      const sessionKey = "agent:main:session-fail";
      const onDeferredMaintenanceFailure = vi.fn();
      const maintain = vi.fn<Maintain>(async ({ abortSignal: signal }) => {
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
        return unchanged;
      });
      const backgroundEngine = createBackgroundMaintenanceEngine(maintain);
      await runContextEngineMaintenance({
        contextEngine: backgroundEngine,
        ...sessionParams("session-fail"),
        onDeferredMaintenanceFailure,
      });
      await backgroundEngine.started;
      process.emit("SIGTERM", "SIGTERM");
      await waitForSessionMaintenance(sessionKey);
      expect(onDeferredMaintenanceFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "maintenance cleanup failed" }),
      );
    }),
  );
});
