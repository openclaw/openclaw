import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as terminalSignals from "../../sessions/subagent-terminal-state.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { applyAcpSessionMutation } from "../runtime/session-meta-write.kernel.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  withAcpCancellationFixture,
  readDurableAcpSignals,
} from "./manager.cancel-session.worker.test-support.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it.each(["global", "inline"] as const)(
  "preserves registered idle ACP resolution for %s metadata without host data SQL",
  async (metadata) => {
    await withAcpCancellationFixture(
      async (f) => {
        const sql = observeHostDataSql();
        try {
          const cancellation = f.manager.cancelSession({
            ...f.target,
            expectedOwnerKey: "agent:main:main",
          });
          if (metadata === "inline") {
            await expect(cancellation).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
          } else {
            await cancellation;
          }
          sql.restore();
          if (metadata === "inline") {
            expect(f.ensureSession).not.toHaveBeenCalled();
            expect(f.cancel).not.toHaveBeenCalled();
            expect(readAcpSessionEntry(f.target)?.entry?.acp?.state).toBe("running");
          } else {
            expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
              handle: expect.objectContaining({ runtimeSessionName: "retained-runtime" }),
              reason: undefined,
            });
            expect(readAcpSessionEntry(f.target)?.acp?.state).toBe("idle");
          }
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
      },
      { metadata },
    );
  },
);

it.each(["acknowledged", "failed"] as const)(
  "settles %s registered active cancellation without host data SQL",
  async (outcome) => {
    await withAcpCancellationFixture(async (f) => {
      const entered = createDeferred();
      const stop = new AbortController();
      if (outcome === "failed") {
        f.cancel.mockRejectedValueOnce(new Error("Synthetic cancel transport failure."));
      }
      f.runTurn.mockImplementationOnce(async function* (input) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done", stopReason: "cancel" };
      });
      const admittedRunContext = createTestAdmittedRunContext("active-worker");
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext,
        provenance: "system",
        mode: "prompt",
        text: "active",
        requestId: "active-worker",
        signal: stop.signal,
      });
      const turnResult = Promise.allSettled([turn]);
      await awaitGateBeforeSettlement(
        entered.promise,
        turnResult,
        "Run ended before runtime entry.",
      );
      const sql = observeHostDataSql();
      try {
        const cancellation = f.manager.cancelSession({
          ...f.target,
          expectedRunId: "active-worker",
          expectedInstanceId: admittedRunContext.operationalRunInstance.instanceId,
          expectedOwnerKey: "agent:main:main",
        });
        const result = await Promise.allSettled([cancellation, turn]);
        sql.restore();
        expect(result).toMatchObject(
          outcome === "failed"
            ? [
                {
                  status: "rejected",
                  reason: {
                    code: "ACP_TURN_FAILED",
                    message: "Synthetic cancel transport failure.",
                  },
                },
                { status: "fulfilled" },
              ]
            : [{ status: "fulfilled" }, { status: "fulfilled" }],
        );
        expect(f.cancel).toHaveBeenCalledOnce();
        // The producer's cancelled terminal is independent of the cancellation RPC failure.
        expect(readDurableAcpSignals(f, "active-worker")).toMatchObject([{ kind: "run_failed" }]);
        expect(readAcpSessionEntry(f.target)?.acp?.state).toBe("idle");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        stop.abort();
        await turnResult;
      }
    });
  },
);

it("does not admit durable runtime cancellation from an inherited discovery snapshot", async () => {
  await withAcpCancellationFixture(async (f) => {
    const entered = createDeferred();
    const release = createDeferred();
    f.ensureSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "retained-runtime",
      };
    });
    const cancellation = withOpenClawStateDatabaseReadSnapshot(
      () => f.manager.cancelSession({ ...f.target, expectedOwnerKey: "agent:main:main" }),
      { env: f.state.env },
    );
    const result = Promise.allSettled([cancellation]);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        result,
        "Cancellation ended before runtime preparation.",
      );
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          applyAcpSessionMutation(db, {
            agentId: "main",
            sessionKey: f.target.sessionKey,
            storageSessionKey: f.target.sessionKey,
            entry: {
              sessionId: "cancellation-session",
              lifecycleRevision: "cancellation-lifecycle",
              updatedAt: 100,
            },
            decision: { kind: "clear" },
          }),
        { env: f.state.env },
      );
      release.resolve();
      await result;
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    } finally {
      release.resolve();
      await result;
    }
  });
});

