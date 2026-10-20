import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { refreshSessionEntryFromStore } from "../../auto-reply/reply/agent-runner-core.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { resolveCompactionTimeoutMs } from "./compaction-safety-timeout.js";
import {
  type RecoveryFixture,
  recoveryCompaction,
  unchangedMaintenance,
  waitForCompactionAbort,
  withRecoveryFixture,
} from "./run.compaction-runtime.test-support.js";

type Snapshot = Awaited<ReturnType<RecoveryFixture["snapshot"]>>;

function recoveryTest(
  name: string,
  options: Parameters<typeof withRecoveryFixture>[0],
  proof: Parameters<typeof withRecoveryFixture>[1],
) {
  it(name, () => withRecoveryFixture(options, proof));
}

function expectArchivedEvents(before: Snapshot, after: Snapshot) {
  expect(after.eventDigests.slice(0, before.eventDigests.length)).toEqual(before.eventDigests);
}

function expectCompactionAccounting(fixture: RecoveryFixture) {
  expect(fixture.recoveryState).toMatchObject({
    autoCompactionCount: 1,
    lastCompactionTokensAfter: 3_000,
  });
}

function expectStoppedBeforePublication(fixture: RecoveryFixture) {
  expect(fixture.afterHook).not.toHaveBeenCalled();
  expect(fixture.updates).not.toHaveBeenCalled();
  fixture.expectNoContinuation();
}

function realCompactor(fixture: RecoveryFixture) {
  return expectDefined(
    fixture.compact.getMockImplementation(),
    "Fixture must provide the real append implementation",
  );
}

// Only deadline tests control timers; real persistence must reach its checkpoint first.
async function recoverAtSafetyDeadline(
  fixture: RecoveryFixture,
  kind: Parameters<RecoveryFixture["recover"]>[0],
  checkpoint: Promise<void>,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = fixture.recover(kind);
  try {
    await awaitGateBeforeSettlement(
      checkpoint,
      pending,
      "Recovery settled before the safety-timeout checkpoint",
    );
    await vi.advanceTimersByTimeAsync(resolveCompactionTimeoutMs());
    return await pending;
  } catch (error) {
    fixture.stop();
    throw error;
  } finally {
    await pending.catch(() => undefined);
    vi.useRealTimers();
  }
}

