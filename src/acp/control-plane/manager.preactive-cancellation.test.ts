/** Cancellation must own accepted work before provider submission. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP accepted-turn cancellation", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["queued", "setup", "controls", "submission"] as const)(
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
      let actor: Promise<unknown> | undefined;
      if (phase === "queued") {
        state.getStatus.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { summary: "ready" };
        });
        actor = manager.getSessionStatus({ cfg: baseCfg, sessionKey });
        await entered.promise;
      } else if (phase === "setup") {
        state.ensureSession.mockImplementationOnce(async (input) => {
          entered.resolve();
          await release.promise;
          return { sessionKey: input.sessionKey, backend: "acpx", runtimeSessionName: "late" };
        });
      } else if (phase === "controls") {
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
      if (phase !== "queued") {
        await entered.promise;
      }
      const cancel = manager.cancelSession({ cfg: baseCfg, sessionKey, reason: "preactive-proof" });
      const cancellation = Promise.allSettled([cancel]);
      release.resolve();
      await actor;
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
