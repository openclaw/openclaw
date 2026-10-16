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
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import type { AgentCommandOpts } from "./command/types.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery/main-session-recovery-admission.js";
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

  function startOwner(target: ReturnType<typeof createTarget>) {
    return beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [sessionKey, target.sessionId],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
  }

  it.each<{
    name: string;
    target?: Partial<ReturnType<typeof createTarget>> & { previousSessionId?: string };
    before?: Partial<SessionEntry>;
    duringPreparation?: Partial<SessionEntry>;
    explicitSession?: boolean;
  }>([
    {
      name: "interruption appears during preparation",
      before: {},
      duringPreparation: {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      },
    },
    {
      name: "an admitted recovery is still running",
      before: {
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "gateway-generation" }],
        mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 1 },
      },
    },
    {
      name: "freshness rollover still has an interrupted predecessor",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "session-2" },
      before: {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      },
    },
    {
      name: "an explicit replacement still has an interrupted predecessor",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "fresh-session" },
      before: {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      },
      explicitSession: true,
    },
    {
      name: "an explicit session is tombstoned",
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
      name: "a fresh key acquires an interruption during preparation",
      target: { isNewSession: true, sessionId: "fresh-session" },
      duringPreparation: {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      },
    },
  ])("rejects standalone work when $name", async (scenario) => {
    const target = { ...createTarget(), ...scenario.target };
    if (scenario.before) {
      await write(target, {
        sessionId: target.previousSessionId ?? target.sessionId,
        updatedAt: 100,
        ...scenario.before,
      });
    }
    const run = vi.fn();
    await expect(
      execute(target, {
        mode: "reject_uncoordinated",
        opts: (scenario.explicitSession ? { sessionId: target.sessionId } : {}) as AgentCommandOpts,
        prepare: async () => {
          if (scenario.duringPreparation) {
            await write(target, {
              sessionId: target.sessionId,
              updatedAt: 200,
              ...scenario.duringPreparation,
            });
          }
          return target;
        },
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
    expect(read(target)?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("refreshes the prepared working copy after claiming a recovery owner", async () => {
    const base = createTarget();
    const staleEntry: SessionEntry = {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    };
    const target = {
      ...base,
      sessionEntry: { ...staleEntry },
      sessionStore: { [sessionKey]: { ...staleEntry } },
    };
    await write(target, staleEntry);

    await execute(target, {
      opts: { runId: "foreground-run" } as AgentCommandOpts,
      run: async (prepared) => {
        const claims = prepared.sessionEntry.mainRestartRecovery?.foregroundClaims;
        expect(claims?.tokens).toEqual([expect.any(String)]);
        expect(Object.values(claims?.runIdsByClaimId ?? {})).toContain("foreground-run");
        expect(prepared.sessionStore[sessionKey]).toEqual(prepared.sessionEntry);
        const completed: SessionEntry = {
          ...prepared.sessionEntry,
          status: "done",
          abortedLastRun: false,
        };
        await write(target, completed);
      },
    });

    const completed = read(target) as SessionEntry | undefined;
    expect(completed?.abortedLastRun).toBe(false);
    expect(completed?.mainRestartRecovery).toBeUndefined();
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it.each([undefined, "done"] as const)(
    "resumes requester settle from persisted empty recovery (status=%s)",
    async (status) => {
      const target = createTarget();
      await write(target, {
        status,
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      });

      const requesterResult = "The completed subagent result reached the requester.";
      const run = vi.fn(async () => requesterResult);
      await expect(
        execute(target, {
          opts: {
            runId: "settle-turn",
            inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
          } as AgentCommandOpts,
          run,
        }),
      ).resolves.toBe(requesterResult);

      expect(run).toHaveBeenCalledOnce();
      expect(read(target)?.status).toBe(status);
      expect(read(target)?.abortedLastRun).toBe(false);
      expect(read(target)?.mainRestartRecovery).toBeUndefined();
    },
  );

  it("preserves persisted interrupted recovery custody during requester settle", async () => {
    const base = createTarget();
    const interruptedEntry: SessionEntry = {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    };
    const target = { ...base, sessionEntry: { ...interruptedEntry } };
    await write(target, interruptedEntry);

    const run = vi.fn(async (prepared: typeof target) => {
      expect(prepared.sessionEntry.mainRestartRecovery?.foregroundClaims?.tokens).toEqual([
        expect.any(String),
      ]);
      expect(prepared.sessionEntry.abortedLastRun).toBe(true);
      return "The requester settled while recovery custody remained.";
    });
    await expect(
      execute(target, {
        opts: {
          runId: "settle-turn",
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        } as AgentCommandOpts,
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

  it.each<{
    name: string;
    mode: "claim" | "reject_uncoordinated";
    target?: Partial<ReturnType<typeof createTarget>> & { previousSessionId?: string };
    before?: Partial<SessionEntry>;
    duringPreparation?: Partial<SessionEntry>;
    opts?: Partial<AgentCommandOpts>;
    result: string;
  }>([
    {
      name: "cleared interruption",
      mode: "reject_uncoordinated",
      result: "ran",
      before: {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      },
      duringPreparation: { updatedAt: 200 },
    },
    {
      name: "Gateway recovery",
      mode: "claim",
      result: "recovered",
      before: runningRecovery("previous"),
      opts: { mainRestartRecoveryAdmitted: true },
    },
    {
      name: "freshness successor",
      mode: "claim",
      result: "successor",
      target: { isNewSession: true, previousSessionId: "session-1", sessionId: "session-2" },
      before: { updatedAt: 200 },
    },
    {
      name: "explicit fresh session",
      mode: "reject_uncoordinated",
      result: "fresh",
      target: { sessionId: "fresh-session" },
      opts: { sessionId: "fresh-session" },
    },
  ])("admits $name", async ({ target: fields, before, duringPreparation, mode, opts, result }) => {
    const target = { ...createTarget(), ...fields };
    if (before) {
      await write(target, before);
    }
    const run = vi.fn(async () => result);
    await expect(
      execute(target, {
        mode,
        opts: (opts ?? {}) as AgentCommandOpts,
        prepare: async () => {
          if (duringPreparation) {
            await write(target, duringPreparation);
          }
          return target;
        },
        run,
      }),
    ).resolves.toBe(result);
    expect(run).toHaveBeenCalledOnce();
  });

  it("restores a Gateway-admitted recovery when command preparation fails", async () => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await write(target, runningRecovery(lifecycleGeneration));
    const restoredTarget = {
      sessionId: target.sessionId,
      sessionKey,
      storePath: target.storePath,
    };
    const restoreAdmittedRecovery = vi.fn(async () => {
      const entry = read(target) as SessionEntry;
      entry.abortedLastRun = true;
      entry.status = "interrupted";
      await write(target, entry);
      return restoredTarget;
    });
    const run = vi.fn();

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
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
      restoredTarget,
    );
    expect(run).not.toHaveBeenCalled();
    expect(read(target)).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("keeps retrying admitted recovery restoration after immediate store failures", async () => {
    vi.useFakeTimers();
    try {
      const target = createTarget();
      const restoredTarget = {
        sessionId: target.sessionId,
        sessionKey,
        storePath: target.storePath,
      };
      let failures = 0;
      const restoreAdmittedRecovery = vi.fn(async () => {
        if (failures < 3) {
          failures += 1;
          throw new Error("transient session-store failure");
        }
        return restoredTarget;
      });
      const recovery = execute(target, {
        opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
        prepare: async () => {
          throw new Error("model preparation failed");
        },
        restoreAdmittedRecovery,
        run: vi.fn(),
      });
      const rejected = expect(recovery).rejects.toThrow("model preparation failed");

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(restoreAdmittedRecovery).toHaveBeenCalledTimes(3);
      expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
        undefined,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(restoreAdmittedRecovery).toHaveBeenCalledTimes(4);
      expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
        restoredTarget,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["subagent_settle", "before preparation", false],
    ["subagent_settle", "during claim", false],
    ["subagent_announce", "before preparation", false],
    ["subagent_announce", "during claim", false],
    ["subagent_settle", "before preparation", true],
    ["subagent_announce", "before preparation", true],
  ] as const)(
    "keeps a requester %s turn pending when recovery starts %s (same source: %s)",
    async (sourceTool, timing, sameSource) => {
      const target = createTarget();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await write(target, runningRecovery(lifecycleGeneration));
      // This is the production failure, not a mocked admission rejection.
      await expect(
        claimMainSessionRecoveryOwner({
          lifecycleGeneration,
          sessionId: target.sessionId,
          target: { sessionKey, storePath: target.storePath },
        }),
      ).resolves.toEqual({ kind: "invalidated", reason: "state_changed" });
      let owner: Awaited<ReturnType<typeof startOwner>> | undefined;
      const ownerStarted = createDeferred();
      if (timing === "before preparation") {
        owner = await startOwner(target);
        ownerStarted.resolve();
      } else {
        const commit = sessionAccessor.applySessionEntryReplacements;
        vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
          async (params) => {
            owner = await startOwner(target);
            ownerStarted.resolve();
            return await commit(params);
          },
        );
      }
      vi.useFakeTimers();
      const run = vi.fn(async () => "consolidated final");
      const prepare = vi.fn(async () => ({
        ...target,
        sessionEntry: read(target),
        runLease: { release: vi.fn(async () => {}) },
      }));
      let settled = false;
      const wake = execute(target, {
        lifecycleGeneration,
        opts: {
          runId: "settle-turn",
          inputProvenance: { kind: "inter_session", sourceTool },
        } as AgentCommandOpts,
        prepare,
        run,
      }).finally(() => {
        settled = true;
      });
      void wake.catch(() => {});
      try {
        await ownerStarted.promise;
        await vi.advanceTimersByTimeAsync(300_000);
        expect({ settled, executions: run.mock.calls.length }).toEqual({
          settled: false,
          executions: 0,
        });
        await write(target, {
          sessionId: target.sessionId,
          updatedAt: 300,
          status: "done",
          restartRecoveryTerminalRunIds: [sameSource ? "settle-turn" : "another-source"],
        });
        owner!.release();
        if (sameSource) {
          await expect(wake).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
          expect(run).not.toHaveBeenCalled();
        } else {
          await expect(wake).resolves.toBe("consolidated final");
          expect(run).toHaveBeenCalledOnce();
          expect(run).toHaveBeenCalledWith(
            expect.objectContaining({ sessionEntry: expect.objectContaining({ status: "done" }) }),
          );
        }
        for (const result of prepare.mock.results) {
          expect((await result.value).runLease.release).toHaveBeenCalledOnce();
        }
      } finally {
        owner?.release();
        await wake.catch(() => {});
      }
    },
  );

  it("rejects an ordinary claim while a live recovery owner holds the requester", async () => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await write(target, runningRecovery(lifecycleGeneration));
    const owner = await startOwner(target);
    const run = vi.fn();
    try {
      await expect(
        execute(target, {
          lifecycleGeneration,
          opts: { runId: "ordinary-turn" } as AgentCommandOpts,
          prepare: async () => ({ ...target, runLease: { release: vi.fn(async () => {}) } }),
          run,
        }),
      ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      owner.release();
    }
  });

  it.each(
    (
      [
        "cancelled",
        "cancelled during refresh",
        "cancelled during claim",
        "replaced",
        "rerouted",
        "tombstoned",
        "ownerless",
        "generation rotated",
      ] as const
    ).flatMap((outcome) =>
      (["subagent_settle", "subagent_announce"] as const).map(
        (sourceTool) => [outcome, sourceTool] as const,
      ),
    ),
  )("does not execute a %s requester %s turn", async (outcome, sourceTool) => {
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
        : await startOwner(target);
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
    const prepared = createDeferred();
    let preparationCount = 0;
    const release = vi.fn(async () => {});
    const run = vi.fn();
    const wake = execute(target, {
      lifecycleGeneration,
      opts: {
        runId: "settle-turn",
        abortSignal: controller.signal,
        inputProvenance: { kind: "inter_session", sourceTool },
      } as AgentCommandOpts,
      prepare: async () => {
        preparationCount += 1;
        prepared.resolve();
        if (preparationCount > 1 && outcome === "cancelled during refresh") {
          controller.abort();
        }
        return {
          ...target,
          ...(outcome === "rerouted" && preparationCount > 1
            ? { sessionId: "replacement-session" }
            : {}),
          runLease: { release },
        };
      },
      run,
    });
    void wake.catch(() => {});
    try {
      await prepared.promise;
      if (outcome === "cancelled") {
        controller.abort();
        await expect(wake).rejects.toMatchObject({ name: "AbortError" });
      } else {
        if (outcome === "replaced" || outcome === "rerouted") {
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
        owner?.release();
        if (outcome === "cancelled during refresh" || outcome === "cancelled during claim") {
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
      owner?.release();
      controller.abort();
      await wake.catch(() => {});
    }
  });

  it.each(["different predecessor", "actual run"] as const)(
    "binds a transferred recovery lease to its %s",
    async (binding) => {
      const base = createTarget();
      await write(base, {
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
      });
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

  it("invalidates an explicit session replaced during preparation", async () => {
    const target = createTarget();
    await write(target, {});
    const run = vi.fn();

    await expect(
      execute(target, {
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => {
          await write(target, { sessionId: "replacement-session", updatedAt: 200 });
          return target;
        },
        run,
      }),
    ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(run).not.toHaveBeenCalled();
  });
});
