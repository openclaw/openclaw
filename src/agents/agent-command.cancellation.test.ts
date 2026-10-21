import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.context.js";
import {
  agentCommand,
  compactionTestRuntime,
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

afterEach(() => clearRuntimeConfigSnapshot());

registerAgentCommandCompactionTestHooks();

beforeEach(() => {
  setRuntimeConfigSnapshot(expectDefined(state.cfg, "compaction fixture config"));
});

async function createCommandTarget() {
  const target = {
    agentId: "main",
    sessionId: "outer-command-identity",
    sessionKey: "agent:main:explicit:outer-command-identity",
    storePath: requireCompactionStorePath(),
  };
  await compactionTestRuntime.replaceSessionEntry(target, {
    sessionId: target.sessionId,
    updatedAt: Date.now(),
  });
  return target;
}

it.each(["owned", "detached"] as const)(
  "reports %s command identity changes only to its admitted owner",
  async (ownership) => {
    const target = await createCommandTarget();
    const reportedId = "reported-command-identity";
    const onSessionIdChanged = vi.fn();

    await withSessionTurn(target, async (operation) => {
      const outer = expectDefined(operation, "outer command owner");
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        expect(getCurrentSessionControllerOwner()).toBe(ownership === "owned" ? outer : undefined);
        params.opts.onSessionIdChanged?.(reportedId);
        return makeCompactionResult({
          sessionId: params.sessionId,
          text: "Synthetic command result",
          runner: "embedded",
        });
      });

      await agentCommand({
        message: "Report the command identity",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        ...(ownership === "detached" ? { sessionEffects: "internal" as const } : {}),
        onSessionIdChanged,
      });

      expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
      expect(onSessionIdChanged).toHaveBeenCalledExactlyOnceWith(reportedId);
      expect(getCurrentSessionControllerOwner()).toBe(outer);
      expect(outer.sessionId).toBe(ownership === "owned" ? reportedId : target.sessionId);
      expect(outer.hasOwnedSessionId(reportedId)).toBe(ownership === "owned");
      expect(outer.abortSignal.aborted).toBe(false);
      expect(outer.result).toBeNull();
    });
  },
);

it("cancels a nested command without cancelling the borrowed outer turn", async () => {
  const target = await createCommandTarget();
  const caller = new AbortController();
  const reason = new Error("nested command cancelled");
  const entered = createDeferred();
  const release = createDeferred();
  let attemptSignal: AbortSignal | undefined;

  await withSessionTurn(target, async (operation) => {
    const outer = expectDefined(operation, "outer command owner");
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      expect(getCurrentSessionControllerOwner()).toBe(outer);
      attemptSignal = params.opts.abortSignal;
      entered.resolve();
      await release.promise;
      attemptSignal?.throwIfAborted();
      return makeCompactionResult({
        sessionId: params.sessionId,
        text: "Synthetic command result",
        runner: "embedded",
      });
    });
    const command = agentCommand({
      message: "Run until cancelled",
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      abortSignal: caller.signal,
    });
    const outcome = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        command,
        "Command never reached its runtime",
      );
      caller.abort(reason);
      expect(attemptSignal?.aborted).toBe(true);
      expect(attemptSignal?.reason).toBe(reason);
      expect(outer.abortSignal.aborted).toBe(false);
      expect(outer.result).toBeNull();
      release.resolve();
      expect(await outcome).toBe(reason);
      expect(getCurrentSessionControllerOwner()).toBe(outer);
      expect(outer.abortSignal.aborted).toBe(false);
      expect(outer.result).toBeNull();
    } finally {
      caller.abort(reason);
      release.resolve();
      await outcome;
    }
  });
});