it("joins a failing accepted sibling while another terminal signal remains active", async () => {
  await withAcpCancellationFixture(async (f) => {
    const actorEntered = createDeferred();
    const releaseActor = createDeferred();
    f.getStatus.mockImplementationOnce(async () => {
      actorEntered.resolve();
      await releaseActor.promise;
      return { summary: "ready" };
    });
    const actor = f.manager.getSessionStatus(f.target);
    const actorResult = Promise.allSettled([actor]);
    await actorEntered.promise;
    const secondEntered = createDeferred();
    const releaseSecond = createDeferred();
    const original = terminalSignals.recordSubagentTerminalState;
    const intercepted = vi
      .spyOn(terminalSignals, "recordSubagentTerminalState")
      .mockImplementation(async (...args) => {
        if (args[0].runId === "sibling-second") {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return original(...args);
      });
    const turns = ["sibling-first", "sibling-second"].map((requestId) =>
      f.manager.runTurn({
        ...f.target,
        admittedRunContext: createTestAdmittedRunContext(requestId),
        provenance: "system",
        mode: "prompt",
        text: "queued",
        requestId,
        onEvent:
          requestId === "sibling-first"
            ? async () => {
                throw new Error("First cancellation delivery failed.");
              }
            : undefined,
      }),
    );
    const turnResults = Promise.allSettled(turns);
    let settled = false;
    const sql = observeHostDataSql();
    const cancellation = f.manager.cancelSession({
      ...f.target,
      expectedOwnerKey: "agent:main:main",
    });
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    try {
      await awaitGateBeforeSettlement(
        secondEntered.promise,
        turnResults,
        "Sibling signal was never admitted.",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      releaseSecond.resolve();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(await turnResults).toMatchObject([{ status: "rejected" }, { status: "fulfilled" }]);
      sql.restore();
      expect(sql.queries).toEqual([]);
      expect(readDurableAcpSignals(f, "sibling-second")).toMatchObject([{ kind: "run_failed" }]);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      releaseSecond.resolve();
      releaseActor.resolve();
      intercepted.mockRestore();
      await Promise.allSettled([result, turnResults, actorResult]);
    }
  });
});

it.each(["metadata", "lifecycle"] as const)(
  "refuses late idle runtime effects after %s replacement",
  async (replacement) => {
    await withAcpCancellationFixture(async (f) => {
      const close = vi.spyOn(f.runtime, "close");
      const entered = createDeferred();
      const release = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return {
          sessionKey: f.target.sessionKey,
          backend: "cancellation-proof",
          runtimeSessionName: "late-runtime",
        };
      });
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedOwnerKey: "agent:main:main",
      });
      const result = Promise.allSettled([cancellation]);
      await awaitGateBeforeSettlement(entered.promise, result, "Cancellation ended before setup.");
      try {
        if (replacement === "metadata") {
          await upsertAcpSessionMeta({ ...f.target, skipMaintenance: true, mutate: () => null });
        } else {
          await replaceSessionEntry(f.target, {
            sessionId: "cancellation-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 200,
            spawnedBy: "agent:main:main",
          });
        }
      } finally {
        release.resolve();
      }
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    });
  },
);

