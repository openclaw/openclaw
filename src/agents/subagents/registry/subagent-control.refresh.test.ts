// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import * as generations from "../../../config/sessions/session-delivery-generation.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { runSessionMutation } from "../../../sessions/session-controller.lifecycle.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import * as killScope from "./subagent-control-kill-scope.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./subagent-control-native.test-support.js";
import * as killSession from "./subagent-control-session.js";
import {
  beginControlAdmission,
  controlController as controller,
  createControlRunFixture,
  enqueueControlRun,
  expectControlIdle,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import type { KillScope } from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import * as registryState from "./subagent-registry-state.js";
import { type registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const records = createControlRunFixture(() => fixture.stateDir);
const owner = "agent:main:main";
const sessionIdentity = (runId: string) => ({
  sessionId: `${runId}-session`,
  lifecycleRevision: `${runId}-revision`,
});
const writeSession = (runId: string, sessionKey: string, agentId = "main") =>
  records.writeSession(runId, sessionIdentity(runId).lifecycleRevision, {
    sessionKey,
    agentId,
  });
const registerRun = (
  runId: string,
  childSessionKey: string,
  requesterSessionKey = owner,
  overrides: Partial<Parameters<typeof registerSubagentRun>[0]> = {},
) =>
  records.register(runId, undefined, {
    childSessionKey,
    sessionEntry: sessionIdentity(runId),
    requesterSessionKey,
    controllerSessionKey: requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    collect: true,
    ...overrides,
  });

it.for(["complete", "reject undefined", "native failure"] as const)(
  "coalesces or retires refresh batches in the enclosing scope before %s",
  async (completion, { signal }) => {
    const rootKey = "agent:main:subagent:refresh-root";
    const sharedRawKey = completion === "complete";
    const nativeFailure = completion === "native failure";
    const failure = new SqliteWorkerError("discovery outcome unknown", "outcome-unknown");
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
      registerRun("refresh-" + id, key(id), id === "root" ? owner : rootKey, {
        childAgentId: agentId(id),
        requesterDisplayKey: "main",
        ...(nativeFailure && id === "root" ? { controllerSessionKey: undefined } : {}),
      });
    for (const id of ["root", "first", "second"]) {
      await writeSession("refresh-" + id, key(id), agentId(id));
    }
    await register("root");
    const lane = new AsyncLocalStorage<string>();
    const ready = createDeferred<KillScope>();
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
            if (nativeFailure && index === 0) {
              throw failure;
            }
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
          if (completion !== "complete") {
            const rejected = createDeferred<never>();
            rejected.reject();
            return await rejected.promise;
          }
          return "selected";
        },
        undefined,
        () => {
          publishedBeforeJoin ||= !finalReadSettled;
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
      void first.catch(() => {});
      await withinTest(entered[0]!.promise, signal);
      if (nativeFailure) {
        const results = Promise.allSettled([first, refresh("queued caller")]);
        gates[0]!.resolve();
        expect(await withinTest(results, signal)).toEqual([
          { status: "rejected", reason: failure },
          { status: "rejected", reason: failure },
        ]);
        expect(await Promise.allSettled([refresh("later caller")])).toEqual([
          { status: "rejected", reason: failure },
        ]);
        expect(contexts).toEqual(["kill-scope"]);
        finishRun.resolve();
        await expect(stopped).rejects.toBeInstanceOf(AggregateError);
        await expect(stopped).rejects.toMatchObject({ errors: [undefined, failure] });
        await expect(scope.refresh()).rejects.toThrow("refresh scope is no longer active");
        expect(contexts).toHaveLength(1);
        return;
      }
      await register("first");
      let middleSettled = false;
      const middle = Promise.all(
        ["second caller", "third caller", "fourth caller"].map(refresh),
      ).then((counts) => {
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
      expect([publishedBeforeJoin, releasedBeforeJoin]).toEqual([false, false]);
    } finally {
      release();
      await Promise.allSettled([...accepted, stopped]);
      signal.removeEventListener("abort", release);
      lane.disable();
    }
  },
);

it("retains a captured child prefix when the next child's session preparation fails", async () => {
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
    storePath = await writeSession(runId, sessionKey);
    await registerRun(runId, sessionKey, requesterSessionKey, { queued });
  }
  const firstStart = vi.fn(async () => {});
  const secondStart = vi.fn(async () => {});
  const unrelatedStart = vi.fn(async () => {});
  for (const [runId, groupId, active, start] of [
    ["prefix-first", "prefix", "prefix-root", firstStart],
    ["prefix-second", "prefix", "prefix-root", secondStart],
    ["unrelated-prefix", "unrelated-prefix", "unrelated-active", unrelatedStart],
  ] as const) {
    enqueueControlRun(groupId, runId, [active], start);
  }
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
    controller,
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

it.each([
  ...[undefined, 2, 4].map((faultAt) => ({ phase: "ancestor drain", faultAt })),
  { phase: "later sibling drain", faultAt: 1 },
])(
  "reports retained identity check $faultAt failure after $phase without losing descendant accounting",
  async ({ phase, faultAt }) => {
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
      storePath = await writeSession(runId, sessionKey);
      if (runId !== "g") {
        await registerRun(runId, sessionKey, requesterSessionKey);
      }
    }
    const a = subagentRuns.get("a")!;
    const d = subagentRuns.get("d")!;
    const healthy = subagentRuns.get("healthy")!;
    const admit = (key: string, id: string, interrupt: () => void) =>
      beginControlAdmission(storePath, key, id, interrupt);
    const entered = createDeferred();
    const admissionA = await admit(aKey, "a-session", entered.resolve);
    const interruptD = vi.fn(() => admissionD.release());
    const admissionD = await admit(dKey, "d-session", interruptD);
    const healthyEntered = createDeferred();
    const admissionHealthy = await admit(healthyKey, "healthy-session", () => {
      healthyEntered.resolve();
      if (phase === "ancestor drain") {
        admissionHealthy.release();
      }
    });
    const abortA = vi.fn();
    const abortD = vi.fn(() => {
      expect(releaseSwarmRun("d")).toBe(true);
    });
    const handleA = createEmbeddedRunHandle({ runId: "a", abort: abortA });
    const handleD = createEmbeddedRunHandle({ runId: "d", abort: abortD });
    attachActiveEmbeddedRun("a-session", handleA, aKey);
    attachActiveEmbeddedRun("d-session", handleD, dKey);
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
      controller,
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
        await registerRun("g", gKey, dKey, { queued: true });
        enqueueControlRun("late-refresh", "g", ["d"], startG, {
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
        await runSessionMutation({
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
        expect(result).toMatchObject({
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
        await detachActiveEmbeddedRun("a-session", handleA, aKey);
        await detachActiveEmbeddedRun("d-session", handleD, dKey);
      }
      expectControlIdle();
    }
  },
);
