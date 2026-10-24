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
import { logMessageQueued } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  listActiveSessionRunIds,
  listActiveSessionRunKeys,
} from "../../sessions/session-controller.queries.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { getEmbeddedRunAttachment, type EmbeddedAgentQueueHandle } from "./run-state.js";
import {
  detachActiveEmbeddedRun as retireActiveEmbeddedRun,
  prepareEmbeddedAgentRunCompletionClaim,
  getActiveEmbeddedRunSnapshot,
  updateActiveEmbeddedRunSnapshot,
  resolveActiveEmbeddedRunSessionIdBySessionFile as resolveRunByFile,
  resolveActiveEmbeddedRunOwnerByRunId,
  attachActiveEmbeddedRun as registerActiveEmbeddedRun,
} from "./runs.js";
import {
  createEmbeddedRunHandle,
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

type HandleOptions = Partial<
  Pick<EmbeddedAgentQueueHandle, "abort" | "diagnosticOwner" | "queueMessage" | "runId">
> & { compacting?: boolean };

function createRunHandle(params: HandleOptions = {}): EmbeddedAgentQueueHandle {
  const diagnosticOwner = params.diagnosticOwner;
  return {
    ...createEmbeddedRunHandle({
      ...params,
      runId: params.runId ?? "run",
      isAbortable: false,
      isCompacting: params.compacting,
    }),
    kind: "embedded",
    diagnosticOwner,
    closeDiagnostics: diagnosticOwner
      ? () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner)
      : undefined,
  };
}

function createIdentity(name: string) {
  return { sessionId: `${name}-session`, sessionKey: `agent:main:${name}` };
}

function mockRun(runId: string) {
  const abort = vi.fn();
  const queueMessage = vi.fn(async () => {});
  return { abort, queueMessage, handle: createRunHandle({ runId, abort, queueMessage }) };
}

function registerSharedRun(
  handle: EmbeddedAgentQueueHandle,
  kind: "stale" | "current",
  generation?: string,
  id = "shared-session",
) {
  return setActiveEmbeddedRun(
    id,
    handle,
    `agent:main:${kind}`,
    `/tmp/${kind}-session.jsonl`,
    undefined,
    undefined,
    generation,
  );
}

function emitRequest(owner: DiagnosticEmbeddedRunOwner, runId: string, eventRef = ref) {
  emitCoreModelRequestStartedDiagnosticEvent(
    { ...eventRef, runId, callId: "call", provider: "mock", model: "model" },
    owner.generation,
    300_000,
  );
}

function attachOperation(
  operation: ReturnType<typeof createReplyOperation>,
  handle: EmbeddedAgentQueueHandle,
  identity: typeof ref,
  sessionFile?: string,
) {
  return registerActiveEmbeddedRun(
    identity.sessionId,
    handle,
    identity.sessionKey,
    sessionFile,
    undefined,
    operation,
  );
}

function diagnosticRun(identity: typeof ref, runId: string) {
  const operation = createReplyOperation({ ...identity, resetTriggered: false });
  const owner = createDiagnosticEmbeddedRunOwner({ ...identity, runId });
  const handle = createRunHandle({ diagnosticOwner: owner, runId });
  const attachment = attachOperation(operation, handle, identity);
  return { operation, owner, handle, attachment };
}

function retireDiagnosticRun(
  run: Pick<ReturnType<typeof diagnosticRun>, "handle" | "attachment">,
  identity: typeof ref,
) {
  retireActiveEmbeddedRun(
    identity.sessionId,
    run.handle,
    identity.sessionKey,
    undefined,
    "run_completed",
    run.attachment,
  );
}