it("joins only the superseded actor's late handle after post-ensure control read", async () => {
  await withAcpCancellationFixture(async (f) => {
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    const closeEntered = createDeferred();
    const releaseClose = createDeferred();
    let ensured = false;
    let gated = false;
    let settled = false;
    f.ensureSession.mockImplementationOnce(async () => {
      ensured = true;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "superseded-late-runtime",
      };
    });
    const close = vi.spyOn(f.runtime, "close").mockImplementationOnce(async () => {
      closeEntered.resolve();
      await releaseClose.promise;
    });
    const load = DEFAULT_DEPS.loadSessionEntryAsync;
    const read = vi
      .spyOn(DEFAULT_DEPS, "loadSessionEntryAsync")
      .mockImplementation(async (params) => {
        const value = await load(params);
        if (ensured && !gated) {
          gated = true;
          readEntered.resolve();
          await releaseRead.promise;
        }
        return value;
      });
    const sql = observeHostDataSql();
    const cancellation = f.manager.cancelSession({
      ...f.target,
      reason: "old-actor",
      expectedOwnerKey: "agent:main:main",
    });
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    let successor: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        readEntered.promise,
        result,
        "Cancellation ended before post-ensure read.",
      );
      await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
        ...f.target,
        reason: "fixture-actor-replacement",
      });
      successor = f.manager.cancelSession({
        ...f.target,
        reason: "successor-actor",
        expectedOwnerKey: "agent:main:main",
      });
      await successor;
      releaseRead.resolve();
      await awaitGateBeforeSettlement(
        closeEntered.promise,
        result,
        "Superseded handle was not closed.",
      );
      expect(settled).toBe(false);
      expect(close).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ runtimeSessionName: "superseded-late-runtime" }),
        reason: "session-actor-superseded",
        discardPersistentState: true,
      });
      releaseClose.resolve();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      await f.manager.cancelSession({ ...f.target, reason: "successor-reuse" });
      sql.restore();
      expect(f.ensureSession).toHaveBeenCalledTimes(2);
      expect(f.cancel.mock.calls.map(([input]) => input.reason)).toEqual([
        "successor-actor",
        "successor-reuse",
      ]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      read.mockRestore();
      releaseRead.resolve();
      releaseClose.resolve();
      await Promise.allSettled([result, successor]);
      close.mockRestore();
    }
  });
});

it("refuses caller revocation while the registered cancellation read is pending", async () => {
  await withAcpCancellationFixture(async (f) => {
    const entered = createDeferred();
    const stop = new AbortController();
    let signal: AbortSignal | undefined;
    f.runTurn.mockImplementationOnce(async function* (input) {
      signal = input.signal;
      entered.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", stopReason: "cancel" };
    });
    const context = createTestAdmittedRunContext("caller-worker");
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      mode: "prompt",
      text: "caller",
      requestId: "caller-worker",
      signal: stop.signal,
    });
    const turnResult = Promise.allSettled([turn]);
    await awaitGateBeforeSettlement(
      entered.promise,
      turnResult,
      "Turn ended before runtime entry.",
    );
    const readEntered = createDeferred();
    const readRelease = createDeferred();
    const prepare = DEFAULT_DEPS.prepareSessionControlRead;
    const reader = vi
      .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
      .mockImplementationOnce(async (params) => {
        const read = await prepare(params);
        readEntered.resolve();
        await readRelease.promise;
        return read;
      });
    let callerCurrent = true;
    const cancellation = f.manager.cancelSession({
      ...f.target,
      expectedRunId: "caller-worker",
      expectedInstanceId: context.operationalRunInstance.instanceId,
      expectedOwnerKey: "agent:main:main",
      assertActive: () => {
        if (!callerCurrent) {
          throw new Error("Caller was revoked before admission.");
        }
      },
    });
    const result = Promise.allSettled([cancellation]);
    try {
      await awaitGateBeforeSettlement(
        readEntered.promise,
        result,
        "Cancellation ended before read gate.",
      );
      callerCurrent = false;
      readRelease.resolve();
      expect(await result).toMatchObject([
        { status: "rejected", reason: { message: "Caller was revoked before admission." } },
      ]);
      expect(signal?.aborted).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readDurableAcpSignals(f, "caller-worker")).toEqual([]);
    } finally {
      readRelease.resolve();
      reader.mockRestore();
      stop.abort();
      await Promise.allSettled([result, turnResult]);
    }
  });
});

