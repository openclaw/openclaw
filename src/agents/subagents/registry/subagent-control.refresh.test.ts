// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** A transient discovery failure must survive successful runtime cancellation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import * as generations from "../../../config/sessions/session-delivery-generation.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  runExclusiveSessionLifecycleMutation,
} from "../../../sessions/session-lifecycle-admission.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import * as killScope from "./subagent-control-kill-scope.js";
import * as killSession from "./subagent-control-session.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

it.for(["complete", "reject undefined"] as const)(
  "coalesces fresh refresh batches in the enclosing scope before %s",
  async (completion, { signal }) => {
    const rootKey = "agent:main:subagent:refresh-root";
    const sharedRawKey = completion === "complete";
    if (sharedRawKey) {
      const cfg = getRuntimeConfig();
      setRuntimeConfigSnapshot({
        ...cfg,
        agents: {
          ...cfg.agents,
          ownership: "explicit",
          entries: { main: {}, research: {} },
        },
      });
    }
    const agentId = (id: string) => (sharedRawKey && id === "second" ? "research" : "main");
    const key = (id: string) =>
      id === "root" ? rootKey : sharedRawKey ? "global" : "agent:main:subagent:refresh-" + id;
    const register = (id: string) =>
      registerSubagentRun({
        runId: "refresh-" + id,
        childAgentId: agentId(id),
        childSessionKey: key(id),
        requesterSessionKey: id === "root" ? "agent:main:main" : rootKey,
        controllerSessionKey: id === "root" ? "agent:main:main" : rootKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: id,
        cleanup: "keep",
        collect: true,
        expectsCompletionMessage: false,
      });
    for (const id of ["root", "first", "second"]) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: agentId(id),
        sessionKey: key(id),
        defaultSessionId: "refresh-" + id + "-session",
      });
    }
    await register("root");
    const lane = new AsyncLocalStorage<string>();
    const ready = createDeferred<killScope.KillScope>();
    const finishRun = createDeferred();
    const runFinishing = createDeferred();
    const entered = Array.from({ length: 3 }, () => createDeferred());
    const gates = Array.from({ length: 3 }, () => createDeferred());
    const contexts: Array<string | undefined> = [];
    const accepted: Array<Promise<number>> = [];
    let observing = false;
    let finalReadSettled = false;
    let publishedBeforeJoin = false;
    let releasedBeforeJoin = false;
    const release = () => {
      gates.forEach((gate) => gate.resolve());
      finishRun.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    const read = registryState.withSubagentRunReadSnapshot;
    vi.spyOn(registryState, "withSubagentRunReadSnapshot").mockImplementation(
      (runs, select, consume, scope) => {
        const observe =
          observing &&
          lane.getStore() !== undefined &&
          scope !== "all" &&
          "sessionKeys" in scope &&
          scope.sessionKeys.includes(rootKey);
        const index = observe ? contexts.push(lane.getStore()) - 1 : -1;
        return read(runs, select, consume, scope).then(async (result) => {
          if (index >= 0 && index < gates.length) {
            entered[index]!.resolve();
            await gates[index]!.promise;
            if (index === 2) {
              finalReadSettled = true;
            }
          }
          return result;
        });
      },
    );
    const prepare = killSession.prepareSubagentKillSession;
    vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
      const session = await prepare(...args);
      return {
        ...session,
        release: async () => {
          releasedBeforeJoin ||= observing && !finalReadSettled;
          await session.release();
        },
      };
    });
    const stopped = lane.run("kill-scope", () =>
      killScope.withSubagentKillScope(
        { cfg: getRuntimeConfig(), runs: [subagentRuns.get("refresh-root")!] },
        async (scope) => {
          observing = true;
          ready.resolve(scope);
          await finishRun.promise;
          runFinishing.resolve();
          if (completion === "reject undefined") {
            const rejected = createDeferred<never>();
            rejected.reject();
            return await rejected.promise;
          }
          return "selected";
        },
        undefined,
        {
          prepare: async (publish) => {
            publishedBeforeJoin ||= !finalReadSettled;
            await publish();
          },
        },
      ),
    );
    const outcome = stopped.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const scope = await withinTest(ready.promise, signal);
      const refresh = (caller: string) => {
        const pending = lane.run(caller, scope.refresh);
        accepted.push(pending);
        return pending;
      };
      let firstSettled = false;
      const first = refresh("first caller").then((count) => {
        firstSettled = true;
        return count;
      });
      await withinTest(entered[0]!.promise, signal);
      await register("first");
      let middleSettled = false;
      const middle = Promise.all([
        refresh("second caller"),
        refresh("third caller"),
        refresh("fourth caller"),
      ]).then((counts) => {
        middleSettled = true;
        return counts;
      });
      gates[0]!.resolve();
      await withinTest(entered[1]!.promise, signal);
      expect(firstSettled, "the first batch must not wait for its held successor").toBe(true);
      expect(await first).toBe(1);
      await register("second");
      const tail = Promise.all([refresh("fifth caller"), refresh("sixth caller")]);
      gates[1]!.resolve();
      await withinTest(entered[2]!.promise, signal);
      expect(middleSettled, "each completed batch settles independently").toBe(true);
      expect(await middle).toEqual([2, 2, 2]);
      finishRun.resolve();
      await withinTest(runFinishing.promise, signal);
      gates[2]!.resolve();
      expect(await withinTest(tail, signal)).toEqual([3, 3]);
      expect(await outcome).toEqual(
        completion === "complete"
          ? { ok: true, value: "selected" }
          : { ok: false, error: undefined },
      );
      await expect(scope.refresh()).rejects.toThrow("refresh scope is no longer active");
      expect(contexts).toEqual(["kill-scope", "kill-scope", "kill-scope"]);
      expect(publishedBeforeJoin).toBe(false);
      expect(releasedBeforeJoin).toBe(false);
    } finally {
      release();
      await Promise.allSettled([...accepted, stopped]);
      signal.removeEventListener("abort", release);
      lane.disable();
    }
  },
);

