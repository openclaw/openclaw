import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
} from "../../config/sessions/session-accessor.js";
import { admitAgentRestartRecovery } from "../../gateway/agent-turn/agent-run-recovery-admission.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
  inspectMainSessionRecoveryRequired,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "./main-session-recovery-store.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery-runtime.js";

const sessionKey = "agent:main:main";
const executionIdentity = (runId: string) => ({
  tokenVersion: 1 as const,
  contextId: `context-${runId}`,
  executionId: `execution-${runId}`,
  runId,
  createdAt: 1,
});
const enabledExecutionIdentity = (runId: string) => ({
  state: "enabled" as const,
  token: executionIdentity(runId),
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("main session recovery store", () => {
  let dir: string;
  let lifecycleGeneration: string;
  let storePath: string;

  beforeEach(() => {
    dir = tempDirs.make("openclaw-main-recovery-store-");
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    storePath = path.join(dir, "sessions.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSessionStateForTest({ stateDir: dir });
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(): SessionEntry {
    return sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  }

  function readStore(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ sessionKey: key, entry }) => [key, entry]),
    );
  }

  async function seedExact(entries: Record<string, SessionEntry>): Promise<void> {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: Object.entries(entries).map(([key, entry]) => ({ sessionKey: key, entry })),
      skipMaintenance: true,
    });
  }

  function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
      ...overrides,
    };
  }

  type ClaimParams = Parameters<typeof claimMainSessionRecoveryOwner>[0];
  type CommitParams = Parameters<typeof commitMainSessionRecovery>[0];

  function commitRecovery(
    command: CommitParams["command"],
    options: Omit<CommitParams, "command" | "target"> = {},
  ) {
    return commitMainSessionRecovery({ command, target: { sessionKey, storePath }, ...options });
  }

  function claimRecovery(
    overrides: Omit<ClaimParams, "lifecycleGeneration" | "sessionId" | "target"> = {},
  ) {
    return claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
      ...overrides,
    });
  }

  async function reserve(targetSessionKey = sessionKey) {
    const result = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-1",
        executionIdentity: enabledExecutionIdentity("recovery-1"),
      },
      target: { sessionKey: targetSessionKey, storePath },
    });
    if (result.transition.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    return result.transition.reservation;
  }

  it("persists a cycle before returning a legacy interrupted observation", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });

    const result = await commitRecovery(
      {
        kind: "observe",
        cycleId: "cycle-1",
        lifecycleGeneration,
        sessionKey,
      },
      { requireWriteSuccess: true },
    );

    expect(result.transition).toMatchObject({
      kind: "observed",
      view: { status: "recoverable" },
    });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
    });
  });

  it("preserves a concurrent foreground claim while cancelling its reservation", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "foreground-1",
    });

    await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(read().mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: {
        lifecycleGeneration,
        tokens: ["foreground-1"],
      },
    });
  });

  it("transfers a resumed recovery run to one durable lifecycle owner", async () => {
    await write(
      interruptedEntry({
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-old" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 1,
          reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration },
        },
      }),
    );

    const admitted = await commitRecovery({
      kind: "admit_recovery",
      lifecycleGeneration,
      now: 300,
      runId: "recovery-1",
      sessionId: "session-1",
    });

    expect(admitted.transition).toEqual({
      kind: "admitted_recovery",
      admission: {
        cycleId: "cycle-1",
        attempt: 1,
        lifecycleGeneration,
        runId: "recovery-1",
        sessionId: "session-1",
      },
    });
    expect(read().restartRecoveryRuns).toEqual([{ runId: "recovery-1", lifecycleGeneration }]);
    expect(read().abortedLastRun).toBe(false);
  });

  it.each(["recovery-1", "recovery-2"])(
    "does not let delayed restoration interrupt a newer admission of %s",
    async (successorRunId) => {
      await write(
        interruptedEntry({
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryDeliverySourceRunId: "source-1",
        }),
      );
      await reserve();
      const restorePrevious = await admitAgentRestartRecovery({
        lifecycleGeneration,
        runId: "recovery-1",
        sessionId: "session-1",
        sessionKey,
        storePath,
      });
      // Orphan reconciliation can win while the previous admission's cleanup is deferred.
      await commitRecovery({ kind: "mark_interrupted", cycleId: "unused", now: 400 });
      const observed = await commitRecovery({
        kind: "observe",
        cycleId: "unused",
        lifecycleGeneration,
        sessionKey,
      });
      if (
        observed.transition.kind !== "observed" ||
        observed.transition.view.status !== "recoverable"
      ) {
        throw new Error("expected recoverable session");
      }
      await commitRecovery({
        kind: "prepare_attempt",
        attempt: observed.transition.view.nextAttempt,
        lifecycleGeneration,
        now: 500,
        observation: observed.transition.view.observation,
        runId: successorRunId,
        executionIdentity: { state: "disabled" },
      });
      await sessionAccessor.updateSessionEntry({ sessionKey, storePath }, () => ({
        restartRecoveryDeliveryRunId: successorRunId,
      }));
      const restoreSuccessor = await admitAgentRestartRecovery({
        lifecycleGeneration,
        runId: successorRunId,
        sessionId: "session-1",
        sessionKey,
        storePath,
      });
      const admittedSuccessor = read();

      await expect(restorePrevious()).resolves.toBeUndefined();
      expect(read()).toEqual(admittedSuccessor);
      await expect(restoreSuccessor()).resolves.toMatchObject({
        sessionId: "session-1",
        sessionKey,
      });
      expect(read()).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "source-1",
        mainRestartRecovery: { cycleId: "cycle-1", chargedAttempts: 2 },
      });
      expect(read().lifecycleRunId).toBeUndefined();
      expect(read().restartRecoveryDeliveryRunId).toBeUndefined();
    },
  );

  it("retries the exact restored attempt after its committed response is lost", async () => {
    await write(
      interruptedEntry({
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
      }),
    );
    await reserve();
    const restore = await admitAgentRestartRecovery({
      lifecycleGeneration,
      runId: "recovery-1",
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
    const applyReplacements = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
      async (params) => {
        await applyReplacements(params);
        throw new Error("restoration response lost");
      },
    );

    await expect(restore()).rejects.toThrow("restoration response lost");
    await expect(restore()).resolves.toMatchObject({ sessionId: "session-1", sessionKey });
    expect(read()).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliverySourceRunId: "source-1",
      mainRestartRecovery: { cycleId: "cycle-1", chargedAttempts: 1 },
    });
    expect(read().lifecycleRunId).toBeUndefined();
    expect(read().restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("rejects an observation after the session is replaced", async () => {
    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 1,
        chargedAttempts: 0,
      },
    });

    const result = await commitRecovery({
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration,
      now: 400,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "stale-recovery",
      executionIdentity: enabledExecutionIdentity("stale-recovery"),
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "session_replaced" });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not cancel a reservation after its session is replaced", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();

    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });

    const cancelled = await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read()).toMatchObject({
      sessionId: "session-2",
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });
  });

  it("does not let an old reservation survive healthy clear and immediate re-wedge", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitRecovery({ kind: "clear" });
    await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });

    const cancelled = await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      chargedAttempts: 0,
    });
  });

  it("claims the exact foreground row without scanning aliases", async () => {
    await write(interruptedEntry());
    const accessorSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");

    const claim = await claimRecovery();

    expect(claim.kind).toBe("claimed");
    expect(accessorSpy).toHaveBeenCalledOnce();
    expect(accessorSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKeys: [sessionKey] });
  });

  it.each([
    ["claim", false],
    ["inspect", false],
    ["claim", true],
    ["inspect", true],
  ] as const)("%s follows a moved session with lifecycle rotation=%s", async (kind, rotate) => {
    const movedKey = "agent:main:moved";
    const replacement = { sessionId: "replacement", updatedAt: 200 };
    await seedExact({ [movedKey]: interruptedEntry(), [sessionKey]: replacement });
    if (rotate) {
      const replace = sessionAccessor.applySessionEntryReplacements;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
        async (params) => {
          const result = await replace(params);
          rotateAgentEventLifecycleGeneration();
          return result;
        },
      );
    }

    const result =
      kind === "claim"
        ? await claimRecovery()
        : await inspectMainSessionRecoveryRequired({
            expectedSessionId: "session-1",
            lifecycleGeneration,
            target: { sessionKey, storePath },
          });

    expect(result).toMatchObject(
      rotate
        ? { kind: "invalidated", reason: "stale_generation" }
        : kind === "claim"
          ? { kind: "claimed", sessionKey: movedKey }
          : { kind: "required" },
    );
    expect(read()).toMatchObject(replacement);
    const moved = sessionAccessor.loadSessionEntry({ sessionKey: movedKey, storePath });
    expect(Boolean(moved?.mainRestartRecovery?.foregroundClaims)).toBe(kind === "claim" && !rotate);
  });

  it.each([
    "validate_foreground",
    "release_foreground",
    "cancel_reservation",
    "abandon_reservation",
    "admit_recovery",
  ] as const)("%s does not decode unrelated retained payloads", async (kind) => {
    const unrelatedPayload = `unrelated-recovery-payload:${"x".repeat(32 * 1024)}`;
    await seedExact({
      [sessionKey]: interruptedEntry(),
      ...Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `agent:main:retained-${index}`,
          {
            sessionId: `retained-${index}`,
            updatedAt: 100,
            lastHeartbeatText: unrelatedPayload,
          },
        ]),
      ),
    });
    let command: CommitParams["command"];
    if (kind === "validate_foreground" || kind === "release_foreground") {
      const claim = await claimRecovery();
      if (claim.kind !== "claimed") {
        throw new Error("expected foreground owner claim");
      }
      command = { kind, claim: claim.lease };
    } else {
      const reservation = await reserve();
      command =
        kind === "admit_recovery"
          ? {
              kind,
              lifecycleGeneration,
              now: 300,
              runId: reservation.runId,
              sessionId: "session-1",
            }
          : { kind, reservation };
    }
    const parse = vi.spyOn(JSON, "parse");

    const result = await commitRecovery(command);

    expect(result.sessionKey).toBe(sessionKey);
    expect(result.transition.kind).toBe(
      kind === "validate_foreground"
        ? "foreground_validated"
        : kind === "admit_recovery"
          ? "admitted_recovery"
          : "applied",
    );
    expect(parse.mock.calls.filter(([value]) => value.includes(unrelatedPayload))).toHaveLength(0);
  });

  it("refreshes a moved foreground owner and releases it after its session id rotates", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const movedKey = "agent:main:moved";
    await seedExact({
      [movedKey]: read(),
      [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
    });

    expect(await refreshMainSessionRecoveryOwner(claim.lease)).toMatchObject({
      sessionKey: movedKey,
      entry: { sessionId: "session-1" },
    });
    const moved = sessionAccessor.loadSessionEntry({ sessionKey: movedKey, storePath })!;
    await sessionAccessor.replaceSessionEntry(
      { sessionKey: movedKey, storePath },
      { ...moved, sessionId: "session-2" },
    );
    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
    await releaseMainSessionRecoveryOwner(claim.lease);

    expect(
      sessionAccessor.loadSessionEntry({ sessionKey: movedKey, storePath })?.mainRestartRecovery
        ?.foregroundClaims,
    ).toBeUndefined();
    expect(read()).toMatchObject({ sessionId: "replacement" });
  });

  it.each(["admit_recovery", "cancel_reservation", "abandon_reservation"] as const)(
    "%s finds a moved reservation without changing its replacement",
    async (kind) => {
      await write(interruptedEntry());
      const reservation = await reserve();
      const movedKey = "agent:main:moved";
      await seedExact({
        [movedKey]: read(),
        [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
      });

      const command =
        kind === "admit_recovery"
          ? {
              kind,
              lifecycleGeneration,
              now: 300,
              runId: reservation.runId,
              sessionId: reservation.sessionId,
            }
          : { kind, reservation };
      expect(await commitRecovery(command)).toMatchObject({
        sessionKey: movedKey,
        transition: { kind: kind === "admit_recovery" ? "admitted_recovery" : "applied" },
      });
      const state = sessionAccessor.loadSessionEntry({
        sessionKey: movedKey,
        storePath,
      })?.mainRestartRecovery;
      expect(state?.chargedAttempts).toBe(kind === "cancel_reservation" ? 0 : 1);
      expect(state?.reservation).toBeUndefined();
      expect(read()).toMatchObject({ sessionId: "replacement" });
    },
  );

  it("rechecks lifecycle authority after an exact lookup misses a moved owner", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const movedKey = "agent:main:moved";
    await seedExact({
      [movedKey]: read(),
      [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
    });
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
      async (params) => {
        const result = await replace(params);
        rotateAgentEventLifecycleGeneration();
        return result;
      },
    );

    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
    expect(
      sessionAccessor.loadSessionEntry({ sessionKey: movedKey, storePath })?.mainRestartRecovery
        ?.foregroundClaims?.tokens,
    ).toEqual([claim.lease.claimId]);
  });

  it("atomically clears orphaned lifecycle fences from a healthy row", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: false,
    });
    expect(read().restartRecoveryRuns).toBeUndefined();
    expect(read().mainRestartRecovery).toBeUndefined();
  });

  it("atomically clears orphaned recovery residue from a terminal row", async () => {
    await write(
      interruptedEntry({
        status: "failed",
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "failed",
      abortedLastRun: false,
    });
    expect(read().restartRecoveryRuns).toBeUndefined();
    expect(read().mainRestartRecovery).toBeUndefined();
    expect(read().restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("inspects terminal recovery residue as non-blocking before foreground cleanup", async () => {
    const residue = interruptedEntry({
      status: "done",
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
    });
    await write(residue);

    await expect(
      inspectMainSessionRecoveryRequired({
        expectedSessionId: "session-1",
        lifecycleGeneration,
        target: { sessionKey, storePath },
      }),
    ).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      status: "done",
      abortedLastRun: true,
      restartRecoveryRuns: residue.restartRecoveryRuns,
    });
    expect(read().mainRestartRecovery).toBeUndefined();

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({ status: "done", abortedLastRun: false });
    expect(read().restartRecoveryRuns).toBeUndefined();
  });

  it("binds a foreground claim to its lifecycle run", async () => {
    await write(interruptedEntry());

    const claim = await claimRecovery({ runId: "foreground-run" });

    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    expect(read()).toMatchObject({
      restartRecoveryRuns: [{ lifecycleGeneration, runId: "foreground-run" }],
      mainRestartRecovery: {
        foregroundClaims: {
          lifecycleGeneration,
          runIdsByClaimId: { [claim.lease.claimId]: "foreground-run" },
        },
      },
    });
  });

  it("releases an owner after the durable row session id rotates", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const current = read();
    await write({ ...current, sessionId: "session-2" });

    await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();

    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("keeps retrying an exact owner release after immediate store retries fail", async () => {
    vi.useFakeTimers();
    try {
      await write(interruptedEntry());
      const claim = await claimRecovery();
      if (claim.kind !== "claimed") {
        throw new Error("expected foreground owner claim");
      }
      const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
      let failures = 0;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation(
        async (params) => {
          if (failures < 3) {
            failures += 1;
            throw new Error("transient session-store failure");
          }
          return await applySessionEntryReplacements(params);
        },
      );

      const schedulePending = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const immediateRelease = releaseMainSessionRecoveryOwner(claim.lease);
      const immediateReleaseRejected = expect(immediateRelease).rejects.toThrow(
        "transient session-store failure",
      );
      await vi.advanceTimersByTimeAsync(100);
      await immediateReleaseRejected;
      expect(read().mainRestartRecovery?.foregroundClaims?.tokens).toEqual([claim.lease.claimId]);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
      });
      await vi.waitFor(() =>
        expect(schedulePending).toHaveBeenCalledWith({
          sessionId: "session-1",
          sessionKey,
          storePath,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves interrupted non-main rows to their specialized recovery owner", async () => {
    const subagentKey = "agent:main:subagent:child";
    await seedExact({ [subagentKey]: interruptedEntry({ spawnDepth: 1 }) });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey: subagentKey, storePath },
    });

    expect(claim).toEqual({ kind: "not_required" });
    expect(readStore()[subagentKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("does not let a replacement bypass a tombstoned predecessor", async () => {
    await write(
      interruptedEntry({
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    );

    await expect(claimRecovery({ replacementSessionId: "session-2" })).resolves.toEqual({
      kind: "invalidated",
      reason: "state_changed",
    });
  });

  it("does not let foreground work bypass an exhausted predecessor", async () => {
    await write(
      interruptedEntry({
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
        },
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({
      kind: "invalidated",
      reason: "recovery_exhausted",
    });
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("validates a transferred owner against the latest durable row", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }

    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeDefined();
    await releaseMainSessionRecoveryOwner(claim.lease);
    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });

  it("returns a retry target only when the final foreground owner releases", async () => {
    await write(interruptedEntry());
    const first = await claimRecovery();
    const second = await claimRecovery();
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected foreground owner claims");
    }

    await expect(releaseMainSessionRecoveryOwner(first.lease)).resolves.toBeUndefined();
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
  });

  it("retains the shared-store agent owner through claim, refresh, and release", async () => {
    const target = { agentId: "ops", sessionKey: "global", storePath };
    await sessionAccessor.replaceSessionEntry(target, interruptedEntry());

    await expect(
      inspectMainSessionRecoveryRequired({
        expectedSessionId: "session-1",
        lifecycleGeneration,
        target,
      }),
    ).resolves.toEqual({ kind: "required" });
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target,
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") {
      throw new Error("expected shared-store foreground claim");
    }
    await expect(refreshMainSessionRecoveryOwner(claim.lease, "foreground-run")).resolves.toEqual(
      expect.objectContaining({ entry: expect.objectContaining({ sessionId: "session-1" }) }),
    );
    expect(
      sessionAccessor.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims?.tokens,
    ).toEqual([claim.lease.claimId]);

    await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toEqual({
      ...target,
      sessionId: "session-1",
    });
    expect(
      sessionAccessor.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined();
    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });

  it("settles an owned shared-store recovery receipt without redispatching", async () => {
    const target = { agentId: "ops", sessionKey: "global", storePath };
    await sessionAccessor.replaceSessionEntry(
      target,
      interruptedEntry({
        pendingFinalDelivery: {
          kind: "replayable",
          text: "already handled",
          createdAt: 100,
          intentId: "owned-final",
          deliveries: [{ id: "owned-delivery", state: "suppressed" }],
        },
      }),
    );
    const dispatch = vi.fn(async (): Promise<never> => {
      throw new Error("a settled delivery must not dispatch recovery work");
    });

    await expect(
      retryRestartAbortedMainSessionRecovery({
        ...target,
        expectedSessionId: "session-1",
        stateDir: dir,
        cfg: {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {} },
          },
          session: { scope: "global", store: storePath },
        },
        gatewayRuntime: {
          dispatchSessionMethod: dispatch,
          dispatchAgent: dispatch,
          waitForAgent: dispatch,
          sendRecoveryNotice: dispatch,
        },
      }),
    ).resolves.toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
    const completed = sessionAccessor.loadSessionEntry(target);
    expect(completed).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(completed?.pendingFinalDelivery).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not let an old lease release a same-token claim from a new cycle", async () => {
    await write(interruptedEntry());
    const oldClaim = await claimRecovery();
    if (oldClaim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    await commitRecovery({ kind: "clear" });
    await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });
    await commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: oldClaim.lease.claimId,
    });

    await releaseMainSessionRecoveryOwner(oldClaim.lease);

    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: {
        lifecycleGeneration,
        tokens: [oldClaim.lease.claimId],
      },
    });
  });

  it("retries a transient owner release write failure", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("transient writer failure"))
      .mockImplementation(async (params) => await applySessionEntryReplacements(params));

    await releaseMainSessionRecoveryOwner(claim.lease);

    expect(accessorSpy).toHaveBeenCalledTimes(2);
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("rejects an old claimant queued ahead of the current lifecycle generation", async () => {
    await write(interruptedEntry());

    let enterWriter = () => {};
    const writerEntered = new Promise<void>((resolve) => {
      enterWriter = resolve;
    });
    let releaseWriter = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const blocker = sessionAccessor.applySessionEntryReplacements({
      storePath,
      update: async () => {
        enterWriter();
        await writerGate;
        return { result: undefined };
      },
    });
    await writerEntered;

    const staleClaim = commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "stale-owner",
    });
    const staleOwnerClaim = claimRecovery({
      allowMissingSession: true,
      replacementSessionId: "session-2",
    });
    const staleInspection = inspectMainSessionRecoveryRequired({
      expectedSessionId: "session-1",
      lifecycleGeneration,
      target: { sessionKey, storePath },
    });
    await Promise.resolve();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const currentClaim = commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: currentGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "current-owner",
    });
    releaseWriter();

    await blocker;
    expect((await staleClaim).transition).toEqual({
      kind: "rejected",
      reason: "stale_generation",
    });
    await expect(staleOwnerClaim).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    await expect(staleInspection).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    expect((await currentClaim).transition).toMatchObject({
      kind: "foreground_claimed",
      claim: { claimId: "current-owner" },
    });
    expect(read().mainRestartRecovery?.foregroundClaims).toEqual({
      lifecycleGeneration: currentGeneration,
      tokens: ["current-owner"],
    });
  });

  it("rejects a delayed admitted-interruption callback after lifecycle rotation", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );
    rotateAgentEventLifecycleGeneration();

    const result = await commitRecovery({
      kind: "mark_admitted_recovery_interrupted",
      cycleId: "cycle-1",
      attempt: 0,
      lifecycleGeneration,
      now: 300,
      runId: "recovery-1",
      sessionId: "session-1",
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "stale_generation" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: false,
    });
  });

  it("rejects a transferred foreground lease after lifecycle rotation", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    rotateAgentEventLifecycleGeneration();

    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });
});
