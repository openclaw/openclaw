import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { getCurrentSessionControllerOwner as currentOwner } from "../sessions/session-controller.context.js";
import {
  agentCommand,
  compactionTestRuntime as runtime,
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";

afterEach(() => clearRuntimeConfigSnapshot());

registerAgentCommandCompactionTestHooks();

beforeEach(() => setRuntimeConfigSnapshot(expectDefined(state.cfg, "compaction fixture config")));

type Owner = NonNullable<ReturnType<typeof currentOwner>>;
const identity = { sessionId: "outer", sessionKey: "agent:main:explicit:outer" };
const commandOptions = { ...identity, message: "test" };
const result = (sessionId: string) =>
  makeCompactionResult({ sessionId, text: "done", runner: "embedded" });

async function withCommandTarget(run: (owner: Owner) => Promise<void>) {
  const target = { ...identity, agentId: "main", storePath: requireCompactionStorePath() };
  await runtime.replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  return withSessionTurn(target, (operation) =>
    run(expectDefined(operation, "outer command owner")),
  );
}

it.each(["owned", "detached"] as const)("scopes %s command identity", async (ownership) => {
  const reportedId = "reported";
  const onSessionIdChanged = vi.fn();

  await withCommandTarget(async (outer) => {
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      expect(currentOwner()).toBe(ownership === "owned" ? outer : undefined);
      params.opts.onSessionIdChanged?.(reportedId);
      return result(params.sessionId);
    });

    await agentCommand({
      ...commandOptions,
      ...(ownership === "detached" ? { sessionEffects: "internal" as const } : {}),
      onSessionIdChanged,
    });

    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(onSessionIdChanged).toHaveBeenCalledExactlyOnceWith(reportedId);
    expect(currentOwner()).toBe(outer);
    expect(outer.sessionId).toBe(ownership === "owned" ? reportedId : identity.sessionId);
    expect(outer.hasOwnedSessionId(reportedId)).toBe(ownership === "owned");
    expect(outer).toMatchObject({ abortSignal: { aborted: false }, result: null });
  });
});

it("cancels a nested command without aborting its outer turn", async () => {
  const caller = new AbortController();
  const reason = new Error("nested command cancelled");
  const entered = createDeferred();
  const release = createDeferred();
  let attemptSignal: AbortSignal | undefined;

  await withCommandTarget(async (outer) => {
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      expect(currentOwner()).toBe(outer);
      attemptSignal = params.opts.abortSignal;
      entered.resolve();
      await release.promise;
      attemptSignal?.throwIfAborted();
      return result(params.sessionId);
    });
    const command = agentCommand({ ...commandOptions, abortSignal: caller.signal });
    const outcome = command.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, command, "Runtime did not start");
      caller.abort(reason);
      expect(attemptSignal?.aborted).toBe(true);
      expect(attemptSignal?.reason).toBe(reason);
      expect(outer).toMatchObject({ abortSignal: { aborted: false }, result: null });
      release.resolve();
      expect(await outcome).toBe(reason);
      expect(currentOwner()).toBe(outer);
      expect(outer).toMatchObject({ abortSignal: { aborted: false }, result: null });
    } finally {
      caller.abort(reason);
      release.resolve();
      await outcome;
    }
  });
});
