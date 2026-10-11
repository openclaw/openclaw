/** Cancellation must own accepted work before provider submission. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { getActiveAcpTurnCount, listActiveAcpSessionsForOwner } from "./active-turns.js";
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

describe("ACP accepted-turn cancellation", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["controls", "submission"] as const)(
    "settles cancellation during %s without submitting a prompt",
    async (phase) => {
      const state = createRuntime();
      const entered = createDeferred();
      const release = createDeferred();
      const sessionKey = "agent:codex:acp:preactive";
      const events: AcpRuntimeEvent[] = [];
      const lifecycle: unknown[] = [];
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
      hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
      const manager = new AcpSessionManager();
      if (phase === "controls") {
        state.getCapabilities.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { controls: [] };
        });
      }
      const turn = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "must not submit",
        mode: "prompt",
        requestId: "preactive-turn",
        onEvent: (event) => {
          events.push(event);
        },
        onLifecycle: (event) => {
          lifecycle.push(event);
        },
        ...(phase === "submission"
          ? {
              onBeforePrompt: async () => {
                entered.resolve();
                await release.promise;
              },
            }
          : {}),
      });
      // Observe rejection immediately so the baseline cannot leak an unhandled rejection.
      const settlement = Promise.allSettled([turn]);
      await entered.promise;
      const cancel = manager.cancelSession({ cfg: baseCfg, sessionKey, reason: "preactive-proof" });
      const cancellation = Promise.allSettled([cancel]);
      release.resolve();
      const [turnResults, cancelResults] = await Promise.all([settlement, cancellation]);
      expect(turnResults[0].status).toBe("fulfilled");
      expect(cancelResults[0].status).toBe("fulfilled");
      expect(state.runTurn).not.toHaveBeenCalled();
      expect(lifecycle).toEqual([]);
      expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
      expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
    },
  );

  it("disposes a late setup handle without allowing its prompt", async () => {
    const state = createRuntime();
    const entered = createDeferred();
    const release = createDeferred();
    const sessionKey = "agent:codex:acp:dispose-setup";
    const events: AcpRuntimeEvent[] = [];
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
    state.ensureSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { sessionKey, backend: "acpx", runtimeSessionName: "dispose-late" };
    });
    const manager = new AcpSessionManager();
    const turn = manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "must not submit",
      mode: "prompt",
      requestId: "dispose-turn",
      onEvent: (event) => {
        events.push(event);
      },
    });
    const settlement = Promise.allSettled([turn]);
    await entered.promise;
    const disposal = disposeAcpSessionManagerInstance(manager, "shutdown");
    release.resolve();
    await Promise.all([settlement, disposal]);
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
    expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });
});

describe("ACP reset successor liveness", () => {
  installAcpSessionManagerTestLifecycle();

  it("retains a silent successor after the retired predecessor settles", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const sessionKey = "agent:codex:acp:reset-liveness";
      const ownerSessionKey = "agent:quant:telegram:quant:direct:822430204";
      const runtimeState = createRuntime();
      const oldEntered = createDeferred();
      const freshEntered = createDeferred();
      const releaseOld = createDeferred();
      const releaseFresh = createDeferred();
      let ensureCount = 0;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${++ensureCount}`,
      }));
      runtimeState.runTurn.mockImplementation(async function* (input) {
        if (input.text === "old turn") {
          oldEntered.resolve();
          await releaseOld.promise;
        } else {
          freshEntered.resolve();
          await releaseFresh.promise;
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
        await Promise.race([
          oldEntered.promise,
          old.then(() => {
            throw new Error("Predecessor completed before entering the controlled runtime");
          }),
        ]);
        await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
          cfg: baseCfg,
          sessionKey,
          reason: "session-reset",
        });
        fresh = manager.runTurn({ ...input, text: "fresh turn", requestId: "successor-turn" });
        await Promise.race([
          freshEntered.promise,
          fresh.then(() => {
            throw new Error("Successor completed before entering the controlled runtime");
          }),
        ]);
        expect(ensureCount).toBe(2);
        releaseOld.resolve();
        await oldSettled;
        expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([sessionKey]);
        expect(getActiveAcpTurnCount()).toBe(1);
        releaseFresh.resolve();
        await fresh;
        expect(listActiveAcpSessionsForOwner(ownerSessionKey)).toEqual([]);
        expect(getActiveAcpTurnCount()).toBe(0);
      } finally {
        releaseOld.resolve();
        releaseFresh.resolve();
        await Promise.allSettled([oldSettled, ...(fresh ? [fresh] : [])]);
      }
    });
  });
});

const { disposeAcpSessionManager, getAcpSessionManager } = await import("./manager.js");

describe("ACP session manager restart", () => {
  installAcpSessionManagerTestLifecycle();

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
    expect(events).not.toContainEqual({ type: "done", status: "cancelled", stopReason: "cancel" });
    expect(state.runTurn).toHaveBeenCalledOnce();
    expect(afterRestart).not.toBe(beforeRestart);
  });
});