async function expectCurrentRun(current: ReturnType<typeof mockRun>, id: string, text: string) {
  await expect(steerTestSessionTurn(id, text)).resolves.toMatchObject({ status: "accepted" });
  expect(current.queueMessage).toHaveBeenCalledOnce();
  expect(current.abort).not.toHaveBeenCalled();
  expect(listActiveSessionRunIds()).toContain(id);
  expect(listActiveSessionRunKeys()).toEqual(["agent:main:current"]);
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
        const attachment = attachOperation(
          operation,
          current,
          { sessionId, sessionKey: currentKey },
          currentFile,
        );
        updateActiveEmbeddedRunSnapshot(attachment, snapshot);
      });
      expect(staleAbort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(getActiveEmbeddedRunSnapshot(currentFile)).toEqual({
        transcriptLeafId: "current-leaf",
      });
      expect(resolveRunByFile(currentFile)).toBe(sessionId);
      expect(resolveRunByFile(staleFile)).toBeUndefined();
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
      expect(resolveRunByFile(sessionFile)).toBe(sessionId);
      rotateAgentEventLifecycleGeneration();
      expect(abort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(resolveRunByFile(sessionFile)).toBeUndefined();
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
      const completedRef = createIdentity("controller-completed");
      const runId = "controller-completed-run";
      const operation = createReplyOperation({ ...completedRef, resetTriggered: false });
      const diagnosticOwner = hasOwner
        ? createDiagnosticEmbeddedRunOwner({ ...completedRef, runId })
        : undefined;
      const handle = createRunHandle({ diagnosticOwner, runId });
      startDiagnosticRunActivityTracking();
      const attachment = attachOperation(operation, handle, completedRef);
      expect(getDiagnosticSessionState(completedRef).state).toBe("processing");

      operation.complete();
      expect(getEmbeddedRunAttachment(handle)).toBe(attachment);
      expect(getDiagnosticSessionActivitySnapshot(completedRef).activeWorkKind).toBe(
        "embedded_run",
      );

      retireDiagnosticRun({ handle, attachment }, completedRef);

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
    const successorRef = createIdentity("native-cleanup-successor");
    startDiagnosticRunActivityTracking();
    const prior = diagnosticRun(successorRef, "prior-native-run");
    prior.operation.complete();
    const successor = diagnosticRun(successorRef, "successor-native-run");
    retireDiagnosticRun(prior, successorRef);

    expect(isDiagnosticEmbeddedRunOwnerClosed(prior.owner)).toBe(true);
    expect(isDiagnosticEmbeddedRunOwnerClosed(successor.owner)).toBe(false);
    expect(getDiagnosticSessionState(successorRef).state).toBe("processing");
    expect(resolveActiveEmbeddedRunOwnerByRunId("successor-native-run")).toBeDefined();
    expect(getEmbeddedRunAttachment(successor.handle)).toBe(successor.attachment);
    retireDiagnosticRun(successor, successorRef);
    successor.operation.complete();
  });

  it("retires processing when a successor fails before native start without consuming queued work", () => {
    const pendingRef = createIdentity("blocked-recovery");
    const priorOperation = createReplyOperation({ ...pendingRef, resetTriggered: false });
    const priorHandle = createRunHandle({ runId: "prior-native-run" });
    const priorAttachment = attachOperation(priorOperation, priorHandle, pendingRef);
    logMessageQueued({ ...pendingRef, source: "pending-followup" });
    priorOperation.complete();
    const successor = createReplyOperation({ ...pendingRef, resetTriggered: false });
    retireDiagnosticRun({ handle: priorHandle, attachment: priorAttachment }, pendingRef);
    successor.fail("run_failed", new Error("Session ended during restart recovery"));
    successor.complete();

    expect(listActiveSessionRunKeys()).not.toContain(pendingRef.sessionKey);
    expect(resolveActiveEmbeddedRunOwnerByRunId("prior-native-run")).toBeUndefined();
    expect(getDiagnosticSessionState(pendingRef)).toMatchObject({ state: "idle", queueDepth: 1 });
  });

  it.each(["completed", "unbound", "unpublished"] as const)(
    "settles completion registration after %s ownership",
    async (state) => {
      const handle = createRunHandle({ runId: "claim-run" });
      const prepared = prepareEmbeddedAgentRunCompletionClaim("claim-session", "claim-run");
      if (state !== "unpublished") {
        setActiveEmbeddedRun("claim-session", handle);
      }
      if (state === "completed") {
        clearActiveEmbeddedRun("claim-session", handle);
      }
      if (state !== "unbound") {
        rotateAgentEventLifecycleGeneration();
      }
      await expect(prepared.registered).resolves.toBeUndefined();
      expect(prepared.claimCompletion()).toBe(state === "unbound");
    },
  );

  it("aborts a rootless compacting run when its gateway lifecycle rotates", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort, compacting: true, runId: "rootless-run" });
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

  it.each([false, true])(
    "rejects prior-lifecycle registration with a replacement: %s",
    async (replacement) => {
      const generation = getAgentEventLifecycleGeneration();
      const stale = mockRun("stale-run");
      const staleId = replacement ? "shared-session" : "stale-session";
      rotateAgentEventLifecycleGeneration();
      const current = mockRun("current-run");
      if (replacement) {
        registerSharedRun(current.handle, "current", undefined, sessionId);
      }
      registerSharedRun(stale.handle, "stale", generation, staleId);
      if (replacement) {
        await expectCurrentRun(current, sessionId, "still live");
      } else {
        await expect(steerTestSessionTurn(staleId, "should not arrive")).resolves.toMatchObject({
          status: "rejected",
          reason: "no_active_run",
        });
        expect(listActiveSessionRunKeys()).not.toContain("agent:main:stale");
        expect(resolveRunByFile("/tmp/stale-session.jsonl")).toBeUndefined();
      }
      expect(stale.queueMessage).not.toHaveBeenCalled();
      expect(stale.abort).toHaveBeenCalledWith("restart");
      expect(listActiveSessionRunIds()).not.toContain(staleId);
    },
  );

  it("retains a handle's original lifecycle fence after eviction and clear", () => {
    const abort = vi.fn();
    const staleHandle = createRunHandle({ abort, runId: "cleared-stale-run" });

    setActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");
    rotateAgentEventLifecycleGeneration();
    clearActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");

    setActiveEmbeddedRun("cleared-stale-session", staleHandle, "agent:main:cleared-stale");

    expect(abort.mock.calls).toEqual([["restart"], ["restart"]]);
    expect(listActiveSessionRunIds()).not.toContain("cleared-stale-session");
  });

  it("rejects a current-lifecycle handle after its diagnostic owner closes", () => {
    const closedRef = createIdentity("closed");

    const abort = vi.fn();
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({ ...closedRef, runId: "closed-run" });
    const handle = createRunHandle({ abort, diagnosticOwner, runId: "closed-run" });
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
      runId: "stale-run",
    });

    rotateAgentEventLifecycleGeneration();

    expect(() =>
      registerSharedRun(staleHandle, "stale", priorLifecycleGeneration, "stale-session"),
    ).toThrow("stale abort failed");
    expect(listActiveSessionRunIds()).not.toContain("stale-session");
  });

  it.each([false, true])(
    "preserves a replacement installed during stale abort: %s",
    async (synchronous) => {
      const current = mockRun("current-run");
      const stale = mockRun("stale-run");
      const replace = () => {
        clearActiveEmbeddedRun("shared-session", stale.handle, "agent:main:stale");
        staleOperation.complete();
        registerSharedRun(current.handle, "current");
      };
      if (synchronous) {
        stale.abort.mockImplementation(replace);
      }
      const staleOperation = registerSharedRun(stale.handle, "stale");
      rotateAgentEventLifecycleGeneration();
      if (!synchronous) {
        expect(listActiveSessionRunIds()).toContain("shared-session");
        replace();
      }
      clearActiveEmbeddedRun("shared-session", stale.handle, "agent:main:stale");
      await expectCurrentRun(current, "shared-session", "current survives");
      expect(stale.queueMessage).not.toHaveBeenCalled();
      expect(stale.abort).toHaveBeenCalledExactlyOnceWith("restart");
      expect(resolveRunByFile("/tmp/stale-session.jsonl")).toBeUndefined();
    },
  );

  it("closes queued diagnostic authority before rotation eviction and abort failure", async () => {
    const rotationRef = createIdentity("rotation");

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
    const replacementRef = createIdentity("replacement");
    const runId = "reused-rotation-run";
    const staleOwner = createDiagnosticEmbeddedRunOwner({ ...replacementRef, runId });
    let currentOperation: ReturnType<typeof createReplyOperation> | undefined;
    const staleHandle = createRunHandle({
      abort: () => {
        clearActiveEmbeddedRun(replacementRef.sessionId, staleHandle, replacementRef.sessionKey);
        staleOperation.complete();
        const successor = createReplyOperation({ ...replacementRef, resetTriggered: false });
        currentOperation = successor;
        const currentOwner = createDiagnosticEmbeddedRunOwner({
          ...replacementRef,
          runId,
          watchdogAttempt: successor.watchdog.attachAttempt({
            assertCurrent: () => assertSessionControllerOperation(successor),
          }),
        });
        const currentHandle = createRunHandle({ diagnosticOwner: currentOwner, runId });
        setActiveEmbeddedRun(replacementRef.sessionId, currentHandle, replacementRef.sessionKey);
      },
      diagnosticOwner: staleOwner,
      runId,
    });
    startDiagnosticRunActivityTracking();
    const staleOperation = setActiveEmbeddedRun(
      replacementRef.sessionId,
      staleHandle,
      replacementRef.sessionKey,
    );
    emitRequest(staleOwner, runId, replacementRef);
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
      ...createIdentity("hot-loaded"),
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
