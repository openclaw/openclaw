import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../../infra/diagnostic-model-request.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  isDiagnosticEmbeddedRunOwnerClosed,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
  type DiagnosticEmbeddedRunOwner,
} from "../../logging/diagnostic-run-activity.js";
import { getDiagnosticSessionState } from "../../logging/diagnostic-session-state.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  listActiveSessionRunIds,
  listActiveSessionRunKeys,
} from "../../sessions/session-controller.queries.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { getEmbeddedRunAttachment, type EmbeddedAgentQueueHandle } from "./run-state.js";
import {
  detachActiveEmbeddedRun as retireActiveEmbeddedRun,
  prepareEmbeddedAgentRunCompletionClaim,
  getActiveEmbeddedRunSnapshot,
  updateActiveEmbeddedRunSnapshot,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile as resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  resolveActiveEmbeddedRunOwnerByRunId,
  attachActiveEmbeddedRun as registerActiveEmbeddedRun,
} from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing,
  steerTestSessionTurn,
} from "./runs.test-support.js";

const sessionId = "session";
const ref = { sessionId, sessionKey: "agent:main:test" };

const lifecycleMock = vi.hoisted(() => {
  let generationSequence = 0;
  const get = () => `test-generation-${generationSequence}`;
  const handlers = new Map<string, (nextGeneration: string) => void>();
  return {
    get,
    isCurrent: (candidate: string) => candidate === get(),
    register: (key: string, handler: (nextGeneration: string) => void) => {
      handlers.set(key, handler);
    },
    reset: () => {
      generationSequence += 1;
    },
    rotate: (beforeHandlers?: () => void) => {
      generationSequence += 1;
      beforeHandlers?.();
      const errors: unknown[] = [];
      for (const handler of handlers.values()) {
        try {
          handler(get());
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to retire stale agent lifecycle owners");
      }
      return get();
    },
  };
});

vi.mock("../../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-events.js")>()),
  getAgentEventLifecycleGeneration: lifecycleMock.get,
  isAgentEventLifecycleGenerationCurrent: lifecycleMock.isCurrent,
  registerAgentEventLifecycleRotationHandler: lifecycleMock.register,
  rotateAgentEventLifecycleGeneration: lifecycleMock.rotate,
}));

function createRunHandle(
  params: {
    abort?: EmbeddedAgentQueueHandle["abort"];
    compacting?: boolean;
    diagnosticOwner?: DiagnosticEmbeddedRunOwner;
    queueMessage?: EmbeddedAgentQueueHandle["queueMessage"];
    runId?: string;
  } = {},
): EmbeddedAgentQueueHandle {
  const diagnosticOwner = params.diagnosticOwner;
  return {
    kind: "embedded",
    runId: params.runId ?? "run",
    diagnosticOwner,
    closeDiagnostics: diagnosticOwner
      ? () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner)
      : undefined,
    queueMessage: params.queueMessage ?? vi.fn(async () => {}),
    isStreaming: () => true,
    isAbortable: () => false,
    isCompacting: () => params.compacting === true,
    abort: params.abort ?? (() => {}),
  };
}

function emitRequest(owner: DiagnosticEmbeddedRunOwner, runId: string, eventRef = ref) {
  emitCoreModelRequestStartedDiagnosticEvent(
    { ...eventRef, runId, callId: "call", provider: "mock", model: "model" },
    owner.generation,
    300_000,
  );
}

