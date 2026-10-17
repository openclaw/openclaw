import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  resetCommandLane,
} from "../process/command-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { mergeAcceptedSessionSpawnsForRun } from "./accepted-session-spawn.js";
import { closeAdmittedRunDelegatedAuthority } from "./admitted-run-context.js";
import { isSessionPlacementSettlementClosedError } from "./run-termination.js";

const settleRequesterAfterSessionSpawns = vi.hoisted(() =>
  vi
    .fn<
      typeof import("./subagents/registry/subagent-registry.js").settleRequesterAfterSessionSpawns
    >()
    .mockResolvedValue(true),
);
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns,
  markRequesterTurnYielded: vi.fn(async () => 1),
}));

import {
  createTestAdmittedRunContext,
  withTestRunAdmission,
} from "./admitted-run-context.test-support.js";
import { resolveSessionLane } from "./embedded-agent-runner/lanes.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { hasModelFallbackStop, resolveModelFallbackError } from "./failover-error.js";
import {
  captureSessionPlacementCompactionSuccessorAssertion,
  installSessionPlacementAdmissionProvider,
  type SessionPlacementAdmissionProvider,
  withLocalSessionPlacementTurnSettlement as settleLocalTurn,
  withSessionPlacementTurnAdmission as admitTurn,
} from "./session-placement-admission.js";

