// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
/** A transient discovery failure must survive successful runtime cancellation. */
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import * as generations from "../../../config/sessions/session-delivery-generation.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  runExclusiveSessionLifecycleMutation,
} from "../../../sessions/session-lifecycle-admission.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const nativeState = await vi.importActual<typeof registryState>("./subagent-registry-state.js");
beforeEach(() => {
  vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    nativeState.persistSubagentRunsToDiskAsyncOrThrow,
  );
});

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
      expect(startQueuedSubagentRun("g")).toBe(true);
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
    const stopObserving = subscribeSubagentRunChanges((runIds) => {
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
        await runExclusiveSessionLifecycleMutation({
          scope: storePath,
          identities: [gKey, "g-session"],
          run: async () => {},
        });
        expect(a.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
        expect(d.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
        expect(resolveSubagentSessionStatus(subagentRuns.get("g"))).toBe("killed");
        expect(startG).not.toHaveBeenCalled();
        armed = true;
        admissionHealthy.release();
      }
      const result = await pending;
      expect(healthy.endedReason, "independent healthy sibling still stops").toBe(
        SUBAGENT_ENDED_REASON_KILLED,
      );
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
          aKilled: a.endedReason,
          dKilled: d.endedReason,
          healthyKilled: healthy.endedReason,
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
