import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { QuestionAnswerUnconfirmedError } from "../harness/gateway-question-dispatch.js";
import {
  claimPendingEmbeddedAgentQuestionAnswer,
  clearActiveEmbeddedRun,
  formatEmbeddedAgentQueueFailureSummary,
  preemptAndDrainEmbeddedHeartbeatRun,
  queueEmbeddedAgentMessageWithOutcome as queueSync,
  queueEmbeddedAgentMessageWithOutcomeAsync as queueAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync as queueGuarded,
  setActiveEmbeddedRun,
  waitForEmbeddedAgentRunEnd,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

const sessionId = "session",
  sessionKey = "agent:main:test";
const images = [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }];
function start(overrides: Partial<EmbeddedAgentQueueHandle> = {}) {
  const handle = {
    ...createEmbeddedRunHandle(),
    queueMessage: vi.fn(async () => {}),
    ...overrides,
  };
  setActiveEmbeddedRun(sessionId, handle);
  return handle;
}
function failure(reason: string, errorMessage?: string) {
  return {
    queued: false,
    sessionId,
    reason,
    gatewayHealth: "live",
    ...(errorMessage ? { errorMessage } : {}),
  };
}
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("embedded-agent active-run steering", () => {
  it("keeps V1 compatibility and refuses guarded injection", async () => {
    const queueMessage = vi.fn(async () => {}),
      claim = vi.fn(async () => true);
    let available = false;
    let compacting = true;
    start({
      isCompacting: () => compacting,
      runId: "legacy",
      queueMessage,
      claimPendingUserInputAnswer: claim,
      messageInjection: { isAvailable: () => available, queueMessage },
    });
    expect(queueSync(sessionId, "continue")).toEqual(failure("not_streaming"));
    available = true;
    expect(queueSync(sessionId, "continue")).toEqual(failure("compacting"));
    await expect(
      queueGuarded(sessionId, "source-bound", undefined, () => true),
    ).resolves.toMatchObject({ queued: false, reason: "guarded_injection_unsupported" });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    await expect(
      claimPendingEmbeddedAgentQuestionAnswer(sessionId, "unscoped"),
    ).resolves.toBeNull();
    expect(claim).not.toHaveBeenCalled();
    compacting = false;
    await expect(queueAsync(sessionId, "unscoped")).resolves.toMatchObject({ queued: true });
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it.each([true, false])("claims pending answers without steering: %s", async (claimed) => {
    const queueMessage = vi.fn(async () => {});
    start({
      runId: "question-owner",
      queueMessage,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer: async (_text, options, assertCurrent) => {
          assertCurrent();
          return options?.isInboundUserMessage === true && claimed;
        },
      },
    });
    await expect(claimPendingEmbeddedAgentQuestionAnswer(sessionId, "Green")).resolves.toEqual(
      claimed ? { runId: "question-owner" } : null,
    );
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it.each(["image", "overlay", "wrong-authority-overlay"] as const)(
    "routes hidden input through its question owner: %s",
    async (input) => {
      const runId = "hidden-question-owner",
        ownerRun = createQueueTestRun({ prompt: "pending question" });
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(ownerRun));
      const fingerprint = operation.bindToolAuthorityRoute({
        provider: ownerRun.run.provider,
        model: ownerRun.run.model,
      });
      const queueMessage = vi.fn(async () => {}),
        claim = vi.fn(async () => true),
        cancel = vi.fn(async () => true);
      const handle = {
        ...createEmbeddedRunHandle({ runId, queueMessage }),
        kind: "embedded" as const,
        cancel: vi.fn(),
        toolAuthorityFingerprint: fingerprint,
      };
      handle.messageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer: async (_text, _options, assertCurrent, authorityKind) => {
          expect(authorityKind).toBe("source-bound");
          assertCurrent();
          return claim();
        },
        cancelPendingUserInput: async (_resolvedBy, assertCurrent, authorityKind) => {
          expect(authorityKind).toBe("source-bound");
          assertCurrent();
          return cancel();
        },
      };
      operation.attachBackend(handle);
      operation.setPhase("running");
      setActiveEmbeddedRun(sessionId, handle);
      registerAgentRunContext(runId, { isControlUiVisible: false, projectSessionMessages: false });
      const image = input === "image",
        authorized = input !== "wrong-authority-overlay";
      const options: Parameters<typeof queueGuarded>[2] = {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: fingerprint,
        ...(image
          ? { images }
          : {
              toolAuthorityOverlay: {
                senderIsOwner: false,
                disableTools: !authorized,
                traceAuthorized: false,
              },
              pendingInputAuthorityFingerprint: fingerprint,
            }),
      };
      try {
        await expect(queueGuarded(sessionId, "Green", options, () => true)).resolves.toMatchObject(
          input === "overlay"
            ? { queued: true }
            : { queued: false, reason: "input_visibility_mismatch" },
        );
        expect(claim).toHaveBeenCalledTimes(authorized && !image ? 1 : 0);
        expect(cancel).toHaveBeenCalledTimes(image ? 1 : 0);
        expect(queueMessage).not.toHaveBeenCalled();
      } finally {
        clearAgentRunContext(runId);
        operation.complete();
      }
    },
  );

  it.each(["availability", "claim"] as const)(
    "rejects backend replacement during question %s",
    async (stage) => {
      const entered = createDeferredCore(),
        released = createDeferredCore();
      const queueMessage = vi.fn(async () => {}),
        replacement = createEmbeddedRunHandle({ runId: "replacement", queueMessage });
      const claim = vi.fn(
        async (
          _text: string,
          _options: EmbeddedAgentQueueMessageOptions | undefined,
          assertCurrent: () => void,
        ) => {
          entered.resolve();
          await released.promise;
          assertCurrent();
          return true;
        },
      );
      start({
        runId: "question-owner",
        queueMessage,
        messageInjectionV2: {
          version: 2,
          queueMessage,
          claimPendingUserInputAnswer: claim,
          isAvailable: () => {
            if (stage === "availability") {
              setActiveEmbeddedRun(sessionId, replacement);
            }
            return true;
          },
        },
      });
      const result = claimPendingEmbeddedAgentQuestionAnswer(sessionId, "Green");
      try {
        if (stage === "availability") {
          await expect(result).resolves.toBeNull();
          expect(claim).not.toHaveBeenCalled();
        } else {
          await entered.promise;
          setActiveEmbeddedRun(sessionId, replacement);
          released.resolve();
          await expect(result).rejects.toThrow("Message injection authority is no longer current");
        }
        expect(queueMessage).not.toHaveBeenCalled();
      } finally {
        released.resolve();
      }
    },
  );

  it("keeps handle and session waiters distinct through replacements", async () => {
    vi.useFakeTimers();
    const preempt = vi.fn(() => true),
      visibleAbort = vi.fn();
    const heartbeat = start({ isAbortable: () => false, preemptByVisibleTurn: preempt });
    const replacement = createEmbeddedRunHandle({ abort: visibleAbort });
    setActiveEmbeddedRun("visible", replacement);
    const heartbeatWait = preemptAndDrainEmbeddedHeartbeatRun(sessionId, 1_000);
    const sessionWait = waitForEmbeddedAgentRunEnd(sessionId, null);
    let heartbeatDrained = false,
      sessionDrained = false;
    void heartbeatWait.then(() => {
      heartbeatDrained = true;
    });
    void sessionWait.then(() => {
      sessionDrained = true;
    });
    await expect(preemptAndDrainEmbeddedHeartbeatRun("visible", 1_000)).resolves.toBe(
      "not-heartbeat",
    );
    setActiveEmbeddedRun(sessionId, replacement);
    await Promise.resolve();
    expect(heartbeatDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, heartbeat);
    await expect(heartbeatWait).resolves.toBe("drained");
    expect(sessionDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, replacement);
    const successor = createEmbeddedRunHandle();
    setActiveEmbeddedRun(sessionId, successor);
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, successor);
    await expect(sessionWait).resolves.toBe(true);
    expect(preempt).toHaveBeenCalledOnce();
    expect(visibleAbort).not.toHaveBeenCalled();
  });

  it.each([undefined, "message_tool_only"] as const)(
    "preserves source-reply delivery semantics with active mode %s",
    (sourceReplyDeliveryMode) => {
      const handle = start({ sourceReplyDeliveryMode });
      const options = {
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
      } as const;
      const outcome = queueSync(sessionId, "continue", options);
      if (sourceReplyDeliveryMode === "message_tool_only") {
        expect(outcome.queued).toBe(true);
        expect(handle.queueMessage).toHaveBeenCalledExactlyOnceWith("continue", options);
      } else {
        expect(outcome).toEqual(failure("source_reply_delivery_mode_mismatch"));
        expect(handle.queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("uses stopped state for non-streaming steering", () => {
    const queueMessage = vi.fn(async () => {});
    start({ isStreaming: () => false, queueMessage });
    expect(queueSync(sessionId, "continue")).toEqual(failure("not_streaming"));
    expect(queueMessage).not.toHaveBeenCalled();
    start({ isStreaming: () => false, isStopped: () => false, queueMessage });
    expect(queueSync(sessionId, "continue").queued).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });
  });

  it("rejects quiet tool steering only after its stale floor", () => {
    vi.useFakeTimers();
    start();
    markDiagnosticToolStartedForTest({ sessionId, toolName: "exec", toolCallId: "tool" });
    vi.advanceTimersByTime(12 * 60_000);
    expect(queueSync(sessionId, "status?").queued).toBe(true);
    vi.advanceTimersByTime(4 * 60_000);
    expect(queueSync(sessionId, "status?")).toMatchObject({
      queued: false,
      reason: "stale_run",
    });
  });

  it("refuses reply-backed steering with stale registry evidence", () => {
    vi.useFakeTimers();
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.attachBackend({ kind: "cli", cancel: () => {}, isStreaming: () => true });
    operation.setPhase("running");
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(queueSync(sessionId, "hello")).toEqual(failure("stale_run"));
    operation.complete();
  });

  it("fails closed when stopped state checks throw", () => {
    const handle = start({
      isStopped: () => {
        throw new Error("bad stopped state");
      },
    });
    expect(queueSync(sessionId, "continue")).toEqual(failure("not_streaming"));
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when the compacting state check throws", async () => {
    const warnings = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
    const handle = start({
      isCompacting: () => {
        throw new Error("compaction probe unavailable");
      },
    });
    const outcome = failure("compacting");
    await expect(queueAsync(sessionId, "continue")).resolves.toEqual(outcome);
    await expect(queueAsync(sessionId, "retry")).resolves.toEqual(outcome);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it("reports async steering rejection", async () => {
    start({
      queueMessage: async () => {
        throw new Error("cannot steer a compact turn");
      },
    });
    const outcome = await queueAsync(sessionId, "continue");
    expect(outcome).toEqual(failure("runtime_rejected", "cannot steer a compact turn"));
    expect(formatEmbeddedAgentQueueFailureSummary(outcome)).toBe(
      "queue_message_failed reason=runtime_rejected sessionId=session gatewayHealth=live error=cannot steer a compact turn",
    );
  });

  it.each([false, true])("does not replay pending input: unconfirmed=%s", async (unconfirmed) => {
    const error = new QuestionAnswerUnconfirmedError(new Error("answer receipt unavailable"));
    const claim = vi.fn(async () => {
      if (unconfirmed) {
        throw error;
      }
      return true;
    });
    const handle = start({
      toolAuthorityFingerprint: "fallback",
      claimPendingUserInputAnswer: claim,
    });
    const options = {
      isInboundUserMessage: true,
      onQueueAccepted: vi.fn(),
      onQueueSettled: vi.fn(),
      pendingInputAuthorityFingerprint: "fallback",
      toolAuthorityFingerprint: "default",
    } as const;
    const outcome = queueAsync(sessionId, "2", options);
    if (unconfirmed) {
      await expect(outcome).rejects.toBe(error);
      expect(options.onQueueAccepted).not.toHaveBeenCalled();
      expect(options.onQueueSettled).not.toHaveBeenCalled();
    } else {
      await expect(outcome).resolves.toMatchObject({ queued: true, target: "embedded_run" });
      expect(options.onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(options.onQueueSettled).toHaveBeenCalledOnce();
    }
    expect(claim).toHaveBeenCalledExactlyOnceWith("2", {
      ...options,
      onQueueSettled: expect.any(Function),
    });
    // The custody wrapper must not settle the caller twice when its run later retires.
    clearActiveEmbeddedRun(sessionId, handle);
    expect(options.onQueueSettled).toHaveBeenCalledTimes(unconfirmed ? 0 : 1);
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects unmatched authority: unproven image=%s", async (image) => {
    const claim = vi.fn(async () => image),
      cancel = vi.fn(async () => true);
    const handle = start({
      toolAuthorityFingerprint: "fallback",
      claimPendingUserInputAnswer: claim,
      cancelPendingUserInput: cancel,
    });
    const outcome = await queueAsync(sessionId, "continue", {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: "default",
      pendingInputAuthorityFingerprint: image ? undefined : "fallback",
      images: image ? images : undefined,
    });
    expect(outcome).toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
    expect(claim).toHaveBeenCalledTimes(image ? 0 : 1);
    expect(cancel).not.toHaveBeenCalled();
    expect(handle.queueMessage).not.toHaveBeenCalled();
  });

  it.each(["tool_authority_mismatch", "image_input_unsupported"] as const)(
    "cancels pending input before image rejection: %s",
    async (reason) => {
      const cancel = vi.fn(async () => true);
      start({ toolAuthorityFingerprint: "fallback", cancelPendingUserInput: cancel });
      const outcome = await queueAsync(sessionId, "inspect", {
        isInboundUserMessage: true,
        pendingInputAuthorityFingerprint: "fallback",
        toolAuthorityFingerprint: reason === "tool_authority_mismatch" ? "default" : "fallback",
        images,
      });
      expect(outcome).toMatchObject({ queued: false, reason });
      expect(cancel).toHaveBeenCalledWith("image-reply");
    },
  );

  it("settles V1 input custody when its exact receiver retires", async () => {
    const queueMessage = vi.fn(async () => {});
    const handle = start({ messageInjection: { isAvailable: () => true, queueMessage } });
    const onQueueSettled = vi.fn();
    await expect(queueAsync(sessionId, "legacy input", { onQueueSettled })).resolves.toMatchObject({
      queued: true,
    });
    expect(onQueueSettled).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, handle);
    expect(onQueueSettled).toHaveBeenCalledOnce();
  });

  it("preserves unconfirmed steering receipts", async () => {
    const queueMessage = vi.fn(
      async (_text: string, options?: EmbeddedAgentQueueMessageOptions) => {
        options?.onQueueAccepted?.(true);
        return { transcriptCommit: "unconfirmed" as const, errorMessage: "receipt unavailable" };
      },
    );
    start({ toolAuthorityFingerprint: "same", supportsTranscriptCommitWait: true, queueMessage });
    const onQueueAccepted = vi.fn();
    await expect(
      queueAsync(sessionId, "continue", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "same",
        waitForTranscriptCommit: true,
        onQueueAccepted,
      }),
    ).resolves.toEqual({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage: "receipt unavailable",
      enqueuedAtMs: expect.any(Number),
    });
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it("retains custody across a transcript wait retry", async () => {
    const queueMessage = vi.fn(async () => {}),
      onQueueSettled = vi.fn();
    const handle = start({
      queueMessage,
      messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
    });
    await expect(
      queueGuarded(
        sessionId,
        "continue",
        { waitForTranscriptCommit: true, onQueueSettled },
        () => true,
      ),
    ).resolves.toEqual(failure("transcript_commit_wait_unsupported"));
    expect(queueMessage).not.toHaveBeenCalled();
    expect(onQueueSettled).not.toHaveBeenCalled();
    await expect(
      queueGuarded(sessionId, "continue", { onQueueSettled }, () => true),
    ).resolves.toMatchObject({ queued: true });
    expect(onQueueSettled).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, handle);
    expect(onQueueSettled).toHaveBeenCalledOnce();
  });

  it("rejects transcript waits before reply fallback", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible group prompt", sender: { id: "user-42" } },
      target: createTestUserTurnTranscriptTarget(),
    });
    await expect(
      queueAsync(sessionId, "completion from child", {
        waitForTranscriptCommit: true,
        userTurnTranscriptRecorder: recorder,
      }),
    ).resolves.toEqual(failure("transcript_commit_wait_unsupported"));
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
