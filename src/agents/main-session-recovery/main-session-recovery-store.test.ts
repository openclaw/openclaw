import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { applySessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.js";
import { admitAgentRestartRecovery as admitRecovery } from "../../gateway/agent-turn/agent-run-recovery-admission.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { projectMainSessionRecoveryLifecycle as projectLifecycle } from "./main-session-recovery-lifecycle.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import { executionIdentity, recoveryEntry } from "./main-session-recovery-state.test-support.js";
import {
  claimMainSessionRecoveryOwner as claimOwner,
  commitMainSessionRecovery as commit,
  inspectMainSessionRecoveryRequired as inspectRequired,
  refreshMainSessionRecoveryOwner as refreshOwner,
  releaseMainSessionRecoveryOwner as releaseOwner,
} from "./main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "./main-session-recovery-store.test-support.js";
import { retryRestartAbortedMainSessionRecovery as retryRecovery } from "./main-session-restart-recovery-runtime.js";

const sessionKey = "agent:main:main";
const enabledExecutionIdentity = (runId: string) => ({
  state: "enabled" as const,
  token: executionIdentity(runId),
});
describe("main session recovery store", () => {
  let lifecycleGeneration: string;
  let storePath: string;
  const { fixtureStore, createMovedSessionStore, resetCase } =
    createMainSessionRecoveryStoreFixture();

  beforeEach(() => {
    storePath = fixtureStore();
    lifecycleGeneration = getAgentEventLifecycleGeneration();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCase();
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessions.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(key = sessionKey): SessionEntry {
    return sessions.loadSessionEntry({ sessionKey: key, storePath })!;
  }

  const seed = (overrides: Partial<SessionEntry> = {}) => write(interruptedEntry(overrides));

  async function moveOwner(ownerKey = "agent:main:moved") {
    await seedExact({
      [ownerKey]: read(),
      [sessionKey]: { sessionId: "replacement", updatedAt: 200 },
    });
  }

  async function seedExact(entries: Record<string, SessionEntry>): Promise<void> {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: Object.entries(entries).map(([key, entry]) => ({ sessionKey: key, entry })),
      skipMaintenance: true,
    });
  }

  function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return recoveryEntry({ status: "interrupted", abortedLastRun: true, ...overrides });
  }

  type ClaimParams = Parameters<typeof claimOwner>[0];
  type CommitParams = Parameters<typeof commit>[0];
  type Prepare = Extract<CommitParams["command"], { kind: "prepare_attempt" }>;

  function prepare(overrides: Partial<Prepare> = {}) {
    return commitRecovery({
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration,
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: enabledExecutionIdentity("recovery-1"),
      ...overrides,
    });
  }

  function reservationCommand(
    kind: "admit_recovery" | "cancel_reservation" | "abandon_reservation",
    reservation: MainSessionRecoveryReservation,
  ): CommitParams["command"] {
    return kind === "admit_recovery"
      ? {
          kind,
          lifecycleGeneration,
          now: 300,
          runId: reservation.runId,
          sessionId: reservation.sessionId,
        }
      : { kind, reservation };
  }

  function commitRecovery(
    command: CommitParams["command"],
    options: Omit<CommitParams, "command" | "target"> = {},
  ) {
    return commit({ command, target: { sessionKey, storePath }, ...options });
  }

  function observe() {
    return commitRecovery({ kind: "observe", cycleId: "unused", lifecycleGeneration, sessionKey });
  }

  function foreground(claimId: string, generation = lifecycleGeneration) {
    return commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: generation,
      sessionId: "session-1",
      sessionKey,
      claimId,
    });
  }

  function admit(runId = "recovery-1") {
    return admitRecovery({
      lifecycleGeneration,
      runId,
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
  }

  function inspect(target = { sessionKey, storePath }) {
    return inspectRequired({ expectedSessionId: "session-1", lifecycleGeneration, target });
  }

  function beforeRecoveryUpdate(
    inspectEntries: (entries: sessions.SessionEntryReplacementSnapshot[]) => void,
    once = false,
  ) {
    const replace = sessions.applySessionEntryReplacements;
    const implementation: typeof replace = (params) =>
      replace({
        ...params,
        update: (entries) => {
          inspectEntries(entries);
          return params.update(entries);
        },
      });
    const spy = vi.spyOn(sessions, "applySessionEntryReplacements");
    return once
      ? spy.mockImplementationOnce(implementation)
      : spy.mockImplementation(implementation);
  }

  function claimRecovery(overrides: Partial<ClaimParams> = {}) {
    return claimOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
      ...overrides,
    });
  }

  async function claimedRecovery(overrides: Partial<ClaimParams> = {}) {
    const claim = await claimRecovery(overrides);
    assert(claim.kind === "claimed", "expected foreground owner claim");
    return claim;
  }

  async function seedOwner(moved: boolean) {
    if (moved) {
      storePath = createMovedSessionStore();
    }
    await seed();
    const claim = await claimedRecovery();
    const ownerKey = moved ? "agent:main:moved" : sessionKey;
    if (moved) {
      await moveOwner(ownerKey);
    }
    return { claim, ownerKey };
  }

  async function reserve() {
    const result = await prepare();
    assert(result.transition.kind === "reserved", "expected reservation");
    return result.transition.reservation;
  }

  async function seedDelivery() {
    await seed({
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });
    await reserve();
    return admit();
  }

  function expectRestored(chargedAttempts: number) {
    const entry = read();
    expect(entry).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliverySourceRunId: "source-1",
      mainRestartRecovery: { cycleId: "cycle-1", chargedAttempts },
    });
    expect(entry.lifecycleRunId).toBeUndefined();
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
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
        const stop = projectLifecycle({
          entry: running,
          currentLifecycleGeneration: lifecycleGeneration,
          event: {
            runId: "stopped-run",
            lifecycleGeneration,
            data: { phase: "end", status: "cancelled", aborted: true, stopReason: "rpc" },
          },
          snapshotPatch: { status: "killed", abortedLastRun: true },
        });
        assert(stop.action === "apply", "Stop must settle its current owner");
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
        { kind: "observe", cycleId: "cycle-1", lifecycleGeneration, sessionKey },
        { requireWriteSuccess: true },
      );

      expect(result.transition).toMatchObject({ kind: "observed", view: { status: "inactive" } });
      expect(read().mainRestartRecovery).toBeUndefined();
    },
  );

  it("preserves a concurrent foreground claim while cancelling its reservation", async () => {
    await seed();
    const reservation = await reserve();
    await foreground("foreground-1");

    await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(read().mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: { lifecycleGeneration, tokens: ["foreground-1"] },
    });
  });

  it.each(["recovery-1", "recovery-2"])(
    "does not let delayed restoration interrupt a newer admission of %s",
    async (successorRunId) => {
      const restorePrevious = await seedDelivery();
      // Orphan reconciliation can win while the previous admission's cleanup is deferred.
      await commitRecovery({ kind: "mark_interrupted", cycleId: "unused", now: 400 });
      const observed = await observe();
      assert(
        observed.transition.kind === "observed" &&
          observed.transition.view.status === "recoverable",
        "expected recoverable session",
      );
      await prepare({
        attempt: observed.transition.view.nextAttempt,
        now: 500,
        observation: observed.transition.view.observation,
        runId: successorRunId,
        executionIdentity: { state: "disabled" },
      });
      await sessions.updateSessionEntry({ sessionKey, storePath }, () => ({
        restartRecoveryDeliveryRunId: successorRunId,
      }));
      const restoreSuccessor = await admit(successorRunId);
      const admittedSuccessor = read();

      await expect(restorePrevious()).resolves.toBeUndefined();
      expect(read()).toEqual(admittedSuccessor);
      await expect(restoreSuccessor()).resolves.toMatchObject({
        sessionId: "session-1",
        sessionKey,
      });
      expectRestored(2);
    },
  );

  it("retries the exact restored attempt after its committed response is lost", async () => {
    const restore = await seedDelivery();
    const applyReplacements = sessions.applySessionEntryReplacements;
    vi.spyOn(sessions, "applySessionEntryReplacements").mockImplementationOnce(async (params) => {
      await applyReplacements(params);
      throw new Error("restoration response lost");
    });

    await expect(restore()).rejects.toThrow("restoration response lost");
    await expect(restore()).resolves.toMatchObject({ sessionId: "session-1", sessionKey });
    expectRestored(1);
  });

  it("rejects an observation after the session is replaced", async () => {
    await seed({
      sessionId: "session-2",
      updatedAt: 300,
      mainRestartRecovery: { cycleId: "cycle-2", revision: 1, chargedAttempts: 0 },
    });

    const result = await prepare({
      now: 400,
      runId: "stale-recovery",
      executionIdentity: enabledExecutionIdentity("stale-recovery"),
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "session_replaced" });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it.each(["replacement", "new cycle"] as const)(
    "does not cancel a stale reservation after %s",
    async (change) => {
      await seed();
      const reservation = await reserve();
      if (change === "replacement") {
        await seed({
          sessionId: "session-2",
          updatedAt: 300,
          mainRestartRecovery: { cycleId: "cycle-2", revision: 4, chargedAttempts: 2 },
        });
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

  it.each(["claim", "inspect"] as const)("%s follows a moved session", async (kind) => {
    storePath = createMovedSessionStore();
    const movedKey = "agent:main:moved";
    const replacement = { sessionId: "replacement", updatedAt: 200 };
    await seedExact({ [movedKey]: interruptedEntry(), [sessionKey]: replacement });
    const result = kind === "claim" ? await claimRecovery() : await inspect();

    expect(result).toMatchObject(
      kind === "claim" ? { kind: "claimed", sessionKey: movedKey } : { kind: "required" },
    );
    expect(read()).toMatchObject(replacement);
    const moved = read(movedKey);
    expect(Boolean(moved?.mainRestartRecovery?.foregroundClaims)).toBe(kind === "claim");
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
        const claim = await claimedRecovery();
        command = { kind, claim: claim.lease };
      } else {
        command = reservationCommand(kind, await reserve());
      }
      const unrelatedPayloads: string[] = [];
      // Inspect the real decoded snapshot before recovery selects its owner.
      beforeRecoveryUpdate((entries) => {
        unrelatedPayloads.push(
          ...entries.flatMap(({ entry }) =>
            entry.lastHeartbeatText === unrelatedPayload ? [entry.lastHeartbeatText] : [],
          ),
        );
      });

      const result = await commitRecovery(command);

      expect(result).toMatchObject({
        sessionKey,
        transition: {
          kind:
            kind === "validate_foreground"
              ? "foreground_validated"
              : kind === "admit_recovery"
                ? "admitted_recovery"
                : "applied",
        },
      });
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

  it.each([
    [false, "session"],
    [true, "session"],
    [false, "lifecycle"],
    [true, "lifecycle"],
  ] as const)("invalidates the owner after rotation (moved=%s, %s)", async (moved, rotation) => {
    const { claim, ownerKey } = await seedOwner(moved);
    if (rotation === "lifecycle") {
      if (moved) {
        beforeRecoveryUpdate(rotateAgentEventLifecycleGeneration, true);
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      await expect(refreshOwner(claim.lease)).resolves.toBeUndefined();
      expect(read(ownerKey)?.mainRestartRecovery?.foregroundClaims?.tokens).toEqual([
        claim.lease.claimId,
      ]);
      return;
    }
    expect(await refreshOwner(claim.lease)).toMatchObject({
      sessionKey: ownerKey,
      entry: { sessionId: "session-1" },
    });
    const target = { sessionKey: ownerKey, storePath };
    await sessions.updateSessionEntry(target, () => ({ sessionId: "session-2" }));
    await expect(refreshOwner(claim.lease)).resolves.toBeUndefined();
    await expect(releaseOwner(claim.lease)).resolves.toBeUndefined();
    expect(
      sessions.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined();
    if (moved) {
      expect(read()).toMatchObject({ sessionId: "replacement" });
    }
  });

  it.each(["admit_recovery", "cancel_reservation", "abandon_reservation"] as const)(
    "%s finds a moved reservation without changing its replacement",
    async (kind) => {
      storePath = createMovedSessionStore();
      await seed();
      const reservation = await reserve();
      const movedKey = "agent:main:moved";
      await moveOwner(movedKey);

      expect(await commitRecovery(reservationCommand(kind, reservation))).toMatchObject({
        sessionKey: movedKey,
        transition: { kind: kind === "admit_recovery" ? "admitted_recovery" : "applied" },
      });
      const state = read(movedKey)?.mainRestartRecovery;
      expect(state).toMatchObject({
        chargedAttempts: kind === "cancel_reservation" ? 0 : 1,
      });
      expect(state?.reservation).toBeUndefined();
      expect(read()).toMatchObject({ sessionId: "replacement" });
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
      await expect(inspect()).resolves.toEqual({ kind: "not_required" });
      const inspected = read();
      expect(inspected.status).toBe(status);
      expect(inspected.mainRestartRecovery).toBeUndefined();
      expect(inspected).toMatchObject({
        abortedLastRun: residue.abortedLastRun,
        restartRecoveryRuns: residue.restartRecoveryRuns,
      });
      expect(await claimRecovery()).toEqual({ kind: "not_required", entry: read(), sessionKey });
      const cleared = read();
      expect(cleared).toMatchObject({
        sessionId: "session-1",
        abortedLastRun: false,
      });
      expect(cleared.status).toBe(status);
      expect(cleared.restartRecoveryRuns).toBeUndefined();
      expect(cleared.mainRestartRecovery).toBeUndefined();
      expect(cleared.restartRecoveryDeliveryRunId).toBeUndefined();
    },
  );

  it.each(["claim", "refresh"] as const)(
    "retains the session owner when binding its run at %s",
    async (bindAt) => {
      const target =
        bindAt === "claim"
          ? { sessionKey, storePath }
          : { agentId: "ops", sessionKey: "global", storePath: fixtureStore("ops") };
      await sessions.replaceSessionEntry(target, interruptedEntry());
      await expect(inspect(target)).resolves.toEqual({ kind: "required" });
      const accessorSpy = vi.spyOn(sessions, "applySessionEntryReplacements");
      const claim = await claimedRecovery({
        target,
        ...(bindAt === "claim" ? { runId: "foreground-run" } : {}),
      });
      expect(accessorSpy).toHaveBeenCalledOnce();
      expect(accessorSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKeys: [target.sessionKey] });
      await expect(
        refreshOwner(claim.lease, bindAt === "refresh" ? "foreground-run" : undefined),
      ).resolves.toMatchObject({ entry: { sessionId: "session-1" } });
      expect(sessions.loadSessionEntry(target)).toMatchObject({
        restartRecoveryRuns: [{ lifecycleGeneration, runId: "foreground-run" }],
        mainRestartRecovery: {
          foregroundClaims: {
            lifecycleGeneration,
            tokens: [claim.lease.claimId],
            runIdsByClaimId: { [claim.lease.claimId]: "foreground-run" },
          },
        },
      });
      await expect(releaseOwner(claim.lease)).resolves.toEqual({
        ...target,
        sessionId: "session-1",
      });
      expect(
        sessions.loadSessionEntry(target)?.mainRestartRecovery?.foregroundClaims,
      ).toBeUndefined();
      await expect(refreshOwner(claim.lease)).resolves.toBeUndefined();
    },
  );

  it("reports owner release failure without retrying its durable claim", async () => {
    await seed();
    const claim = await claimedRecovery();
    const accessorSpy = vi
      .spyOn(sessions, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("session-store failure"));

    await expect(releaseOwner(claim.lease)).rejects.toThrow("session-store failure");
    expect(accessorSpy).toHaveBeenCalledOnce();
    expect(read().mainRestartRecovery?.foregroundClaims?.tokens).toEqual([claim.lease.claimId]);
  });

  it("leaves interrupted non-main rows to their specialized recovery owner", async () => {
    const subagentKey = "agent:main:subagent:child";
    await seedExact({ [subagentKey]: interruptedEntry({ spawnDepth: 1 }) });

    const claim = await claimRecovery({ target: { sessionKey: subagentKey, storePath } });

    expect(claim).toEqual({
      kind: "not_required",
      entry: read(subagentKey),
      sessionKey: subagentKey,
    });
    expect(read(subagentKey)?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it.each([false, true])(
    "does not bypass an exhausted predecessor (tombstoned=%s)",
    async (tombstoned) => {
      await seed({
        status: tombstoned ? "failed" : "interrupted",
        abortedLastRun: !tombstoned,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          ...(tombstoned ? { tombstone: { reason: "automatic recovery exhausted" } } : {}),
        },
      });
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
    await seed();
    const first = await claimedRecovery();
    const second = await claimedRecovery();

    const retryTarget = { sessionId: "session-1", sessionKey, storePath };
    await expect(releaseOwner(first.lease)).resolves.toBeUndefined();
    await expect(releaseOwner(second.lease)).resolves.toEqual(retryTarget);
    await expect(releaseOwner(second.lease)).resolves.toEqual(retryTarget);
  });

  it("settles an owned shared-store recovery receipt without redispatching", async () => {
    const opsStorePath = fixtureStore("ops");
    const target = { agentId: "ops", sessionKey: "global", storePath: opsStorePath };
    await sessions.replaceSessionEntry(
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
      retryRecovery({
        ...target,
        expectedSessionId: "session-1",
        stateDir: path.dirname(opsStorePath),
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
    const settled = sessions.loadSessionEntry(target);
    expect(settled).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(settled?.pendingFinalDelivery).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not let an old lease release a same-token claim from a new cycle", async () => {
    await seed();
    const oldClaim = await claimedRecovery();
    await commitRecovery({ kind: "clear" });
    await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });
    await foreground(oldClaim.lease.claimId);

    await releaseOwner(oldClaim.lease);

    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: { lifecycleGeneration, tokens: [oldClaim.lease.claimId] },
    });
  });

  it("rejects an old claimant queued ahead of the current lifecycle generation", async () => {
    await seed();

    const writerEntered = createDeferred();
    const writerGate = createDeferred();
    const blocker = sessions.applySessionEntryReplacements({
      storePath,
      update: async () => {
        writerEntered.resolve();
        await writerGate.promise;
        return { result: undefined };
      },
    });
    await writerEntered.promise;

    const staleClaim = foreground("stale-owner");
    const staleOwnerClaim = claimRecovery({
      allowMissingSession: true,
      replacementSessionId: "session-2",
    });
    const staleInspection = inspect();
    await Promise.resolve();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const currentClaim = foreground("current-owner", currentGeneration);
    writerGate.resolve();

    await blocker;
    expect((await staleClaim).transition).toEqual({ kind: "rejected", reason: "stale_generation" });
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
