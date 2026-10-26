import assert from "node:assert/strict";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { supersedeReplyRunByRunId } from "../../sessions/session-controller.stop-runtime.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { captureRequesterOrigin, hasSameRequesterOrigin } from "../requester-origin.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { prepareEmbeddedRunPermissionChange } from "./run-permissions.js";
import { createEmbeddedRunPermissionChanges } from "./run/permission-change.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  captureEmbeddedRunDrainTarget,
  isEmbeddedAgentRunHandleActive,
  markActiveEmbeddedRunAbandoned,
  markEmbeddedRunRecoveringTimeout,
  restoreEmbeddedRunTimeoutAbandonment,
  prepareEmbeddedAgentRunCompletionClaim,
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunOwnerByRunId,
  resolveEmbeddedRunAbandonment,
  attachActiveEmbeddedRun as setDetachedEmbeddedRun,
} from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
} from "./runs.test-support.js";

const sessionId = "session";
const sessionKey = "agent:main:test";
const createRunHandle = createEmbeddedRunHandle;

type Handle = ReturnType<typeof createRunHandle>;

function activate(handle = createRunHandle(), key?: string, file?: string) {
  setActiveEmbeddedRun(sessionId, handle, key, file);
  return handle;
}

function unused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectAbandonment(expected: "timeout" | undefined) {
  for (const identity of [{ sessionId }, { sessionKey }]) {
    expect(resolveEmbeddedRunAbandonment(identity)).toBe(expected);
  }
}

function startReply(
  handle: Handle,
  operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false }),
) {
  const backend = {
    kind: "embedded" as const,
    cancel: handle.abort,
    isStreaming: handle.isStreaming,
    isAbortable: handle.isAbortable,
    isCompacting: handle.isCompacting,
  };
  operation.setPhase("running");
  operation.attachBackend(backend);
  setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, operation);
  return { operation, backend };
}

afterEach(() => {
  vi.useRealTimers();
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetSessionControllerForTest();
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(false);
  vi.restoreAllMocks();
});