it.for(["await refresh", "reject undefined"] as const)(
  "retires queued refreshes after an escaping native failure while the caller will %s",
  async (completion, { signal }) => {
    const rootKey = "agent:main:subagent:refresh-failure";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: rootKey,
      defaultSessionId: "refresh-failure-session",
    });
    await registerSubagentRun({
      runId: "refresh-failure",
      childSessionKey: rootKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "failed discovery",
      cleanup: "keep",
      collect: true,
      expectsCompletionMessage: false,
    });
    const ready = createDeferred<killScope.KillScope>();
    const entered = createDeferred();
    const finishRun = createDeferred();
    const releaseRead = createDeferred();
    const failure = new SqliteWorkerError("discovery outcome unknown", "outcome-unknown");
    const accepted: Array<Promise<number>> = [];
    let observing = false;
    let reads = 0;
    const release = () => {
      finishRun.resolve();
      releaseRead.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    const read = registryState.withSubagentRunReadSnapshot;
    vi.spyOn(registryState, "withSubagentRunReadSnapshot").mockImplementation(
      (runs, select, consume, scope) => {
        const index =
          observing &&
          scope !== "all" &&
          "sessionKeys" in scope &&
          scope.sessionKeys.includes(rootKey)
            ? ++reads
            : 0;
        return read(runs, select, consume, scope).then(async (result) => {
          if (index === 1) {
            entered.resolve();
            await releaseRead.promise;
            throw failure;
          }
          return result;
        });
      },
    );
    const stopped = killScope.withSubagentKillScope(
      { cfg: getRuntimeConfig(), runs: [subagentRuns.get("refresh-failure")!] },
      async (scope) => {
        observing = true;
        ready.resolve(scope);
        await finishRun.promise;
        if (completion === "reject undefined") {
          const rejected = createDeferred<never>();
          rejected.reject();
          return await rejected.promise;
        }
        return await accepted[0]!;
      },
    );
    const outcome = stopped.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const scope = await withinTest(ready.promise, signal);
      const first = scope.refresh();
      accepted.push(first);
      void first.catch(() => {});
      await withinTest(entered.promise, signal);
      accepted.push(scope.refresh());
      const results = Promise.allSettled(accepted);
      releaseRead.resolve();
      expect(await withinTest(results, signal)).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      const later = scope.refresh();
      accepted.push(later);
      expect(await Promise.allSettled([later])).toEqual([{ status: "rejected", reason: failure }]);
      expect(reads, "native uncertainty retires the accepted successor batch").toBe(1);
      finishRun.resolve();
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        if (completion === "await refresh") {
          expect(result.error).toBe(failure);
        } else {
          expect(result.error).toBeInstanceOf(AggregateError);
          if (result.error instanceof AggregateError) {
            expect(result.error.errors).toEqual([undefined, failure]);
          }
        }
      }
      await expect(scope.refresh()).rejects.toThrow("refresh scope is no longer active");
      expect(reads).toBe(1);
    } finally {
      release();
      await Promise.allSettled([...accepted, stopped]);
      signal.removeEventListener("abort", release);
    }
  },
);

