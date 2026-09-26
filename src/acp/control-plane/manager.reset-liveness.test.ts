/** Reset overlap must preserve the native successor until its provider stream settles. */
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { getActiveAcpTurnCount, listActiveAcpSessionsForOwner } from "./active-turns.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
} from "./manager.test-helpers.js";

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