describe("embedded run ownership", () => {
  it.each([
    { sameOwner: true, successor: false },
    { sameOwner: false, successor: false },
    { sameOwner: true, successor: true },
  ])(
    "fences replacement permission acknowledgements: same owner=$sameOwner, successor=$successor",
    async ({ sameOwner, successor }) => {
      const completed = createDeferredCore<boolean>();
      const owner = createEmbeddedRunPermissionChanges({});
      const other = createEmbeddedRunPermissionChanges({});
      const handle = {
        ...createRunHandle({ runId: "run" }),
        permissionChangeOwner: owner.forAttempt().owner,
        applyPermissionMode: () => completed.promise,
      };
      const operation = setActiveEmbeddedRun(sessionId, handle);
      const target = getSessionControllerEntryForOperation(operation).target;
      assert(target, "expected a physical permission target");
      const change = prepareEmbeddedRunPermissionChange(target);
      assert(change.kind === "active", "expected an active permission change");
      const acknowledgement = change.apply("full", vi.fn());
      if (successor) {
        clearActiveEmbeddedRun(sessionId, handle);
      }
      activate({
        ...createRunHandle({ runId: "run" }),
        permissionChangeOwner: (sameOwner ? owner : other).forAttempt().owner,
      });
      completed.resolve(true);
      await expect(acknowledgement).resolves.toBe(sameOwner && !successor);
      owner.close();
      other.close();
    },
  );

  it("rejects permissions captured by a replaced run", async () => {
    const applyPermissionMode = vi.fn(async () => true);
    const operation = setActiveEmbeddedRun(sessionId, {
      ...createRunHandle(),
      applyPermissionMode,
    });
    const target = getSessionControllerEntryForOperation(operation).target;
    assert(target, "expected a physical permission target");
    const change = prepareEmbeddedRunPermissionChange(target);
    assert(change.kind === "active", "expected an active permission change");
    activate();
    await expect(change.apply("full", vi.fn())).resolves.toBe(false);
    unused(applyPermissionMode);
  });

  it("skips failed compaction probes when aborting", () => {
    const unknown = vi.fn(),
      compacting = vi.fn(),
      normal = vi.fn();
    setActiveEmbeddedRun("unknown", {
      ...createRunHandle({ abort: unknown }),
      isCompacting: () => {
        throw new Error("compaction probe unavailable");
      },
    });
    setActiveEmbeddedRun("compacting", createRunHandle({ isCompacting: true, abort: compacting }));
    setActiveEmbeddedRun("normal", createRunHandle({ abort: normal }));
    expect(abortEmbeddedAgentRun(undefined, { mode: "compacting" })).toBe(true);
    expect(compacting).toHaveBeenCalledOnce();
    unused(unknown, normal);
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun(
      "session-a",
      createEmbeddedRunHandle({ isCompacting: true, abort: abortA }),
    );

    setActiveEmbeddedRun("session-b", createEmbeddedRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedAgentRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("keeps finalizing runs active while rejecting abort requests", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, isAbortable: false });
    const { operation, backend } = startReply(handle);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(false);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(false);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
    expect(operation.result).toBeNull();
    expect(isSessionRunActive(sessionId)).toBe(true);
    unused(abort);
    clearActiveEmbeddedRun(sessionId, handle);
    operation.detachBackend(backend);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(isSessionRunActive(sessionId)).toBe(false);
  });

  it("expires reply-owned stuck recovery as run_stalled instead of user abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cancel = vi.fn();
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    cancel.mockImplementation(() => operation.complete());
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    operation.setPhase("running");
    vi.setSystemTime(6 * 60_000);
    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
    });
    expect(result).toEqual({ aborted: true, drained: true, forceCleared: false });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(cancel).toHaveBeenCalledWith("superseded");
  });

  it("cancels a detached handle during stuck recovery", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "detached-stuck" });
    setDetachedEmbeddedRun(sessionId, handle);
    const pending = abortAndDrainEmbeddedAgentRun({
      sessionId,
      reason: "stuck_recovery",
      settleMs: 100,
    });
    expect(abort).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ aborted: true, drained: false, forceCleared: false });
  });

  it("expires stuck recovery as run_stalled even with a live embedded handle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    // Reentrant user abort must not replace the watchdog's failure attribution.
    const handle = createEmbeddedRunHandle({
      abort: () => {
        operation.abortByUser();
      },
    });
    startReply(handle, operation);
    vi.setSystemTime(6 * 60_000);
    const pending = abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 50,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).aborted).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    clearActiveEmbeddedRun(sessionId, handle);
    operation.complete();
  });

  it.each([false, true])("propagates restart cancellation (throwing backend: %s)", (throws) => {
    const abort = vi.fn(() => {
      if (throws) {
        throw new Error("cancel failed");
      }
    });
    const { operation } = startReply(createRunHandle({ abort }));
    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(abort).toHaveBeenCalledExactlyOnceWith("restart");
  });

  it.each(["all", "compacting"] as const)(
    "does not bypass frozen shared ownership through %s handle aborts",
    (mode) => {
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort, isCompacting: true });
      const { operation } = startReply(handle);
      operation.freezeAbort();

      expect(abortEmbeddedAgentRun(undefined, { mode, reason: "restart" })).toBe(false);
      expect(operation.result).toBeNull();
      unused(abort);
    },
  );

  it("does not bypass retained terminal ownership through compacting handle aborts", () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, isCompacting: true });
    const { operation } = startReply(handle);
    operation.fail("run_failed", new Error("terminal failure"));

    expect(abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    unused(abort);
  });

  it("fences timeout recovery across module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=recovery-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=recovery-b",
    );
    const first = createRunHandle({ runId: "first" }),
      replacement = createRunHandle({ runId: "second" });
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    const timeout = { sessionId, sessionKey, reason: "timeout" } as const;
    try {
      runsA.attachActiveEmbeddedRun(sessionId, first, sessionKey, undefined, undefined, operation);
      expect(runsA.markActiveEmbeddedRunAbandoned({ ...timeout, handle: first })).toBe(true);
      expect(runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "other" })).toBeUndefined();
      const stale = runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "first" });
      expect(stale).toBeDefined();
      runsB.attachActiveEmbeddedRun(
        sessionId,
        replacement,
        sessionKey,
        undefined,
        undefined,
        operation,
      );
      expect(runsA.markActiveEmbeddedRunAbandoned({ ...timeout, handle: first })).toBe(false);
      expect(runsB.markActiveEmbeddedRunAbandoned({ ...timeout, handle: replacement })).toBe(true);
      const current = runsB.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "second" });
      expect(current).toBeDefined();
      expect(runsA.restoreEmbeddedRunTimeoutAbandonment(stale!)).toBe(false);
      expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("recovering_timeout");
      expect(runsB.restoreEmbeddedRunTimeoutAbandonment(current!)).toBe(true);
      expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("timeout");
    } finally {
      runsB.detachActiveEmbeddedRun(sessionId, replacement, sessionKey);
      operation.complete();
    }
  });

  it("keeps timeout recovery and successor cleanup with their physical owner", async () => {
    const makeOwner = (store: string, id = sessionId) => {
      const target = captureSessionTarget({ storeScope: store, sessionKey, incarnation: id });
      const operation = createReplyOperation({
        sessionId: id,
        sessionKey,
        target,
        resetTriggered: false,
      });
      const handle = createRunHandle({ runId: `${store}:${id}` });
      const file = `${store}/session.jsonl`;
      setDetachedEmbeddedRun(id, handle, sessionKey, file, undefined, operation);
      return { target, operation, handle, file };
    };
    const a = makeOwner("/tmp/timeout-owner-a");
    const b = makeOwner("/tmp/timeout-owner-b");
    const abandon = (owner: typeof a) =>
      markActiveEmbeddedRunAbandoned({
        sessionId: owner.operation.sessionId,
        sessionKey,
        sessionFile: owner.file,
        handle: owner.handle,
        reason: "timeout",
      });
    const observation = (owner: typeof a) =>
      resolveEmbeddedRunAbandonment({
        sessionId: owner.operation.sessionId,
        sessionKey,
        target: owner.target,
      });
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(abandon(a)).toBe(true);
    expect(observation(a)).toBe("timeout");
    expect(observation(b)).toBeUndefined();
    expect(abandon(b)).toBe(true);
    expect(resolveEmbeddedRunAbandonment({ sessionId })).toBeUndefined();
    expect(
      markEmbeddedRunRecoveringTimeout({
        sessionId: "different-incarnation",
        runId: a.handle.runId,
        operation: a.operation,
      }),
    ).toBeUndefined();
    expect(observation(a)).toBe("timeout");
    const marker = markEmbeddedRunRecoveringTimeout({
      sessionId,
      runId: a.handle.runId,
      operation: a.operation,
    });
    expect(marker).toBeDefined();
    expect(observation(a)).toBe("recovering_timeout");
    expect(observation(b)).toBe("timeout");
    expect(markEmbeddedRunRecoveringTimeout({ sessionId })).toBeUndefined();
    const retiredEntry = getSessionControllerEntryForOperation(a.operation);
    clearActiveEmbeddedRun(sessionId, a.handle, sessionKey, a.file);
    a.operation.complete();
    await a.operation.ownerSettlement;
    const successor = makeOwner("/tmp/timeout-owner-a", "successor");
    expect(getSessionControllerEntryForOperation(successor.operation)).not.toBe(retiredEntry);
    expect(observation(successor)).toBeUndefined();
    expect(observation(b)).toBe("timeout");
    expect(restoreEmbeddedRunTimeoutAbandonment(marker!)).toBe(false);
    expect(abandon(a)).toBe(false);
    const bMarker = markEmbeddedRunRecoveringTimeout({ sessionId, runId: b.handle.runId });
    expect(bMarker).toBeDefined();
    expect(restoreEmbeddedRunTimeoutAbandonment(bMarker!)).toBe(true);
    expect(observation(b)).toBe("timeout");
  });

  it("tracks timeout abandonment by session id and key until a new run starts", () => {
    const sessionFile = "/tmp/abandoned-session.jsonl";
    const timeout = { sessionKey, reason: "timeout" } as const;
    const handle = activate(createRunHandle(), sessionKey, sessionFile);
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId, handle, sessionFile })).toBe(
      true,
    );
    expectAbandonment("timeout");
    const next = createRunHandle();
    clearActiveEmbeddedRun(sessionId, handle, sessionKey, sessionFile);
    setActiveEmbeddedRun("next", next, sessionKey, sessionFile);
    expectAbandonment(undefined);
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId: "next", handle: next })).toBe(
      true,
    );
    clearActiveEmbeddedRun("next", next, sessionKey, sessionFile);
    setActiveEmbeddedRun("third", createRunHandle(), sessionKey);
    expect(resolveEmbeddedRunAbandonment({ sessionKey })).toBeUndefined();
  });

  it("revokes prepared claims on abort", () => {
    const handle = createRunHandle({ runId: "run" });
    const { claimCompletion } = prepareEmbeddedAgentRunCompletionClaim(sessionId, "run");
    activate(handle);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(claimCompletion()).toBe(false);
  });

  it("rejects Stop captured before owner replacement", () => {
    const firstAbort = vi.fn(),
      secondAbort = vi.fn();
    const first = { ...createRunHandle({ runId: "first", abort: firstAbort }), startedAtMs: 123 };
    setActiveEmbeddedRun(sessionId, first, sessionKey);
    const identity = resolveActiveEmbeddedRunOwnerByRunId("first");
    const expected = { runId: "first", sessionId, sessionKey, startedAtMs: 123 };
    expect(identity).toMatchObject(expected);
    expect(resolveActiveEmbeddedRunOwner(sessionId)).toMatchObject(expected);
    setActiveEmbeddedRun(
      sessionId,
      createRunHandle({ runId: "second", abort: secondAbort }),
      sessionKey,
    );
    expect(identity?.abort()).toBe(false);
    unused(firstAbort, secondAbort);
  });

  it.each([false, true])(
    "joins the original producer after replacement even if the observer releases: %s",
    async (releaseObserver) => {
      const original = createRunHandle({ runId: "original" });
      const replacementAbort = vi.fn();
      const replacement = createRunHandle({ runId: "replacement", abort: replacementAbort });
      const operation = setActiveEmbeddedRun(sessionId, original, sessionKey);
      expect(captureEmbeddedRunDrainTarget(sessionId, { agentId: "other" })).toBeUndefined();
      const target = captureEmbeddedRunDrainTarget(sessionId, { agentId: "main" })!;
      try {
        operation.complete();
        setActiveEmbeddedRun(sessionId, replacement, sessionKey);
        expect(target.abort()).toBe(false);
        let settled = false;
        const drained = target.waitForEnd(null).then((ended) => {
          settled = true;
          return ended;
        });
        if (releaseObserver) {
          target.release();
        }
        await Promise.resolve();
        expect(settled).toBe(false);
        clearActiveEmbeddedRun(sessionId, original);
        await expect(drained).resolves.toBe(true);
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
        unused(replacementAbort);
      } finally {
        target.release();
        clearActiveEmbeddedRun(sessionId, original);
        clearActiveEmbeddedRun(sessionId, replacement);
      }
    },
  );

  it("stops captured manual compaction without a run ID", () => {
    const abort = vi.fn();
    setActiveEmbeddedRun(sessionId, createRunHandle({ isCompacting: true, abort }), sessionKey);
    const target = captureEmbeddedRunDrainTarget(sessionId, { agentId: "main" });
    expect(target?.abort()).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each(["retry", "compaction", "replacement"] as const)(
    "keeps captured controller Stop with its logical turn across %s",
    async (transition) => {
      const firstAbort = vi.fn();
      const nextAbort = vi.fn();
      const first = createRunHandle({ runId: "first", abort: firstAbort });
      const next = createRunHandle({ runId: "next", abort: nextAbort });
      const operation = setActiveEmbeddedRun(sessionId, first, sessionKey);
      const capture = captureSessionControllerStop({ operations: [operation] });
      const nextSessionId = transition === "compaction" ? "compacted-session" : sessionId;
      if (transition === "replacement") {
        operation.complete();
      } else if (transition === "compaction") {
        operation.updateSessionId(nextSessionId);
      }
      const successor = setActiveEmbeddedRun(
        nextSessionId,
        next,
        sessionKey,
        undefined,
        undefined,
        transition === "replacement" ? undefined : operation,
      );
      try {
        const stopped = await stopSession({ source: "interrupt", capture }).completed;
        expect(stopped.aborted).toBe(transition !== "replacement");
        unused(firstAbort);
        expect(nextAbort).toHaveBeenCalledTimes(transition === "replacement" ? 0 : 1);
        expect(successor.result).toEqual(
          transition === "replacement" ? null : { kind: "aborted", code: "aborted_by_user" },
        );
      } finally {
        clearActiveEmbeddedRun(sessionId, first);
        clearActiveEmbeddedRun(nextSessionId, next);
      }
    },
  );

  it.each(["replaced", "released"] as const)(
    "does not stop a native turn after the captured caller authority is %s",
    async (retirement) => {
      const instance = createOperationalRunInstanceRef("stop-caller");
      const authority = claimAgentRunDelegatedAuthority(instance);
      const authorities = [authority];
      const abort = vi.fn();
      const handle = createRunHandle({ runId: "target", abort });
      const operation = setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const capture = captureSessionControllerStop({ operations: [operation] });
      const assertCurrent = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:stop-caller",
          operationalRunInstance: instance,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        },
        () => captureGatewayToolCallerAssertion(),
      );
      if (!assertCurrent) {
        throw new Error("Expected admitted Stop caller assertion");
      }
      try {
        assertCurrent();
        releaseAgentRunDelegatedAuthority(authority);
        if (retirement === "replaced") {
          authorities.push(
            claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef(instance.runId)),
          );
        }
        await expect(
          stopSession({ source: "interrupt", capture, assertCurrent }).completed,
        ).rejects.toThrow("agent tool caller authority is no longer active");
        unused(abort);
        expect(operation.result).toBeNull();
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      } finally {
        for (const retained of authorities) {
          releaseAgentRunDelegatedAuthority(retained);
        }
        clearActiveEmbeddedRun(sessionId, handle);
      }
    },
  );

  it.each([
    ["stopped", { isStopped: (): boolean => true }],
    ["aborted", { isAborted: (): boolean => true }],
    ["frozen", { isAbortable: (): boolean => false }],
    [
      "throwing",
      {
        isStopped: (): never => {
          throw new Error("probe failed");
        },
      },
    ],
  ] as const)("does not supersede a %s owner", (state, probes) => {
    const warn =
      state === "throwing"
        ? vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {})
        : undefined;
    const abort = vi.fn(),
      cancel = vi.fn(),
      beforeCancel = vi.fn();
    const handle = { ...createRunHandle({ abort, runId: "terminal" }), ...probes, cancel };
    activate(handle);
    expect(supersedeReplyRunByRunId("terminal", beforeCancel)).toBe(false);
    unused(beforeCancel, cancel, abort);
    if (warn) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("lifecycle_check_failed"));
    }
  });

  it("publishes completion authority and fences later turns of the same session", async () => {
    const requesterOrigin = captureRequesterOrigin({
      sessionKey,
      messageProvider: "telegram",
      senderId: "completion-requester",
    })!;
    const first = createRunHandle({ runId: "first" });
    const oldClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, "first");
    let published = false;
    void oldClaim.registered.then(() => {
      published = true;
    });
    await Promise.resolve();
    expect(published).toBe(false);
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        embeddedRunToolAuthorityBinding: () => ({
          source: "reply",
          acceptsRequesterOrigin: (incoming) => hasSameRequesterOrigin(requesterOrigin, incoming),
          project: () => "authority",
          projectAsync: async () => "authority",
          assertRegistrationActive: () => {},
          assertActive: () => {},
        }),
      },
      () => setActiveEmbeddedRun(sessionId, first, sessionKey),
    );
    await expect(oldClaim.registered).resolves.toEqual({
      toolAuthority: expect.objectContaining({ source: "reply" }),
    });
    clearActiveEmbeddedRun(sessionId, first, sessionKey);
    const intervening = createRunHandle({ runId: "intervening" });
    setActiveEmbeddedRun(sessionId, intervening, sessionKey);
    clearActiveEmbeddedRun(sessionId, intervening, sessionKey);
    expect(oldClaim.claimCompletion()).toBe(false);
    const next = createRunHandle({ runId: "next" });
    const replacedClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, "replaced");
    const replaced = createRunHandle({ runId: "replaced" });
    setActiveEmbeddedRun(sessionId, replaced, sessionKey);
    clearActiveEmbeddedRun(sessionId, replaced, sessionKey);
    const currentClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, "next");
    expect(replacedClaim.claimCompletion()).toBe(false);
    setActiveEmbeddedRun(sessionId, next, sessionKey);
    await expect(currentClaim.registered).resolves.toBeUndefined();
    clearActiveEmbeddedRun(sessionId, next, sessionKey);
    expect(currentClaim.claimCompletion()).toBe(true);
    expect(currentClaim.claimCompletion()).toBe(false);
  });
});
