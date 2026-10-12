import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
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
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
  type DiagnosticEmbeddedRunOwner,
} from "../../logging/diagnostic-run-activity.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./active-run-projections.js";
import {
  setActiveEmbeddedRunLifecycleGeneration,
  type EmbeddedAgentQueueHandle,
} from "./run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunAbortableForRunId,
  prepareEmbeddedAgentRunCompletionClaim,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

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
    rotate: () => {
      generationSequence += 1;
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
    isCompacting: () => false,
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
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticEventsForTest();
    lifecycleMock.reset();
  });

  it("revokes completed claims on lifecycle rotation", () => {
    const handle = createRunHandle();
    const { claimCompletion } = prepareEmbeddedAgentRunCompletionClaim(sessionId, "run");
    setActiveEmbeddedRun(sessionId, handle);
    clearActiveEmbeddedRun(sessionId, handle);

    rotateAgentEventLifecycleGeneration();

    expect(claimCompletion()).toBe(false);
  });

  it("rejects stale registrations without replacing current work", async () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);

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

    setActiveEmbeddedRun(sessionId, staleHandle, "agent:main:stale", "/tmp/stale-session.jsonl");
    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "still live"),
    ).resolves.toMatchObject({ queued: true, target: "embedded_run" });
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(listActiveEmbeddedRunSessionIds()).toContain(sessionId);
    expect(listActiveEmbeddedRunSessionKeys()).toEqual(["agent:main:current"]);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(isEmbeddedAgentRunAbortableForRunId("current-run")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("stale-run")).toBe(true);
  });

  it("rejects registrations after diagnostic ownership closes", () => {
    const abort = vi.fn();
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({ ...ref, runId: "closed-run" });
    const handle = createRunHandle({
      abort,
      diagnosticOwner,
      runId: "closed-run",
    });
    setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
    clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);

    setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);

    expect(abort).toHaveBeenCalledWith("restart");
    expect(listActiveEmbeddedRunSessionIds()).not.toContain(ref.sessionId);
  });

  it("closes queued diagnostics before a failed rotation abort", async () => {
    const runId = "rotation-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    setActiveEmbeddedRun(
      ref.sessionId,
      createRunHandle({
        abort: () => {
          throw new Error("rotation abort failed");
        },
        diagnosticOwner: owner,
        runId,
      }),
      ref.sessionKey,
    );
    emitRequest(owner, runId);

    expect(() => rotateAgentEventLifecycleGeneration()).toThrow(
      "Failed to retire stale agent lifecycle owners",
    );
    expect(getDiagnosticSessionActivitySnapshot(ref).activeWorkKind).toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).activeWorkKind).toBeUndefined();
  });

  it("preserves the replacement owner through stale abort and cleanup", async () => {
    const runId = "reused-run",
      oldRef = { ...ref, sessionKey: "agent:main:stale" };
    const staleOwner = createDiagnosticEmbeddedRunOwner({ ...oldRef, runId });
    const currentOwner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    const queueMessage = vi.fn(async () => {}),
      currentAbort = vi.fn();
    const current = createRunHandle({
      diagnosticOwner: currentOwner,
      runId,
      queueMessage,
      abort: currentAbort,
    });
    const staleAbort = vi.fn(() =>
      setActiveEmbeddedRun(sessionId, current, ref.sessionKey, "/tmp/current.jsonl"),
    );
    const stale = createRunHandle({ abort: staleAbort, diagnosticOwner: staleOwner, runId });
    startDiagnosticRunActivityTracking();
    setActiveEmbeddedRun(sessionId, stale, oldRef.sessionKey, "/tmp/stale.jsonl");
    emitRequest(staleOwner, runId, oldRef);
    await waitForDiagnosticEventsDrained();
    rotateAgentEventLifecycleGeneration();
    clearActiveEmbeddedRun(sessionId, stale, oldRef.sessionKey);
    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "continue"),
    ).resolves.toMatchObject({ queued: true, target: "embedded_run" });
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(listActiveEmbeddedRunSessionKeys()).toEqual([ref.sessionKey]);
    expect(resolveActiveEmbeddedRunHandleSessionId(oldRef.sessionKey)).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale.jsonl"),
    ).toBeUndefined();
    expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/current.jsonl")).toBe(
      sessionId,
    );
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: undefined,
    });
  });

  it("retires reply owners created by a reloaded module", async () => {
    const first = await importFreshModule<
      typeof import("../../auto-reply/reply/reply-run-registry.js")
    >(import.meta.url, "../../auto-reply/reply/reply-run-registry.js?scope=generation-a");
    const operation = first.createReplyOperation({
      sessionId,
      sessionKey: ref.sessionKey,
      resetTriggered: false,
    });
    const cancel = vi.fn();
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    const reloaded = await importFreshModule<
      typeof import("../../auto-reply/reply/reply-run-registry.js")
    >(import.meta.url, "../../auto-reply/reply/reply-run-registry.js?scope=generation-b");
    rotateAgentEventLifecycleGeneration();
    expect(cancel).toHaveBeenCalledWith("restart");
    expect(reloaded.isReplyRunActiveForSessionId(sessionId)).toBe(false);
  });
});
