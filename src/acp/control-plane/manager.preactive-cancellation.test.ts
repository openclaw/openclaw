import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { getActiveAcpTurnCount, listActiveAcpSessionsForOwner } from "./active-turns.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";
import { cancelledEvent, createAcceptedFixture, gate } from "./manager.ownership.test-support.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  disposeAcpSessionManagerInstance,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  runtimeHandle,
} from "./manager.test-helpers.js";

installAcpSessionManagerTestLifecycle();

it.each(["controls", "submission", "setup-disposal"] as const)(
  "settles cancellation during %s without submitting a prompt",
  async (phase) => {
    const state = createAcceptedFixture({ sessionKey: "agent:codex:acp:preactive" });
    const paused = gate();
    const onLifecycle = vi.fn();
    if (phase === "controls") {
      state.getCapabilities.mockImplementationOnce(async () => {
        await paused.wait();
        return { controls: [] };
      });
    } else if (phase === "setup-disposal") {
      state.ensureSession.mockImplementationOnce(async () => {
        await paused.wait();
        return runtimeHandle(state.target.sessionKey, "dispose-late");
      });
    }
    const { turn, events } = state.startTurn("preactive-turn", {
      text: "must not submit",
      onLifecycle,
      ...(phase === "submission" ? { onBeforePrompt: paused.wait } : {}),
    });
    // Observe rejection before releasing the paused producer.
    const settlement = Promise.allSettled([turn]);
    await paused.entered;
    const cancellation =
      phase === "setup-disposal"
        ? disposeAcpSessionManagerInstance(state.manager, "shutdown")
        : stopAcpControllerTurns({ ...state.target, reason: "preactive-proof" });
    paused.release();
    const [turnResults] = await Promise.all([settlement, cancellation]);
    if (phase === "setup-disposal") {
      expect(state.cancel).toHaveBeenCalledOnce();
      expect(state.close).toHaveBeenCalledOnce();
      expect(state.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
    } else {
      expect(turnResults[0].status).toBe("fulfilled");
    }
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(onLifecycle).not.toHaveBeenCalled();
    expect(events).toEqual([cancelledEvent]);
    expect(state.manager.getObservabilitySnapshot().turns.active).toBe(0);
  },
);

it("retains a silent successor after the retired predecessor settles", async () => {
  await withStateDirEnv("openclaw-acp-manager-", async () => {
    const sessionKey = "agent:codex:acp:reset-liveness";
    const ownerSessionKey = "agent:quant:telegram:quant:direct:822430204";
    const state = createAcceptedFixture({ sessionKey });
    const oldGate = gate();
    const freshGate = gate();
    let ensureCount = 0;
    state.ensureSession.mockImplementation(async (input) =>
      runtimeHandle(input.sessionKey, `runtime-${++ensureCount}`),
    );
    state.runTurn.mockImplementation(async function* (input) {
      await (input.text === "old turn" ? oldGate : freshGate).wait();
      yield { type: "done" as const };
    });
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: ownerSessionKey,
    });
    const old = state.run("retired-turn", { text: "old turn" });
    const oldSettled = old.catch(() => undefined);
    let fresh: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(oldGate.entered, old, "Predecessor ended before runtime");
      await getAcpSessionResetControls(state.manager).forceDiscardSessionRuntime({
        ...state.target,
        reason: "session-reset",
      });
      fresh = state.run("successor-turn", { text: "fresh turn" });
      oldGate.release();
      await oldSettled;
      await awaitGateBeforeSettlement(freshGate.entered, fresh, "Successor ended before runtime");
      expect(ensureCount).toBe(2);
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([sessionKey]);
      expect(getActiveAcpTurnCount()).toBe(1);
      freshGate.release();
      await fresh;
      expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([]);
      expect(getActiveAcpTurnCount()).toBe(0);
    } finally {
      oldGate.release();
      freshGate.release();
      await Promise.allSettled([oldSettled, ...(fresh ? [fresh] : [])]);
    }
  });
});

const { disposeAcpSessionManager, getAcpSessionManager } = await import("./manager.js");

it("builds a fresh manager that submits prompts after shutdown disposal", async () => {
  const state = createAcceptedFixture({ sessionKey: "agent:codex:acp:restart" });
  const beforeRestart = getAcpSessionManager();

  await disposeAcpSessionManager("gateway-shutdown");

  const afterRestart = getAcpSessionManager();
  const events: AcpRuntimeEvent[] = [];
  await afterRestart.runTurn({
    ...state.target,
    provenance: "system",
    text: "after restart",
    mode: "prompt",
    requestId: "after-restart-turn",
    admittedRunContext: createTestAdmittedRunContext("after-restart-turn"),
    onEvent: (event) => void events.push(event),
  });
  expect(events).not.toContainEqual(cancelledEvent);
  expect(state.runTurn).toHaveBeenCalledOnce();
  expect(afterRestart).not.toBe(beforeRestart);
});