let uninstallProvider: (() => void) | undefined;
const assertCompactionSuccessorAllowed = () => {};
const executeLocalTurn: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
  _claim,
  runLocal,
) => await runLocal();
const executeTurn: SessionPlacementAdmissionProvider["executeTurn"] = async (
  _claim,
  _params,
  runLocal,
) => await runLocal();
function installProvider(overrides: Partial<SessionPlacementAdmissionProvider> = {}) {
  const uninstall = installSessionPlacementAdmissionProvider({
    assertCompactionSuccessorAllowed,
    executeLocalTurn,
    executeTurn,
    ...overrides,
  });
  uninstallProvider = uninstall;
  return uninstall;
}
const completed = (text?: string): EmbeddedAgentRunResult => ({
  ...(text ? { payloads: [{ text }] } : {}),
  meta: { durationMs: 1 },
});
const acceptedSpawn = (runId = "child-run") => ({
  runId,
  childSessionKey: "agent:main:subagent:child",
  expectsCompletionMessage: true,
});
const yieldedResult = (runId?: string): EmbeddedAgentRunResult => ({
  acceptedSessionSpawns: [acceptedSpawn(runId)],
  meta: { durationMs: 1, yielded: true },
});
function recordSettlement(events: string[]) {
  settleRequesterAfterSessionSpawns.mockImplementation(async () => {
    events.push("settle");
    return true;
  });
}
async function recordTurn<T>(events: string[], task: () => Promise<T>): Promise<T> {
  events.push("claim");
  const result = await task();
  events.push("release");
  return result;
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(() => {
  uninstallProvider?.();
  uninstallProvider = undefined;
  settleRequesterAfterSessionSpawns.mockReset();
  settleRequesterAfterSessionSpawns.mockResolvedValue(true);
  clearRuntimeConfigSnapshot();
});

describe("captured compaction placement owner", () => {
  const params = {
    currentTarget: {
      agentId: "main",
      sessionId: "before",
      sessionKey: "agent:main:turn",
      storePath: "/tmp/agent.sqlite",
    },
    successorSessionId: "after",
  };
  const install = (guard: SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"]) =>
    installProvider({ assertCompactionSuccessorAllowed: guard });

  it("allows standalone acceptance only while its captured absence is unchanged", async () => {
    const assertion = captureSessionPlacementCompactionSuccessorAssertion();
    await Promise.resolve();
    expect(() => assertion(params)).not.toThrow();
  });

  it("rejects a provider replaced after capture without delegating to a new owner", async () => {
    const first = vi.fn();
    const second = vi.fn();
    install(first);
    const assertion = captureSessionPlacementCompactionSuccessorAssertion();
    await Promise.resolve();
    install(second);
    expect(() => assertion(params)).toThrow("session placement owner changed");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("rechecks the captured owner's current placement on every use", async () => {
    const denied = new Error("worker placement cannot rotate its session ID");
    let blocked = false;
    const guard = vi.fn(() => {
      if (blocked) {
        throw denied;
      }
    });
    install(guard);
    const assertion = captureSessionPlacementCompactionSuccessorAssertion();
    assertion(params);
    await Promise.resolve();
    blocked = true;
    expect(() => assertion(params)).toThrow(denied);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledWith(params);
  });
});

describe("local turn placement admission", () => {
  const turnParams = {
    admittedRunContext: createTestAdmittedRunContext("run-1"),
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "test",
    timeoutMs: 1_000,
    runId: "run-1",
  };
  const admit = (sessionId: string, runId: string) =>
    admitTurn({ sessionId, runId }, { ...turnParams, sessionId, runId }, async () => completed());

  it.each(["local CLI", "embedded"])(
    "queues a CLI follow-up until the active %s session turn releases its placement",
    async (runtime) => {
      const activeTurn = createDeferredCore();
      const turnStarted = createDeferredCore();
      const events: string[] = [];
      let active = false;
      const execute: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
        claim,
        task,
      ) => {
        if (active) {
          throw new Error("session already has an active turn claim");
        }
        active = true;
        events.push(`claim:${claim.runId}`);
        try {
          return await task();
        } finally {
          active = false;
          events.push(`release:${claim.runId}`);
        }
      };
      installProvider({
        executeLocalTurn: execute,
        executeTurn: async (claim, _params, task) => execute(claim, task),
      });
      const claim = { sessionId: "busy-session", sessionKey: "agent:main:busy", runId: "parent" };
      const parentTask = async () => {
        turnStarted.resolve();
        await activeTurn.promise;
        return completed("parent done");
      };
      const parent =
        runtime === "local CLI"
          ? settleLocalTurn(claim, parentTask)
          : enqueueCommandInLane("session:agent:main:busy", () =>
              admitTurn(claim, turnParams, parentTask),
            );
      await turnStarted.promise;
      const followup = settleLocalTurn({ ...claim, runId: "completion" }, async () =>
        completed("completion visible"),
      );
      const result = followup.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        activeTurn.resolve();
        await parent;
        expect(await result).toEqual({
          value: { payloads: [{ text: "completion visible" }], meta: { durationMs: 1 } },
        });
        expect(events).toEqual([
          "claim:parent",
          "release:parent",
          "claim:completion",
          "release:completion",
        ]);
      } finally {
        activeTurn.resolve();
        await Promise.allSettled([parent, followup]);
      }
    },
  );

  it.each([
    ["queued", "cancelled"],
    ["queued", "provider replaced"],
    ["queued", "lifecycle retired"],
    ["placement", "cancelled"],
    ["placement", "provider replaced"],
    ["placement", "lifecycle retired"],
  ] as const)("does not execute a %s CLI turn after it is %s", async (stage, change) => {
    const gate = createDeferredCore();
    const started = createDeferredCore();
    const abort = new AbortController();
    const task = vi.fn(async () => completed());
    let claims = 0;
    const provider: SessionPlacementAdmissionProvider = {
      assertCompactionSuccessorAllowed,
      executeLocalTurn: async (_claim, runLocal) => {
        claims += 1;
        if (stage === "placement") {
          started.resolve();
          await gate.promise;
        }
        return runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => runLocal(),
    };
    uninstallProvider = installSessionPlacementAdmissionProvider(provider);
    const blocker =
      stage === "queued"
        ? enqueueCommandInLane("session:agent:main:fenced", async () => {
            started.resolve();
            await gate.promise;
          })
        : undefined;
    if (blocker) {
      await started.promise;
    }
    const run = settleLocalTurn(
      { sessionId: "fenced", sessionKey: "agent:main:fenced", runId: "fenced-run" },
      task,
      { abortSignal: abort.signal },
    );
    const result = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (stage === "placement") {
      await started.promise;
    }
    if (change === "cancelled") {
      abort.abort(new Error("cancelled before admission"));
    } else if (change === "provider replaced") {
      uninstallProvider = installSessionPlacementAdmissionProvider({ ...provider });
    } else {
      rotateAgentEventLifecycleGeneration();
    }
    try {
      if (stage === "queued" && change === "cancelled") {
        expect(getCommandLaneSnapshot(resolveSessionLane("agent:main:fenced"))).toMatchObject({
          activeCount: 1,
          queuedCount: 0,
        });
      } else {
        gate.resolve();
      }
      expect(await result).toMatchObject({
        name: change === "cancelled" ? "Error" : "AbortError",
      });
      expect(task).not.toHaveBeenCalled();
      expect(claims).toBe(stage === "queued" ? 0 : 1);
    } finally {
      gate.resolve();
      await Promise.allSettled([blocker, run]);
    }
  });

  it.each(["embedded", "standalone CLI", "CLI candidate"] as const)(
    "releases placement before settling %s ownership",
    async (runtime) => {
      const embedded = runtime === "embedded";
      const events: string[] = [];
      let activeParams = turnParams;
      recordSettlement(events);
      const task = async () => {
        events.push("turn");
        const result = yieldedResult();
        if (embedded) {
          result.meta.executionTrace = { runner: "cli", attempts: [], fallbackUsed: false };
        }
        return result;
      };
      installProvider({
        executeLocalTurn: (_claim, runLocal) => recordTurn(events, runLocal),
        executeTurn: async (claim, params, runLocal) => {
          expect(claim).toEqual({
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            runId: "run-1",
          });
          expect(params).toEqual({ ...activeParams, abortSignal: expect.any(AbortSignal) });
          return recordTurn(events, runLocal);
        },
      });
      if (embedded) {
        await withTestRunAdmission(turnParams, async (admittedRunContext) => {
          activeParams = { ...turnParams, admittedRunContext };
          const result = await admitTurn(
            { sessionId: "session-1", sessionKey: "agent:main:main", runId: "run-1" },
            activeParams,
            task,
            () => events.push("admitted"),
          );
          expect(result.meta.durationMs).toBe(1);
        });
      } else {
        await settleLocalTurn(
          {
            sessionId: "session-cli",
            sessionKey: "agent:main:cli",
            agentId: "main",
            runId: "run-cli",
          },
          task,
          { isFinalFallbackAttempt: runtime === "CLI candidate" ? false : undefined },
        );
      }
      expect(events).toEqual([
        "claim",
        ...(embedded ? ["admitted"] : []),
        "turn",
        "release",
        ...(runtime === "CLI candidate" ? [] : ["settle"]),
      ]);
    },
  );

  it("does not start a local turn when the provider routes remotely", async () => {
    const turn = vi.fn(async () => completed());
    const onAdmitted = vi.fn();
    const remoteTurn = vi.fn<SessionPlacementAdmissionProvider["executeTurn"]>(
      async (_claim, _params, _runLocal, notifyAdmitted) => {
        notifyAdmitted?.();
        notifyAdmitted?.();
        return {
          payloads: [{ text: "remote" }],
          meta: { durationMs: 2 },
        };
      },
    );
    installProvider({ executeTurn: remoteTurn });

    const result = await admitTurn(
      { sessionId: "session-2", runId: "run-2" },
      { ...turnParams, sessionId: "session-2", runId: "run-2" },
      turn,
      onAdmitted,
    );
    expect(result.payloads).toEqual([{ text: "remote" }]);
    expect(remoteTurn).toHaveBeenCalledOnce();
    expect(remoteTurn.mock.calls[0]?.[0]).toEqual({ sessionId: "session-2", runId: "run-2" });
    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(turn).not.toHaveBeenCalled();
  });

  it("admits once when a provider signals before calling the local turn", async () => {
    const events: string[] = [];
    installProvider({
      executeTurn: async (_claim, _params, runLocal, notifyAdmitted) => {
        notifyAdmitted?.();
        return await runLocal();
      },
    });

    await admitTurn(
      { sessionId: "session-once", runId: "run-once" },
      { ...turnParams, sessionId: "session-once", runId: "run-once" },
      async () => {
        events.push("turn");
        return completed();
      },
      () => events.push("admitted"),
    );

    expect(events).toEqual(["admitted", "turn"]);
  });

  it("does not resurrect a replaced provider during uninstall", async () => {
    const firstClaim = vi.fn(executeTurn);
    const uninstallFirst = installProvider({ executeTurn: firstClaim });
    const secondClaim = vi.fn(executeTurn);
    const uninstallSecond = installProvider({ executeTurn: secondClaim });

    uninstallFirst();
    await admit("session-4", "run-4");
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).toHaveBeenCalledOnce();

    uninstallSecond();
    uninstallProvider = undefined;
    await admit("session-5", "run-5");
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).toHaveBeenCalledOnce();
  });

  it("rejects CLI continuation when settlement fails", async () => {
    settleRequesterAfterSessionSpawns.mockResolvedValueOnce(false);
    const claim = {
      sessionId: "continuation",
      sessionKey: "agent:main:continuation",
      runId: "parent",
    };
    await expect(settleLocalTurn(claim, async () => yieldedResult("child"))).rejects.toThrow(
      "could not transfer terminal delivery",
    );
  });

  it.each([
    { yielded: true, sameInstance: false, pending: false },
    { yielded: false, sameInstance: true, pending: true },
  ])(
    "settles inherited native work after CLI placement ($yielded/$sameInstance/$pending)",
    async ({ yielded, sameInstance, pending }) => {
      const origin = createTestAdmittedRunContext("fallback-parent");
      const admittedRunContext = sameInstance
        ? origin
        : createTestAdmittedRunContext("fallback-parent");
      const accepted = acceptedSpawn("native-child");
      await withTestRunAdmission(
        { admittedRunContext: origin, runId: "fallback-parent" },
        async (originContext) => {
          const destination = sameInstance ? originContext : admittedRunContext;
          await withTestRunAdmission(
            { admittedRunContext: destination, runId: "fallback-parent" },
            async (activeContext) => {
              mergeAcceptedSessionSpawnsForRun(originContext.operationalRunInstance, [accepted]);
              const result = await settleLocalTurn(
                {
                  sessionId: "fallback-session",
                  sessionKey: "agent:main:fallback",
                  agentId: "main",
                  runId: "fallback-parent",
                },
                async () => ({
                  meta: {
                    durationMs: 1,
                    yielded,
                    ...(pending ? { continuationPending: true as const } : {}),
                  },
                }),
                { admittedRunContext: activeContext },
              );
              if (sameInstance) {
                expect(result.acceptedSessionSpawns).toEqual([accepted]);
              }
              expect(settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
              expect(result.requesterContinuationSettled).toBeUndefined();
            },
          );
        },
      );
    },
  );

  it("rejects a CLI handoff when its admitted owner closes during execution", async () => {
    const runId = "revoked-cli-parent";
    await withTestRunAdmission(
      { admittedRunContext: createTestAdmittedRunContext(runId), runId },
      async (admittedRunContext) => {
        await expect(
          settleLocalTurn(
            { sessionId: runId, sessionKey: "agent:main:revoked-cli", runId },
            async () => {
              closeAdmittedRunDelegatedAuthority(admittedRunContext);
              return yieldedResult("child");
            },
            { admittedRunContext },
          ),
        ).rejects.toThrow("admitted run authority is no longer active");
        expect(settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["settled", "reset-with-successor"] as const)(
    "closes a standalone CLI settlement assertion after its lane task is %s",
    async (ending) => {
      const sessionId = `standalone-${ending}`;
      const started = createDeferredCore();
      const release = createDeferredCore();
      let retained: (() => void) | undefined;
      const running = settleLocalTurn({ sessionId, runId: sessionId }, async (assertCurrent) => {
        retained = assertCurrent;
        assertCurrent();
        started.resolve();
        await release.promise;
        return completed();
      });
      await started.promise;
      try {
        if (ending !== "settled") {
          expect(resetCommandLane(resolveSessionLane(sessionId))).toBe(1);
          await settleLocalTurn(
            { sessionId, runId: `${sessionId}-replacement` },
            async (assertCurrent) => {
              assertCurrent();
              return completed();
            },
          );
        } else {
          release.resolve();
          await running;
        }
        expect(retained).toBeDefined();
        let thrownError: unknown;
        try {
          retained?.();
        } catch (err) {
          thrownError = err;
        }
        expect(thrownError).toBeDefined();
        expect(isSessionPlacementSettlementClosedError(thrownError)).toBe(true);
        expect(hasModelFallbackStop(thrownError)).toBe(true);
        expect(resolveModelFallbackError(thrownError)).toEqual({
          kind: "terminal",
          error: thrownError,
        });
        expect(thrownError).toMatchObject({
          code: "SESSION_PLACEMENT_TURN_SETTLEMENT_CLOSED",
          message: "session placement turn settlement is closed",
          name: "AbortError",
        });
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});
