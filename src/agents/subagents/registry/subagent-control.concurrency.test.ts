// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import * as controllerLifecycle from "../../../sessions/session-controller.lifecycle.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  runSessionMutation,
  type SessionEffectRef,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import {
  beginControlAdmission as admit,
  controlSessionKey as key,
  controlController,
  createControlRunFixture,
  enqueueControlRun,
  expectControlIdle as expectIdle,
} from "./subagent-control.fixtures.test-support.js";
import * as nativeControl from "./subagent-control.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated } from "./subagent-registry.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

const requesterKey = "agent:main:main";
const { writeSession, register, seed } = createControlRunFixture(() => fixture.stateDir);

async function block(enabled: boolean, scope: string, identities: string[]) {
  const mutationGate = createEnteredGate();
  const pending = enabled
    ? runSessionMutation({
        scope,
        identities,
        run: mutationGate.wait,
      })
    : Promise.resolve();
  if (enabled) {
    await mutationGate.entered;
  }
  return { pending, release: mutationGate.release };
}

it("does not transfer a selected task cancellation to an admitted follow-up generation", async () => {
  const { sessionKey, sessionId } = await seed("selected-generation", {
    runId: "selected-original",
    requesterAgentId: undefined,
    requesterDisplayKey: requesterKey,
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  const original = subagentRuns.get("selected-original")!;
  const handoff = createEnteredGate();
  const killNative = nativeControl.killSubagentRunAdmin;
  vi.spyOn(nativeControl, "killSubagentRunAdmin").mockImplementation(async (...args) => {
    await handoff.wait();
    return killNative(...args);
  });
  const tool = createSubagentsTool({ agentSessionKey: requesterKey, config: getRuntimeConfig() });
  const pending = tool.execute("cancel-original", { action: "cancel", runId: original.runId });
  const controller = new AbortController();
  const handle = createEmbeddedRunHandle({
    runId: "selected-followup",
    abort: () => controller.abort(),
  });
  try {
    await awaitGateBeforeSettlement(
      handoff.entered,
      pending,
      "Cancellation never reached its runtime handoff.",
    );
    expect(
      await markSubagentRunTerminated({
        runId: original.runId,
        reason: "Original execution stopped",
      }),
    ).toBe(1);
    expect(
      await reactivateCompletedSubagentSession({
        sessionKey,
        runId: "selected-followup",
        task: "Admitted follow-up work",
      }),
    ).toBe(true);
    const successor = subagentRuns.get("selected-followup")!;
    expect(successor.generation).toBeGreaterThan(original.generation!);
    attachActiveEmbeddedRun(sessionId, handle, sessionKey);
    handoff.release();
    expect((await pending).details).toMatchObject({ killed: false });
    expect(controller.signal.aborted).toBe(false);
  } finally {
    handoff.release();
    await pending;
    await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it.each(["before interruption", "after interruption", "after abort"] as const)(
  "refuses a Stop revoked before admission and finishes one revoked %s",
  async (revocation) => {
    const { storePath, sessionKey, sessionId, runId } = await seed("caller-control", {
      runId: "caller-control-run",
    });
    let callerControlsAncestor = true;
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      if (revocation === "after abort") {
        callerControlsAncestor = false;
      }
    };
    const handle = createEmbeddedRunHandle({ runId, abort });
    attachActiveEmbeddedRun(sessionId, handle, sessionKey);
    const interrupted = createDeferred();
    const onInterrupt = vi.fn(() => {
      interrupted.resolve();
      if (revocation === "after abort") {
        admission.release();
      }
    });
    const admission = await admit(storePath, sessionKey, sessionId, onInterrupt, runId);
    const blocker = await block(revocation === "before interruption", storePath, [
      sessionKey,
      sessionId,
    ]);
    const pending = killSubagentRunAdmin(
      {
        cfg: getRuntimeConfig(),
        sessionKey,
        expectedRunId: runId,
        expectedOwnerKey: "agent:main:main",
      },
      {
        assertCurrent: () => {
          if (!callerControlsAncestor) {
            throw new Error("Caller no longer controls ancestor.");
          }
        },
      },
    );
    try {
      if (revocation === "before interruption") {
        callerControlsAncestor = false;
        blocker.release();
      } else if (revocation === "after interruption") {
        await interrupted.promise;
        expect(subagentRuns.get(runId)?.killIntent).toBeDefined();
        callerControlsAncestor = false;
        admission.release();
      }
      if (revocation === "before interruption") {
        // Revoked while the Stop still selected its tree: refused before any effect.
        await expect(pending).rejects.toThrow("Caller no longer controls ancestor.");
        expect(controller.signal.aborted).toBe(false);
        expect(onInterrupt).not.toHaveBeenCalled();
      } else {
        // Revocation applies to the caller's next request; this admitted Stop finishes.
        await expect(pending).resolves.toMatchObject({ found: true, killed: true });
        expect(controller.signal.aborted).toBe(true);
        expect(onInterrupt).toHaveBeenCalledTimes(1);
      }
      expect(subagentRuns.get(runId)?.killIntent).toBeUndefined();
    } finally {
      blocker.release();
      admission.release();
      await Promise.allSettled([blocker.pending, pending]);
      await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
      expectIdle();
    }
  },
);

it.each([
  { phase: "queued", terminal: false },
  { phase: "accepted", terminal: false },
  { phase: "accepted", terminal: true },
] as const)(
  "an admitted Stop never waits on caller facts requested while $phase (terminal=$terminal)",
  async ({ phase, terminal }) => {
    const { storePath, sessionKey, sessionId, runId } = await seed("readiness", {
      runId: "readiness-run",
    });
    const controller = new AbortController();
    const handle = createEmbeddedRunHandle({ runId, abort: () => controller.abort() });
    attachActiveEmbeddedRun(sessionId, handle, sessionKey);
    const interrupted = createDeferred();
    const admission = await admit(
      storePath,
      sessionKey,
      sessionId,
      () => {
        controller.abort();
        interrupted.resolve();
        if (phase === "queued") {
          admission.release();
        }
        return { runId };
      },
      runId,
    );
    const blocker = await block(phase === "queued", storePath, [sessionKey, sessionId]);
    const mutationQueued = createDeferred();
    if (phase === "queued") {
      const mutate = controllerLifecycle.runSessionMutation;
      vi.spyOn(controllerLifecycle, "runSessionMutation").mockImplementation((params) => {
        const mutation = mutate(params);
        if ("scope" in params && params.scope === storePath && params.prepare) {
          mutationQueued.resolve();
        }
        return mutation;
      });
    }
    let needsRead = false;
    let readRequested = false;
    const pending = killSubagentRunAdmin(
      {
        cfg: getRuntimeConfig(),
        sessionKey,
        expectedRunId: runId,
      },
      {
        assertCurrent: () => {
          if (needsRead) {
            throw new Error("Caller facts were not prepared.");
          }
        },
        prepareRead: () => {
          if (!needsRead) {
            return undefined;
          }
          readRequested = true;
          return new Promise<void>(() => {});
        },
      },
    );
    try {
      await awaitGateBeforeSettlement(
        phase === "accepted" ? interrupted.promise : mutationQueued.promise,
        pending,
        "Cancellation never reached its selected lifecycle phase.",
      );
      // Caller facts serve only the admission check; the admitted Stop never reads them again.
      needsRead = true;
      blocker.release();
      admission.release();
      if (terminal) {
        expect(await markSubagentRunTerminated({ runId, reason: "killed" })).toBe(1);
      }
      const result = await pending;
      expect(readRequested).toBe(false);
      expect(result).toMatchObject({ found: true });
      expect(result).not.toHaveProperty("error");
      expect(controller.signal.aborted).toBe(true);
      expect(subagentRuns.get(runId)?.killIntent).toBeUndefined();
      expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
    } finally {
      blocker.release();
      admission.release();
      await Promise.allSettled([blocker.pending, pending]);
      await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
      expectIdle();
    }
  },
);

it.for(["admin", "bulk"] as const)(
  "%s cancellation interrupts every sibling before waiting for any sibling to drain",
  async (boundary, { signal }) => {
    const owner = key("root");
    const running = Array.from({ length: 8 }, (_, index) => `running-${index}`);
    const queued = ["queued-0", "queued-1"];
    const selected = [...running, ...queued];
    let storePath = "";
    for (const id of ["root", ...selected]) {
      storePath = await writeSession(id, `${id}-revision`);
      await register(id, storePath, {
        requesterSessionKey: id === "root" ? requesterKey : owner,
        requesterTurnRunId: id === "root" ? undefined : "root",
        requesterDisplayKey: requesterKey,
        collect: true,
        queued: queued.includes(id),
      });
    }
    const start = vi.fn(async () => {});
    const cleanupGate = createDeferred();
    const allRemoved = createDeferred();
    let removals = 0;
    const removed = async () => {
      removals += 1;
      if (removals === queued.length) {
        allRemoved.resolve();
      }
      await cleanupGate.promise;
    };
    for (const runId of queued) {
      enqueueControlRun("sibling-cancellation", runId, running, start, {
        maxConcurrent: running.length,
        onRemoved: removed,
      });
    }
    const interrupted: string[] = [];
    const allInterrupted = createDeferred();
    const leases: SessionEffectRef[] = [];
    const activeRuns = running.map((runId) => ({
      runId,
      handle: createEmbeddedRunHandle({ runId }),
    }));
    for (const { runId, handle } of activeRuns) {
      attachActiveEmbeddedRun(`${runId}-session`, handle, key(runId));
      leases.push(
        await admit(
          storePath,
          key(runId),
          `${runId}-session`,
          () => {
            interrupted.push(runId);
            if (interrupted.length === running.length) {
              allInterrupted.resolve();
            }
            // Cancellation releases real scheduler capacity while these admissions
            // remain held. Selected queued children must still never dispatch.
            expect(releaseSwarmRun(runId)).toBe(true);
          },
          runId,
        ),
      );
    }
    const cfg = getRuntimeConfig();
    let settled = false;
    const pending = (
      boundary === "admin"
        ? killSubagentRunAdmin({ cfg, sessionKey: owner, expectedRunId: "root" })
        : killAllControlledSubagentRuns({
            cfg,
            controller: {
              ...controlController,
              controllerSessionKey: owner,
              callerSessionKey: owner,
            },
            runs: selected.map((id) => subagentRuns.get(id)!),
          })
    ).finally(() => {
      settled = true;
    });
    const awaitProgress = (gate: Promise<void>, label: string) =>
      withinTest(awaitGateBeforeSettlement(gate, pending, label), signal);
    try {
      await awaitProgress(allInterrupted.promise, "Cancellation skipped a running sibling");
      expect(interrupted.toSorted()).toEqual(running);
      expect(start).not.toHaveBeenCalled();
      for (const lease of leases.toReversed()) {
        lease.release();
      }
      await awaitProgress(allRemoved.promise, "Cancellation skipped a queued sibling");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      cleanupGate.resolve();
      await expect(pending).resolves.toMatchObject(
        boundary === "admin"
          ? { found: true, killed: true, cascadeKilled: selected.length, cascadeLabels: selected }
          : { status: "ok", killed: selected.length, labels: selected },
      );
      for (const id of selected) {
        expect(resolveSubagentSessionStatus(subagentRuns.get(id))).toBe("killed");
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      cleanupGate.resolve();
      for (const lease of leases) {
        lease.release();
      }
      await pending;
      for (const { runId, handle } of activeRuns) {
        await detachActiveEmbeddedRun(`${runId}-session`, handle, key(runId));
      }
      expectIdle();
    }
  },
);

it.for(["before capacity release", "after interrupt"] as const)(
  "keeps a late descendant queued when registered %s on an independent sibling that releases first",
  async (registration, { signal }) => {
    const owner = requesterKey;
    const parents = { a: owner, b: owner, d: key("a"), x: key("d"), g: key("d") };
    let storePath = "";
    const registerChild = (id: keyof typeof parents, queued = false) =>
      register(id, storePath, {
        requesterSessionKey: parents[id],
        controllerSessionKey: parents[id],
        swarmRequesterSessionKey: parents[id],
        requesterDisplayKey: parents[id],
        groupId: "shared-name",
        collect: true,
        queued,
      });
    for (const id of ["a", "b", "d", "x", "g"] as const) {
      storePath = await writeSession(id, `${id}-revision`);
      if (id !== "g") {
        await registerChild(id);
      }
    }
    const unrelatedStarted = createDeferred();
    const unrelatedStart = async () => {
      unrelatedStarted.resolve();
    };
    const startG = vi.fn(async () => {});
    const startFailure = vi.fn(() => true);
    const groupFor = (requester: string) => JSON.stringify(["main", requester, "shared-name"]);
    enqueueControlRun(groupFor(owner), "unrelated", ["a", "b"], unrelatedStart, {
      maxConcurrent: 2,
      onStartFailure: startFailure,
    });
    const aInterrupted = createDeferred();
    const bInterrupted = createDeferred();
    const bReleased = createDeferred();
    const admissionA = await admit(storePath, key("a"), "a-session", () => aInterrupted.resolve());
    const admissionB = await admit(storePath, key("b"), "b-session", () => bInterrupted.resolve());
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await admit(storePath, key("d"), "d-session", interruptD);
    const registerG = () =>
      admissionD.run(async () => {
        const pendingRegistration = registerChild("g", true);
        // Keep G queued before B releases capacity, without detaching its durable registration.
        enqueueControlRun(groupFor(key("d")), "g", ["x"], startG, { onStartFailure: startFailure });
        await pendingRegistration;
      });
    let lateRegistration: Promise<void> | undefined;
    const handleB = createEmbeddedRunHandle({
      runId: "b",
      abort: () => {
        if (registration === "before capacity release") {
          lateRegistration = registerG();
        }
        expect(releaseSwarmRun("b")).toBe(true);
        bReleased.resolve();
      },
    });
    const handleX = createEmbeddedRunHandle({
      runId: "x",
      abort: () => expect(releaseSwarmRun("x")).toBe(true),
    });
    attachActiveEmbeddedRun("b-session", handleB, key("b"));
    attachActiveEmbeddedRun("x-session", handleX, key("x"));
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: controlController,
      runs: [subagentRuns.get("a")!, subagentRuns.get("b")!],
    });
    try {
      await Promise.all([aInterrupted.promise, bInterrupted.promise]);
      expect(interruptD).not.toHaveBeenCalled();
      // Reusing a group name does not merge different callers' scheduler lanes.
      if (registration === "after interrupt") {
        lateRegistration = registerG();
        await lateRegistration;
      }
      admissionB.release();
      await bReleased.promise;
      expect(lateRegistration).toBeDefined();
      await lateRegistration;
      // The kill cannot settle while admission A is held, so only the test deadline bounds this.
      await withinTest(unrelatedStarted.promise, signal);
      expect(interruptD).not.toHaveBeenCalled();
      expect(startG).not.toHaveBeenCalled();
      admissionA.release();
      const result = await pending;
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "ok",
        killed: 5,
        labels: ["a", "d", "x", "g", "b"],
      });
      expect(resolveSubagentSessionStatus(subagentRuns.get("g"))).toBe("killed");
      expect(startG).not.toHaveBeenCalled();
      expect(startFailure).not.toHaveBeenCalled();
    } finally {
      admissionA.release();
      admissionB.release();
      admissionD.release();
      await Promise.all([pending, lateRegistration]);
      await detachActiveEmbeddedRun("b-session", handleB, key("b"));
      await detachActiveEmbeddedRun("x-session", handleX, key("x"));
      expectIdle();
    }
  },
);

it("full child Stop preserves later and foreign sources while joining captured queue cleanup", async () => {
  const { sessionKey, sessionId, storePath } = await seed(
    "captured-queue",
    { runId: "captured-queue-run", requesterDisplayKey: "main", task: "captured queue" },
    "captured-queue-revision",
  );
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    incarnation: sessionId,
  });
  const interrupted = createDeferred();
  const cleanupGate = createEnteredGate();
  const admission = await beginSessionEffect({
    target,
    assertAllowed: () => {},
    onInterrupt: () => interrupted.resolve(),
  });
  const own = reserveSessionControllerSource(sessionKey, {
    target,
    policy: { mode: "followup" },
    adapter: {
      onSettled: cleanupGate.wait,
    },
  });
  const foreign = reserveSessionControllerSource(sessionKey, {
    target: captureSessionTarget({ ...target, storeScope: storePath + ".foreign" }),
    policy: { mode: "followup" },
  });
  let later: typeof own | undefined;
  let completed = false;
  const pending = killSubagentRunAdmin({
    cfg: getRuntimeConfig(),
    sessionKey,
  }).finally(() => {
    completed = true;
  });
  try {
    await interrupted.promise;
    later = reserveSessionControllerSource(sessionKey, { target, policy: { mode: "followup" } });
    admission.release();
    await cleanupGate.entered;
    expect(own.abortSignal.aborted).toBe(true);
    expect(later.abortSignal.aborted).toBe(false);
    expect(foreign.abortSignal.aborted).toBe(false);
    expect(completed).toBe(false);
    cleanupGate.release();
    expect(await pending).toMatchObject({ found: true, killed: true });
    await own.settlement.promise;
    expect(later.abortSignal.aborted).toBe(false);
  } finally {
    cleanupGate.release();
    admission.release();
    await pending;
    const inputs = [own, foreign, ...(later ? [later] : [])];
    inputs.forEach(retireSessionControllerInput);
    await Promise.all(inputs.map((input) => input.settlement.promise));
  }
});
