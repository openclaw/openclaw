import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:child-1";
const target = { cfg: baseCfg, sessionKey };
const owner = "agent:main:main";

function fixture(parented = true) {
  const runtime = createRuntime();
  const state = { currentMeta: readySessionMeta() };
  installMutableAcpSessionMetaUpsert(state);
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: state.currentMeta,
  }));
  if (parented) {
    mockParentedAcpSessionEntries({ childSessionKey: sessionKey, parentSessionKey: owner, state });
  }
  const manager = new AcpSessionManager();
  const events: AcpRuntimeEvent[] = [];
  return {
    ...runtime,
    manager,
    events,
    startTurn(text: string, admittedRunContext?: ReturnType<typeof createTestAdmittedRunContext>) {
      return manager.runTurn({
        ...target,
        provenance: "system",
        mode: "prompt",
        requestId: "run-shared",
        text,
        admittedRunContext,
        onEvent: (event) => {
          events.push(event);
        },
      });
    },
  };
}

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("records idle cancellation failure and preserves its cause", async () => {
    const f = fixture(false);
    const error = new Error("Cancel transport failed");
    f.cancel.mockRejectedValue(error);
    await expect(
      f.manager.cancelSession({ ...target, reason: "manual-cancel" }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: error.message,
      cause: error,
    });
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.cancel.mock.calls[0]?.[0].reason).toBe("manual-cancel");
    expect(extractStatesFromUpserts().at(-1)).toBe("error");
  });

  it("cancels the active instance and leaves its queued same-id successor running", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const f = fixture();
      const firstEntered = createDeferred();
      const secondEntered = createDeferred();
      const release = createDeferred();
      let secondSignal: AbortSignal | undefined;
      f.runTurn
        .mockImplementationOnce(async function* (input) {
          firstEntered.resolve();
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) {
              resolve();
              return;
            }
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "done", stopReason: "cancel" };
        })
        .mockImplementationOnce(async function* (input) {
          secondSignal = input.signal;
          secondEntered.resolve();
          await release.promise;
          yield { type: "done", stopReason: "end_turn" };
        });
      const admitted = createTestAdmittedRunContext("run-shared");
      const first = f.startTurn("first", admitted);
      await firstEntered.promise;
      const successor = f.startTurn("successor");
      try {
        await Promise.resolve();
        expect(f.runTurn).toHaveBeenCalledOnce();
        await f.manager.cancelSession({
          ...target,
          reason: "manual-cancel",
          expectedRunId: "run-shared",
          expectedInstanceId: admitted.operationalRunInstance.instanceId,
          expectedOwnerKey: owner,
        });
        await first;
        await secondEntered.promise;
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(f.cancel.mock.calls[0]?.[0].reason).toBe("manual-cancel");
        expect(f.events.at(-1)).toEqual({
          type: "done",
          status: "cancelled",
          stopReason: "cancel",
        });
        const states = extractStatesFromUpserts();
        expect(states).toContain("running");
        expect(states).toContain("idle");
        expect(states).not.toContain("error");
        expect(secondSignal?.aborted).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([first, successor]);
      }
      expect(f.cancel).toHaveBeenCalledOnce();
    });
  });

  it("does not cancel a replacement active turn", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const f = fixture();
      const entered = createDeferred();
      const release = createDeferred();
      f.runTurn.mockImplementationOnce(async function* () {
        entered.resolve();
        await release.promise;
        yield { type: "done", stopReason: "end_turn" };
      });
      const admitted = createTestAdmittedRunContext("run-shared");
      const turn = f.startTurn("replacement", admitted);
      try {
        await entered.promise;
        const cancellation = {
          ...target,
          expectedRunId: "run-shared",
          expectedInstanceId: admitted.operationalRunInstance.instanceId,
          expectedOwnerKey: owner,
        };
        await expect(
          f.manager.cancelSession({
            ...cancellation,
            expectedOwnerKey: "agent:main:other",
          }),
        ).rejects.toThrow("ACP task owner could not be verified.");
        expect(f.cancel).not.toHaveBeenCalled();
        await expect(
          f.manager.cancelSession({
            ...cancellation,
            expectedInstanceId: "instance-from-prior-turn",
          }),
        ).rejects.toThrow("ACP task is no longer the active run.");
        expect(f.cancel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await turn;
      }
    });
  });
});