it.each(["acknowledged", "failed"] as const)(
  "retains %s late-handle cleanup after caller revocation without host data SQL",
  async (outcome) => {
    await withAcpCancellationFixture(async (f) => {
      const ensureEntered = createDeferred();
      const ensureRelease = createDeferred();
      const admitted = createDeferred();
      const cancelEntered = createDeferred();
      const cancelRelease = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        ensureEntered.resolve();
        await ensureRelease.promise;
        return {
          sessionKey: f.target.sessionKey,
          backend: "cancellation-proof",
          runtimeSessionName: "late-runtime",
        };
      });
      f.cancel.mockImplementationOnce(async () => {
        cancelEntered.resolve();
        await cancelRelease.promise;
        if (outcome === "failed") {
          throw new Error("Late cancellation failed.");
        }
      });
      const context = createTestAdmittedRunContext("late-worker");
      const events: unknown[] = [];
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        mode: "prompt",
        text: "late",
        requestId: "late-worker",
        onEvent: (event) => {
          events.push(event);
        },
      });
      const turnResult = Promise.allSettled([turn]);
      await awaitGateBeforeSettlement(
        ensureEntered.promise,
        turnResult,
        "Turn ended before setup gate.",
      );
      let callerCurrent = true;
      let settled = false;
      const sql = observeHostDataSql();
      let controlPrepared = false;
      const prepare = DEFAULT_DEPS.prepareSessionControlRead;
      const reader = vi
        .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          controlPrepared = true;
          return read;
        });
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedRunId: "late-worker",
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
        assertActive: () => {
          if (!callerCurrent) {
            throw new Error("Caller was revoked.");
          }
          if (controlPrepared) {
            admitted.resolve();
          }
        },
      });
      const result = Promise.allSettled([cancellation, turn]).then((value) => {
        settled = true;
        return value;
      });
      try {
        await awaitGateBeforeSettlement(
          admitted.promise,
          result,
          "Cancellation ended before admission.",
        );
        callerCurrent = false;
        ensureRelease.resolve();
        await awaitGateBeforeSettlement(
          cancelEntered.promise,
          result,
          "Cancellation ended before runtime cleanup.",
        );
        expect(settled).toBe(false);
        expect(f.runTurn).not.toHaveBeenCalled();
        cancelRelease.resolve();
        expect(await result).toMatchObject(
          outcome === "failed"
            ? [
                { status: "rejected", reason: { message: "Late cancellation failed." } },
                { status: "rejected", reason: { message: "Late cancellation failed." } },
              ]
            : [{ status: "fulfilled" }, { status: "fulfilled" }],
        );
        sql.restore();
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(readDurableAcpSignals(f, "late-worker")).toMatchObject([{ kind: "run_failed" }]);
        expect(events).toEqual(
          outcome === "failed" ? [] : [{ type: "done", status: "cancelled", stopReason: "cancel" }],
        );
        expect(sql.queries).toEqual([]);
      } finally {
        reader.mockRestore();
        sql.restore();
        ensureRelease.resolve();
        cancelRelease.resolve();
        await Promise.allSettled([result, turnResult]);
      }
    });
  },
);

