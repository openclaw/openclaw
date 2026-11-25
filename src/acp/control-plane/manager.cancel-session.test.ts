import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  extractStatesFromUpserts,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  readySessionMeta,
} from "./manager.test-helpers.js";

// Load manager defaults only after the unit fixture registers its module mocks.
const { createGate } = await import("./manager.cancellation-locator.test-support.js");
const sessionKey = "agent:codex:acp:child-1";

function fixture() {
  const state = managerFixture(sessionKey);
  mockMutableSession(sessionKey, { currentMeta: readySessionMeta() });
  return state;
}

installAcpSessionManagerTestLifecycle();

it("records idle cancellation failure and preserves its cause", async () => {
  const { runtimeState: runtime, manager, target } = fixture();
  const error = new Error("Cancel transport failed");
  runtime.cancel.mockRejectedValue(error);
  await expect(manager.cancelSession({ ...target, reason: "manual-cancel" })).rejects.toMatchObject(
    {
      code: "ACP_TURN_FAILED",
      message: error.message,
      cause: error,
    },
  );
  expect(runtime.cancel).toHaveBeenCalledOnce();
  expect(runtime.cancel.mock.calls[0]?.[0].reason).toBe("manual-cancel");
  expect(extractStatesFromUpserts().at(-1)).toBe("error");
});

it("cancels an active controller turn through the manager API", async () => {
  const { runtimeState: runtime, manager, run, target } = fixture();
  const entered = createDeferred();
  const release = createDeferred();
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
  const turn = run({ requestId: "active", text: "active" });
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
  const { runtimeState: runtime, manager, run, target } = fixture();
  const backend = createGate("Idle cancellation settled before entering the backend.");
  runtime.cancel.mockImplementationOnce(backend.wait);
  const cancellation = manager.cancelSession(target);
  let turn: Promise<void> | undefined;
  try {
    await backend.reached(cancellation);
    turn = run({ requestId: "after-idle-cancel", text: "after idle cancel" });
    await nextTurn();
    expect(runtime.runTurn).not.toHaveBeenCalled();
    backend.open();
    await Promise.all([cancellation, turn]);
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.runTurn).toHaveBeenCalledOnce();
  } finally {
    backend.open();
    await Promise.allSettled([cancellation, turn]);
  }
});
