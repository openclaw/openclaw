/** Accepted cancellation retains exact turn, actor, and late-runtime custody. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
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

function fixture({ sessionKey = "agent:codex:acp:accepted-ownership", parented = false } = {}) {
  const runtime = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
  if (parented) {
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: "agent:main:main",
    });
  }
  const manager = new AcpSessionManager();
  const target = { cfg: baseCfg, sessionKey };
  return {
    ...runtime,
    manager,
    target,
    startTurn(
      requestId: string,
      options: Partial<
        Pick<Parameters<AcpSessionManager["runTurn"]>[0], "text" | "signal" | "admittedRunContext">
      > = {},
    ) {
      const events: AcpRuntimeEvent[] = [];
      const turn = manager.runTurn({
        ...target,
        provenance: "system",
        mode: "prompt",
        text: requestId,
        requestId,
        onEvent: (event) => {
          events.push(event);
        },
        ...options,
      });
      return { turn, events };
    },
  };
}

describe("ACP accepted cancellation ownership", () => {
  installAcpSessionManagerTestLifecycle();

  it("cancels only the accepted snapshot and records queued cancellation signals before releasing the actor", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = fixture({ parented: true });
      const entered = createDeferred();
      const release = createDeferred();
      state.getStatus.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { summary: "ready" };
      });
      const actor = state.manager.getSessionStatus(state.target);
      await entered.promise;
      const snapshot = [0, 1].map((index) =>
        state.startTurn(`snapshot-${index}`, {
          text: "cancelled",
          admittedRunContext: createTestAdmittedRunContext(`snapshot-${index}`),
        }),
      );
      const cancelled = snapshot.map(({ turn }) => turn);
      const events = snapshot.map((accepted) => accepted.events);
      const cancellation = state.manager.cancelSession(state.target);
      const { turn: later } = state.startTurn("later", { text: "survivor" });
      try {
        await Promise.all([...cancelled, cancellation]);
        expect(state.runTurn).not.toHaveBeenCalled();
        expect(events).toEqual(
          Array.from({ length: 2 }, () => [
            { type: "done", status: "cancelled", stopReason: "cancel" },
          ]),
        );
        expect(
          (await listSessionStateEventsSince(state.target.sessionKey, "codex", 0, 200)).events,
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
    });
  });

  it("cancels a queued exact instance without terminalizing its same-id predecessor", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = fixture({ parented: true });
      const entered = createDeferred();
      const release = createDeferred();
      let activeSignal: AbortSignal | undefined;
      state.runTurn.mockImplementationOnce(async function* (input) {
        activeSignal = input.signal;
        entered.resolve();
        await release.promise;
        yield { type: "done", stopReason: "end_turn" };
      });
      const { turn: first } = state.startTurn("same-id", { text: "predecessor" });
      await entered.promise;
      const context = createTestAdmittedRunContext("same-id");
      const { turn: queued, events } = state.startTurn("same-id", {
        text: "successor",
        admittedRunContext: context,
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
        expect(extractStatesFromUpserts().at(-1)).toBe("running");
        expect(activeSignal?.aborted).toBe(false);
        expect(state.cancel).not.toHaveBeenCalled();
        expect(
          (await listSessionStateEventsSince(state.target.sessionKey, "codex", 0, 200)).events,
        ).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([first, queued]);
      }
      expect(state.runTurn).toHaveBeenCalledOnce();
      expect(
        (await listSessionStateEventsSince(state.target.sessionKey, "codex", 0, 200)).events,
      ).toMatchObject([{ kind: "run_completed", runId: "same-id" }]);
    });
  });

  it("keeps a different agent's identical logical session outside cancellation", async () => {
    const state = fixture({ sessionKey: "shared-session" });
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
      admittedRunContext: createTestAdmittedRunContext("alpha"),
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

  it("settles cancellation after disposal before actor admission without setup", async () => {
    const state = fixture();
    await disposeAcpSessionManagerInstance(state.manager, "shutdown");
    const { turn, events } = state.startTurn("disposed");
    await turn;
    expect(state.ensureSession).not.toHaveBeenCalled();
    expect(state.runTurn).not.toHaveBeenCalled();
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
    const { turn, events } = state.startTurn("failed");
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
});