it("does not adopt a same-request successor after actor replacement during cancellation preparation", async () => {
  await withAcpCancellationFixture(async (f) => {
    const firstEntered = createDeferred();
    const firstRelease = createDeferred();
    const nextEntered = createDeferred();
    const nextRelease = createDeferred();
    let nextSignal: AbortSignal | undefined;
    let handle = 0;
    f.ensureSession.mockImplementation(async () => ({
      sessionKey: f.target.sessionKey,
      backend: "cancellation-proof",
      runtimeSessionName: `actor-runtime-${++handle}`,
    }));
    f.runTurn
      .mockImplementationOnce(async function* () {
        firstEntered.resolve();
        await firstRelease.promise;
        yield { type: "done" };
      })
      .mockImplementationOnce(async function* (input) {
        nextSignal = input.signal;
        nextEntered.resolve();
        await nextRelease.promise;
        yield { type: "done" };
      });
    const context = createTestAdmittedRunContext("actor-worker");
    const first = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      mode: "prompt",
      text: "first actor",
      requestId: "actor-worker",
    });
    const firstResult = Promise.allSettled([first]);
    await awaitGateBeforeSettlement(
      firstEntered.promise,
      firstResult,
      "First actor ended before entry.",
    );
    const readEntered = createDeferred();
    const readRelease = createDeferred();
    const prepare = DEFAULT_DEPS.prepareSessionControlRead;
    const reader = vi
      .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
      .mockImplementationOnce(async (params) => {
        const read = await prepare(params);
        readEntered.resolve();
        await readRelease.promise;
        return read;
      });
    const cancellation = f.manager.cancelSession({
      ...f.target,
      reason: "pending-request",
      expectedRunId: "actor-worker",
      expectedInstanceId: context.operationalRunInstance.instanceId,
      expectedOwnerKey: "agent:main:main",
    });
    const result = Promise.allSettled([cancellation]);
    let successor: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        readEntered.promise,
        result,
        "Cancellation ended before read gate.",
      );
      await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
        ...f.target,
        reason: "fixture-actor-replacement",
      });
      successor = f.manager.runTurn({
        ...f.target,
        admittedRunContext: createTestAdmittedRunContext("actor-worker"),
        provenance: "system",
        mode: "prompt",
        text: "successor",
        requestId: "actor-worker",
      });
      const successorResult = Promise.allSettled([successor]);
      await awaitGateBeforeSettlement(
        nextEntered.promise,
        successorResult,
        "Successor ended before entry.",
      );
      readRelease.resolve();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(nextSignal?.aborted).toBe(false);
      expect(f.cancel.mock.calls.some(([input]) => input.reason === "pending-request")).toBe(false);
    } finally {
      reader.mockRestore();
      readRelease.resolve();
      firstRelease.resolve();
      nextRelease.resolve();
      await Promise.allSettled([firstResult, successor, result]);
    }
  });
});

it("joins reentrant cancellation without issuing a second backend effect", async () => {
  await withAcpCancellationFixture(async (f) => {
    const turnEntered = createDeferred();
    const cancelEntered = createDeferred();
    const releaseCancel = createDeferred();
    f.runTurn.mockImplementationOnce(async function* (input) {
      turnEntered.resolve();
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", stopReason: "cancel" };
    });
    const context = createTestAdmittedRunContext("reentrant-cancel");
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      mode: "prompt",
      text: "running",
      requestId: "reentrant-cancel",
    });
    const turnResult = Promise.allSettled([turn]);
    await turnEntered.promise;
    const request = {
      ...f.target,
      expectedRunId: "reentrant-cancel",
      expectedInstanceId: context.operationalRunInstance.instanceId,
    };
    let nested: Promise<void> | undefined;
    let nestedSettled = false;
    let outerSettled = false;
    f.cancel.mockImplementationOnce(async () => {
      // Launch the reentry without making the backend wait on its own cancellation.
      nested = f.manager.cancelSession({ ...request, reason: "nested" }).then(() => {
        nestedSettled = true;
      });
      void nested.catch(() => {});
      cancelEntered.resolve();
      await releaseCancel.promise;
    });
    const outer = f.manager.cancelSession({ ...request, reason: "outer" }).then(() => {
      outerSettled = true;
    });
    const outerResult = Promise.allSettled([outer]);
    try {
      await cancelEntered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(nestedSettled).toBe(false);
      expect(outerSettled).toBe(false);
      releaseCancel.resolve();
      expect(await Promise.allSettled([outer, nested, turn])).toMatchObject([
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "fulfilled" },
      ]);
      expect(readDurableAcpSignals(f, "reentrant-cancel")).toMatchObject([{ kind: "run_failed" }]);
    } finally {
      releaseCancel.resolve();
      await Promise.allSettled([outerResult, nested, turnResult]);
    }
  });
});

