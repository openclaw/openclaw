/** Cancellation must own accepted work before provider submission. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { getActiveAcpTurnCount, listActiveAcpSessionsForOwner } from "./active-turns.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";
import { cancelledEvent, createAcceptedFixture, gate } from "./manager.ownership.test-support.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

installAcpSessionManagerTestLifecycle();

describe("ACP accepted-turn cancellation", () => {
  it.each(["controls", "submission"] as const)(
    "settles cancellation during %s without submitting a prompt",
    async (phase) => {
      const state = createAcceptedFixture({ sessionKey: "agent:codex:acp:preactive" });
      const paused = gate();
      const lifecycle: unknown[] = [];
      if (phase === "controls") {
        state.getCapabilities.mockImplementationOnce(async () => {
          await paused.wait();
          return { controls: [] };
        });
      }
      const { turn, events } = state.startTurn("preactive-turn", {
        text: "must not submit",
        onLifecycle: (event) => {
          lifecycle.push(event);
        },
        ...(phase === "submission" ? { onBeforePrompt: paused.wait } : {}),
      });
      // Observe rejection immediately so the baseline cannot leak an unhandled rejection.
      const settlement = Promise.allSettled([turn]);
      await paused.entered;
      const cancel = stopAcpControllerTurns({
        ...state.target,
        reason: "preactive-proof",
      });
      const cancellation = Promise.allSettled([cancel]);
      paused.release();
      const [turnResults, cancelResults] = await Promise.all([settlement, cancellation]);
      expect([turnResults[0].status, cancelResults[0].status]).toEqual(["fulfilled", "fulfilled"]);
      expect(state.runTurn).not.toHaveBeenCalled();
      expect(lifecycle).toEqual([]);
      expect(events).toEqual([cancelledEvent]);
      expect(state.manager.getObservabilitySnapshot().turns.active).toBe(0);
    },
  );

  it("disposes a late setup handle without allowing its prompt", async () => {
    const sessionKey = "agent:codex:acp:dispose-setup";
    const state = createAcceptedFixture({ sessionKey });
    const paused = gate();
    state.ensureSession.mockImplementationOnce(async () => {
      await paused.wait();
      return { sessionKey, backend: "acpx", runtimeSessionName: "dispose-late" };
    });
    const { turn, events } = state.startTurn("dispose-turn", { text: "must not submit" });
    const settlement = Promise.allSettled([turn]);
    await paused.entered;
    const disposal = disposeAcpSessionManagerInstance(state.manager, "shutdown");
    paused.release();
    await Promise.all([settlement, disposal]);
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
    expect(events).toEqual([cancelledEvent]);
    expect(state.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });
});

it("retains a silent successor after the retired predecessor settles", async () => {
  await withStateDirEnv("openclaw-acp-manager-", async () => {
    const sessionKey = "agent:codex:acp:reset-liveness";
    const ownerSessionKey = "agent:quant:telegram:quant:direct:822430204";
    const runtimeState = createRuntime();
    const oldGate = gate();
    const freshGate = gate();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${++ensureCount}`,
    }));
    runtimeState.runTurn.mockImplementation(async function* (input) {
      if (input.text === "old turn") {
        await oldGate.wait();
      } else {
        await freshGate.wait();
      }
      yield { type: "done" as const };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: ownerSessionKey,
    });
    const manager = new AcpSessionManager();
    const input = {
      provenance: "system" as const,
      cfg: baseCfg,
      sessionKey,
      mode: "prompt" as const,
    };
    const old = manager.runTurn({ ...input, text: "old turn", requestId: "retired-turn" });
    const oldSettled = old.catch(() => undefined);
    let fresh: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(oldGate.entered, old, "Predecessor ended before runtime");
      await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
        cfg: baseCfg,
        sessionKey,
        reason: "session-reset",
      });
      fresh = manager.runTurn({ ...input, text: "fresh turn", requestId: "successor-turn" });
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
  const state = createRuntime();
  const sessionKey = "agent:codex:acp:restart";
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
  hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
  const beforeRestart = getAcpSessionManager();

  await disposeAcpSessionManager("gateway-shutdown");

  const afterRestart = getAcpSessionManager();
  const events: AcpRuntimeEvent[] = [];
  await afterRestart.runTurn({
    provenance: "system",
    cfg: baseCfg,
    sessionKey,
    text: "after restart",
    mode: "prompt",
    requestId: "after-restart-turn",
    admittedRunContext: createTestAdmittedRunContext("after-restart-turn"),
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(events).not.toContainEqual(cancelledEvent);
  expect(state.runTurn).toHaveBeenCalledOnce();
  expect(afterRestart).not.toBe(beforeRestart);
});
