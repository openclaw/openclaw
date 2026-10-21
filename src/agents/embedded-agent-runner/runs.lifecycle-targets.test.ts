import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { SessionControllerAdmissionRequiredError } from "../harness/errors.js";
import { isAgentRunRestartAbortReason } from "../run-termination.js";
import { withSessionPlacementForcedTerminalSettlement } from "../session-placement-forced-terminal-settlement.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { getActiveNativeAttempt, getEmbeddedRunAttachment } from "./run-state.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  detachActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  attachActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

const sessionId = "native-lifecycle-session";
const sessionKey = "agent:main:native-lifecycle";
const undrained = { aborted: false, drained: false, forceCleared: false };

function drain(
  options: Omit<Parameters<typeof abortAndDrainEmbeddedAgentRun>[0], "sessionId"> = {},
) {
  return abortAndDrainEmbeddedAgentRun({ sessionId, settleMs: 100, ...options });
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  vi.useRealTimers();
});

describe("native lifecycle admission and cancellation", () => {
  it("retires exact transcript ownership behind an alias without clearing a replacement", async () => {
    const sessionFile = "in-memory:detached-native-file";
    const effect = await beginSessionEffect({
      scope: "/tmp/native-file-store",
      identities: [sessionId],
    });
    const first = createEmbeddedRunHandle();
    const second = createEmbeddedRunHandle();
    try {
      const firstAttachment = attachActiveEmbeddedRun(sessionId, first, undefined, sessionFile);
      expect(firstAttachment).toBeDefined();
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      expect(resolveActiveEmbeddedRunSessionIdBySessionFile(sessionFile)).toBe(sessionId);

      attachActiveEmbeddedRun(sessionId, second, undefined, sessionFile);
      expect(getEmbeddedRunAttachment(first)).toBeUndefined();
      expect(firstAttachment?.settled).toBeUndefined();
      detachActiveEmbeddedRun(sessionId, first);
      expect(firstAttachment?.settled).toBe(true);
      expect(resolveActiveEmbeddedRunSessionIdBySessionFile(sessionFile)).toBe(sessionId);

      detachActiveEmbeddedRun(sessionId, second);
      expect(resolveActiveEmbeddedRunSessionIdBySessionFile(sessionFile)).toBeUndefined();
      effect.release();
      expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
    } finally {
      detachActiveEmbeddedRun(sessionId, first);
      detachActiveEmbeddedRun(sessionId, second);
      effect.release();
    }
  });

  it.each([
    ["owned", "model"],
    ["detached", "model"],
    ["owned", "execution"],
    ["owned", "refused"],
  ] as const)(
    "reports %s native %s recovery without confusing recovery with settlement",
    async (kind, recovery) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const operation =
        kind === "owned"
          ? createReplyOperation({ sessionId, sessionKey, resetTriggered: false })
          : undefined;
      const abort = vi.fn();
      const cleanup = vi.fn(async () => {});
      const recoverStalledModelCall = vi.fn(() => recovery === "model");
      const recoverExecution = vi.fn(async () => true);
      const handle = { ...createEmbeddedRunHandle({ abort }), recoverStalledModelCall };
      const key = operation ? sessionKey : undefined;
      const attach = () =>
        attachActiveEmbeddedRun(sessionId, handle, key, undefined, undefined, operation);
      if (recovery === "model") {
        withSessionPlacementForcedTerminalSettlement(cleanup, () => {}, attach);
      } else {
        attach();
      }
      if (recovery === "execution") {
        operation?.watchdog.beginExecution(() => 1, recoverExecution);
      }
      vi.setSystemTime(recovery === "execution" ? 1 : 6 * 60_000);
      const draining = drain({
        reason: "stuck_recovery",
        ...(recovery === "model" ? { forceClear: true } : {}),
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        await expect(draining).resolves.toEqual({
          ...undrained,
          aborted: recovery !== "execution",
          ...(recovery === "model" ? { recoveringModelAttempt: true } : {}),
        });
        expect(recoverStalledModelCall).toHaveBeenCalledTimes(recovery === "execution" ? 0 : 1);
        expect(recoverExecution).toHaveBeenCalledTimes(recovery === "execution" ? 1 : 0);
        expect(abort).toHaveBeenCalledTimes(recovery === "refused" ? 1 : 0);
        if (recovery === "model") {
          expect(cleanup).not.toHaveBeenCalled();
          expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
          expect(operation?.result ?? null).toBeNull();
        }
      } finally {
        detachActiveEmbeddedRun(sessionId, handle, key);
        operation?.complete();
        await draining;
      }
    },
  );

  it.each([false, true])("requires exact admission even with an ambient turn: %s", (active) => {
    const operation = active
      ? createReplyOperation({ sessionId, sessionKey, resetTriggered: false })
      : undefined;
    const handle = createEmbeddedRunHandle();
    let rejection: unknown;
    try {
      attachActiveEmbeddedRun(sessionId, handle, sessionKey);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(SessionControllerAdmissionRequiredError);
    expect(rejection).toMatchObject({ code: "SESSION_CONTROLLER_ADMISSION_REQUIRED" });
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    expect(getEmbeddedRunAttachment(handle)).toBeUndefined();
    expect(isSessionRunActive(sessionId)).toBe(active);
    operation?.complete();
  });

  it("retains an admitted detached policy key without taking the session turn", async () => {
    const handle = createEmbeddedRunHandle({ runId: "detached-policy-run" });
    const assertActive = vi.fn();
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        embeddedRunToolAuthorityBinding: () => ({
          source: "attempt",
          acceptsRequesterOrigin: () => false,
          detached: true,
          project: () => undefined,
          projectAsync: async () => undefined,
          assertRegistrationActive: assertActive,
          assertActive,
        }),
      },
      () => attachActiveEmbeddedRun(sessionId, handle, sessionKey),
    );
    expect(assertActive).toHaveBeenCalled();
    expect(getEmbeddedRunAttachment(handle)).toMatchObject({ sessionKey });
    expect(getEmbeddedRunAttachment(handle)?.operation).toBeUndefined();
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
    expect(isSessionRunActive(sessionId)).toBe(false);
    detachActiveEmbeddedRun(sessionId, handle, sessionKey);
  });

  it.each(["owned", "preparing", "detached"] as const)(
    "preserves typed single-session restart cancellation for %s work",
    (kind) => {
      const operation =
        kind === "detached"
          ? undefined
          : createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort });
      if (kind === "owned") {
        attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, operation);
      } else if (kind === "detached") {
        attachActiveEmbeddedRun(sessionId, handle);
      }
      expect(abortEmbeddedAgentRun(sessionId, { reason: "restart" })).toBe(true);
      if (operation) {
        expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
        expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(true);
      }
      if (kind === "preparing") {
        expect(abort).not.toHaveBeenCalled();
      } else {
        expect(abort).toHaveBeenCalledExactlyOnceWith("restart");
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
        detachActiveEmbeddedRun(sessionId, handle, operation ? sessionKey : undefined);
      }
      operation?.complete();
    },
  );

  it.each([undefined, "restart"] as const)(
    "reports a detached cancellation callback failure without losing its producer: %s",
    (reason) => {
      const abort = vi.fn(() => {
        throw new Error("detached runtime cancellation failed");
      });
      const handle = createEmbeddedRunHandle({ abort });
      attachActiveEmbeddedRun(sessionId, handle);
      try {
        expect(abortEmbeddedAgentRun(sessionId, { reason })).toBe(false);
        expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      } finally {
        detachActiveEmbeddedRun(sessionId, handle);
      }
    },
  );

  it.each([false, true])(
    "continues detached cleanup after cancellation fails (producer settles=%s)",
    async (producerSettles) => {
      vi.useFakeTimers();
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      const cleanup = vi.fn(async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      });
      const abort = vi.fn(() => {
        throw new Error("detached runtime cancellation failed");
      });
      const handle = createEmbeddedRunHandle({ abort });
      withSessionPlacementForcedTerminalSettlement(
        cleanup,
        () => {},
        () => attachActiveEmbeddedRun(sessionId, handle),
      );
      let completed: Awaited<ReturnType<typeof drain>> | undefined;
      const draining = drain({ forceClear: true }).then((result) => (completed = result));
      try {
        await awaitGateBeforeSettlement(
          cleanupEntered.promise,
          draining,
          "drain settled before entering detached cleanup",
        );
        expect(abort).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
        if (producerSettles) {
          detachActiveEmbeddedRun(sessionId, handle);
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(completed).toBeUndefined();
        releaseCleanup.resolve();
        await expect(draining).resolves.toEqual({ ...undrained, drained: producerSettles });
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(!producerSettles);
      } finally {
        releaseCleanup.resolve();
        detachActiveEmbeddedRun(sessionId, handle);
        await draining.catch(() => undefined);
      }
    },
  );

  it.each([undefined, "stuck_recovery"])(
    "does not abort a non-abortable detached producer while draining: %s",
    async (reason) => {
      vi.useFakeTimers();
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort, isAbortable: false });
      attachActiveEmbeddedRun(sessionId, handle);
      const draining = drain({ reason });
      await vi.advanceTimersByTimeAsync(100);
      await expect(draining).resolves.toEqual(undrained);
      expect(abort).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      detachActiveEmbeddedRun(sessionId, handle);
    },
  );
});