it.each(["metadata-read", "runtime-rpc"] as const)(
  "retries only a pre-effect refusal after %s cancellation failure",
  async (failure) => {
    await withAcpCancellationFixture(async (f) => {
      const turnEntered = createDeferred();
      const releaseTurn = createDeferred();
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      const firstRefusal = createDeferred();
      const secondAdmission = createDeferred();
      let signal: AbortSignal | undefined;
      let turnSettled = false;
      f.runTurn.mockImplementationOnce(async function* (input) {
        signal = input.signal;
        turnEntered.resolve();
        // A backend may keep producing after abort until its own cleanup finishes.
        await releaseTurn.promise;
        yield { type: "done", stopReason: "cancel" };
      });
      const context = createTestAdmittedRunContext("retry-cancel");
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        mode: "prompt",
        text: "running",
        requestId: "retry-cancel",
      });
      const turnResult = Promise.allSettled([turn]).then((result) => {
        turnSettled = true;
        return result;
      });
      await turnEntered.promise;
      const originalMeta = readAcpSessionEntry(f.target)?.acp;
      if (!originalMeta) {
        releaseTurn.resolve();
        await turnResult;
        throw new Error("Fixture has no global ACP metadata.");
      }
      const prepare = DEFAULT_DEPS.prepareSessionControlRead;
      let gated = false;
      let observedMissingAcp = false;
      let secondPrepared = false;
      const reader = vi
        .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          return {
            ...read,
            readCurrent: async (cfg: typeof f.target.cfg) => {
              const pause = failure === "metadata-read" && signal?.aborted && !gated;
              if (pause) {
                gated = true;
                readEntered.resolve();
                await releaseRead.promise;
              }
              const current = await read.readCurrent(cfg);
              if (pause) {
                observedMissingAcp = !current.session.acp;
                firstRefusal.resolve();
              }
              return current;
            },
          };
        })
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          secondPrepared = true;
          return read;
        });
      if (failure === "runtime-rpc") {
        f.cancel.mockImplementationOnce(async () => {
          firstRefusal.resolve();
          throw new Error("Cancellation RPC failed after starting.");
        });
      }
      const request = {
        ...f.target,
        expectedRunId: "retry-cancel",
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
      };
      const first = f.manager.cancelSession({ ...request, reason: "first-stop" });
      const firstResult = Promise.allSettled([first]);
      let second: Promise<void> | undefined;
      try {
        if (failure === "metadata-read") {
          await readEntered.promise;
          await upsertAcpSessionMeta({ ...f.target, skipMaintenance: true, mutate: () => null });
          releaseRead.resolve();
        }
        await firstRefusal.promise;
        // Let the active cancellation reject while the producer is still held open.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(signal?.aborted).toBe(true);
        expect(turnSettled).toBe(false);
        expect(f.cancel).toHaveBeenCalledTimes(failure === "runtime-rpc" ? 1 : 0);
        if (failure === "metadata-read") {
          expect(observedMissingAcp).toBe(true);
          await upsertAcpSessionMeta({
            ...f.target,
            skipMaintenance: true,
            mutate: () => originalMeta,
          });
        }
        second = f.manager.cancelSession({
          ...request,
          reason: "second-stop",
          assertActive: () => {
            if (secondPrepared) {
              secondAdmission.resolve();
            }
          },
        });
        const secondResult = Promise.allSettled([second]);
        await awaitGateBeforeSettlement(
          secondAdmission.promise,
          secondResult,
          "Second Stop ended before fresh control admission.",
        );
        expect(turnSettled).toBe(false);
        releaseTurn.resolve();
        expect(await Promise.allSettled([first, second, turn])).toMatchObject([
          {
            status: "rejected",
            reason: {
              code: "ACP_TURN_FAILED",
              message:
                failure === "metadata-read"
                  ? "ACP task owner could not be verified."
                  : "Cancellation RPC failed after starting.",
            },
          },
          failure === "metadata-read"
            ? { status: "fulfilled" }
            : {
                status: "rejected",
                reason: { message: "Cancellation RPC failed after starting." },
              },
          { status: "fulfilled" },
        ]);
        expect(f.cancel).toHaveBeenCalledOnce();
      } finally {
        releaseRead.resolve();
        releaseTurn.resolve();
        await Promise.allSettled([firstResult, second, turnResult]);
        reader.mockRestore();
      }
    });
  },
);
