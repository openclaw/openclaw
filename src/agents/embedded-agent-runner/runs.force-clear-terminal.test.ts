import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
  runAfterReplyOperationClear,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDeferredEmbeddedRunLifecycleManager } from "./run/deferred-lifecycle-owner.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  updateActiveEmbeddedRunSnapshot,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle as createRunHandle, testing } from "./runs.test-support.js";

const sessionId = "session",
  sessionKey = "agent:main:test",
  startedAt = 123;
let testState: OpenClawTestState;
let storePath: string;
function forceClear(settleMs = 0, key = sessionKey) {
  return abortAndDrainEmbeddedAgentRun({
    sessionId,
    sessionKey: key,
    settleMs,
    forceClear: true,
    reason: "stuck_recovery",
  });
}
function seed(id = sessionId) {
  return upsertSessionEntryCore(
    { sessionKey, storePath },
    { sessionId: id, updatedAt: Date.now(), status: "running" },
  );
}

function startReply(handle: ReturnType<typeof createRunHandle>, embedded = true) {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.attachBackend({
    kind: "embedded",
    cancel: handle.abort,
    isStreaming: handle.isStreaming,
  });
  operation.setPhase("running");
  if (embedded) {
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
  return operation;
}
beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-forceclear-",
  });
  storePath = path.join(testState.sessionsDir(), "sessions.json");
  setRuntimeConfigSnapshot({ session: { store: storePath } });
});
afterEach(async () => {
  try {
    clearRuntimeConfigSnapshot();
    testing.resetActiveEmbeddedRuns();
    resetDiagnosticRunActivityForTest();
    replyRunTesting.resetReplyRunRegistry();
    vi.useRealTimers();
  } finally {
    await testState.cleanup();
  }
});

describe("force-clear terminal state persistence", () => {
  it("defers followups until the old owner settles", async () => {
    // Keep owner ordering independent of the wall-clock drain deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    const handle = createRunHandle(),
      operation = startReply(handle);
    const observed: boolean[] = [];
    runAfterReplyOperationClear(operation, () => {
      observed.push(isEmbeddedAgentRunHandleActive(sessionId));
    });
    const recovery = forceClear(100);
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);
    expect(observed).toEqual([]);
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    let settled = false;
    void recovery.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(observed).toEqual([]);
    operation.complete();
    await expect(recovery).resolves.toEqual({ aborted: true, drained: true, forceCleared: false });
    await Promise.resolve();
    expect(observed).toEqual([false]);
  });

  it("clears owners before followups when cancel throws", async () => {
    const handle = createRunHandle({
      abort: () => {
        throw new Error("cancel failed");
      },
    });
    const operation = startReply(handle),
      followup = createDeferredCore<boolean>();
    const onFollowup = vi.fn(() => {
      followup.resolve(isEmbeddedAgentRunHandleActive(sessionId));
    });
    runAfterReplyOperationClear(operation, onFollowup);
    await expect(forceClear(20)).resolves.toEqual({
      aborted: false,
      drained: false,
      forceCleared: true,
    });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    await expect(followup.promise).resolves.toBe(false);
    expect(onFollowup).toHaveBeenCalledOnce();
  });

  it("clears reply owners when accepted cancellation stalls", async () => {
    const cancel = vi.fn(),
      operation = startReply(createRunHandle({ abort: cancel }), false);
    const followup = createDeferredCore<boolean>();
    const onFollowup = vi.fn(() => {
      followup.resolve(isReplyRunActiveForSessionId(sessionId));
    });
    runAfterReplyOperationClear(operation, onFollowup);
    await expect(forceClear(20)).resolves.toEqual({
      aborted: false,
      drained: false,
      forceCleared: true,
    });
    expect(cancel).toHaveBeenCalledWith("superseded");
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    await expect(followup.promise).resolves.toBe(false);
    expect(onFollowup).toHaveBeenCalledOnce();
  });

  it("persists killed state under the fixed store owner", async () => {
    storePath = testState.statePath("shared-store.sqlite");
    setRuntimeConfigSnapshot({
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath },
      { sessionId, updatedAt: startedAt, startedAt, status: "running" },
    );
    setActiveEmbeddedRun(sessionId, createRunHandle(), "global");
    await expect(forceClear(0, "global")).resolves.toMatchObject({ forceCleared: true });
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "global", storePath })).toMatchObject({
      sessionId,
      status: "killed",
      abortedLastRun: true,
    });
  });

  it("persists terminal state in the deferred agent's global store", async () => {
    const agentId = "work",
      key = "global";
    setRuntimeConfigSnapshot({
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
      session: { scope: "global" },
    });
    for (const owner of ["main", "work"]) {
      await upsertSessionEntryCore(
        { agentId: owner, sessionKey: key },
        {
          sessionId: owner === agentId ? sessionId : "main-global",
          updatedAt: startedAt,
          startedAt,
          status: "running",
          lifecycleRunId: `${owner}-run`,
        },
      );
    }
    const deferred = createDeferredEmbeddedRunLifecycleManager({
      agentId,
      sessionId,
      sessionKey: key,
      runId: "work-run",
    });
    deferred.handoffToCli();
    updateActiveEmbeddedRunSnapshot(sessionId, {
      transcriptLeafId: "leaf",
      inFlightPrompt: "pending",
    });
    expect(getActiveEmbeddedRunSnapshot(sessionId)).toEqual({
      transcriptLeafId: "leaf",
      inFlightPrompt: "pending",
    });
    await expect(forceClear(0, key)).resolves.toMatchObject({ forceCleared: true });
    const entry = loadSessionEntry({ agentId, sessionKey: key });
    expect(entry).toMatchObject({ sessionId, status: "killed", abortedLastRun: true });
    expect(entry?.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(entry?.lifecycleRunId).toBeUndefined();
    await deferred.complete();
    expect(getActiveEmbeddedRunSnapshot(sessionId)).toBeUndefined();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
      sessionId: "main-global",
      status: "running",
      lifecycleRunId: "main-run",
    });
  });

  it("preserves a replacement session entry", async () => {
    await seed();
    setActiveEmbeddedRun(sessionId, createRunHandle(), sessionKey);
    await seed("new-session");
    await expect(forceClear()).resolves.toMatchObject({ forceCleared: true });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "new-session",
      status: "running",
    });
  });

  it.each([sessionId, "new-session"])(
    "preserves a replacement run in session %s",
    async (replacementId) => {
      await seed();
      const replacement = createRunHandle();
      const original = createRunHandle({
        abort: () => setActiveEmbeddedRun(replacementId, replacement, sessionKey),
      });
      setActiveEmbeddedRun(sessionId, original, sessionKey);
      await expect(forceClear()).resolves.toEqual({
        aborted: true,
        drained: false,
        forceCleared: replacementId !== sessionId,
      });
      expect(isEmbeddedAgentRunHandleActive(replacementId)).toBe(true);
      expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("running");
    },
  );
});