describe("embedded compaction recovery authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["truncate", "small", "beyond-reader-window"] as const)(
    "preserves archived resets while recovering %s output",
    async (mode) => {
      await withRecoveryFixture(
        {
          historicalTurns: 4,
          ...(mode === "small" ? { oversized: false } : {}),
          ...(mode === "beyond-reader-window"
            ? { contextTokenBudget: 200_000, toolResultText: "x".repeat(1_200_000) }
            : {}),
        },
        async (fixture) => {
          const before = await fixture.snapshot();
          if (mode === "beyond-reader-window") {
            fixture.compact.mockRejectedValueOnce(new Error("independent engine failure"));
          }
          await expect(
            fixture.recover("overflow", mode !== "beyond-reader-window"),
          ).resolves.toEqual({ action: "retry" });
          const after = await fixture.snapshot();
          expectArchivedEvents(before, after);
          expect(after).toMatchObject({ resetCount: before.resetCount });
          if (mode === "small") {
            expect(after).toMatchObject({ toolResultChars: before.toolResultChars });
            expect(after.eventDigests).toHaveLength(before.eventDigests.length + 1);
          } else {
            expect(after.toolResultChars).toBeLessThan(before.toolResultChars);
            if (mode === "truncate") {
              expect(after.eventDigests.length - before.eventDigests.length).toBeLessThanOrEqual(5);
              fixture.assertActive();
            }
          }
        },
      );
    },
  );

  it("settles successful no-op engine hooks for overflow recovery", async () => {
    await withRecoveryFixture({ oversized: false }, async (fixture) => {
      const before = await fixture.snapshot();
      const entry = fixture.loadEntry();
      fixture.compact.mockResolvedValueOnce({ ok: true, compacted: false, reason: "proof no-op" });

      await fixture.recover("overflow");

      expect(fixture.beforeHook).toHaveBeenCalledTimes(1);
      expect(fixture.afterHook).toHaveBeenCalledTimes(1);
      expect(fixture.afterHook).toHaveBeenCalledWith(
        expect.objectContaining({ compactedCount: 0 }),
        expect.objectContaining({ sessionKey: fixture.getSessionTarget()?.sessionKey }),
      );
      expect(fixture.maintain).not.toHaveBeenCalled();
      expect(fixture.getCommittedSuccessor()).toBeUndefined();
      expect(fixture.recoveryState.autoCompactionCount).toBe(0);
      expect(fixture.loadEntry()).toEqual(entry);
      expect(await fixture.snapshot()).toEqual(before);
    });
  });

  it.each(["overflow", "timeout"] as const)(
    "accepts a healthy declared successor through the host writer (%s)",
    async (kind) => {
      await withRecoveryFixture({ oversized: false, replyAdmission: true }, async (fixture) => {
        const before = fixture.loadEntry();
        expect(before).toHaveProperty("activeWriterRunId", fixture.runId);
        const successorId = randomUUID();
        fixture.compact.mockImplementationOnce(async ({ sessionTarget }) => {
          // Only the host transfers the durable row and its private writer facts.
          expect(sessionTarget).not.toHaveProperty("expectedWriterRunId");
          expect(fixture.loadEntry()?.sessionId).toBe(before?.sessionId);
          return recoveryCompaction({
            summary: "Engine-owned successor context",
            sessionId: successorId,
            sessionTarget: { ...sessionTarget, sessionId: successorId, threadId: "thread-hint" },
          });
        });

        await expect(fixture.recover(kind)).resolves.toEqual(
          kind === "overflow" ? { action: "retry" } : true,
        );

        const after = fixture.loadEntry();
        expect(after).toMatchObject({
          sessionId: successorId,
          activeWriterRunId: fixture.runId,
        });
        expect(after?.lifecycleRevision).toBe(before?.lifecycleRevision);
        expect(fixture.getSessionTarget()).toMatchObject({
          sessionId: successorId,
          threadId: "thread-hint",
        });
        expect(fixture.getCommittedSuccessor()?.entry).toEqual(after);
        expectCompactionAccounting(fixture);
        expect(fixture.afterHook).toHaveBeenCalledWith(
          expect.objectContaining({ previousSessionId: before?.sessionId }),
          expect.objectContaining({ sessionId: successorId }),
        );
        fixture.assertActive();
        const refresh = () =>
          refreshSessionEntryFromStore({
            ...fixture.target,
            expectedGeneration: after,
            reader: getReplyOperationSessionReader(fixture.replyOperation),
          });
        await expect(refresh()).resolves.toMatchObject({ sessionId: successorId });
        await upsertSessionEntryCore(fixture.target, {
          ...after,
          sessionId: successorId,
          lifecycleRevision: "external-reset-after-compaction",
          updatedAt: Date.now(),
        });
        await expect(refresh()).rejects.toThrow("Session entry changed during read");
      });
    },
  );
  recoveryTest(
    "records successor target and tokens before an identity observer aborts recovery",
    { oversized: false, replyAdmission: true },
    async (fixture) => {
      const { onSessionIdentityMutation } =
        await import("../../sessions/session-lifecycle-events.js");
      const previousSessionId = fixture.loadEntry()?.sessionId;
      const successorId = randomUUID();
      const observe = () => ({
        accepted: fixture.getCommittedSuccessor(),
        count: fixture.recoveryState.autoCompactionCount,
        tokensAfter: fixture.recoveryState.lastCompactionTokensAfter,
      });
      let atObserver: ReturnType<typeof observe> | undefined;
      const unsubscribe = onSessionIdentityMutation((mutation) => {
        if (mutation.kind !== "replace" || mutation.previous.sessionId !== previousSessionId) {
          return;
        }
        atObserver = observe();
        fixture.updates.mockClear();
        fixture.stop();
      });
      fixture.compact.mockResolvedValueOnce(recoveryCompaction({ sessionId: successorId }));
      try {
        await expect(fixture.recover("overflow")).rejects.toBe(fixture.callerError);
        expect(atObserver).toMatchObject({
          accepted: {
            sessionId: successorId,
            previousSessionId,
            entry: { sessionId: successorId, activeWriterRunId: fixture.runId },
          },
          count: 1,
          tokensAfter: 3_000,
        });
        expect(fixture.getCommittedSuccessor()).toBe(atObserver?.accepted);
        expect(fixture.loadEntry()?.sessionId).toBe(successorId);
        expect(fixture.maintain).not.toHaveBeenCalled();
        expectStoppedBeforePublication(fixture);
      } finally {
        unsubscribe();
      }
    },
  );

  recoveryTest(
    "keeps overflow recovery read-only when detached without a caller-owned manager",
    { detached: true, oversized: false },
    async (fixture) => {
      const before = await fixture.snapshot();
      const entryBefore = fixture.loadEntry();
      let rewriteError: unknown;
      fixture.compact.mockResolvedValueOnce(
        recoveryCompaction({ summary: "engine-owned context" }),
      );
      fixture.maintain.mockImplementationOnce(async ({ runtimeContext }) => {
        try {
          await runtimeContext?.rewriteTranscriptEntries?.({
            replacements: [fixture.replacement],
          });
        } catch (error) {
          rewriteError = error;
        }
        return unchangedMaintenance();
      });
      fixture.updates.mockClear();

      await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });

      expect(await fixture.snapshot()).toEqual(before);
      expect(fixture.loadEntry()).toEqual(entryBefore);
      expect(fixture.getCommittedSuccessor()).toBeUndefined();
      expectCompactionAccounting(fixture);
      expect(fixture.updates).not.toHaveBeenCalled();
      expect(rewriteError).toBeInstanceOf(Error);
      expect(String(rewriteError)).toContain("detached recovery has no caller-owned transcript");
      fixture.assertActive();
    },
  );

  recoveryTest(
    "blocks an ordinary portable SessionManager write inside detached overflow compaction",
    { detached: true, oversized: false },
    async (fixture) => {
      const before = await fixture.snapshot();
      const entryBefore = fixture.loadEntry();
      fixture.updates.mockClear();

      // The default backend opens a portable SessionManager without a writer claim.
      const outcome = await fixture.recover("overflow");

      expect(fixture.compact).toHaveBeenCalledOnce();
      await expect.soft(fixture.compact.mock.results[0]?.value).rejects.toBeInstanceOf(Error);
      // A rejected recovery compaction is a genuine failure, not a benign skip.
      expect.soft(outcome).toMatchObject({ action: "surface", kind: "compaction_failure" });
      expect.soft(await fixture.snapshot()).toEqual(before);
      expect.soft(fixture.loadEntry()).toEqual(entryBefore);
      expect.soft(fixture.recoveryState).toMatchObject({
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
      });
      expect(fixture.maintain).not.toHaveBeenCalled();
      expectStoppedBeforePublication(fixture);
    },
  );

  it("preserves the exact caller error without post-abort overflow work", async () => {
    await withRecoveryFixture({ oversized: true }, async (fixture) => {
      const before = await fixture.snapshot();
      fixture.updates.mockClear();
      fixture.compact.mockImplementationOnce(({ abortSignal }) =>
        waitForCompactionAbort(abortSignal, () => queueMicrotask(fixture.stop)),
      );

      await expect.soft(fixture.recover("overflow")).rejects.toBe(fixture.callerError);
      expect.soft(await fixture.snapshot()).toEqual(before);
      expect(fixture.compact).toHaveBeenCalledOnce();
      expect(fixture.beforeHook).toHaveBeenCalledOnce();
      expect(fixture.maintain).not.toHaveBeenCalled();
      expect(fixture.recoveryState.autoCompactionCount).toBe(0);
      expectStoppedBeforePublication(fixture);
    });
  });

  it.each([
    { kind: "overflow", loss: "closed" },
    { kind: "overflow", loss: "replaced" },
  ] as const)(
    "stops $kind recovery when authority is $loss without a caller signal",
    async ({ kind, loss }) => {
      await withRecoveryFixture({}, async (fixture) => {
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.compact.mockImplementationOnce(async () => {
          await fixture.invalidate(loss);
          throw new Error("engine failed after losing its owner");
        });

        await expect.soft(fixture.recover(kind)).rejects.toBeInstanceOf(Error);

        expect.soft(await fixture.snapshot()).toEqual(before);
        expectStoppedBeforePublication(fixture);
      });
    },
  );

  it.each(["maintenance", "after-hook"] as const)(
    "retains committed accounting but stops publication after an abort in %s",
    async (phase) => {
      await withRecoveryFixture({}, async (fixture) => {
        const before = await fixture.snapshot();
        let committed: Snapshot | undefined;
        const abort = async () => {
          if (phase === "maintenance") {
            committed = await fixture.snapshot();
          }
          fixture.updates.mockClear();
          fixture.stop();
        };
        if (phase === "maintenance") {
          fixture.maintain.mockImplementationOnce(async () => {
            await abort();
            return unchangedMaintenance();
          });
        } else {
          fixture.afterHook.mockImplementationOnce(abort);
        }
        await expect
          .soft(
            fixture.recover(
              phase === "maintenance" ? "overflow" : "timeout",
              phase === "maintenance",
            ),
          )
          .rejects.toBe(fixture.callerError);
        if (phase === "maintenance") {
          expect(committed?.eventDigests).toHaveLength(before.eventDigests.length + 1);
          expect(committed?.eventDigests.slice(0, before.eventDigests.length)).toEqual(
            before.eventDigests,
          );
          expect(committed?.compactionIds).toHaveLength(1);
          expect.soft(await fixture.snapshot()).toEqual(committed);
        } else {
          expect((await fixture.snapshot()).compactionIds).toHaveLength(1);
          expect(fixture.afterHook).toHaveBeenCalledOnce();
        }
        expectCompactionAccounting(fixture);
        expect(fixture.updates).not.toHaveBeenCalled();
        fixture.expectNoContinuation();
        if (phase === "maintenance") {
          expect(fixture.afterHook).not.toHaveBeenCalled();
        }
      });
    },
  );

  recoveryTest(
    "refuses a pending writer append when the safety deadline precedes persistence",
    { oversized: false },
    async (fixture) => {
      const { SessionManager } = await import("../sessions/session-manager.js");
      const before = await fixture.snapshot();
      const opened = createDeferred();
      const release = createDeferred();
      const originalOpen = SessionManager.openAsync.bind(SessionManager);
      const originalCompact = realCompactor(fixture);
      let committed = false;
      fixture.compact.mockImplementationOnce(async (params) => {
        vi.spyOn(SessionManager, "openAsync").mockImplementationOnce(async (...args) => {
          const manager = await originalOpen(...args);
          opened.resolve();
          await release.promise;
          return manager;
        });
        const result = await originalCompact(params);
        committed = true;
        return result;
      });
      try {
        await expect(recoverAtSafetyDeadline(fixture, "timeout", opened.promise)).resolves.toBe(
          false,
        );
      } finally {
        release.resolve();
      }
      await expect(fixture.compact.mock.results[0]?.value).rejects.toThrow("Compaction timed out");
      expect(committed).toBe(false);
      expect(await fixture.snapshot()).toEqual(before);
      expect(fixture.recoveryState.autoCompactionCount).toBe(0);
      fixture.assertActive();
      expectStoppedBeforePublication(fixture);
    },
  );

  recoveryTest(
    "still truncates overflow after an independent safety timeout while the caller is active",
    {},
    async (fixture) => {
      const before = await fixture.snapshot();
      fixture.updates.mockClear();
      const backendWaiting = createDeferred();
      fixture.compact.mockImplementationOnce(async ({ abortSignal }) => {
        return await waitForCompactionAbort(abortSignal, backendWaiting.resolve);
      });

      await expect(
        recoverAtSafetyDeadline(fixture, "overflow", backendWaiting.promise),
      ).resolves.toEqual({ action: "retry" });

      fixture.assertActive();
      expect(fixture.controller.signal.aborted).toBe(false);
      const after = await fixture.snapshot();
      expectArchivedEvents(before, after);
      expect(after.eventDigests.length).toBeGreaterThan(before.eventDigests.length);
      expect(after.leafId).not.toBe(before.leafId);
      expect(after.toolResultChars).toBeGreaterThan(0);
      expect(after.toolResultChars).toBeLessThan(before.toolResultChars);
      expect(fixture.updates).toHaveBeenCalled();
      expect(fixture.recoveryState.autoCompactionCount).toBe(0);
    },
  );

  it.each([
    { kind: "overflow", failure: "throw" },
    { kind: "timeout", failure: "safety timeout" },
  ] as const)(
    "retries $kind from committed context after an active backend $failure",
    async ({ kind, failure }) => {
      const { readCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const compactionHooks = await import("./compaction-hooks.js");
      const postEffects = vi.spyOn(compactionHooks, "runPostCompactionSideEffects");
      await withRecoveryFixture({ oversized: true }, async (fixture) => {
        const before = await fixture.snapshot();
        const entryBefore = fixture.loadEntry();
        const targetBefore = fixture.getSessionTarget();
        const sourceError = new Error("backend failed after committing compaction");
        const originalCompact = realCompactor(fixture);
        const committedAndWaiting = createDeferred();
        let childSignal: AbortSignal | undefined;
        fixture.compact.mockImplementationOnce(async (params) => {
          const committed = await originalCompact(params);
          const recorder = expectDefined(
            readCompactionAccountingRecorder(params.runtimeContext),
            "Recovery must attach its private accounting recorder",
          );
          const usage = expectDefined(committed.result, "Compaction must report committed usage");
          recorder.recordCompaction?.({
            tokensBefore: usage.tokensBefore,
            tokensAfter: usage.tokensAfter,
            compactionKind: "context-engine",
          });
          fixture.updates.mockClear();
          childSignal = params.abortSignal;
          if (failure === "throw") {
            throw sourceError;
          }
          return await waitForCompactionAbort(childSignal, committedAndWaiting.resolve);
        });

        const outcome =
          failure === "safety timeout"
            ? await recoverAtSafetyDeadline(fixture, kind, committedAndWaiting.promise)
            : await fixture.recover(kind);

        fixture.assertActive();
        expect(fixture.controller.signal.aborted).toBe(false);
        expect(fixture.compact).toHaveBeenCalledOnce();
        if (failure === "throw") {
          await expect(fixture.compact.mock.results[0]?.value).rejects.toBe(sourceError);
        } else {
          expect(childSignal?.aborted).toBe(true);
          await expect(fixture.compact.mock.results[0]?.value).rejects.toBe(childSignal?.reason);
        }
        expect.soft(outcome).toEqual(kind === "overflow" ? { action: "retry" } : true);
        const after = await fixture.snapshot();
        expect.soft(after.eventDigests).toHaveLength(before.eventDigests.length + 1);
        expectArchivedEvents(before, after);
        expect(after.compactionIds).toHaveLength(1);
        expect.soft(after.leafId).toBe(after.compactionIds[0]);
        expect.soft(after.toolResultChars).toBe(before.toolResultChars);
        expect(fixture.loadEntry()).toEqual(entryBefore);
        expect(fixture.getSessionTarget()).toEqual(targetBefore);
        expect(fixture.recoveryState).toMatchObject({
          autoCompactionCount: 1,
          lastCompactionTokensAfter: 3_000,
          currentContextSnapshot: { tokens: 3_000 },
        });
        expect.soft(fixture.recoveryState.toolResultTruncationAttempted).toBe(false);
        expect(fixture.maintain).not.toHaveBeenCalled();
        expect(fixture.afterHook).not.toHaveBeenCalled();
        expect.soft(fixture.updates).not.toHaveBeenCalled();
        expect(postEffects).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["active", "closed", "writer-replaced"] as const)(
    "binds a retained maintenance rewrite to its %s owner",
    async (owner) => {
      await withRecoveryFixture({}, async (fixture) => {
        let retainedRewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
        fixture.maintain.mockImplementationOnce(async ({ runtimeContext }) => {
          retainedRewrite = runtimeContext?.rewriteTranscriptEntries;
          return unchangedMaintenance();
        });
        await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
        const rewriteTranscript = expectDefined(retainedRewrite, "Missing host rewrite capability");
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        if (owner !== "active") {
          const retainedWriter = await fixture.openWriter();
          await fixture.invalidate(owner);
          if (owner === "writer-replaced") {
            // Retained capabilities must not reopen an unfenced replacement.
            await expect(
              retainedWriter.appendMessageAsync(fixture.replacement.message),
            ).rejects.toThrow();
          }
        }

        const rewrite = rewriteTranscript({ replacements: [fixture.replacement] });
        if (owner === "active") {
          await expect(rewrite).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
          const after = await fixture.snapshot();
          expectArchivedEvents(before, after);
          expect(after.leafId).not.toBe(before.leafId);
          expect(fixture.updates).toHaveBeenCalled();
        } else {
          await expect.soft(rewrite).rejects.toBeInstanceOf(Error);
          expect.soft(await fixture.snapshot()).toEqual(before);
          expect(fixture.updates).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(["active", "closed"] as const)(
    "requires liveness but no durable claim for %s caller-owned in-memory recovery",
    async (owner) => {
      await withRecoveryFixture({ inMemory: true }, async (fixture) => {
        const before = await fixture.snapshot();
        expect(fixture.loadEntry()).toBeUndefined();
        if (owner === "active") {
          await expect(fixture.recover("timeout")).resolves.toBe(true);
          expect((await fixture.snapshot()).compactionIds).toHaveLength(1);
          expect(fixture.recoveryState.autoCompactionCount).toBe(1);
        } else {
          fixture.compact.mockImplementationOnce(async () => {
            await fixture.invalidate("closed");
            throw new Error("engine failed after in-memory admission closed");
          });
          await expect.soft(fixture.recover("timeout")).rejects.toBeInstanceOf(Error);
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.afterHook).not.toHaveBeenCalled();
          fixture.expectNoContinuation();
        }
        expect(fixture.loadEntry()).toBeUndefined();
        expect(fixture.getCommittedSuccessor()).toBeUndefined();
      });
    },
  );
});