it("retains a captured child prefix when the next child's session preparation fails", async () => {
  const owner = "agent:main:main";
  const rootKey = "agent:main:subagent:prefix-root";
  const firstKey = "agent:main:subagent:prefix-first";
  const secondKey = "agent:main:subagent:prefix-second";
  const healthyKey = "agent:main:subagent:prefix-healthy";
  let storePath = "";
  for (const [runId, sessionKey, requesterSessionKey, queued] of [
    ["prefix-root", rootKey, owner, false],
    ["prefix-first", firstKey, rootKey, true],
    ["prefix-second", secondKey, rootKey, true],
    ["prefix-healthy", healthyKey, owner, false],
  ] as const) {
    storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: `${runId}-session`,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey,
      controllerSessionKey: requesterSessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterSessionKey,
      task: runId,
      cleanup: "keep",
      collect: true,
      queued,
      expectsCompletionMessage: false,
    });
  }
  const firstStart = vi.fn(async () => {});
  const secondStart = vi.fn(async () => {});
  const unrelatedStart = vi.fn(async () => {});
  for (const [runId, start] of [
    ["prefix-first", firstStart],
    ["prefix-second", secondStart],
  ] as const) {
    enqueueSwarmRun({
      groupId: "prefix",
      runId,
      maxConcurrent: 1,
      activeRunIds: ["prefix-root"],
      start,
      onStartFailure: () => true,
    });
  }
  enqueueSwarmRun({
    groupId: "unrelated-prefix",
    runId: "unrelated-prefix",
    maxConcurrent: 1,
    activeRunIds: ["unrelated-active"],
    start: unrelatedStart,
    onStartFailure: () => true,
  });
  const prepare = generations.prepareSessionGenerationFacts;
  let capturedFirst = false;
  let failedReads = 0;
  const failure = "next child session preparation unavailable";
  vi.spyOn(generations, "prepareSessionGenerationFacts").mockImplementation(async (input) => {
    if (capturedFirst && input.sessionKey === secondKey && failedReads === 0) {
      failedReads += 1;
      throw new Error(failure);
    }
    const generation = await prepare(input);
    if (input.sessionKey === firstKey) {
      capturedFirst = true;
    }
    return generation;
  });
  const result = await killAllControlledSubagentRuns({
    cfg: getRuntimeConfig(),
    controller: {
      controllerSessionKey: owner,
      controllerAgentId: "main",
      callerSessionKey: owner,
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [subagentRuns.get("prefix-root")!, subagentRuns.get("prefix-healthy")!],
    beforeKill: () => {
      releaseSwarmRun("unrelated-active");
      return true;
    },
  });
  expect(failedReads).toBe(1);
  expect(
    sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry,
  ).toBeDefined();
  expect(result).toMatchObject({
    status: "error",
    failed: 1,
    error: expect.stringContaining(failure),
  });
  expect(
    firstStart,
    "an already captured reservation cannot escape on scope disposal",
  ).not.toHaveBeenCalled();
  expect(resolveSubagentSessionStatus(subagentRuns.get("prefix-first"))).toBe("killed");
  expect(resolveSubagentSessionStatus(subagentRuns.get("prefix-second"))).not.toBe("killed");
  expect(resolveSubagentSessionStatus(subagentRuns.get("prefix-healthy"))).toBe("killed");
  expect(unrelatedStart).toHaveBeenCalledOnce();
});

