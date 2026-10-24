import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
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
import { hasModelFallbackStop, resolveModelFallbackError } from "./failover-error.js";
import {
  captureSessionPlacementCompactionSuccessorAssertion,
  installSessionPlacementAdmissionProvider,
  type SessionPlacementAdmissionProvider,
  type SessionPlacementTurnParams,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";
import type { LocalTurnPlacementClaim } from "./session-placement-admission.types.js";

let uninstallProvider: (() => void) | undefined;
const assertCompactionSuccessorAllowed = () => {};
const executeLocalTurn: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
  _claim,
  runLocal,
) => await runLocal();
const localResult = () => ({ meta: { durationMs: 1 } });
const acceptedSpawn = (runId = "child") => ({
  runId,
  childSessionKey: "agent:main:subagent:child",
  expectsCompletionMessage: true,
});
function installProvider(overrides: Partial<SessionPlacementAdmissionProvider>) {
  uninstallProvider = installSessionPlacementAdmissionProvider({
    assertCompactionSuccessorAllowed,
    executeLocalTurn,
    executeTurn: async (_claim, _params, runLocal) => runLocal(),
    ...overrides,
  });
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
  const install = (
    guard: SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"],
  ) => {
    installProvider({
      assertCompactionSuccessorAllowed: guard,
    });
  };

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
    withSessionPlacementTurnAdmission(
      { sessionId, runId },
      { ...turnParams, sessionId, runId },
      async () => localResult(),
    );

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
        return { payloads: [{ text: "parent done" }], meta: { durationMs: 1 } };
      };
      const parent =
        runtime === "local CLI"
          ? withLocalSessionPlacementTurnSettlement(claim, parentTask)
          : withSessionTurn(claim, () =>
              withSessionPlacementTurnAdmission(
                claim,
                { ...turnParams, admittedRunContext: undefined },
                parentTask,
              ),
            );
      await turnStarted.promise;
      const followup = withLocalSessionPlacementTurnSettlement(
        { ...claim, runId: "completion" },
        async () => ({ payloads: [{ text: "completion visible" }], meta: { durationMs: 1 } }),
      );
      const result = followup.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        activeTurn.resolve();
        await parent;
        expect(await result).toEqual({
          value: {
            payloads: [{ text: "completion visible" }],
            meta: { durationMs: 1 },
          },
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
    const task = vi.fn(async () => ({ meta: { durationMs: 1 } }));
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
        ? withSessionTurn({ sessionKey: "agent:main:fenced", sessionId: "fenced" }, async () => {
            started.resolve();
            await gate.promise;
          })
        : undefined;
    if (blocker) {
      await started.promise;
    }
    const run = withLocalSessionPlacementTurnSettlement(
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
        const mailbox = getExistingSessionControllerMailbox("agent:main:fenced");
        expect(mailbox?.claim).toBeDefined();
        expect(mailbox?.entries.filter((input) => input.phase === "waiting")).toHaveLength(0);
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

  it("delegates the final turn decision to the installed provider", async () => {
    await withTestRunAdmission(turnParams, async (admittedRunContext) => {
      const activeParams = { ...turnParams, admittedRunContext };
      const events: string[] = [];
      settleRequesterAfterSessionSpawns.mockImplementation(async () => {
        events.push("settle");
        return true;
      });
      installProvider({
        executeTurn: async (claim, params, runLocal) => {
          events.push("claim");
          expect(claim).toEqual({
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            runId: "run-1",
          });
          const replyOperation = getCurrentSessionControllerOwner();
          expect(replyOperation).toBeDefined();
          expect(params.replyOperation).toBe(replyOperation);
          expect(params).toEqual({
            ...activeParams,
            replyOperation,
            abortSignal: expect.any(AbortSignal),
          });
          const result = await runLocal();
          events.push("release");
          return result;
        },
      });

      const result = await withSessionPlacementTurnAdmission(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          runId: "run-1",
        },
        activeParams,
        async () => {
          events.push("turn");
          return {
            acceptedSessionSpawns: [acceptedSpawn("child-run")],
            meta: {
              durationMs: 1,
              yielded: true,
              executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
            },
          };
        },
        () => events.push("admitted"),
      );

      expect(result.meta.durationMs).toBe(1);
      expect(events).toEqual(["claim", "admitted", "turn", "release", "settle"]);
    });
  });

  it.each(["completes", "rejects"] as const)(
    "passes provider-prepared input to the hosted task and restores it when the task %s",
    async (outcome) => {
      const caller: SessionPlacementTurnParams = {
        ...turnParams,
        admittedRunContext: undefined,
        sessionKey: "agent:main:prepared-local",
        transcriptPrompt: "original transcript",
        abortSignal: new AbortController().signal,
        sessionTarget: { storePath: "/tmp/prepared-local.sqlite", sessionId: "session-1" },
      };
      const original = { ...caller };
      const preparedTarget = { ...caller.sessionTarget, expectedWriterRunId: caller.runId };
      let admittedTurn: SessionPlacementTurnParams | undefined;
      const failure = new Error("local execution failed");
      installProvider({
        executeTurn: async (_claim, admitted, runLocal) => {
          admittedTurn = admitted;
          admitted.prompt = "test with prepared attachment paths";
          admitted.transcriptPrompt = "prepared transcript";
          admitted.sessionTarget = preparedTarget;
          try {
            return await runLocal();
          } finally {
            expect(caller).toStrictEqual(original);
            expect(admitted.prompt).toBe("test with prepared attachment paths");
            expect(admitted.sessionTarget).toBe(preparedTarget);
          }
        },
      });
      const run = withSessionPlacementTurnAdmission(
        { sessionId: caller.sessionId, sessionKey: caller.sessionKey, runId: caller.runId },
        caller,
        async (signal) => {
          expect(caller).toMatchObject({
            prompt: "test with prepared attachment paths",
            transcriptPrompt: "prepared transcript",
          });
          expect(caller.sessionTarget).toBe(preparedTarget);
          expect(caller.replyOperation).toBeDefined();
          expect(caller.replyOperation).toBe(admittedTurn?.replyOperation);
          expect(caller.replyOperation).toBe(getCurrentSessionControllerOwner());
          expect(caller.abortSignal).toBe(signal);
          if (outcome === "rejects") {
            throw failure;
          }
          return { meta: { durationMs: 1 } };
        },
      );
      if (outcome === "rejects") {
        await expect(run).rejects.toBe(failure);
      } else {
        await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
      }
    },
  );

  it("does not start a local turn when the provider routes remotely", async () => {
    const turn = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn();
    const executeTurn = vi.fn<SessionPlacementAdmissionProvider["executeTurn"]>(
      async (_claim, _params, _runLocal, admitTurn) => {
        admitTurn?.();
        admitTurn?.();
        return {
          payloads: [{ text: "remote" }],
          meta: { durationMs: 2 },
        };
      },
    );
    installProvider({ executeTurn });

    const result = await withSessionPlacementTurnAdmission(
      { sessionId: "session-2", runId: "run-2" },
      { ...turnParams, sessionId: "session-2", runId: "run-2" },
      turn,
      onAdmitted,
    );
    expect(result.payloads).toEqual([{ text: "remote" }]);
    expect(executeTurn).toHaveBeenCalledOnce();
    expect(executeTurn.mock.calls[0]?.[0]).toEqual({ sessionId: "session-2", runId: "run-2" });
    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(turn).not.toHaveBeenCalled();
  });

  it("admits once when a provider signals before calling the local turn", async () => {
    const events: string[] = [];
    installProvider({
      executeTurn: async (_claim, _params, runLocal, admitTurn) => {
        admitTurn?.();
        return await runLocal();
      },
    });

    await withSessionPlacementTurnAdmission(
      { sessionId: "session-once", runId: "run-once" },
      { ...turnParams, sessionId: "session-once", runId: "run-once" },
      async () => {
        events.push("turn");
        return localResult();
      },
      () => events.push("admitted"),
    );

    expect(events).toEqual(["admitted", "turn"]);
  });

  it("does not resurrect a replaced provider during uninstall", async () => {
    const runLocal: SessionPlacementAdmissionProvider["executeTurn"] = async (
      _claim,
      _params,
      run,
    ) => run();
    const firstClaim = vi.fn(runLocal);
    const uninstallFirst = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: firstClaim,
    });
    const secondClaim = vi.fn(runLocal);
    const uninstallSecond = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: secondClaim,
    });
    uninstallProvider = uninstallSecond;

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

  it("rejects a CLI continuation whose settlement fails", async () => {
    settleRequesterAfterSessionSpawns.mockResolvedValueOnce(false);
    const claim = {
      sessionId: "continuation",
      sessionKey: "agent:main:continuation",
      runId: "parent",
    };
    const run = () =>
      withLocalSessionPlacementTurnSettlement(claim, async () => ({
        acceptedSessionSpawns: [acceptedSpawn()],
        meta: { durationMs: 1, yielded: true },
      }));
    await expect(run()).rejects.toThrow("could not transfer terminal delivery");
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
              const result = await withLocalSessionPlacementTurnSettlement(
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
          withLocalSessionPlacementTurnSettlement(
            { sessionId: runId, sessionKey: "agent:main:revoked-cli", runId },
            async () => {
              closeAdmittedRunDelegatedAuthority(admittedRunContext);
              return {
                acceptedSessionSpawns: [acceptedSpawn()],
                meta: { durationMs: 1, yielded: true },
              };
            },
            { admittedRunContext },
          ),
        ).rejects.toThrow("admitted run authority is no longer active");
        expect(settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
      },
    );
  });

  it.each([undefined, false])(
    "settles only standalone CLI ownership after placement releases (candidate marker=%s)",
    async (isFinalFallbackAttempt) => {
      const events: string[] = [];
      settleRequesterAfterSessionSpawns.mockImplementation(async () => {
        events.push("settle");
        return true;
      });
      installProvider({
        async executeLocalTurn<T>(
          _claim: LocalTurnPlacementClaim,
          runLocal: () => Promise<T>,
        ): Promise<T> {
          events.push("claim");
          const result = await runLocal();
          events.push("release");
          return result;
        },
      });

      await withLocalSessionPlacementTurnSettlement(
        {
          sessionId: "session-cli",
          sessionKey: "agent:main:cli",
          agentId: "main",
          runId: "run-cli",
        },
        async () => {
          events.push("turn");
          return {
            acceptedSessionSpawns: [acceptedSpawn("child-run")],
            meta: { durationMs: 1, yielded: true },
          };
        },
        { isFinalFallbackAttempt },
      );

      expect(events).toEqual([
        "claim",
        "turn",
        "release",
        ...(isFinalFallbackAttempt === undefined ? ["settle"] : []),
      ]);
    },
  );

  it.each(["settled", "cancelled-without-successor", "cancelled-with-successor"] as const)(
    "closes a captured CLI settlement assertion after its controller turn is %s",
    async (ending) => {
      const sessionId = `standalone-${ending}`;
      const started = createDeferredCore();
      const release = createDeferredCore();
      const sessionKey = `agent:main:${sessionId}`;
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      let retained: (() => void) | undefined;
      const running = withLocalSessionPlacementTurnSettlement(
        { sessionId, sessionKey, runId: sessionId },
        async (assertCurrent) => {
          operation = getCurrentSessionControllerOwner();
          retained = assertCurrent;
          assertCurrent();
          started.resolve();
          await release.promise;
          return { meta: { durationMs: 1 } };
        },
      );
      await started.promise;
      try {
        if (ending !== "settled") {
          expect(operation?.abortByUser()).toBe(true);
          if (ending === "cancelled-with-successor") {
            const successor = withLocalSessionPlacementTurnSettlement(
              { sessionId, sessionKey, runId: `${sessionId}-replacement` },
              async (assertCurrent) => {
                assertCurrent();
                return { meta: { durationMs: 1 } };
              },
            );
            release.resolve();
            await running.catch(() => {});
            await successor;
          }
        } else {
          release.resolve();
          await running;
        }
        expect(retained).toBeDefined();
        if (ending === "cancelled-without-successor") {
          expect(() => retained?.()).not.toThrow();
          release.resolve();
          await running.catch(() => {});
        }
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
        await running.catch(() => {});
      }
    },
  );
});
