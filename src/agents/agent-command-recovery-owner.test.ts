import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import type { AgentCommandOpts } from "./command/types.js";
import { claimMainSessionRecoveryOwner } from "./main-session-recovery/main-session-recovery-store.js";

const recoveryOwnerMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("./main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget:
    recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget,
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-agent-command-owner-");
const sessionKey = "agent:main:main";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("agent command restart recovery ownership", () => {
  function createTarget() {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    return {
      sessionAgentId: "main",
      isNewSession: false,
      sessionId: "session-1",
      sessionKey,
      storePath,
    };
  }

  async function write(target: ReturnType<typeof createTarget>, entry: Partial<SessionEntry>) {
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 100, ...entry });
  }

  function read(target: ReturnType<typeof createTarget>) {
    return loadSessionEntry(target);
  }

  type Target = ReturnType<typeof createTarget> & { previousSessionId?: string };
  type Scenario = {
    name: string;
    target?: Partial<Target>;
    before?: Partial<SessionEntry>;
    duringPreparation?: Partial<SessionEntry>;
    outcome?: "interrupted" | "changed";
    mode?: "claim";
    explicitSession?: boolean;
    opts?: Partial<AgentCommandOpts>;
  };

  async function prepareScenario(scenario: Scenario, predecessor = false) {
    const target = { ...createTarget(), ...scenario.target };
    if (scenario.before) {
      await write(target, {
        sessionId: (predecessor && target.previousSessionId) || target.sessionId,
        ...scenario.before,
      });
    }
    const prepare = async () => {
      if (scenario.duringPreparation) {
        await write(target, { updatedAt: 200, ...scenario.duringPreparation });
      }
      return target;
    };
    return { target, prepare };
  }

  function leasedPreparation(target: Target) {
    const prepared = createDeferred();
    const release = vi.fn(async () => {});
    const prepare = vi.fn(async () => {
      prepared.resolve();
      return { ...target, runLease: { release } };
    });
    return { prepared, release, prepare };
  }

  function execute<T extends ReturnType<typeof createTarget>>(
    target: T,
    overrides: Partial<Parameters<typeof runWithAgentCommandRecoveryOwner<T, unknown>>[0]> = {},
  ) {
    return runWithAgentCommandRecoveryOwner({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      mode: "claim",
      opts: {} as AgentCommandOpts,
      prepare: async () => target,
      run: async () => "ran",
      ...overrides,
    });
  }

  function runningRecovery(lifecycleGeneration: string): Partial<SessionEntry> {
    return {
      updatedAt: 200,
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
      mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 1 },
    };
  }

  const interrupted = (): Partial<SessionEntry> => ({
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
  });
  const requesterOpts = {
    message: "Settle requester",
    runId: "settle-turn",
    inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
  } as const;

  async function interruptedTarget() {
    const base = createTarget();
    const entry: SessionEntry = { sessionId: base.sessionId, updatedAt: 100, ...interrupted() };
    await write(base, entry);
    return { ...base, sessionEntry: { ...entry }, sessionStore: { [sessionKey]: { ...entry } } };
  }

  function startOwner(target: ReturnType<typeof createTarget>) {
    return createReplyOperation({
      sessionKey,
      sessionId: target.sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: target.storePath,
        sessionKey,
        incarnation: target.sessionId,
        agentId: target.sessionAgentId,
      }),
    });
  }

  it.each<Scenario>([
    {
      name: "rejects an interruption appearing during preparation",
      outcome: "interrupted",
      before: {},
      duringPreparation: interrupted(),
    },
    {
      name: "rejects standalone work during recovery",
      outcome: "interrupted",
      before: runningRecovery("gateway-generation"),
    },
    {
      name: "rejects freshness rollover of an interrupted predecessor",
      outcome: "interrupted",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "session-2" },
      before: interrupted(),
    },
    {
      name: "rejects explicit replacement of an interrupted predecessor",
      outcome: "interrupted",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "fresh-session" },
      before: interrupted(),
      explicitSession: true,
    },
    {
      name: "rejects an explicit tombstoned session",
      outcome: "interrupted",
      before: {
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      },
      explicitSession: true,
    },
    {
      name: "rejects interruption acquired by a fresh key during preparation",
      outcome: "interrupted",
      target: { isNewSession: true, sessionId: "fresh-session" },
      duringPreparation: interrupted(),
    },
    {
      name: "invalidates an explicit session replaced during preparation",
      outcome: "changed",
      explicitSession: true,
      before: {},
      duringPreparation: { sessionId: "replacement-session" },
    },
    {
      name: "admits a cleared interruption",
      before: interrupted(),
      duringPreparation: { updatedAt: 200 },
    },
    {
      name: "admits Gateway recovery",
      mode: "claim",
      before: runningRecovery("previous"),
      opts: { mainRestartRecoveryAdmitted: true },
    },
    {
      name: "admits a freshness successor",
      mode: "claim",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "session-2" },
      before: { updatedAt: 200 },
    },
    {
      name: "admits an explicit fresh session",
      target: { sessionId: "fresh-session" },
      explicitSession: true,
    },
  ])("$name", async (scenario) => {
    const { target, prepare } = await prepareScenario(scenario, Boolean(scenario.outcome));
    const run = vi.fn(async () => "ran");
    const result = execute(target, {
      mode: scenario.mode ?? "reject_uncoordinated",
      opts: {
        ...(scenario.explicitSession ? { sessionId: target.sessionId } : {}),
        ...scenario.opts,
      } as AgentCommandOpts,
      prepare,
      run,
    });
    if (scenario.outcome) {
      if (scenario.outcome === "changed") {
        await expect(result).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      } else {
        await expect(result).rejects.toThrow("interrupted work pending restart recovery");
        expect(read(target)?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
      }
      expect(run).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe("ran");
      expect(run).toHaveBeenCalledOnce();
    }
  });

  it("refreshes the prepared working copy after claiming a recovery owner", async () => {
    const target = await interruptedTarget();

    await execute(target, {
      opts: { runId: "foreground-run" } as AgentCommandOpts,
      run: async (prepared) => {
        const claims = prepared.sessionEntry.mainRestartRecovery?.foregroundClaims;
        expect(claims?.tokens).toEqual([expect.any(String)]);
        expect(Object.values(claims?.runIdsByClaimId ?? {})).toContain("foreground-run");
        expect(prepared.sessionStore[sessionKey]).toEqual(prepared.sessionEntry);
        await write(target, { ...prepared.sessionEntry, status: "done", abortedLastRun: false });
      },
    });

    const completed = read(target) as SessionEntry | undefined;
    expect(completed?.abortedLastRun).toBe(false);
    expect(completed?.mainRestartRecovery).toBeUndefined();
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it("resumes requester settle from persisted empty recovery", async () => {
    const target = createTarget();
    await write(target, {
      status: "done",
      abortedLastRun: false,
      restartRecoveryRuns: undefined,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    });

    const requesterResult = "The completed subagent result reached the requester.";
    const run = vi.fn(async () => requesterResult);
    await expect(execute(target, { opts: requesterOpts, run })).resolves.toBe(requesterResult);

    expect(run).toHaveBeenCalledOnce();
    expect(read(target)?.status).toBe("done");
    expect(read(target)?.abortedLastRun).toBe(false);
    expect(read(target)?.mainRestartRecovery).toBeUndefined();
  });

  it("preserves persisted interrupted recovery custody during requester settle", async () => {
    const target = await interruptedTarget();

    const run = vi.fn(async (prepared: typeof target) => {
      expect(prepared.sessionEntry.mainRestartRecovery?.foregroundClaims?.tokens).toEqual([
        expect.any(String),
      ]);
      expect(prepared.sessionEntry.abortedLastRun).toBe(true);
      return "The requester settled while recovery custody remained.";
    });
    await expect(
      execute(target, {
        opts: requesterOpts,
        prepare: async () => ({ ...target, sessionEntry: read(target) ?? target.sessionEntry }),
        run,
      }),
    ).resolves.toBe("The requester settled while recovery custody remained.");

    expect(run).toHaveBeenCalledOnce();
    expect(read(target)).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle-1", chargedAttempts: 0 },
    });
    expect(read(target)?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: target.sessionId,
        sessionKey,
        storePath: target.storePath,
      }),
    );
  });

  it.each([
    { mode: "claim", status: "failed", cleared: true },
    { mode: "reject_uncoordinated", status: "done", cleared: false },
  ] as const)("handles terminal residue in $mode mode", async ({ mode, status, cleared }) => {
    const target = createTarget();
    const restartRecoveryRuns = [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }];
    await write(target, {
      status,
      abortedLastRun: false,
      restartRecoveryRuns,
      restartRecoveryTerminalRunIds: ["stale-run"],
    });
    const run = vi.fn(async () => "ran");
    await expect(execute(target, { mode, run })).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
    const stored = read(target);
    expect(stored).toMatchObject({ status, abortedLastRun: false });
    expect(stored?.restartRecoveryRuns).toEqual(cleared ? undefined : restartRecoveryRuns);
    expect(stored?.mainRestartRecovery).toBeUndefined();
  });

  it.each([false, true])(
    "restores failed command preparation (restoration fails: %s)",
    async (fails) => {
      const target = createTarget();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await write(target, runningRecovery(lifecycleGeneration));
      const restoredTarget = {
        sessionId: target.sessionId,
        sessionKey,
        storePath: target.storePath,
      };
      const restoreAdmittedRecovery = vi.fn(async () => {
        if (fails) {
          throw new Error("transient session-store failure");
        }
        await write(target, { ...read(target), abortedLastRun: true, status: "interrupted" });
        return restoredTarget;
      });
      const run = vi.fn();
      const logs = createWarnLogCapture("openclaw-command-recovery-restore");
      try {
        await expect(
          execute(target, {
            lifecycleGeneration,
            opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
            prepare: async () => {
              throw new Error("model preparation failed");
            },
            restoreAdmittedRecovery,
            run,
          }),
        ).rejects.toThrow("model preparation failed");

        expect(restoreAdmittedRecovery).toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();
        expect(read(target)).toMatchObject(
          fails ? runningRecovery(lifecycleGeneration) : { abortedLastRun: true },
        );
        expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
          fails ? undefined : restoredTarget,
        );
        if (fails) {
          await expect(
            logs.findText("failed to restore admitted recovery after command preparation"),
          ).resolves.toContain("transient session-store failure");
        }
      } finally {
        logs.cleanup();
      }
    },
  );

  it.each([
    ["subagent_settle", false],
    ["subagent_announce", true],
    [undefined, false],
  ] as const)("queues %s behind recovery (already settled: %s)", async (sourceTool, sameSource) => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await write(target, runningRecovery(lifecycleGeneration));
    if (sourceTool === "subagent_settle") {
      await expect(
        claimMainSessionRecoveryOwner({
          lifecycleGeneration,
          sessionId: target.sessionId,
          target,
        }),
      ).resolves.toMatchObject({ kind: "invalidated", reason: "recovery_pending" });
    }
    const owner = startOwner(target);
    const prepared = createDeferred();
    const run = vi.fn(async () => "consolidated final");
    const prepare = vi.fn(async () => {
      prepared.resolve();
      return {
        ...target,
        ...(sourceTool ? { sessionEntry: read(target) } : {}),
        runLease: { release: vi.fn(async () => {}) },
      };
    });
    let settled = false;
    const wake = execute(target, {
      lifecycleGeneration,
      opts: {
        runId: sourceTool ? "settle-turn" : "ordinary-turn",
        ...(sourceTool ? { inputProvenance: { kind: "inter_session", sourceTool } } : {}),
      } as AgentCommandOpts,
      prepare,
      run,
    }).finally(() => {
      settled = true;
    });
    void wake.catch(() => {});
    try {
      await prepared.promise;
      await Promise.resolve();
      expect({ settled, executions: run.mock.calls.length }).toEqual({
        settled: false,
        executions: 0,
      });
      await write(target, {
        status: "done",
        ...(sourceTool
          ? {
              updatedAt: 300,
              restartRecoveryTerminalRunIds: [sameSource ? "settle-turn" : "another-source"],
            }
          : {}),
      });
      owner.complete();
      if (sameSource) {
        await expect(wake).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        expect(run).not.toHaveBeenCalled();
      } else {
        await expect(wake).resolves.toBe("consolidated final");
        expect(run).toHaveBeenCalledOnce();
        if (sourceTool) {
          expect(run).toHaveBeenCalledWith(
            expect.objectContaining({ sessionEntry: expect.objectContaining({ status: "done" }) }),
          );
        }
      }
      for (const result of prepare.mock.results) {
        expect((await result.value).runLease.release).toHaveBeenCalledOnce();
      }
    } finally {
      owner.complete();
      await wake.catch(() => {});
    }
  });

  it.each([
    "cancelled",
    "cancelled during claim",
    "replaced",
    "tombstoned",
    "ownerless",
    "generation rotated",
  ] as const)("does not execute a %s requester turn", async (outcome) => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const entry = { sessionId: target.sessionId, ...runningRecovery(lifecycleGeneration) };
    await write(
      target,
      outcome === "cancelled during claim"
        ? { ...entry, status: "interrupted", abortedLastRun: true }
        : entry,
    );
    const owner =
      outcome === "ownerless" || outcome === "cancelled during claim"
        ? undefined
        : startOwner(target);
    const controller = new AbortController();
    if (outcome === "cancelled during claim") {
      const commit = sessionAccessor.applySessionEntryReplacements;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
        async (params) => {
          const result = await commit(params);
          controller.abort();
          return result;
        },
      );
    }
    const { prepared, release, prepare } = leasedPreparation(target);
    const run = vi.fn();
    const wake = execute(target, {
      lifecycleGeneration,
      opts: {
        runId: "settle-turn",
        abortSignal: controller.signal,
        inputProvenance: requesterOpts.inputProvenance,
      } as AgentCommandOpts,
      prepare,
      run,
    });
    void wake.catch(() => {});
    try {
      await prepared.promise;
      if (outcome === "cancelled") {
        controller.abort();
        await expect(wake).rejects.toMatchObject({ name: "AbortError" });
      } else {
        if (outcome === "replaced") {
          await write(target, { sessionId: "replacement-session", updatedAt: 300 });
        } else if (outcome === "tombstoned") {
          await write(target, {
            ...entry,
            status: "failed",
            mainRestartRecovery: {
              ...entry.mainRestartRecovery!,
              tombstone: { reason: "automatic recovery exhausted" },
            },
          });
        }
        if (outcome === "generation rotated") {
          rotateAgentEventLifecycleGeneration();
        }
        owner?.complete();
        if (outcome === "cancelled during claim") {
          await expect(wake).rejects.toMatchObject({ name: "AbortError" });
        } else if (outcome === "generation rotated") {
          await expect(wake).rejects.toThrow();
        } else {
          await expect(wake).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        }
      }
      expect(run).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      if (outcome === "cancelled during claim") {
        expect(read(target)?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
      }
    } finally {
      owner?.complete();
      controller.abort();
      await wake.catch(() => {});
    }
  });

  it.each(["different predecessor", "actual run"] as const)(
    "binds a transferred recovery lease to its %s",
    async (binding) => {
      const base = createTarget();
      await write(base, interrupted());
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const claim = await claimMainSessionRecoveryOwner({
        lifecycleGeneration,
        sessionId: base.sessionId,
        target: base,
      });
      if (claim.kind !== "claimed") {
        throw new Error("expected recovery owner claim");
      }
      const target =
        binding === "different predecessor"
          ? {
              ...base,
              isNewSession: true,
              previousSessionId: "different-predecessor",
              sessionId: "successor-session",
            }
          : base;
      const run = vi.fn(async () => {
        const entry = read(target);
        expect(entry?.restartRecoveryRuns).toContainEqual({
          lifecycleGeneration,
          runId: "foreground-run",
        });
        expect(entry?.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId).toEqual({
          [claim.lease.claimId]: "foreground-run",
        });
        return "ran";
      });
      const execution = execute(target, {
        lifecycleGeneration,
        opts: {
          mainRestartRecoveryOwnerLease: claim.lease,
          ...(binding === "actual run" ? { runId: "foreground-run" } : {}),
        } as AgentCommandOpts,
        run,
      });
      if (binding === "actual run") {
        await expect(execution).resolves.toBe("ran");
        expect(run).toHaveBeenCalledOnce();
      } else {
        await expect(execution).rejects.toThrow(
          "recovery owner changed during ingress preparation",
        );
        expect(run).not.toHaveBeenCalled();
      }
    },
  );
});
