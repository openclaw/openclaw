/** Accepted cancellation retains exact task, actor, and late-runtime custody. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { withTaskCancellationControl } from "../../tasks/task-cancellation-context.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

function fixture(sessionKey = "agent:codex:acp:accepted-ownership") {
  const runtime = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
  const manager = new AcpSessionManager();
  return { ...runtime, manager, target: { cfg: baseCfg, sessionKey } };
}

describe("ACP accepted cancellation ownership", () => {
  installAcpSessionManagerTestLifecycle();

  it("cancels only the accepted snapshot and records queued tasks before releasing the actor", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const state = fixture();
      mockParentedAcpSessionEntries({
        childSessionKey: state.target.sessionKey,
        parentSessionKey: "agent:main:main",
      });
      const entered = createDeferred();
      const release = createDeferred();
      state.getStatus.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { summary: "ready" };
      });
      const actor = state.manager.getSessionStatus(state.target);
      await entered.promise;
      const events: AcpRuntimeEvent[][] = [[], []];
      const cancelled = events.map((row, index) =>
        state.manager.runTurn({
          ...state.target,
          provenance: "system",
          mode: "prompt",
          text: "cancelled",
          requestId: `snapshot-${index}`,
          onEvent: (event) => {
            row.push(event);
          },
        }),
      );
      const cancellation = state.manager.cancelSession(state.target);
      const later = state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "survivor",
        requestId: "later",
      });
      try {
        await Promise.all([...cancelled, cancellation]);
        expect(state.runTurn).not.toHaveBeenCalled();
        expect(events).toEqual(
          Array.from({ length: 2 }, () => [
            { type: "done", status: "cancelled", stopReason: "cancel" },
          ]),
        );
        expect(requireTaskByRunId("snapshot-0").status).toBe("cancelled");
        expect(requireTaskByRunId("snapshot-1").status).toBe("cancelled");
        expect(
          listSessionStateEventsSince(state.target.sessionKey, "codex", 0, 200).events,
        ).toMatchObject([
          { kind: "run_failed", runId: "snapshot-0", payload: { outcome: "cancelled" } },
          { kind: "run_failed", runId: "snapshot-1", payload: { outcome: "cancelled" } },
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([actor, ...cancelled, cancellation, later]);
      }
      expect(state.runTurn).toHaveBeenCalledOnce();
      expect(state.runTurn.mock.calls[0]?.[0].text).toBe("survivor");
      expect(requireTaskByRunId("later").status).toBe("succeeded");
    });
  });

  it("cancels a queued exact instance without terminalizing its same-id predecessor", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const state = fixture();
      mockParentedAcpSessionEntries({
        childSessionKey: state.target.sessionKey,
        parentSessionKey: "agent:main:main",
      });
      const entered = createDeferred();
      const release = createDeferred();
      let activeSignal: AbortSignal | undefined;
      state.runTurn.mockImplementationOnce(async function* (input) {
        activeSignal = input.signal;
        entered.resolve();
        await release.promise;
        yield { type: "done", stopReason: "end_turn" };
      });
      const first = state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "predecessor",
        requestId: "same-id",
      });
      await entered.promise;
      const before = requireTaskByRunId("same-id");
      const context = createTestAdmittedRunContext("same-id");
      const events: AcpRuntimeEvent[] = [];
      const queued = state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "successor",
        requestId: "same-id",
        admittedRunContext: context,
        onEvent: (event) => {
          events.push(event);
        },
      });
      try {
        await state.manager.cancelSession({
          ...state.target,
          expectedRunId: "same-id",
          expectedInstanceId: context.operationalRunInstance.instanceId,
          expectedOwnerKey: "agent:main:main",
        });
        await queued;
        expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
        expect(requireTaskByRunId("same-id")).toEqual(before);
        expect(extractStatesFromUpserts().at(-1)).toBe("running");
        expect(activeSignal?.aborted).toBe(false);
        expect(state.cancel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([first, queued]);
      }
      expect(state.runTurn).toHaveBeenCalledOnce();
    });
  });

  it("refuses stale caller authority before aborting an accepted turn", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const state = fixture();
      mockParentedAcpSessionEntries({
        childSessionKey: state.target.sessionKey,
        parentSessionKey: "agent:main:main",
      });
      const entered = createDeferred();
      const release = createDeferred();
      let activeSignal: AbortSignal | undefined;
      state.runTurn.mockImplementationOnce(async function* (input) {
        activeSignal = input.signal;
        entered.resolve();
        await release.promise;
        yield { type: "done", stopReason: "end_turn" };
      });
      const admitted = createTestAdmittedRunContext("caller-revoked");
      const turn = state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "keep working",
        requestId: "caller-revoked",
        admittedRunContext: admitted,
      });
      try {
        await entered.promise;
        await expect(
          withTaskCancellationControl(
            {
              assertCurrent: () => {
                throw new Error("Caller no longer controls this task.");
              },
            },
            () =>
              state.manager.cancelSession({
                ...state.target,
                expectedRunId: "caller-revoked",
                expectedInstanceId: admitted.operationalRunInstance.instanceId,
                expectedOwnerKey: "agent:main:main",
              }),
          ),
        ).rejects.toThrow("Caller no longer controls this task.");
        expect(activeSignal?.aborted).toBe(false);
        expect(state.cancel).not.toHaveBeenCalled();
        expect(requireTaskByRunId("caller-revoked").status).toBe("running");
      } finally {
        release.resolve();
        await turn;
      }
      expect(requireTaskByRunId("caller-revoked").status).toBe("succeeded");
    });
  });

  it("joins accepted late-handle cancellation after caller authority is revoked", async () => {
    const state = fixture();
    const ensureEntered = createDeferred();
    const ensureRelease = createDeferred();
    const cancelEntered = createDeferred();
    const cancelRelease = createDeferred();
    state.ensureSession.mockImplementationOnce(async () => {
      ensureEntered.resolve();
      await ensureRelease.promise;
      return {
        sessionKey: state.target.sessionKey,
        backend: "acpx",
        runtimeSessionName: "late-exact",
      };
    });
    state.cancel.mockImplementationOnce(async () => {
      cancelEntered.resolve();
      await cancelRelease.promise;
    });
    const events: AcpRuntimeEvent[] = [];
    const turn = state.manager.runTurn({
      ...state.target,
      provenance: "system",
      mode: "prompt",
      text: "late",
      requestId: "late",
      onEvent: (event) => {
        events.push(event);
      },
    });
    await ensureEntered.promise;
    let settled = false;
    let callerCurrent = true;
    const cancel = withTaskCancellationControl(
      {
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("Caller no longer controls this task.");
          }
        },
      },
      () => state.manager.cancelSession({ ...state.target, expectedRunId: "late" }),
    ).then(() => {
      settled = true;
    });
    const settlement = Promise.all([turn, cancel]);
    callerCurrent = false;
    ensureRelease.resolve();
    try {
      await Promise.race([
        cancelEntered.promise,
        settlement.then(() => {
          throw new Error("Cancellation settled before backend acknowledgement.");
        }),
      ]);
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      expect(state.runTurn).not.toHaveBeenCalled();
      expect(state.cancel.mock.calls[0]?.[0].handle.runtimeSessionName).toBe("late-exact");
    } finally {
      cancelRelease.resolve();
      await Promise.allSettled([turn, cancel]);
    }
    await settlement;
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
  });

  it("preserves late runtime cancellation failure instead of claiming a cancelled terminal", async () => {
    const state = fixture();
    const entered = createDeferred();
    const release = createDeferred();
    state.ensureSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        sessionKey: state.target.sessionKey,
        backend: "acpx",
        runtimeSessionName: "late-failed",
      };
    });
    state.cancel.mockRejectedValue(new Error("cancel transport failure"));
    const events: AcpRuntimeEvent[] = [];
    const turn = state.manager.runTurn({
      ...state.target,
      provenance: "system",
      mode: "prompt",
      text: "late",
      requestId: "failed",
      onEvent: (event) => {
        events.push(event);
      },
    });
    const turnResult = Promise.allSettled([turn]);
    await entered.promise;
    const cancel = state.manager.cancelSession(state.target);
    const cancelResult = Promise.allSettled([cancel]);
    release.resolve();
    expect(await turnResult).toMatchObject([
      { status: "rejected", reason: { message: "cancel transport failure" } },
    ]);
    expect(await cancelResult).toMatchObject([
      { status: "rejected", reason: { message: "cancel transport failure" } },
    ]);
    expect(events).toEqual([]);
    expect(state.runTurn).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a different agent's identical logical session outside cancellation", async () => {
    const state = fixture("shared-session");
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: { ...state.runtime, ownerAwareSessions: 1 },
    });
    const cfg = {
      ...baseCfg,
      agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } },
    };
    const entered = createDeferred();
    const release = createDeferred();
    state.getStatus.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { summary: "ready" };
    });
    const alpha = { cfg, sessionKey: "shared-session", agentId: "alpha" };
    const beta = { cfg, sessionKey: "shared-session", agentId: "beta" };
    const actor = state.manager.getSessionStatus(alpha);
    await Promise.race([
      entered.promise,
      actor.then(() => {
        throw new Error("status ended before partition gate");
      }),
    ]);
    const cancelled = state.manager.runTurn({
      ...alpha,
      provenance: "system",
      mode: "prompt",
      text: "alpha",
      requestId: "alpha",
    });
    const live = state.manager.runTurn({
      ...beta,
      provenance: "system",
      mode: "prompt",
      text: "beta",
      requestId: "beta",
    });
    try {
      await Promise.all([cancelled, state.manager.cancelSession(alpha), live]);
    } finally {
      release.resolve();
      await Promise.allSettled([actor, cancelled, live]);
    }
    expect(state.runTurn).toHaveBeenCalledOnce();
    expect(state.runTurn.mock.calls[0]?.[0].text).toBe("beta");
  });

  it("revalidates task ownership before queued cancellation writes a terminal task", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const state = fixture();
      mockParentedAcpSessionEntries({
        childSessionKey: state.target.sessionKey,
        parentSessionKey: "agent:main:main",
      });
      const entered = createDeferred();
      const release = createDeferred();
      state.getStatus.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { summary: "ready" };
      });
      const actor = state.manager.getSessionStatus(state.target);
      await entered.promise;
      const events: AcpRuntimeEvent[] = [];
      const turn = state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "queued",
        requestId: "owner-race",
        onEvent: (event) => {
          events.push(event);
        },
      });
      const turnResult = Promise.allSettled([turn]);
      const cancel = state.manager.cancelSession({
        ...state.target,
        expectedOwnerKey: "agent:main:main",
      });
      const cancelResult = Promise.allSettled([cancel]);
      mockParentedAcpSessionEntries({
        childSessionKey: state.target.sessionKey,
        parentSessionKey: "agent:main:other",
      });
      try {
        expect(await turnResult).toMatchObject([
          { status: "rejected", reason: { message: "ACP task owner could not be verified." } },
        ]);
        expect(await cancelResult).toMatchObject([
          { status: "rejected", reason: { message: "ACP task owner could not be verified." } },
        ]);
        expect(events).toEqual([]);
        expect(() => requireTaskByRunId("owner-race")).toThrow("Expected task for run owner-race");
        expect(state.runTurn).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([actor, turn, cancel]);
      }
    });
  });

  it.each(["caller", "disposed"] as const)(
    "settles %s cancellation before actor admission without setup",
    async (reason) => {
      const state = fixture();
      const controller = new AbortController();
      if (reason === "caller") {
        controller.abort();
      } else {
        await disposeAcpSessionManagerInstance(state.manager, "shutdown");
      }
      const events: AcpRuntimeEvent[] = [];
      await state.manager.runTurn({
        ...state.target,
        provenance: "system",
        mode: "prompt",
        text: "not submitted",
        requestId: reason,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(state.ensureSession).not.toHaveBeenCalled();
      expect(state.runTurn).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: "done", status: "cancelled", stopReason: "cancel" }]);
    },
  );
});
