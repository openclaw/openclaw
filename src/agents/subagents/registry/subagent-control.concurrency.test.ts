// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  runExclusiveSessionLifecycleMutation,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import * as nativeControl from "./subagent-control.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated, registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { finalizeInterruptedSubagentRun } from "./subagent-registry.test-helpers.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

it("does not transfer a selected task cancellation to an admitted follow-up generation", async () => {
  const owner = "agent:main:main";
  const sessionKey = "agent:main:subagent:selected-generation";
  const sessionId = "selected-generation-session";
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });
  await registerSubagentRun({
    runId: "selected-original",
    childSessionKey: sessionKey,
    requesterSessionKey: owner,
    requesterDisplayKey: owner,
    task: "Original work",
    cleanup: "keep",
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
  const tool = createSubagentsTool({ agentSessionKey: owner, config: getRuntimeConfig() });
  const pending = tool.execute("cancel-original", { action: "cancel", runId: original.runId });
  const controller = new AbortController();
  const handle = createEmbeddedRunHandle({
    runId: "selected-followup",
    abort: () => controller.abort(),
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Cancellation never reached its runtime handoff.");
      }),
    ]);
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
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    release.resolve();
    expect((await pending).details).toMatchObject({ killed: false });
    expect(controller.signal.aborted).toBe(false);
  } finally {
    release.resolve();
    await pending;
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it.each(["before interruption", "after interruption", "after abort"] as const)(
  "revalidates caller control for new stops and settles accepted stops when revoked %s",
  async (revocation) => {
    const sessionKey = "agent:main:subagent:caller-control";
    const sessionId = "caller-control-session";
    const runId = "caller-control-run";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "keep running until an authorized stop",
      cleanup: "keep",
      expectsCompletionMessage: false,
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
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const interrupted = createDeferred();
    const onInterrupt = vi.fn(() => {
      interrupted.resolve();
      if (revocation === "after abort") {
        admission.release();
      }
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker =
      revocation === "before interruption"
        ? runExclusiveSessionLifecycleMutation({
            scope: storePath,
            identities: [sessionKey, sessionId],
            run: async () => {
              blockerEntered.resolve();
              await releaseBlocker.promise;
            },
          })
        : Promise.resolve();
    if (revocation === "before interruption") {
      await blockerEntered.promise;
    }
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
        releaseBlocker.resolve();
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
      releaseBlocker.resolve();
      admission.release();
      await Promise.allSettled([blocker, pending]);
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
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
    const sessionKey = "agent:main:subagent:readiness";
    const sessionId = "readiness-session";
    const runId = "readiness-run";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "Retain cancellation ownership during preparation",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const controller = new AbortController();
    const aborted = vi.fn();
    controller.signal.addEventListener("abort", aborted, { once: true });
    const handle = createEmbeddedRunHandle({ runId, abort: () => controller.abort() });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const interrupted = createDeferred();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        controller.abort();
        interrupted.resolve();
        if (phase === "queued") {
          admission.release();
        }
        return { runId };
      },
    });
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker =
      phase === "queued"
        ? runExclusiveSessionLifecycleMutation({
            scope: storePath,
            identities: [sessionKey, sessionId],
            run: async () => {
              blockerEntered.resolve();
              await releaseBlocker.promise;
            },
          })
        : Promise.resolve();
    if (phase === "queued") {
      await blockerEntered.promise;
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
      if (phase === "accepted") {
        await interrupted.promise;
      }
      needsRead = true;
      releaseBlocker.resolve();
      admission.release();
      await Promise.race([
        readEntered.promise,
        pending.then(() => {
          throw new Error("Cancellation skipped pending caller preparation.");
        }),
      ]);
      expect(settled).toBe(false);
      expect(aborted).toHaveBeenCalledTimes(phase === "accepted" ? 1 : 0);
      expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);
      if (terminal) {
        expect(markSubagentRunTerminated({ runId, reason: "killed" })).toBe(1);
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
      releaseBlocker.resolve();
      releaseRead.resolve();
      admission.release();
      await Promise.allSettled([blocker, pending]);
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each(["bulk", "admin"] as const)(
  "%s cancellation interrupts every sibling before waiting for any sibling to drain",
  async (boundary) => {
    const requester = "agent:main:main";
    const sessionKey = (id: string) => `agent:main:subagent:${id}`;
    const owner = boundary === "admin" ? sessionKey("root") : requester;
    const running = Array.from({ length: 8 }, (_, index) => `running-${index}`);
    const queued = ["queued-0", "queued-1"];
    const selected = [...running, ...queued];
    let storePath = "";
    for (const id of boundary === "admin" ? ["root", ...selected] : selected) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: sessionKey(id),
        defaultSessionId: `${id}-session`,
      });
      await registerSubagentRun({
        runId: id,
        childSessionKey: sessionKey(id),
        requesterSessionKey: id === "root" ? requester : owner,
        requesterAgentId: "main",
        requesterDisplayKey: requester,
        task: id,
        cleanup: "keep",
        collect: true,
        queued: queued.includes(id),
        expectsCompletionMessage: false,
      });
    }
    const start = vi.fn(async () => {});
    const cleanupGate = createDeferred();
    const removed = vi.fn(async () => await cleanupGate.promise);
    for (const runId of queued) {
      enqueueSwarmRun({
        groupId: "sibling-cancellation",
        runId,
        maxConcurrent: running.length,
        activeRunIds: running,
        start,
        onStartFailure: () => true,
        onRemoved: removed,
      });
    }
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const leases: SessionWorkAdmissionLease[] = [];
    const activeRuns = running.map((runId) => ({
      runId,
      handle: createEmbeddedRunHandle({ runId }),
    }));
    for (const { runId, handle } of activeRuns) {
      setActiveEmbeddedRun(`${runId}-session`, handle, sessionKey(runId));
      leases.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey(runId), `${runId}-session`],
          assertAllowed: () => {},
          onInterrupt: () => {
            interrupted.push(runId);
            firstInterrupted.resolve();
            // Cancellation releases real scheduler capacity while these admissions
            // remain held. Selected queued children must still never dispatch.
            expect(releaseSwarmRun(runId)).toBe(true);
          },
        }),
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
              controllerSessionKey: owner,
              controllerAgentId: "main",
              callerSessionKey: owner,
              callerIsSubagent: false,
              controlScope: "children",
            },
            runs: selected.map((id) => subagentRuns.get(id)!),
          })
    ).finally(() => {
      settled = true;
    });
    try {
      await firstInterrupted.promise;
      await vi.waitFor(() => expect(interrupted.toSorted()).toEqual(running));
      expect(getActiveSessionWorkAdmissionCount()).toBe(running.length);
      expect(start).not.toHaveBeenCalled();
      for (const lease of leases.toReversed()) {
        lease.release();
      }
      await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(queued.length));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      cleanupGate.resolve();
      const result = await pending;
      expect(result).toMatchObject(
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
        clearActiveEmbeddedRun(`${runId}-session`, handle, sessionKey(runId));
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each(["after interrupt", "before capacity release"] as const)(
  "keeps a late descendant queued when registered %s on an independent sibling that releases first",
  async (registration) => {
    const owner = "agent:main:main";
    const key = (id: string) => `agent:main:subagent:${id}`;
    const parents = { a: owner, b: owner, d: key("a"), x: key("d"), g: key("d") };
    let storePath = "";
    const register = (id: keyof typeof parents, queued = false) =>
      registerSubagentRun({
        runId: id,
        childSessionKey: key(id),
        requesterSessionKey: parents[id],
        controllerSessionKey: parents[id],
        swarmRequesterSessionKey: parents[id],
        requesterAgentId: "main",
        requesterDisplayKey: parents[id],
        groupId: "shared-name",
        task: id,
        cleanup: "keep",
        collect: true,
        queued,
        expectsCompletionMessage: false,
      });
    for (const id of ["a", "b", "d", "x", "g"] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: key(id),
        defaultSessionId: `${id}-session`,
      });
      if (id !== "g") {
        await register(id);
      }
    }
    const unrelatedStart = vi.fn(async () => {});
    const startG = vi.fn(async () => {});
    const startFailure = vi.fn(() => true);
    enqueueSwarmRun({
      groupId: JSON.stringify(["main", owner, "shared-name"]),
      runId: "unrelated",
      maxConcurrent: 2,
      activeRunIds: ["a", "b"],
      start: unrelatedStart,
      onStartFailure: startFailure,
    });
    const aInterrupted = createDeferred();
    const bInterrupted = createDeferred();
    const bReleased = createDeferred();
    const admissionA = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("a"), "a-session"],
      assertAllowed: () => {},
      onInterrupt: () => aInterrupted.resolve(),
    });
    const admissionB = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("b"), "b-session"],
      assertAllowed: () => {},
      onInterrupt: () => bInterrupted.resolve(),
    });
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [key("d"), "d-session"],
      assertAllowed: () => {},
      onInterrupt: interruptD,
    });
    const registerG = () =>
      admissionD.run(async () => {
        const pendingRegistration = register("g", true);
        // Keep G queued before B releases capacity, without detaching its durable registration.
        enqueueSwarmRun({
          groupId: JSON.stringify(["main", key("d"), "shared-name"]),
          runId: "g",
          maxConcurrent: 1,
          activeRunIds: ["x"],
          start: startG,
          onStartFailure: startFailure,
        });
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
    setActiveEmbeddedRun("b-session", handleB, key("b"));
    setActiveEmbeddedRun("x-session", handleX, key("x"));
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: {
        controllerSessionKey: owner,
        controllerAgentId: "main",
        callerSessionKey: owner,
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [subagentRuns.get("a")!, subagentRuns.get("b")!],
    });
    try {
      await Promise.all([aInterrupted.promise, bInterrupted.promise]);
      expect(interruptD).not.toHaveBeenCalled();
      // Register after B's refresh, including immediately before its capacity release.
      // Reusing a group name does not merge different callers' scheduler lanes.
      if (registration === "after interrupt") {
        lateRegistration = registerG();
        await lateRegistration;
      }
      admissionB.release();
      await bReleased.promise;
      expect(lateRegistration).toBeDefined();
      await lateRegistration;
      await vi.waitFor(() => expect(unrelatedStart).toHaveBeenCalledOnce());
      expect(interruptD).not.toHaveBeenCalled();
      expect(startG).not.toHaveBeenCalled();
      admissionA.release();
      expect(await pending).toMatchObject({
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
      clearActiveEmbeddedRun("b-session", handleB, key("b"));
      clearActiveEmbeddedRun("x-session", handleX, key("x"));
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
