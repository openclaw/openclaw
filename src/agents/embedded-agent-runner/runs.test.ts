import assert from "node:assert/strict";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { prepareEmbeddedRunPermissionChange } from "./run-permissions.js";
import { EMBEDDED_RUN_WAITERS } from "./run-state.js";
import { createEmbeddedRunPermissionChanges } from "./run/permission-change.js";
import { prepareEmbeddedAgentRunAbort } from "./runs.abort-target.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  captureEmbeddedRunDrainTarget,
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunHandleActive,
  markActiveEmbeddedRunAbandoned,
  prepareEmbeddedAgentRunCompletionClaim,
  queueEmbeddedAgentMessageWithOutcome,
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunOwnerByRunId,
  resolveEmbeddedRunAbandonment,
  retainEmbeddedAgentRunAbortabilityForRunId,
  setActiveEmbeddedRun,
  supersedeEmbeddedAgentRunByRunId,
} from "./runs.js";
import { createEmbeddedRunHandle as createRunHandle, testing } from "./runs.test-support.js";

const sessionId = "session";
const sessionKey = "agent:main:test";
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

function expectAbandonment(expected: "timeout" | undefined, sessionFile: string) {
  for (const identity of [{ sessionId }, { sessionKey }, { sessionFile }]) {
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
  activate(handle);
  return { operation, backend };
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(false);
  vi.restoreAllMocks();
});

