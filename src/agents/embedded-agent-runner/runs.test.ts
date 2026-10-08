import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
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
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { prepareEmbeddedRunPermissionChange } from "./run-permissions.js";
import { createEmbeddedRunPermissionChanges } from "./run/permission-change.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
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

function startReply(handle: ReturnType<typeof createRunHandle>) {
  const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  const backend = {
    kind: "embedded" as const,
    cancel: handle.abort,
    isStreaming: handle.isStreaming,
    isAbortable: handle.isAbortable,
    isCompacting: handle.isCompacting,
  };
  operation.setPhase("running");
  operation.attachBackend(backend);
  setActiveEmbeddedRun(sessionId, handle);
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
      setActiveEmbeddedRun(sessionId, {
        ...createRunHandle({ runId: "run" }),
        permissionChangeOwner: owner.forAttempt().owner,
        applyPermissionMode: () => completed.promise,
      });
      const change = prepareEmbeddedRunPermissionChange(sessionId);
      if (change.kind !== "active") {
        throw new Error("expected an active permission change");
      }
      const acknowledgement = change.apply("full", vi.fn());
      setActiveEmbeddedRun(sessionId, {
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
    setActiveEmbeddedRun(sessionId, { ...createRunHandle(), applyPermissionMode });
    const change = prepareEmbeddedRunPermissionChange(sessionId);
    if (change.kind !== "active") {
      throw new Error("expected an active permission change");
    }
    setActiveEmbeddedRun(sessionId, createRunHandle());
    await expect(change.apply("full", vi.fn())).resolves.toBe(false);
    expect(applyPermissionMode).not.toHaveBeenCalled();
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
    expect(unknown).not.toHaveBeenCalled();
    expect(compacting).toHaveBeenCalledOnce();
    expect(normal).not.toHaveBeenCalled();
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
    expect(abort).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, handle);
    operation.detachBackend(backend);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
  });

  it("retains abortability for the exact run", () => {
    const handle = createRunHandle({ isAbortable: false, runId: "finalizing" });
    setActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("queued")).toBe(true);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(true);
    retainEmbeddedAgentRunAbortabilityForRunId("finalizing");
    setActiveEmbeddedRun(sessionId, handle);
    clearActiveEmbeddedRun(sessionId, handle);
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    setActiveEmbeddedRun(sessionId, createRunHandle({ runId: "queued" }));
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("queued")).toBe(true);
    clearEmbeddedAgentRunAbortabilityForRunId("finalizing");
    expect(isEmbeddedAgentRunAbortableForRunId("finalizing")).toBe(true);
  });

  it("records stale expiry before a reentrant user abort", async () => {
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const handle = createRunHandle({
      abort: () => {
        operation.abortByUser();
      },
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle);
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
    runsA.setActiveEmbeddedRun(sessionId, first, sessionKey);
    expect(
      runsA.markActiveEmbeddedRunAbandoned({
        sessionId,
        sessionKey,
        handle: first,
        reason: "timeout",
      }),
    ).toBe(true);
    expect(runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "other" })).toBeUndefined();
    const stale = runsA.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "first" });
    expect(stale).toBeDefined();
    runsB.setActiveEmbeddedRun(sessionId, replacement, sessionKey);
    expect(
      runsA.markActiveEmbeddedRunAbandoned({
        sessionId,
        sessionKey,
        handle: first,
        reason: "timeout",
      }),
    ).toBe(false);
    expect(
      runsB.markActiveEmbeddedRunAbandoned({
        sessionId,
        sessionKey,
        handle: replacement,
        reason: "timeout",
      }),
    ).toBe(true);
    const current = runsB.markEmbeddedRunRecoveringTimeout({ sessionId, runId: "second" });
    expect(current).toBeDefined();
    expect(runsA.restoreEmbeddedRunTimeoutAbandonment(stale!)).toBe(false);
    expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("recovering_timeout");
    expect(runsB.restoreEmbeddedRunTimeoutAbandonment(current!)).toBe(true);
    expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("timeout");
  });

  it("tracks timeout abandonment by session id, key, and file until a new run starts", () => {
    const sessionFile = "/tmp/abandoned-session.jsonl",
      handle = createRunHandle();
    const timeout = { sessionKey, reason: "timeout" } as const;
    setActiveEmbeddedRun(sessionId, handle, sessionKey, sessionFile);
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId, handle, sessionFile })).toBe(
      true,
    );
    expect(resolveEmbeddedRunAbandonment({ sessionId })).toBe("timeout");
    expect(resolveEmbeddedRunAbandonment({ sessionKey })).toBe("timeout");
    expect(resolveEmbeddedRunAbandonment({ sessionFile })).toBe("timeout");
    const next = createRunHandle();
    setActiveEmbeddedRun("next", next, sessionKey, sessionFile);
    expect(resolveEmbeddedRunAbandonment({ sessionId })).toBeUndefined();
    expect(resolveEmbeddedRunAbandonment({ sessionKey })).toBeUndefined();
    expect(resolveEmbeddedRunAbandonment({ sessionFile })).toBeUndefined();
    expect(markActiveEmbeddedRunAbandoned({ ...timeout, sessionId: "next", handle: next })).toBe(
      true,
    );
    setActiveEmbeddedRun("third", createRunHandle(), sessionKey);
    expect(resolveEmbeddedRunAbandonment({ sessionKey })).toBeUndefined();
  });

  it("revokes prepared claims on abort", () => {
    const handle = createRunHandle({ runId: "run" });
    const { claimCompletion } = prepareEmbeddedAgentRunCompletionClaim(sessionId, "run");
    setActiveEmbeddedRun(sessionId, handle);
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
    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).not.toHaveBeenCalled();
  });

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
    setActiveEmbeddedRun(sessionId, handle, sessionKey, sessionFile);
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
    const handle = { ...createRunHandle({ abort, runId: "terminal" }), ...probes, cancel };
    setActiveEmbeddedRun(sessionId, handle);
    expect(supersedeEmbeddedAgentRunByRunId("terminal", beforeCancel)).toBe(false);
    expect(beforeCancel).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
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
      () => setActiveEmbeddedRun(sessionId, first, sessionKey),
    );
    await expect(oldClaim.registered).resolves.toEqual({
      toolAuthority: expect.objectContaining({ source: "reply" }),
    });
    clearActiveEmbeddedRun(sessionId, first);
    const intervening = createRunHandle({ runId: "intervening" });
    setActiveEmbeddedRun(sessionId, intervening);
    clearActiveEmbeddedRun(sessionId, intervening);
    expect(oldClaim.claimCompletion()).toBe(false);
    const next = createRunHandle({ runId: "next" });
    const currentClaim = prepareEmbeddedAgentRunCompletionClaim(sessionId, "next");
    setActiveEmbeddedRun(sessionId, next);
    await expect(currentClaim.registered).resolves.toBeUndefined();
    clearActiveEmbeddedRun(sessionId, next);
    expect(currentClaim.claimCompletion()).toBe(true);
    expect(currentClaim.claimCompletion()).toBe(false);
  });
});
