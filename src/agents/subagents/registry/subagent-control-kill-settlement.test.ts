import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../../sessions/session-controller.contracts.js";
import {
  captureSessionTarget,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  trackSessionControllerSourceWork,
} from "../../../sessions/session-controller.mailbox.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../../sessions/session-controller.stop.js";
import { settleSubagentKillSources } from "./subagent-control-kill-settlement.js";

async function startSource(name: string) {
  const sessionKey = `agent:main:kill-settlement-${name}`;
  const sessionId = `${name}-session`;
  const target = captureSessionTarget({
    storeScope: "/synthetic/kill-settlement",
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const input = reserveSessionControllerSource(sessionKey, {
    target,
    protocolRunId: name,
    policy: { mode: "followup" },
  });
  const entered = createDeferred<ReplyOperation>();
  const release = createDeferred();
  const work = withSessionTurn(
    { sessionKey, sessionId, target, controllerInput: input },
    async (operation) => {
      const owner = expectDefined(operation, "source operation");
      owner.setPhase("running");
      entered.resolve(owner);
      await release.promise;
    },
  );
  trackSessionControllerSourceWork(input, work);
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([work, input.settlement.promise]);
  });
  const operation = await awaitGateBeforeSettlement(entered.promise, work, "Source did not start");
  return { input, operation, work, finish: release.resolve };
}

it.each(["operations", "claimed inputs"] as const)(
  "joins only interrupted %s after cancellation revokes authority",
  async (selection) => {
    vi.useFakeTimers();
    const id = selection === "operations" ? "operations" : "sources";
    const cancelled = await startSource(`${id}-cancelled`);
    const untouched = await startSource(`${id}-untouched`);
    let joined: ReturnType<typeof settleSubagentKillSources> | undefined;
    try {
      let authorized = true;
      const revoked = new Error("Caller control revoked by accepted cancellation");
      cancelled.operation.abortSignal.addEventListener(
        "abort",
        () => {
          authorized = false;
        },
        { once: true },
      );
      const capture = captureSessionControllerStop(
        selection === "operations"
          ? { operations: [cancelled.operation, untouched.operation] }
          : { inputs: [cancelled.input, untouched.input] },
      );
      const stopped = cancelCapturedSessionControllerSource(capture, {
        assertCurrent: () => {
          if (!authorized) {
            throw revoked;
          }
        },
        onError: () => "continue",
      });
      expect(stopped).toMatchObject({ activeCancelled: 1, failures: [{ error: revoked }] });
      expect(cancelled.operation.abortSignal.aborted).toBe(true);
      expect(untouched.operation).toMatchObject({ abortSignal: { aborted: false }, result: null });

      joined = settleSubagentKillSources({ cleanup: capture });
      const settled = vi.fn();
      void joined.then(settled);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).not.toHaveBeenCalled();

      cancelled.finish();
      await cancelled.work;
      await cancelled.input.settlement.promise;
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
      expect(await joined).toEqual({});
      expect(untouched.operation).toMatchObject({ abortSignal: { aborted: false }, result: null });
      expect(untouched.input.retirementRequested).not.toBe(true);
    } finally {
      cancelled.finish();
      untouched.finish();
      await Promise.allSettled([cancelled.work, untouched.work, joined]);
      await Promise.all([cancelled.input.settlement.promise, untouched.input.settlement.promise]);
      vi.useRealTimers();
    }
  },
);
