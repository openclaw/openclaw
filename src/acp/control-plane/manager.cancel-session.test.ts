import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  mockMutableSession,
  readySessionMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:child-1";
const target = { cfg: baseCfg, sessionKey };

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("records idle cancellation failure and preserves its cause", async () => {
    const runtime = createRuntime();
    const state = { currentMeta: readySessionMeta() };
    installMutableAcpSessionMetaUpsert(state);
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: state.currentMeta,
    }));
    const manager = new AcpSessionManager();
    const error = new Error("Cancel transport failed");
    runtime.cancel.mockRejectedValue(error);
    await expect(
      manager.cancelSession({ ...target, reason: "manual-cancel" }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: error.message,
      cause: error,
    });
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.cancel.mock.calls[0]?.[0].reason).toBe("manual-cancel");
    expect(extractStatesFromUpserts().at(-1)).toBe("error");
  });

  it("cancels an active controller turn through the manager API", async () => {
    const runtime = createRuntime();
    const entered = createDeferred();
    const release = createDeferred();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
    mockMutableSession(sessionKey, { currentMeta: readySessionMeta() });
    runtime.runTurn.mockImplementationOnce(async function* (input) {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
          } else {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          }
        }),
      ]);
      yield { type: "done", status: "cancelled", stopReason: "cancel" };
    });
    const manager = new AcpSessionManager();
    const turn = manager.runTurn({
      ...target,
      provenance: "system",
      requestId: "active",
      mode: "prompt",
      text: "active",
    });
    const turnResult = Promise.allSettled([turn]);
    try {
      await entered.promise;
      await manager.cancelSession({ ...target, reason: "manual-cancel" });
      expect(await turnResult).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(runtime.cancel).toHaveBeenCalledOnce();
      expect(runtime.cancel.mock.calls[0]?.[0].reason).toBe("manual-cancel");
    } finally {
      release.resolve();
      await turnResult;
    }
  });

  it("holds new controller turns until the idle backend cancellation settles", async () => {
    const runtime = createRuntime();
    const entered = createDeferred();
    const release = createDeferred();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
    mockMutableSession(sessionKey, { currentMeta: readySessionMeta() });
    runtime.cancel.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const manager = new AcpSessionManager();
    const cancellation = manager.cancelSession(target);
    let turn: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        cancellation,
        "Idle cancellation settled before entering the backend.",
      );
      turn = manager.runTurn({
        ...target,
        provenance: "system",
        requestId: "after-idle-cancel",
        mode: "prompt",
        text: "after idle cancel",
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(runtime.runTurn).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([cancellation, turn]);
      expect(runtime.cancel).toHaveBeenCalledOnce();
      expect(runtime.runTurn).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([cancellation, turn]);
    }
  });
});