describe("embedded run registry lifecycle generations", () => {
  it("preserves a current scoped snapshot while retiring a same-ID detached producer", () => {
    const currentKey = "agent:main:current-snapshot";
    const staleFile = "in-memory:stale-snapshot-file";
    const currentFile = "in-memory:current-snapshot-file";
    const staleAbort = vi.fn();
    const stale = { ...createRunHandle({ abort: staleAbort }), runId: undefined };
    const current = createRunHandle({ runId: "current-snapshot-run" });
    const snapshot = { transcriptLeafId: "current-leaf" };
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    registerActiveEmbeddedRun(sessionId, stale, undefined, staleFile);
    try {
      // Another lifecycle owner can publish current work before this owner retires old work.
      lifecycleMock.rotate(() => {
        operation = createReplyOperation({
          sessionKey: currentKey,
          sessionId,
          resetTriggered: false,
        });
        const attachment = registerActiveEmbeddedRun(
          sessionId,
          current,
          currentKey,
          currentFile,
          undefined,
          operation,
        );
        updateActiveEmbeddedRunSnapshot(attachment, snapshot);
      });
      expect(staleAbort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(getActiveEmbeddedRunSnapshot(currentFile)).toEqual({
        transcriptLeafId: "current-leaf",
      });
      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(currentFile)).toBe(sessionId);
      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(staleFile)).toBeUndefined();
    } finally {
      retireActiveEmbeddedRun(sessionId, stale);
      retireActiveEmbeddedRun(sessionId, current, currentKey);
      operation?.complete();
    }
  });

  it("evicts and aborts a sessionless file owner hidden by an alias-only effect", async () => {
    const sessionFile = "in-memory:generation-detached-file";
    const effect = await beginSessionEffect({
      scope: "/tmp/generation-detached-store",
      identities: [sessionId],
    });
    const abort = vi.fn();
    const handle = { ...createRunHandle({ abort }), runId: undefined };
    const attachment = registerActiveEmbeddedRun(sessionId, handle, undefined, sessionFile);
    try {
      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBe(sessionId);
      rotateAgentEventLifecycleGeneration();
      expect(abort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBeUndefined();
      expect(getEmbeddedRunAttachment(handle)).toBeUndefined();
      expect(attachment?.settled).toBeUndefined();
      retireActiveEmbeddedRun(sessionId, handle);
      expect(attachment?.settled).toBe(true);
    } finally {
      retireActiveEmbeddedRun(sessionId, handle);
      effect.release();
    }
  });

  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetSessionControllerForTest();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    lifecycleMock.reset();
  });

  it.each([true, false])(
    "retires diagnostics after controller completion (owner: %s)",
    (hasOwner) => {
      const completedRef = {
        sessionId: "controller-completed-session",
        sessionKey: "agent:main:controller-completed",
      };
      const runId = "controller-completed-run";
      const operation = createReplyOperation({
        ...completedRef,
        resetTriggered: false,
      });
      const diagnosticOwner = hasOwner
        ? createDiagnosticEmbeddedRunOwner({ ...completedRef, runId })
        : undefined;
      const handle = createRunHandle({ diagnosticOwner, runId });
      startDiagnosticRunActivityTracking();
      const attachment = registerActiveEmbeddedRun(
        completedRef.sessionId,
        handle,
        completedRef.sessionKey,
        undefined,
        undefined,
        operation,
      );
      expect(getDiagnosticSessionState(completedRef).state).toBe("processing");

      operation.complete();
      expect(getEmbeddedRunAttachment(handle)).toBe(attachment);
      expect(getDiagnosticSessionActivitySnapshot(completedRef).activeWorkKind).toBe(
        "embedded_run",
      );

      retireActiveEmbeddedRun(
        completedRef.sessionId,
        handle,
        completedRef.sessionKey,
        undefined,
        "run_completed",
        attachment,
      );

      if (diagnosticOwner) {
        expect(isDiagnosticEmbeddedRunOwnerClosed(diagnosticOwner)).toBe(true);
      }
      expect(getDiagnosticSessionState(completedRef).state).toBe("idle");
      expect(getDiagnosticSessionActivitySnapshot(completedRef).activeWorkKind).toBeUndefined();
      expect(resolveActiveEmbeddedRunOwnerByRunId(runId)).toBeUndefined();
      expect(getEmbeddedRunAttachment(handle)).toBeUndefined();
      expect(listActiveSessionRunIds()).not.toContain(completedRef.sessionId);
      expect(listActiveSessionRunKeys()).not.toContain(completedRef.sessionKey);
    },
  );

  it("preserves a successor projection when prior native cleanup arrives late", () => {
    const successorRef = {
      sessionId: "native-cleanup-successor-session",
      sessionKey: "agent:main:native-cleanup-successor",
    };
    const priorOperation = createReplyOperation({ ...successorRef, resetTriggered: false });
    const priorOwner = createDiagnosticEmbeddedRunOwner({
      ...successorRef,
      runId: "prior-native-run",
    });
    const priorHandle = createRunHandle({ diagnosticOwner: priorOwner, runId: "prior-native-run" });
    startDiagnosticRunActivityTracking();
    const priorAttachment = registerActiveEmbeddedRun(
      successorRef.sessionId,
      priorHandle,
      successorRef.sessionKey,
      undefined,
      undefined,
      priorOperation,
    );
    priorOperation.complete();

    const successorOperation = createReplyOperation({ ...successorRef, resetTriggered: false });
    const successorOwner = createDiagnosticEmbeddedRunOwner({
      ...successorRef,
      runId: "successor-native-run",
    });
    const successorHandle = createRunHandle({
      diagnosticOwner: successorOwner,
      runId: "successor-native-run",
    });
    const successorAttachment = registerActiveEmbeddedRun(
      successorRef.sessionId,
      successorHandle,
      successorRef.sessionKey,
      undefined,
      undefined,
      successorOperation,
    );

    retireActiveEmbeddedRun(
      successorRef.sessionId,
      priorHandle,
      successorRef.sessionKey,
      undefined,
      "run_completed",
      priorAttachment,
    );

    expect(isDiagnosticEmbeddedRunOwnerClosed(priorOwner)).toBe(true);
    expect(isDiagnosticEmbeddedRunOwnerClosed(successorOwner)).toBe(false);
    expect(getDiagnosticSessionState(successorRef).state).toBe("processing");
    expect(resolveActiveEmbeddedRunOwnerByRunId("successor-native-run")).toBeDefined();
    expect(getEmbeddedRunAttachment(successorHandle)).toBe(successorAttachment);

    retireActiveEmbeddedRun(
      successorRef.sessionId,
      successorHandle,
      successorRef.sessionKey,
      undefined,
      "run_completed",
      successorAttachment,
    );
    successorOperation.complete();
  });

  it("revokes completed claims on lifecycle rotation", () => {
    const handle = createRunHandle();
    const { claimCompletion } = prepareEmbeddedAgentRunCompletionClaim(sessionId, "run");
    setActiveEmbeddedRun(sessionId, handle);
    clearActiveEmbeddedRun(sessionId, handle);

    rotateAgentEventLifecycleGeneration();

    expect(claimCompletion()).toBe(false);
  });

  it("publishes backend completion authority and replaces two-argument claims", async () => {
    const handle = createRunHandle({
      queueMessage: vi.fn(async () => {}),
      runId: "claim-run",
    });
    const prepared = prepareEmbeddedAgentRunCompletionClaim("claim-session", "claim-run");
    let settled = false;
    void prepared.registered.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        embeddedRunToolAuthorityBinding: () => ({
          source: "reply",
          project: () => "authority",
          projectAsync: async () => "authority",
          assertActive: () => {},
        }),
      },
      () => setActiveEmbeddedRun("claim-session", handle, "agent:main:main"),
    );

    await expect(prepared.registered).resolves.toEqual({
      toolAuthority: expect.objectContaining({ source: "reply" }),
    });
    clearActiveEmbeddedRun("claim-session", handle, "agent:main:main");
    const replacement = prepareEmbeddedAgentRunCompletionClaim("claim-session", "next-run");
    expect(prepared.claimCompletion()).toBe(false);
    const nextHandle = createRunHandle({ runId: "next-run" });
    setActiveEmbeddedRun("claim-session", nextHandle, "agent:main:main");
    clearActiveEmbeddedRun("claim-session", nextHandle, "agent:main:main");
    await expect(replacement.registered).resolves.toBeUndefined();
    expect(replacement.claimCompletion()).toBe(true);
    expect(replacement.claimCompletion()).toBe(false);
  });

  it("does not publish completion steering readiness without a tool authority binding", async () => {
    const handle = createRunHandle({
      queueMessage: vi.fn(async () => {}),
      runId: "claim-run",
    });
    const prepared = prepareEmbeddedAgentRunCompletionClaim("claim-session", "claim-run");

    setActiveEmbeddedRun("claim-session", handle);

    await expect(prepared.registered).resolves.toBeUndefined();
    expect(prepared.claimCompletion()).toBe(true);
  });

  it("settles an unpublished completion registration as revoked on lifecycle rotation", async () => {
    const prepared = prepareEmbeddedAgentRunCompletionClaim("claim-session", "claim-run");

    rotateAgentEventLifecycleGeneration();

    await expect(prepared.registered).resolves.toBeUndefined();
    expect(prepared.claimCompletion()).toBe(false);
  });

  it("aborts a rootless compacting run when its gateway lifecycle rotates", () => {
    const abort = vi.fn();
    const handle = createRunHandle({
      abort,
      compacting: true,
      queueMessage: vi.fn(async () => {}),
      runId: "rootless-run",
    });
    const operation = setActiveEmbeddedRun("rootless-session", handle);
    try {
      rotateAgentEventLifecycleGeneration();
      expect(abort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(listActiveSessionRunIds()).toContain("rootless-session");
    } finally {
      clearActiveEmbeddedRun("rootless-session", handle);
      operation.complete();
    }
    expect(listActiveSessionRunIds()).not.toContain("rootless-session");
  });

  it("rejects a delayed prior-lifecycle registration for a current session owner", async () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });

    rotateAgentEventLifecycleGeneration();
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      createRunHandle({
        abort: currentAbort,
        queueMessage: currentQueueMessage,
        runId: "current-run",
      }),
      "agent:main:current",
      "/tmp/current-session.jsonl",
    );

    setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
      undefined,
      undefined,
      priorLifecycleGeneration,
    );

    await expect(steerTestSessionTurn(sessionId, "still live")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(listActiveSessionRunIds()).toContain(sessionId);
    expect(listActiveSessionRunIds()).not.toContain("shared-session");
    expect(listActiveSessionRunKeys()).toEqual(["agent:main:current"]);

    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
  });

  it("rejects a delayed prior-lifecycle registration without a replacement owner", async () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });

    rotateAgentEventLifecycleGeneration();
    setActiveEmbeddedRun(
      "stale-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
      undefined,
      undefined,
      priorLifecycleGeneration,
    );

    await expect(steerTestSessionTurn("stale-session", "should not arrive")).resolves.toMatchObject(
      { status: "rejected", reason: "no_active_run" },
    );
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(listActiveSessionRunIds()).not.toContain("stale-session");
    expect(listActiveSessionRunKeys()).not.toContain("agent:main:stale");
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale-session.jsonl"),
    ).toBeUndefined();
  });

  it("retains a handle's original lifecycle fence after eviction and clear", () => {
    const abort = vi.fn();
    const staleHandle = createRunHandle({
      abort,
      queueMessage: vi.fn(async () => {}),
      runId: "cleared-stale-run",
    });

    setActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");
    rotateAgentEventLifecycleGeneration();
    clearActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");

    setActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");

    expect(abort).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenNthCalledWith(1, "restart");
    expect(abort).toHaveBeenNthCalledWith(2, "restart");
    expect(listActiveSessionRunIds()).not.toContain("cleared-stale-session");
  });

  it("rejects a current-lifecycle handle after its diagnostic owner closes", () => {
    const closedRef = { sessionId: "closed-session", sessionKey: "agent:main:closed" };

    const abort = vi.fn();
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({ ...closedRef, runId: "closed-run" });
    const handle = createRunHandle({
      abort,
      diagnosticOwner,
      runId: "closed-run",
    });
    setActiveEmbeddedRun(closedRef.sessionId, handle, closedRef.sessionKey);
    clearActiveEmbeddedRun(closedRef.sessionId, handle, closedRef.sessionKey);

    setActiveEmbeddedRun(closedRef.sessionId, handle, closedRef.sessionKey);

    expect(abort).toHaveBeenCalledWith("restart");
    expect(listActiveSessionRunIds()).not.toContain(closedRef.sessionId);
  });

  it("propagates failure to abort a delayed prior-lifecycle registration", () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleHandle = createRunHandle({
      abort: () => {
        throw new Error("stale abort failed");
      },
      queueMessage: vi.fn(async () => {}),
      runId: "stale-run",
    });

    rotateAgentEventLifecycleGeneration();

    expect(() =>
      setActiveEmbeddedRun(
        "stale-session",
        staleHandle,
        "agent:main:stale",
        undefined,
        undefined,
        undefined,
        priorLifecycleGeneration,
      ),
    ).toThrow("stale abort failed");
    expect(listActiveSessionRunIds()).not.toContain("stale-session");
  });

  it("lets a current-lifecycle owner replace a stale session owner", async () => {
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });
    const staleOperation = setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );

    rotateAgentEventLifecycleGeneration();
    expect(listActiveSessionRunIds()).toContain("shared-session");
    clearActiveEmbeddedRun("shared-session", staleHandle, "agent:main:stale");
    staleOperation.complete();
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    setActiveEmbeddedRun(
      "shared-session",
      createRunHandle({
        abort: currentAbort,
        queueMessage: currentQueueMessage,
        runId: "current-run",
      }),
      "agent:main:current",
      "/tmp/current-session.jsonl",
    );
    clearActiveEmbeddedRun("shared-session", staleHandle, "agent:main:stale");

    await expect(steerTestSessionTurn("shared-session", "now current")).resolves.toMatchObject({
      status: "accepted",
    });
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledOnce();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(listActiveSessionRunIds()).toContain("shared-session");
    expect(listActiveSessionRunKeys()).toEqual(["agent:main:current"]);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:current")).toBe("shared-session");
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale-session.jsonl"),
    ).toBeUndefined();
  });

  it("preserves a current owner registered synchronously by stale abort", async () => {
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    const currentHandle = createRunHandle({
      abort: currentAbort,
      queueMessage: currentQueueMessage,
      runId: "current-run",
    });
    const staleAbort = vi.fn(() => {
      // This fixture producer returns synchronously before publishing its successor.
      clearActiveEmbeddedRun("shared-session", staleHandle, "agent:main:stale");
      staleOperation.complete();
      setActiveEmbeddedRun(
        "shared-session",
        currentHandle,
        "agent:main:current",
        "/tmp/current-session.jsonl",
      );
    });
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: vi.fn(async () => {}),
      runId: "stale-run",
    });
    const staleOperation = setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );

    rotateAgentEventLifecycleGeneration();

    await expect(steerTestSessionTurn("shared-session", "current survives")).resolves.toMatchObject(
      { status: "accepted" },
    );
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(listActiveSessionRunKeys()).toEqual(["agent:main:current"]);
  });

  it("closes queued diagnostic authority before rotation eviction and abort failure", async () => {
    const rotationRef = { sessionId: "rotation-session", sessionKey: "agent:main:rotation" };

    const runId = "rotation-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...rotationRef, runId });
    startDiagnosticRunActivityTracking();
    setActiveEmbeddedRun(
      rotationRef.sessionId,
      createRunHandle({
        abort: () => {
          throw new Error("rotation abort failed");
        },
        diagnosticOwner: owner,
        runId,
      }),
      rotationRef.sessionKey,
    );
    emitRequest(owner, runId);

    expect(() => rotateAgentEventLifecycleGeneration()).toThrow(
      "Failed to retire stale agent lifecycle owners",
    );
    expect(getDiagnosticSessionActivitySnapshot(rotationRef).activeWorkKind).toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(rotationRef).activeWorkKind).toBeUndefined();
  });

  it("preserves a current diagnostic owner installed synchronously by stale abort", async () => {
    const replacementRef = {
      sessionId: "rotation-replacement",
      sessionKey: "agent:main:replacement",
    };
    const runId = "reused-rotation-run";
    const staleOwner = createDiagnosticEmbeddedRunOwner({ ...replacementRef, runId });
    let currentOperation: ReturnType<typeof createReplyOperation> | undefined;
    const staleHandle = createRunHandle({
      abort: () => {
        clearActiveEmbeddedRun(replacementRef.sessionId, staleHandle, replacementRef.sessionKey);
        staleOperation.complete();
        const successor = createReplyOperation({
          sessionKey: replacementRef.sessionKey,
          sessionId: replacementRef.sessionId,
          resetTriggered: false,
        });
        currentOperation = successor;
        const currentOwner = createDiagnosticEmbeddedRunOwner({
          ...replacementRef,
          runId,
          watchdogAttempt: successor.watchdog.attachAttempt({
            assertCurrent: () => assertSessionControllerOperation(successor),
          }),
        });
        const currentHandle = createRunHandle({
          diagnosticOwner: currentOwner,
          queueMessage: vi.fn(async () => {}),
          runId,
        });
        setActiveEmbeddedRun(replacementRef.sessionId, currentHandle, replacementRef.sessionKey);
      },
      diagnosticOwner: staleOwner,
      queueMessage: vi.fn(async () => {}),
      runId,
    });
    startDiagnosticRunActivityTracking();
    const staleOperation = setActiveEmbeddedRun(
      replacementRef.sessionId,
      staleHandle,
      replacementRef.sessionKey,
    );
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...replacementRef,
        runId,
        callId: "stale-call",
        provider: "mock",
        model: "stale-model",
      },
      staleOwner.generation,
      300_000,
    );
    await waitForDiagnosticEventsDrained();

    rotateAgentEventLifecycleGeneration();

    try {
      expect(getDiagnosticSessionActivitySnapshot(replacementRef)).toMatchObject({
        activeWorkKind: "embedded_run",
        hasActiveEmbeddedRun: true,
        activeModelCallRequestTimeoutMs: undefined,
      });
    } finally {
      currentOperation?.complete();
    }
  });

  it("evicts reply operations created by a prior hot-loaded module instance", async () => {
    const replyRunsA = await importFreshModule<
      typeof import("../../sessions/session-controller.js")
    >(import.meta.url, "../../sessions/session-controller.js?scope=generation-a");
    const operation = replyRunsA.createReplyOperation({
      sessionKey: "agent:main:hot-loaded",
      sessionId: "hot-loaded-session",

      resetTriggered: false,
    });
    const cancel = vi.fn();
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });

    const replyRunsB = await importFreshModule<
      typeof import("../../sessions/session-controller.queries.js")
    >(import.meta.url, "../../sessions/session-controller.queries.js?scope=generation-b");
    rotateAgentEventLifecycleGeneration();

    expect(cancel).toHaveBeenCalledExactlyOnceWith("restart");
    expect(replyRunsB.isSessionRunActive("hot-loaded-session")).toBe(true);
    operation.complete();
    expect(replyRunsB.isSessionRunActive("hot-loaded-session")).toBe(false);
  });
});
