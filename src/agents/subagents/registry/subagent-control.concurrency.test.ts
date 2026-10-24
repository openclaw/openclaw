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
  getSessionMutationCount,
  getSessionControllerWorkCount,
  runSessionMutation,
  type SessionEffectRef,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
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
import { finalizeInterruptedSubagentRun } from "./subagent-registry.test-helpers.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

const requesterKey = "agent:main:main";
const { writeSession, register, seed } = createControlRunFixture(() => fixture.stateDir);

async function block(enabled: boolean, scope: string, identities: string[]) {
  const entered = createDeferred();
  const release = createDeferred();
  const pending = enabled
    ? runSessionMutation({
        scope,
        identities,
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      })
    : Promise.resolve();
  if (enabled) {
    await entered.promise;
  }
  return { pending, release: release.resolve };
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
  const entered = createDeferred();
  const release = createDeferred();
  const killNative = nativeControl.killSubagentRunAdmin;
  vi.spyOn(nativeControl, "killSubagentRunAdmin").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
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
      entered.promise,
      pending,
      "Cancellation never reached its runtime handoff.",
    );
    expect(
      await finalizeInterruptedSubagentRun({
        runId: original.runId,
        expectedEntry: original,
        error: "Original execution interrupted",
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
    release.resolve();
    expect((await pending).details).toMatchObject({ killed: false });
    expect(controller.signal.aborted).toBe(false);
  } finally {
    release.resolve();
    await pending;
    await detachActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it.each(["before interruption", "after interruption", "after abort"] as const)(
  "revalidates caller control for new stops and settles accepted stops when revoked %s",
  async (revocation) => {
    const { storePath, sessionKey, sessionId, runId } = await seed("caller-control", {
      runId: "caller-control-run",
    });
    let callerControlsAncestor = true;
    const controller = new AbortController();
    const abort = vi.fn(() => {
      controller.abort();
      if (revocation === "after abort") {
        callerControlsAncestor = false;
      }
    });
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
      await expect(pending).rejects.toThrow("Caller no longer controls ancestor.");
      const accepted = revocation === "after abort";
      expect(controller.signal.aborted).toBe(accepted);
      expect(abort).toHaveBeenCalledTimes(Number(accepted));
      expect(onInterrupt).toHaveBeenCalledTimes(Number(revocation !== "before interruption"));
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
  ...(["queued", "accepted"] as const).flatMap((phase) =>
    (["ready", "failure"] as const).map((outcome) => ({ phase, outcome, terminal: false })),
  ),
  { phase: "accepted", outcome: "failure", terminal: true },
] as const)(
  "prepares cancellation facts while $phase and settles $outcome (terminal=$terminal)",
  async ({ phase, outcome, terminal }) => {
    const { storePath, sessionKey, sessionId, runId } = await seed("readiness", {
      runId: "readiness-run",
    });
    const controller = new AbortController();
    const aborted = vi.fn();
    controller.signal.addEventListener("abort", aborted, { once: true });
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
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    const failure = new AggregateError([new Error("read cleanup failed")], "cancel read failed");
    let needsRead = false;
    const read = releaseRead.promise.then(() => {
      needsRead = false;
      if (outcome === "failure") {
        throw failure;
      }
    });
    void read.catch(() => {});
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
          readEntered.resolve();
          return read;
        },
      },
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await awaitGateBeforeSettlement(
        phase === "accepted" ? interrupted.promise : mutationQueued.promise,
        pending,
        "Cancellation never reached its selected lifecycle phase.",
      );
      needsRead = true;
      blocker.release();
      admission.release();
      await awaitGateBeforeSettlement(
        readEntered.promise,
        pending,
        "Cancellation skipped pending caller preparation.",
      );
      expect(settled).toBe(false);
      expect(aborted).toHaveBeenCalledTimes(phase === "accepted" ? 1 : 0);
      expect(getSessionMutationCount()).toBeGreaterThan(0);
      if (terminal) {
        expect(await markSubagentRunTerminated({ runId, reason: "killed" })).toBe(1);
        expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("killed");
      }
      releaseRead.resolve();
      const result = await pending;
      if (outcome === "failure") {
        expect(result.killed).toBe(phase === "accepted");
        expect("error" in result ? result.error : undefined).toContain("cancel read failed");
        expect("error" in result ? result.error : undefined).not.toContain(
          "Caller facts were not prepared",
        );
      } else {
        expect(result.killed).toBe(true);
      }
      const stopped = phase === "accepted" || outcome === "ready";
      expect(aborted).toHaveBeenCalledTimes(Number(stopped));
      expect(subagentRuns.get(runId)?.killIntent).toBeUndefined();
      expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe(
        stopped ? "killed" : "running",
      );
    } finally {
      blocker.release();
      releaseRead.resolve();
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
    const removed = vi.fn(async () => {
      removals += 1;
      if (removals === queued.length) {
        allRemoved.resolve();
      }
      await cleanupGate.promise;
    });
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
      expect(getSessionControllerWorkCount()).toBe(running.length);
      expect(start).not.toHaveBeenCalled();
      for (const lease of leases.toReversed()) {
        lease.release();
      }
      await awaitProgress(allRemoved.promise, "Cancellation skipped a queued sibling");
      expect(removed).toHaveBeenCalledTimes(queued.length);
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
    const unrelatedStart = vi.fn(async () => {
      unrelatedStarted.resolve();
    });
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
      expect(unrelatedStart).toHaveBeenCalledOnce();
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
  const cleaning = createDeferred();
  const cleanupFinish = createDeferred();
  const admission = await beginSessionEffect({
    target,
    assertAllowed: () => {},
    onInterrupt: () => interrupted.resolve(),
  });
  const own = reserveSessionControllerSource(sessionKey, {
    target,
    policy: { mode: "followup" },
    adapter: {
      onSettled: async () => {
        cleaning.resolve();
        await cleanupFinish.promise;
      },
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
    await cleaning.promise;
    expect(own.abortSignal.aborted).toBe(true);
    expect(later.abortSignal.aborted).toBe(false);
    expect(foreign.abortSignal.aborted).toBe(false);
    expect(completed).toBe(false);
    cleanupFinish.resolve();
    expect(await pending).toMatchObject({ found: true, killed: true });
    await own.settlement.promise;
    expect(later.abortSignal.aborted).toBe(false);
  } finally {
    cleanupFinish.resolve();
    admission.release();
    await pending;
    const inputs = [own, foreign, ...(later ? [later] : [])];
    inputs.forEach(retireSessionControllerInput);
    await Promise.all(inputs.map((input) => input.settlement.promise));
  }
});
