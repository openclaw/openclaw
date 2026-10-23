import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { refreshSessionEntryFromStore } from "../../auto-reply/reply/agent-runner-core.js";
import { getReplyOperationSessionReader } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { resolveCompactionTimeoutMs } from "./compaction-safety-timeout.js";
import {
  type RecoveryFixture,
  recoveryCompaction,
  waitForCompactionAbort,
  withRecoveryFixture,
} from "./run.compaction-runtime.test-support.js";
import { readCompactionAccountingRecorder as readRecoveryAccountingRecorder } from "./run/compaction-accounting-bridge.js";

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

// These counters observe recovery continuation only, not another model request:
// downstream dispatch already has its own authority and cancellation guards.
describe("embedded compaction recovery authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  recoveryTest(
    "shrinks current tool output without replaying archived resets after compaction",
    { historicalTurns: 4 },
    async (fixture) => {
      const before = await fixture.snapshot();

      await expect(fixture.recover("overflow", true)).resolves.toEqual({
        action: "retry",
      });

      const after = await fixture.snapshot();
      expectArchivedEvents(before, after);
      expect(after.resetCount).toBe(before.resetCount);
      expect(after.eventDigests.length - before.eventDigests.length).toBeLessThanOrEqual(5);
      expect(after.toolResultChars).toBeLessThan(before.toolResultChars);
      fixture.assertActive();
    },
  );

  it.each(["human", "internal"] as const)(
    "keeps the admitted %s source after a later internal observation",
    async (source) => {
      await withRecoveryFixture({ oversized: false }, async (fixture) => {
        const writer = await fixture.openWriter();
        const request = {
          role: "user" as const,
          content: "Review this patch; do not publish it.",
          timestamp: 10,
          idempotencyKey: `${fixture.runId}:user`,
          ...(source === "internal" ? { provenance: { kind: "internal_system" as const } } : {}),
        };
        const appended = await writer.appendMessageWithTranscriptAnchorAsync(request);
        const recorder = createUserTurnTranscriptRecorder({
          target: { ...fixture.target, sessionEntry: fixture.loadEntry() },
          message: request,
        });
        recorder.markRuntimePersisted(
          request,
          expectDefined(appended.anchor, "Fixture requires a durable input admission"),
          { appended: false },
        );
        await recorder.waitForRuntimePersistence();
        fixture.runParams.userTurnTranscriptRecorder = recorder;
        const observation: PersistedUserTurnMessage = {
          role: "user",
          content: "A child reports progress on the same active run.",
          timestamp: 11,
          provenance: { kind: "inter_session" },
        };
        await writer.appendMessageAsync(observation);
        let selectedRequest: string | undefined;
        fixture.compact.mockImplementation(async (params) => {
          const owned = await fixture.openWriter();
          const preparation = prepareCompaction(
            owned.getBranch(),
            { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
            "unresolved",
            readRecoveryAccountingRecorder(params.runtimeContext),
          );
          if (!preparation.ok || !preparation.value) {
            throw new Error("Expected compactable admitted fixture history");
          }
          selectedRequest = preparation.value.latestUnresolvedUserRequest;
          await owned.appendCompactionAsync(
            "Previous work completed; continue the admitted source run.",
            preparation.value.firstKeptEntryId,
            preparation.value.tokensBefore,
            selectedRequest ? { latestUnresolvedUserRequest: selectedRequest } : {},
          );
          return {
            ok: true,
            compacted: true,
            result: { tokensBefore: preparation.value.tokensBefore, tokensAfter: 3_000 },
          };
        });
        await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
        expect(selectedRequest).toBe(source === "human" ? request.content : undefined);
        const reopened = await fixture.openWriter();
        expect(reopened.getBranch().at(-1)).toMatchObject({
          type: "compaction",
          details: source === "human" ? { latestUnresolvedUserRequest: request.content } : {},
        });
      });
    },
  );

  it("keeps the admitted request identity after compaction rotates the session", async () => {
    await withRecoveryFixture({ oversized: false }, async (fixture) => {
      const writer = await fixture.openWriter();
      const request = {
        role: "user" as const,
        content: "Review this patch; do not publish it.",
        timestamp: 10,
        idempotencyKey: `${fixture.runId}:user`,
      };
      const appended = await writer.appendMessageWithTranscriptAnchorAsync(request);
      const admission = expectDefined(
        appended.anchor,
        "Fixture requires a durable input admission",
      );
      const recorder = createUserTurnTranscriptRecorder({
        target: { ...fixture.target, sessionEntry: fixture.loadEntry() },
        message: request,
      });
      recorder.markRuntimePersisted(request, admission, { appended: false });
      await recorder.waitForRuntimePersistence();
      fixture.runParams.userTurnTranscriptRecorder = recorder;

      const successorId = randomUUID();
      fixture.compact.mockResolvedValueOnce(recoveryCompaction({ sessionId: successorId }));
      await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
      const successorTarget = expectDefined(
        fixture.getSessionTarget(),
        "Compaction must install a successor session target",
      );
      expect(successorTarget.sessionId).toBe(successorId);

      const observation: PersistedUserTurnMessage = {
        role: "user",
        content: "A child reports progress on the active request.",
        timestamp: 12,
        provenance: { kind: "inter_session" },
      };
      await appendTranscriptMessage(successorTarget, {
        cwd: fixture.runParams.workspaceDir,
        eventId: admission.entryId,
        parentId: null,
        message: request,
        now: request.timestamp,
      });
      const observationAppend = await appendTranscriptMessage(successorTarget, {
        cwd: fixture.runParams.workspaceDir,
        message: observation,
        now: observation.timestamp,
      });
      await appendTranscriptMessage(successorTarget, {
        cwd: fixture.runParams.workspaceDir,
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text: "The active review continues." }],
          timestamp: 13,
        }),
        now: 13,
      });

      fixture.compact.mockImplementationOnce(async (params) => {
        const accounting = readRecoveryAccountingRecorder(params.runtimeContext);
        expect(accounting?.requestFromEntryId).toBe(admission.entryId);
        const compactionTarget = expectDefined(
          params.sessionTarget,
          "Recovery compaction must receive the successor target",
        );
        const compactionSessionId = expectDefined(
          compactionTarget.sessionId,
          "Recovery compaction target must identify the successor session",
        );
        expect(compactionSessionId).toBe(successorId);
        const { SessionManager } = await import("../sessions/session-manager.js");
        const successor = await SessionManager.openAsync(
          { ...fixture.target, sessionId: compactionSessionId },
          fixture.runParams.workspaceDir,
        );
        expect(successor.getBranch().at(-2)?.id).toBe(observationAppend.messageId);
        const missingRequest = prepareCompaction(
          successor.getBranch().filter((entry) => entry.id !== admission.entryId),
          { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
          "unresolved",
          accounting,
        );
        expect(missingRequest).toMatchObject({
          ok: false,
          error: { code: "invalid_session" },
        });
        const preparation = prepareCompaction(
          successor.getBranch(),
          { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
          "unresolved",
          accounting,
        );
        if (!preparation.ok) {
          throw preparation.error;
        }
        if (!preparation.value) {
          throw new Error("Expected compactable successor history");
        }
        expect(preparation.value.latestUnresolvedUserRequest).toBe(request.content);
        return recoveryCompaction();
      });
      await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
    });
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

  recoveryTest(
    "leaves archived tool output untouched when the compacted context needs no truncation",
    { historicalTurns: 4, oversized: false },
    async (fixture) => {
      const before = await fixture.snapshot();

      await expect(fixture.recover("overflow", true)).resolves.toEqual({ action: "retry" });

      const after = await fixture.snapshot();
      expectArchivedEvents(before, after);
      expect(after.eventDigests).toHaveLength(before.eventDigests.length + 1);
      expect(after.resetCount).toBe(before.resetCount);
      expect(after.toolResultChars).toBe(before.toolResultChars);
    },
  );

  recoveryTest(
    "uses the resolved model budget to recover current output beyond the default reader window",
    { historicalTurns: 4, contextTokenBudget: 200_000, toolResultText: "x".repeat(1_200_000) },
    async (fixture) => {
      const before = await fixture.snapshot();
      fixture.compact.mockRejectedValueOnce(new Error("independent engine failure"));

      await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });

      const after = await fixture.snapshot();
      expect(after.toolResultChars).toBeLessThan(before.toolResultChars);
      expect(after.resetCount).toBe(before.resetCount);
      expectArchivedEvents(before, after);
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
          // Engines declare the public successor; only the host may transfer
          // the real durable row and retain its private admitted-writer facts.
          expect(sessionTarget).not.toHaveProperty("expectedWriterRunId");
          expect(fixture.loadEntry()?.sessionId).toBe(before?.sessionId);
          return {
            ok: true,
            compacted: true,
            result: {
              summary: "Engine-owned successor context",
              tokensBefore: 4_097,
              tokensAfter: 3_000,
              sessionId: successorId,
              sessionTarget: { ...sessionTarget, sessionId: successorId, threadId: "thread-hint" },
            },
          };
        });

        await expect(fixture.recover(kind)).resolves.toEqual(
          kind === "overflow" ? { action: "retry" } : true,
        );

        const after = fixture.loadEntry();
        expect(after?.sessionId).toBe(successorId);
        expect(after?.lifecycleRevision).toBe(before?.lifecycleRevision);
        expect(after).toHaveProperty("activeWriterRunId", fixture.runId);
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
      let atObserver:
        | {
            accepted: ReturnType<RecoveryFixture["getCommittedSuccessor"]>;
            count: number;
            tokensAfter: number | undefined;
          }
        | undefined;
      const unsubscribe = onSessionIdentityMutation((mutation) => {
        if (mutation.kind !== "replace" || mutation.previous.sessionId !== previousSessionId) {
          return;
        }
        atObserver = {
          accepted: fixture.getCommittedSuccessor(),
          count: fixture.recoveryState.autoCompactionCount,
          tokensAfter: fixture.recoveryState.lastCompactionTokensAfter,
        };
        fixture.updates.mockClear();
        fixture.stop();
      });
      fixture.compact.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: {
          summary: "successor context",
          tokensBefore: 4_097,
          tokensAfter: 3_000,
          sessionId: successorId,
        },
      });
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
      fixture.compact.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: { summary: "engine-owned context", tokensBefore: 4_097, tokensAfter: 3_000 },
      });
      fixture.maintain.mockImplementationOnce(async ({ runtimeContext }) => {
        try {
          await runtimeContext?.rewriteTranscriptEntries?.({
            replacements: [fixture.replacement],
          });
        } catch (error) {
          rewriteError = error;
        }
        return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
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

      // Unlike the engine-owned detached control above, the fixture's default backend
      // opens a real SessionManager with its portable target and no writer claim.
      const outcome = await fixture.recover("overflow");

      expect(fixture.compact).toHaveBeenCalledOnce();
      await expect.soft(fixture.compact.mock.results[0]?.value).rejects.toBeInstanceOf(Error);
      expect.soft(outcome).toMatchObject({ action: "surface", kind: "context_overflow" });
      expect.soft(await fixture.snapshot()).toEqual(before);
      expect.soft(fixture.loadEntry()).toEqual(entryBefore);
      expect.soft(fixture.recoveryState.autoCompactionCount).toBe(0);
      expect.soft(fixture.recoveryState.lastCompactionTokensAfter).toBeUndefined();
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

      const outcome = await fixture.recover("overflow").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      expect.soft(outcome).toEqual({ error: fixture.callerError });
      if ("error" in outcome) {
        expect.soft(outcome.error).toBe(fixture.callerError);
      }
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
    { kind: "timeout", loss: "writer-replaced" },
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

  recoveryTest(
    "retains and counts a committed compaction once when the caller stops during maintenance",
    {},
    async (fixture) => {
      const before = await fixture.snapshot();
      let committed: Snapshot | undefined;
      fixture.maintain.mockImplementationOnce(async () => {
        committed = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.stop();
        return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
      });

      await expect.soft(fixture.recover("overflow", true)).rejects.toBe(fixture.callerError);

      expect(committed?.eventDigests).toHaveLength(before.eventDigests.length + 1);
      expect(committed?.eventDigests.slice(0, before.eventDigests.length)).toEqual(
        before.eventDigests,
      );
      expect(committed?.compactionIds).toHaveLength(1);
      expect.soft(await fixture.snapshot()).toEqual(committed);
      expectCompactionAccounting(fixture);
      expectStoppedBeforePublication(fixture);
    },
  );

  recoveryTest(
    "retains timeout compaction accounting but stops publication and retry after an after-hook abort",
    {},
    async (fixture) => {
      fixture.afterHook.mockImplementationOnce(async () => {
        fixture.updates.mockClear();
        fixture.stop();
      });

      await expect.soft(fixture.recover("timeout")).rejects.toBe(fixture.callerError);

      expect((await fixture.snapshot()).compactionIds).toHaveLength(1);
      expectCompactionAccounting(fixture);
      expect(fixture.afterHook).toHaveBeenCalledOnce();
      expect(fixture.updates).not.toHaveBeenCalled();
      fixture.expectNoContinuation();
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
      const originalCompact = fixture.compact.getMockImplementation();
      if (!originalCompact) {
        throw new Error("Fixture must provide the real append implementation");
      }
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
        const originalCompact = fixture.compact.getMockImplementation();
        if (!originalCompact) {
          throw new Error("Fixture must provide the real append implementation");
        }
        const committedAndWaiting = createDeferred();
        let childSignal: AbortSignal | undefined;
        fixture.compact.mockImplementationOnce(async (params) => {
          const committed = await originalCompact(params);
          const recorder = readCompactionAccountingRecorder(params.runtimeContext);
          if (!recorder) {
            throw new Error("Recovery must attach its private accounting recorder");
          }
          if (!committed.result) {
            throw new Error("Fixture compaction must report its committed context usage");
          }
          recorder.recordCompaction?.({
            tokensBefore: committed.result.tokensBefore,
            tokensAfter: committed.result.tokensAfter,
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
          return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
        });
        await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
        if (!retainedRewrite) {
          throw new Error("Maintenance must receive the host-owned rewrite capability");
        }
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        if (owner !== "active") {
          const retainedWriter = await fixture.openWriter();
          await fixture.invalidate(owner);
          if (owner === "writer-replaced") {
            // The existing SQLite fence works for an explicitly fenced manager;
            // the retained capability must not reopen an unfenced replacement.
            await expect(
              retainedWriter.appendMessageAsync(fixture.replacement.message),
            ).rejects.toThrow();
          }
        }

        const rewrite = retainedRewrite({ replacements: [fixture.replacement] });
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
