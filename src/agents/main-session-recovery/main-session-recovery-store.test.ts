import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
  inspectMainSessionRecoveryRequired,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "./main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "./main-session-recovery-store.test-support.js";
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
describe("main session recovery store", () => {
  let lifecycleGeneration: string;
  let storePath: string;
  const { fixtureStore, createMovedSessionStore, resetCase } =
    createMainSessionRecoveryStoreFixture();

  function useIsolatedMovedSessionStore(): void {
    storePath = createMovedSessionStore();
  }

  beforeEach(() => {
    storePath = fixtureStore();
    lifecycleGeneration = getAgentEventLifecycleGeneration();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCase();
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
      status: "interrupted",
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

  function rotateLifecycleBeforeRecoveryUpdate(): void {
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce((params) =>
      replace({
        ...params,
        update: (entries) => {
          rotateAgentEventLifecycleGeneration();
          return params.update(entries);
        },
      }),
    );
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

  async function claimedRecovery() {
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    return claim;
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

  it.each(["interrupted", "killed"] as const)(
    "does not infer recovery authority from a %s outcome",
    async (status) => {
      const entry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        status,
        abortedLastRun: true,
      };
      if (status === "killed") {
        const running = {
          ...entry,
          abortedLastRun: false,
          restartRecoveryRuns: [{ runId: "stopped-run", lifecycleGeneration }],
        };
        const stop = projectMainSessionRecoveryLifecycle({
          entry: running,
          currentLifecycleGeneration: lifecycleGeneration,
          event: {
            runId: "stopped-run",
            lifecycleGeneration,
            data: { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
          },
          snapshotPatch: { status: "killed", abortedLastRun: true },
        });
        expect(stop.action).toBe("apply");
        if (stop.action !== "apply") {
          throw new Error("Stop must settle its current owner");
        }
        Object.assign(entry, running, stop.patch);
      }
      await write(entry);
      expect(read().restartRecoveryRuns).toBeUndefined();
      await expect(claimRecovery({ runId: "follow-up" })).resolves.toEqual({
        kind: "not_required",
        entry: read(),
        sessionKey,
      });
      expect(read()).toMatchObject({ status, abortedLastRun: true });

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
        view: { status: "inactive" },
      });
      expect(read().mainRestartRecovery).toBeUndefined();
    },
  );

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
      status: "interrupted",
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

  it.each(["replacement", "new cycle"] as const)(
    "does not cancel a stale reservation after %s",
    async (change) => {
      await write(interruptedEntry());
      const reservation = await reserve();
      if (change === "replacement") {
        await write(
          interruptedEntry({
            sessionId: "session-2",
            updatedAt: 300,
            mainRestartRecovery: { cycleId: "cycle-2", revision: 4, chargedAttempts: 2 },
          }),
        );
      } else {
        await commitRecovery({ kind: "clear" });
        await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });
      }
      const cancelled = await commitRecovery({ kind: "cancel_reservation", reservation });
      expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
      expect(read()).toMatchObject({
        sessionId: change === "replacement" ? "session-2" : "session-1",
        mainRestartRecovery: {
          cycleId: "cycle-2",
          revision: change === "replacement" ? 4 : 1,
          chargedAttempts: change === "replacement" ? 2 : 0,
        },
      });
    },
  );

  it.each([
    ["claim", false],
    ["inspect", false],
    ["claim", true],
    ["inspect", true],
  ] as const)("%s follows a moved session with lifecycle rotation=%s", async (kind, rotate) => {
    useIsolatedMovedSessionStore();
    const movedKey = "agent:main:moved";
    const replacement = { sessionId: "replacement", updatedAt: 200 };
    await seedExact({ [movedKey]: interruptedEntry(), [sessionKey]: replacement });
    if (rotate) {
      rotateLifecycleBeforeRecoveryUpdate();
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
  ] as const)(
    "%s keeps live and settled lookups independent of unrelated payloads",
    async (kind) => {
      const unrelatedPayload = `unrelated-recovery-payload:${"x".repeat(32 * 1024)}`;
      // These rows exercise point reads, so automatic retention must not age them out.
      const retainedUpdatedAt = Date.now();
      await seedExact({
        [sessionKey]: interruptedEntry(),
        ...Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [
            `agent:main:retained-${index}`,
            {
              sessionId: `retained-${index}`,
              updatedAt: retainedUpdatedAt,
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
      const unrelatedPayloads: string[] = [];
      const replace = sessionAccessor.applySessionEntryReplacements;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) =>
        replace({
          ...params,
          update: (entries) => {
            // Observe the real snapshot after worker decoding, before recovery selects its owner.
            unrelatedPayloads.push(
              ...entries.flatMap(({ entry }) =>
                entry.lastHeartbeatText === unrelatedPayload ? [entry.lastHeartbeatText] : [],
              ),
            );
            return params.update(entries);
          },
        }),
      );

      const result = await commitRecovery(command);

      expect(result.sessionKey).toBe(sessionKey);
      expect(result.transition.kind).toBe(
        kind === "validate_foreground"
          ? "foreground_validated"
          : kind === "admit_recovery"
            ? "admitted_recovery"
            : "applied",
      );
      expect(unrelatedPayloads).toHaveLength(0);
      if (command.kind === "validate_foreground") {
        await commitRecovery({ kind: "release_foreground", claim: command.claim });
      }
      const settled = read();

      const repeated = await commitRecovery(command);

      expect(repeated.transition).toEqual(
        kind === "validate_foreground" || kind === "release_foreground"
          ? { kind: "no_change" }
          : {
              kind: "rejected",
              reason: kind === "admit_recovery" ? "not_interrupted" : "stale_reservation",
            },
      );
      expect(read()).toEqual(settled);
      expect(unrelatedPayloads).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "refreshes and releases an owner after session rotation (moved=%s)",
    async (moved) => {
      if (moved) {
        useIsolatedMovedSessionStore();
      }
      await write(interruptedEntry());
      const claim = await claimedRecovery();
      const ownerKey = moved ? "agent:main:moved" : sessionKey;
      if (moved) {
        await seedExact({
          [ownerKey]: read(),
          [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
        });
      }
      expect(await refreshMainSessionRecoveryOwner(claim.lease)).toMatchObject({
        sessionKey: ownerKey,
        entry: { sessionId: "session-1" },
      });
      const target = { sessionKey: ownerKey, storePath };
      await sessionAccessor.updateSessionEntry(target, () => ({ sessionId: "session-2" }));
      await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
      await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
      expect(
        sessionAccessor.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims,
      ).toBeUndefined();
      if (moved) {
        expect(read()).toMatchObject({ sessionId: "replacement" });
      }
    },
  );

  it.each(["admit_recovery", "cancel_reservation", "abandon_reservation"] as const)(
    "%s finds a moved reservation without changing its replacement",
    async (kind) => {
      useIsolatedMovedSessionStore();
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

  it.each([false, true])(
    "rejects a foreground lease after lifecycle rotation (moved=%s)",
    async (moved) => {
      if (moved) {
        useIsolatedMovedSessionStore();
      }
      await write(interruptedEntry());
      const claim = await claimedRecovery();
      const ownerKey = moved ? "agent:main:moved" : sessionKey;
      if (moved) {
        await seedExact({
          [ownerKey]: read(),
          [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
        });
        rotateLifecycleBeforeRecoveryUpdate();
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
      expect(
        sessionAccessor.loadSessionEntry({ sessionKey: ownerKey, storePath })?.mainRestartRecovery
          ?.foregroundClaims?.tokens,
      ).toEqual([claim.lease.claimId]);
    },
  );

  it.each([undefined, "done"] as const)(
    "inspects and clears terminal recovery residue from a %s row",
    async (status) => {
      const residue = interruptedEntry({
        status,
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
        restartRecoveryTerminalRunIds: ["stale-run"],
      });
      await write(residue);
      await expect(
        inspectMainSessionRecoveryRequired({
          expectedSessionId: "session-1",
          lifecycleGeneration,
          target: { sessionKey, storePath },
        }),
      ).resolves.toEqual({ kind: "not_required" });
      expect(read().status).toBe(status);
      expect(read()).toMatchObject({
        abortedLastRun: residue.abortedLastRun,
        restartRecoveryRuns: residue.restartRecoveryRuns,
      });
      expect(read().mainRestartRecovery).toBeUndefined();
      expect(await claimRecovery()).toEqual({ kind: "not_required", entry: read(), sessionKey });
      expect(read()).toMatchObject({ sessionId: "session-1", abortedLastRun: false });
      expect(read().status).toBe(status);
      expect(read().restartRecoveryRuns).toBeUndefined();
      expect(read().mainRestartRecovery).toBeUndefined();
      expect(read().restartRecoveryDeliveryRunId).toBeUndefined();
    },
  );

  it.each(["claim", "refresh"] as const)(
    "retains the session owner when binding its run at %s",
    async (bindAt) => {
      const target =
        bindAt === "claim"
          ? { sessionKey, storePath }
          : { agentId: "ops", sessionKey: "global", storePath: fixtureStore("ops") };
      await sessionAccessor.replaceSessionEntry(target, interruptedEntry());
      await expect(
        inspectMainSessionRecoveryRequired({
          expectedSessionId: "session-1",
          lifecycleGeneration,
          target,
        }),
      ).resolves.toEqual({ kind: "required" });
      const accessorSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");
      const claim = await claimMainSessionRecoveryOwner({
        lifecycleGeneration,
        sessionId: "session-1",
        target,
        ...(bindAt === "claim" ? { runId: "foreground-run" } : {}),
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") {
        throw new Error("expected foreground owner claim");
      }
      expect(accessorSpy).toHaveBeenCalledOnce();
      expect(accessorSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKeys: [target.sessionKey] });
      await expect(
        refreshMainSessionRecoveryOwner(
          claim.lease,
          bindAt === "refresh" ? "foreground-run" : undefined,
        ),
      ).resolves.toMatchObject({ entry: { sessionId: "session-1" } });
      expect(sessionAccessor.loadSessionEntry(target)).toMatchObject({
        restartRecoveryRuns: [{ lifecycleGeneration, runId: "foreground-run" }],
        mainRestartRecovery: {
          foregroundClaims: {
            lifecycleGeneration,
            tokens: [claim.lease.claimId],
            runIdsByClaimId: { [claim.lease.claimId]: "foreground-run" },
          },
        },
      });
      await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toEqual({
        ...target,
        sessionId: "session-1",
      });
      expect(
        sessionAccessor.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims,
      ).toBeUndefined();
      await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
    },
  );

  it.each([1, 3])(
    "retries owner release after %s transient store failures",
    async (failureCount) => {
      vi.useFakeTimers();
      try {
        await write(interruptedEntry());
        const claim = await claimedRecovery();
        const replace = sessionAccessor.applySessionEntryReplacements;
        let failures = 0;
        const accessorSpy = vi
          .spyOn(sessionAccessor, "applySessionEntryReplacements")
          .mockImplementation(async (params) => {
            if (failures++ < failureCount) {
              throw new Error("transient session-store failure");
            }
            return await replace(params);
          });
        const schedulePending =
          failureCount === 3
            ? vi
                .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
                .mockImplementation(() => {})
            : undefined;
        const release = releaseMainSessionRecoveryOwner(claim.lease);
        const settled =
          failureCount === 3
            ? expect(release).rejects.toThrow("transient session-store failure")
            : expect(release).resolves.toMatchObject({
                sessionId: "session-1",
                sessionKey,
                storePath,
              });
        await vi.advanceTimersByTimeAsync(100);
        await settled;
        if (failureCount === 3) {
          expect(read().mainRestartRecovery?.foregroundClaims?.tokens).toEqual([
            claim.lease.claimId,
          ]);
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() =>
            expect(schedulePending).toHaveBeenCalledWith({
              sessionId: "session-1",
              sessionKey,
              storePath,
            }),
          );
        } else {
          expect(accessorSpy).toHaveBeenCalledTimes(2);
        }
        await vi.waitFor(() =>
          expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined(),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves interrupted non-main rows to their specialized recovery owner", async () => {
    const subagentKey = "agent:main:subagent:child";
    await seedExact({ [subagentKey]: interruptedEntry({ spawnDepth: 1 }) });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey: subagentKey, storePath },
    });

    expect(claim).toEqual({
      kind: "not_required",
      entry: readStore()[subagentKey],
      sessionKey: subagentKey,
    });
    expect(readStore()[subagentKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it.each([false, true])(
    "does not bypass an exhausted predecessor (tombstoned=%s)",
    async (tombstoned) => {
      await write(
        interruptedEntry({
          status: tombstoned ? "failed" : "interrupted",
          abortedLastRun: !tombstoned,
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 4,
            chargedAttempts: 3,
            ...(tombstoned ? { tombstone: { reason: "automatic recovery exhausted" } } : {}),
          },
        }),
      );
      await expect(
        claimRecovery(tombstoned ? { replacementSessionId: "session-2" } : {}),
      ).resolves.toEqual({
        kind: "invalidated",
        reason: tombstoned ? "state_changed" : "recovery_exhausted",
      });
      expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
    },
  );

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

  it("settles an owned shared-store recovery receipt without redispatching", async () => {
    const opsStorePath = fixtureStore("ops");
    const dir = path.dirname(opsStorePath);
    const target = { agentId: "ops", sessionKey: "global", storePath: opsStorePath };
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
          session: { scope: "global", store: opsStorePath },
        },
        gatewayRuntime: {
          prepareRestartRecovery: () => undefined,
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
    const oldClaim = await claimedRecovery();
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
        status: undefined,
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
      abortedLastRun: false,
    });
    expect(read().status).toBeUndefined();
  });
});