// Sweep retained identity checks after admission interruption. Every injected
// failure must remain visible while independent siblings still settle.
it.each([
  ...[undefined, 1, 2, 3, 4].map((faultAt) => ({ phase: "ancestor drain", faultAt })),
  ...[undefined, 1].map((faultAt) => ({ phase: "later sibling drain", faultAt })),
])(
  "reports retained identity check $faultAt failure after $phase without losing descendant accounting",
  async ({ phase, faultAt }) => {
    const owner = "agent:main:main";
    const aKey = "agent:main:subagent:ancestor";
    const dKey = "agent:main:subagent:active-child";
    const gKey = "agent:main:subagent:late-grandchild";
    const healthyKey = "agent:main:subagent:healthy";
    let storePath = "";
    for (const [runId, sessionKey, requesterSessionKey] of [
      ["a", aKey, owner],
      ["d", dKey, aKey],
      ["healthy", healthyKey, owner],
      ["g", gKey, dKey],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
        lifecycleRevision: `${runId}-revision`,
      });
      if (runId !== "g") {
        await registerSubagentRun({
          runId,
          childSessionKey: sessionKey,
          requesterSessionKey,
          controllerSessionKey: requesterSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: requesterSessionKey,
          task: runId,
          cleanup: "keep",
          expectsCompletionMessage: false,
          collect: true,
        });
      }
    }
    const a = subagentRuns.get("a")!;
    const d = subagentRuns.get("d")!;
    const healthy = subagentRuns.get("healthy")!;
    const entered = createDeferred();
    const admissionA = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [aKey, "a-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [dKey, "d-session"],
      assertAllowed: () => {},
      onInterrupt: interruptD,
    });
    const healthyEntered = createDeferred();
    const admissionHealthy = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [healthyKey, "healthy-session"],
      assertAllowed: () => {},
      onInterrupt: () => {
        healthyEntered.resolve();
        if (phase === "ancestor drain") {
          admissionHealthy.release();
        }
      },
    });
    const abortA = vi.fn();
    const abortD = vi.fn(() => {
      expect(releaseSwarmRun("d")).toBe(true);
    });
    const handleA = createEmbeddedRunHandle({ runId: "a", abort: abortA });
    const handleD = createEmbeddedRunHandle({ runId: "d", abort: abortD });
    setActiveEmbeddedRun("a-session", handleA, aKey);
    setActiveEmbeddedRun("d-session", handleD, dKey);
    const startG = vi.fn(async () => {
      expect(await startQueuedSubagentRun("g")).toBe(true);
    });
    const startFailure = vi.fn(() => true);
    const prepare = generations.prepareSessionGenerationFacts;
    let armed = false;
    let reads = 0;
    let failedReads = 0;
    const failure = "transient ancestor identity facts unavailable";
    const reader = vi
      .spyOn(generations, "prepareSessionGenerationFacts")
      .mockImplementation(async (input) => {
        const generation = await prepare(input);
        return {
          ...generation,
          assertCurrent() {
            generation.assertCurrent();
            if (armed && input.sessionKey === aKey) {
              reads += 1;
              if (reads === faultAt) {
                failedReads += 1;
                throw new Error(failure);
              }
            }
          },
        };
      });
    const grandchildCancelled = createDeferred();
    const stopObserving = subscribeSubagentRunChanges("projection", ({ runIds }) => {
      if (
        runIds?.includes("g") &&
        resolveSubagentSessionStatus(subagentRuns.get("g")) === "killed"
      ) {
        grandchildCancelled.resolve();
      }
    });
    const pending = killAllControlledSubagentRuns({
      cfg: getRuntimeConfig(),
      controller: {
        controllerSessionKey: owner,
        controllerAgentId: "main",
        callerSessionKey: owner,
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [a, healthy],
    });
    const awaitProgress = (signal: Promise<void>, label: string) =>
      Promise.race([
        signal,
        pending.then((result) => {
          throw new Error(`${label} was not reached: ${JSON.stringify(result)}`);
        }),
      ]);
    try {
      await awaitProgress(entered.promise, "ancestor interruption");
      expect(failedReads, "initial binding and iteration entered without a fault").toBe(0);
      expect(abortA).not.toHaveBeenCalled();
      expect(interruptD, "D remains admitted while A drains").not.toHaveBeenCalled();
      expect(d.execution.status).toBe("running");
      expect(subagentRuns.has("g")).toBe(false);
      // D, not the interrupted ancestor A, owns this accepted late registration.
      await admissionD.run(async () => {
        await registerSubagentRun({
          runId: "g",
          childSessionKey: gKey,
          requesterSessionKey: dKey,
          controllerSessionKey: dKey,
          requesterAgentId: "main",
          requesterDisplayKey: dKey,
          task: "late grandchild",
          cleanup: "keep",
          expectsCompletionMessage: false,
          collect: true,
          queued: true,
        });
        enqueueSwarmRun({
          groupId: "late-refresh",
          runId: "g",
          maxConcurrent: 1,
          activeRunIds: ["d"],
          start: startG,
          onStartFailure: startFailure,
        });
      });
      expect(startG).not.toHaveBeenCalled();
      armed = phase === "ancestor drain";
      admissionA.release();
      if (phase === "later sibling drain") {
        await awaitProgress(healthyEntered.promise, "healthy sibling interruption");
        await awaitProgress(grandchildCancelled.promise, "grandchild cancellation publication");
        // Publication precedes G's abort-marker write. Join its mutation from
        // outside the observer's reentrant context before arming the next fault.
        await runExclusiveSessionLifecycleMutation("subagent-kill", {
          scope: storePath,
          identities: [gKey, "g-session"],
          run: async () => {},
        });
        expect(subagentRuns.get(a.runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
        expect(subagentRuns.get(d.runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
        expect(resolveSubagentSessionStatus(subagentRuns.get("g"))).toBe("killed");
        expect(startG).not.toHaveBeenCalled();
        armed = true;
        admissionHealthy.release();
      }
      const result = await pending;
      expect(
        subagentRuns.get(healthy.runId)?.endedReason,
        "independent healthy sibling still stops",
      ).toBe(SUBAGENT_ENDED_REASON_KILLED);
      expect(startFailure).not.toHaveBeenCalled();
      if (faultAt === undefined) {
        expect(result).toMatchObject({ status: "ok", killed: 4 });
        expect(resolveSubagentSessionStatus(subagentRuns.get("g"))).toBe("killed");
        expect(startG).not.toHaveBeenCalled();
      } else {
        expect(failedReads, "exactly one transient identity-facts fault").toBe(1);
        expect(
          sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: aKey })?.entry.sessionId,
        ).toBe("a-session");
        const observation = JSON.stringify({
          phase,
          faultAt,
          failedReads,
          aKilled: subagentRuns.get(a.runId)?.endedReason,
          dKilled: subagentRuns.get(d.runId)?.endedReason,
          healthyKilled: subagentRuns.get(healthy.runId)?.endedReason,
          gTask: resolveSubagentSessionStatus(subagentRuns.get("g")),
          gExecution: subagentRuns.get("g")?.execution.status,
          gDispatches: startG.mock.calls.length,
          result,
        });
        expect(result, observation).toMatchObject({
          status: "error",
          failed: 1,
          error: expect.stringContaining(failure),
        });
      }
    } finally {
      armed = false;
      stopObserving();
      admissionA.release();
      admissionD.release();
      admissionHealthy.release();
      try {
        await pending;
      } finally {
        reader.mockRestore();
        releaseSwarmRun("d");
        releaseSwarmRun("g");
        clearActiveEmbeddedRun("a-session", handleA, aKey);
        clearActiveEmbeddedRun("d-session", handleD, dKey);
      }
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