describe("embedded run ownership", () => {
  it.each([true, false])(
    "fences replacement permission acknowledgements: %s",
    async (sameOwner) => {
      const completed = createDeferredCore<boolean>();
      const owner = createEmbeddedRunPermissionChanges({});
      const other = createEmbeddedRunPermissionChanges({});
      activate({
        ...createRunHandle({ runId: "run" }),
        permissionChangeOwner: owner.forAttempt().owner,
        applyPermissionMode: () => completed.promise,
      });
      const change = prepareEmbeddedRunPermissionChange(sessionId);
      assert(change.kind === "active", "expected an active permission change");
      const acknowledgement = change.apply("full", vi.fn());
      activate({
        ...createRunHandle({ runId: "run" }),
        permissionChangeOwner: (sameOwner ? owner : other).forAttempt().owner,
      });
      completed.resolve(true);
      await expect(acknowledgement).resolves.toBe(sameOwner);
      owner.close();
      other.close();
    },
  );

  it("rejects permissions captured by a replaced run", async () => {
    const applyPermissionMode = vi.fn(async () => true);
    activate({ ...createRunHandle(), applyPermissionMode });
    const change = prepareEmbeddedRunPermissionChange(sessionId);
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

  it("keeps finalizing owners active during restart", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort, isAbortable: false });
    const { operation, backend } = startReply(handle);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(false);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(false);
    expect(isEmbeddedAgentRunAbortableForCompaction(sessionId)).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
    expect(operation.result).toBeNull();
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);
    unused(abort);
    clearActiveEmbeddedRun(sessionId, handle);
    operation.detachBackend(backend);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
  });

  it("retains abortability for the exact run", () => {
    const handle = activate(createRunHandle({ isAbortable: false, runId: "finalizing" }));
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("queued")).toBe(true);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(true);
    retainEmbeddedAgentRunAbortabilityForRunId("finalizing");
    activate(handle);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    activate(createRunHandle({ runId: "queued" }));
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("queued")).toBe(true);
    clearEmbeddedAgentRunAbortabilityForRunId("finalizing");
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(true);
  });

  it("records stale expiry before a reentrant user abort", async () => {
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    startReply(createRunHandle({ abort: () => operation.abortByUser() }), operation);
    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 50,
    });
    expect(result.aborted).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
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
    const timeout = { sessionId, sessionKey, reason: "timeout" } as const;
    runsA.setActiveEmbeddedRun(sessionId, first, sessionKey);
    expect(runsA.markActiveEmbeddedRunAbandoned({ ...timeout, handle: first })).toBe(true);
    expect(runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "other" })).toBeUndefined();
    const stale = runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "first" });
    expect(stale).toBeDefined();
    runsB.setActiveEmbeddedRun(sessionId, replacement, sessionKey);
    expect(runsA.markActiveEmbeddedRunAbandoned({ ...timeout, handle: first })).toBe(false);
    expect(runsB.markActiveEmbeddedRunAbandoned({ ...timeout, handle: replacement })).toBe(true);
    const current = runsB.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "second" });
    expect(current).toBeDefined();
    expect(runsA.restoreEmbeddedRunTimeoutAbandonment(stale!)).toBe(false);
    expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("recovering_timeout");
    expect(runsB.restoreEmbeddedRunTimeoutAbandonment(current!)).toBe(true);
    expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("timeout");
  });

  it("tracks timeout abandonment by session id, key, and file until a new run starts", () => {
    const sessionFile = "/tmp/abandoned-session.jsonl";
    const timeout = { sessionKey, reason: "timeout" } as const;
    const handle = activate(createRunHandle(), sessionKey, sessionFile);
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId, handle, sessionFile })).toBe(
      true,
    );
    expectAbandonment("timeout", sessionFile);
    const next = createRunHandle();
    setActiveEmbeddedRun("next", next, sessionKey, sessionFile);
    expectAbandonment(undefined, sessionFile);
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId: "next", handle: next })).toBe(
      true,
    );
    setActiveEmbeddedRun("third", createRunHandle(), sessionKey);
    expect(resolveEmbeddedRunAbandonment({ sessionKey })).toBeUndefined();
  });

  it("revokes prepared claims on abort", () => {
    const { claimCompletion } = prepareEmbeddedAgentRunCompletionClaim(sessionId, "run");
    const handle = activate(createRunHandle({ runId: "run" }));
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(claimCompletion()).toBe(false);
  });

  it("rejects Stop captured before owner replacement", () => {
    const firstAbort = vi.fn(),
      secondAbort = vi.fn();
    activate(
      { ...createRunHandle({ runId: "first", abort: firstAbort }), startedAtMs: 123 },
      sessionKey,
    );
    const identity = resolveActiveEmbeddedRunOwnerByRunId("first");
    const prepared = prepareEmbeddedAgentRunAbort(sessionId);
    const expected = { runId: "first", sessionId, sessionKey, startedAtMs: 123 };
    expect(identity).toMatchObject(expected);
    expect(resolveActiveEmbeddedRunOwner(sessionId)).toMatchObject(expected);
    activate(createRunHandle({ runId: "second", abort: secondAbort }), sessionKey);
    expect(identity?.abort()).toBe(false);
    expect(prepared()).toMatchObject({ active: false, aborted: false });
    unused(firstAbort, secondAbort);
  });

  it.each(["completed", "released"] as const)(
    "retains a captured drain through replacement until its original handle is %s",
    async (ending) => {
      const original = activate(createRunHandle(), sessionKey);
      const replacementAbort = vi.fn();
      const replacement = createRunHandle({ abort: replacementAbort });
      expect(captureEmbeddedRunDrainTarget(sessionId, { agentId: "other" })).toBeUndefined();
      expect(EMBEDDED_RUN_WAITERS.has(sessionId)).toBe(false);
      const target = captureEmbeddedRunDrainTarget(sessionId, { agentId: "main" })!;
      try {
        activate(replacement, "agent:other:replacement");
        expect(target.abort()).toBe(false);
        const drained = target.waitForEnd(null);
        let result: boolean | undefined;
        void drained.then((value) => {
          result = value;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(result).toBeUndefined();
        if (ending === "completed") {
          clearActiveEmbeddedRun(sessionId, original);
        } else {
          target.release();
        }
        await expect(drained).resolves.toBe(ending === "completed");
        expect(EMBEDDED_RUN_WAITERS.has(sessionId)).toBe(false);
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
    activate(createRunHandle({ isCompacting: true, abort }), sessionKey);
    const prepared = prepareEmbeddedAgentRunAbort(sessionId);
    expect(prepared()).toMatchObject({ active: true, aborted: true, sessionId });
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each(["retry", "compaction", "replacement", "new-claim", "retired", "agent", "key"] as const)(
    "keeps prepared Stop with its admitted request across %s",
    async (transition) => {
      const instance = createOperationalRunInstanceRef("native-retry");
      const authority = claimAgentRunDelegatedAuthority(instance);
      const authorities = [authority];
      const firstAbort = vi.fn();
      const nextAbort = vi.fn();
      const first = createRunHandle({ runId: instance.runId, abort: firstAbort });
      try {
        await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey, operationalRunInstance: instance },
          () => setActiveEmbeddedRun(sessionId, first, sessionKey, undefined, "main"),
        );
        const stop = prepareEmbeddedAgentRunAbort(sessionId);
        const nextInstance =
          transition === "replacement" ? createOperationalRunInstanceRef(instance.runId) : instance;
        if (transition === "replacement" || transition === "new-claim") {
          releaseAgentRunDelegatedAuthority(authority);
          authorities.push(claimAgentRunDelegatedAuthority(nextInstance));
        }
        const nextSessionId = transition === "compaction" ? "compacted-session" : sessionId;
        const nextAgentId = transition === "agent" ? "other" : "main";
        const nextKey = transition === "key" ? "agent:main:another" : sessionKey;
        await withGatewayToolCallerIdentity(
          {
            agentId: nextAgentId,
            sessionKey: nextKey,
            operationalRunInstance: nextInstance,
          },
          () =>
            setActiveEmbeddedRun(
              nextSessionId,
              createRunHandle({ runId: instance.runId, abort: nextAbort }),
              nextKey,
              undefined,
              nextAgentId,
            ),
        );
        if (transition === "retired") {
          releaseAgentRunDelegatedAuthority(authority);
        }
        const sameRequest = transition === "retry" || transition === "compaction";
        expect(stop()).toMatchObject({ active: sameRequest, aborted: sameRequest });
        unused(firstAbort);
        expect(nextAbort).toHaveBeenCalledTimes(sameRequest ? 1 : 0);
      } finally {
        for (const retained of authorities) {
          releaseAgentRunDelegatedAuthority(retained);
        }
      }
    },
  );

  it("clears steering backlog when the run ends", () => {
    setDiagnosticsEnabledForProcess(true);
    const depths: Array<number | undefined> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.queued" && event.source === "embedded-agent-runner") {
        depths.push(event.queueDepth);
      }
    });
    const handle = createRunHandle(),
      sessionFile = "/tmp/diagnostic-session.jsonl";
    logMessageQueued({ sessionId, source: "test-turn" });
    logSessionStateChange({ sessionId, state: "processing" });
    activate(handle, sessionKey, sessionFile);
    try {
      expect(queueEmbeddedAgentMessageWithOutcome(sessionId, "first").queued).toBe(true);
      expect(queueEmbeddedAgentMessageWithOutcome(sessionId, "second").queued).toBe(true);
      expect(getDiagnosticSessionState({ sessionId }).sessionFile).toBe(sessionFile);
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
      logSessionStateChange({ sessionId, state: "idle" });
      unsubscribe();
    }
    expect(getDiagnosticSessionState({ sessionId }).queueDepth).toBe(0);
    expect(depths).toEqual([1, 1]);
  });
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
    activate({ ...createRunHandle({ abort, runId: "terminal" }), ...probes, cancel });
    expect(supersedeEmbeddedAgentRunByRunId("terminal", beforeCancel)).toBe(false);
    unused(beforeCancel, cancel, abort);
    if (warn) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("lifecycle_check_failed"));
    }
  });

  it("publishes completion authority and fences later session owners", async () => {
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
          project: () => "authority",
          projectAsync: async () => "authority",
          assertActive: () => {},
        }),
      },
      () => activate(first, sessionKey),
    );
    await expect(oldClaim.registered).resolves.toEqual({
      toolAuthority: expect.objectContaining({ source: "reply" }),
    });
    clearActiveEmbeddedRun(sessionId, first);
    const intervening = activate(createRunHandle({ runId: "intervening" }));
    clearActiveEmbeddedRun(sessionId, intervening);
    expect(oldClaim.claimCompletion()).toBe(false);
    const next = createRunHandle({ runId: "next" });
    const currentClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, "next");
    activate(next);
    await expect(currentClaim.registered).resolves.toBeUndefined();
    clearActiveEmbeddedRun(sessionId, next);
    expect(currentClaim.claimCompletion()).toBe(true);
    expect(currentClaim.claimCompletion()).toBe(false);
  });
});
