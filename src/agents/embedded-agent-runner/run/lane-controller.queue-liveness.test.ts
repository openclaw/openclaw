import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  isAgentRunWaitingForCapacity,
  registerAgentRunCapacityWait,
} from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  sweepStaleRunContexts,
} from "../../../infra/agent-run-registry.js";
import {
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import {
  getExistingSessionControllerMailbox,
  abortSessionControllerInput,
  isSessionControllerSourceQueued,
} from "../../../sessions/session-controller.mailbox.js";
import { isReplyRunEvidenceStale } from "../../../sessions/session-controller.state.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { installSessionPlacementAdmissionProvider } from "../../session-placement-admission.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

// mock-isolation: Context-retention unit cases exercise mailbox and capacity, not durable writers.
vi.mock("./session-bootstrap.js", () => ({
  claimAgentSessionWriter: vi.fn(async () => undefined),
}));

const CONTEXT_TTL_MS = 30 * 60 * 1000;
const GLOBAL_LANE = "queued-run-context-global";
const registeredAt = 1_000;
const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;

function createRunResult(): EmbeddedAgentRunResult {
  return { meta: { durationMs: 1 } };
}

function rejectUnexpectedCompactionSuccessor(): never {
  throw new Error("Unexpected compaction successor during queue liveness test");
}

function createRunController(
  overrides: Partial<RunEmbeddedAgentParams> = {},
  context: Parameters<typeof registerAgentRunContext>[1] = {},
) {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const runId = overrides.runId ?? "healthy-queued-run";
  const params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    lifecycleGeneration,
    prompt: "queued run",
    runId,
    sessionFile: "/tmp/queued-run.jsonl",
    sessionId: "queued-session",
    timeoutMs: 60_000,
    workspaceDir: "/tmp",
    ...overrides,
  };
  const { controller } = createLaneControllerFixture(params, {
    globalLane: GLOBAL_LANE,
    lifecycleGeneration,
  });
  registerAgentRunContext(runId, { lifecycleGeneration, registeredAt, ...context });
  return {
    controller,
    params,
    enqueue: (task = async () => createRunResult()) =>
      controller.enqueueSession(() => controller.enqueueGlobal(task)),
  };
}

function placementGate(
  execute: Parameters<typeof installSessionPlacementAdmissionProvider>[0]["executeTurn"] = async (
    _claim,
    _params,
    runLocal,
  ) => await runLocal(),
) {
  const entered = createDeferred();
  const resume = createDeferred();
  const uninstall = installSessionPlacementAdmissionProvider({
    assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
    executeLocalTurn: async (_claim, runLocal) => await runLocal(),
    executeTurn: async (...args) => {
      entered.resolve();
      await resume.promise;
      return await execute(...args);
    },
  });
  return { entered: entered.promise, resume: resume.resolve, uninstall };
}

async function waitForQueuedLane(lane: string): Promise<void> {
  for (let turn = 0; turn < 10 && getCommandLaneSnapshot(lane).queuedCount === 0; turn++) {
    await Promise.resolve();
  }
  expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
}

function blockQueue(queue: "session" | "global") {
  const sessionKey = "agent:main:queued-cancellation";
  const predecessor =
    queue === "session"
      ? createReplyOperation({ sessionKey, sessionId: "queued-session", resetTriggered: false })
      : undefined;
  const queued = createDeferred();
  if (queue === "global") {
    setCommandLaneConcurrency(GLOBAL_LANE, 0);
  }
  const sources = () => [...(getExistingSessionControllerMailbox(sessionKey)?.entries ?? [])];
  const depth = () =>
    queue === "session"
      ? sources().filter(
          (input) => isSessionControllerSourceQueued(input) && !input.retirementRequested,
        ).length
      : getCommandLaneSnapshot(GLOBAL_LANE).queuedCount;
  return {
    sessionKey,
    onQueued: () => queued.resolve(),
    async wait() {
      if (queue === "global") {
        await queued.promise;
      }
      expect(depth()).toBe(1);
    },
    depth,
    cancel: () =>
      sources().filter((input) =>
        abortSessionControllerInput(input, new Error("source owner cancelled waiting work")),
      ).length,
    release() {
      predecessor?.complete();
      if (queue === "global") {
        setCommandLaneConcurrency(GLOBAL_LANE, 1);
      }
    },
  };
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

describe("queued embedded run context liveness", () => {
  test.each([{ blockedLane: GLOBAL_LANE, queue: "global" }])(
    "retains a healthy run past the context TTL while the $queue lane is full",
    async ({ blockedLane }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { controller, params } = createRunController();

      registerAgentRunContext(params.runId, {
        agentId: "main",
        isControlUiVisible: false,
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:queued",
      });
      registerAgentRunContext("abandoned-run", {
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:abandoned",
      });
      setCommandLaneConcurrency(blockedLane, 0);

      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );

      try {
        await waitForQueuedLane(blockedLane);

        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext("abandoned-run")).toBeUndefined();
        expect(getAgentRunContext(params.runId)).toMatchObject({ lifecycleGeneration });

        setCommandLaneConcurrency(blockedLane, 1);
        await run;
        expect(getAgentRunContext(params.runId)).toMatchObject({
          agentId: "main",
          isControlUiVisible: false,
          lastActiveAt: admissionAt,
          registeredAt,
          sessionKey: "agent:main:subagent:queued",
        });

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
        expect(sweepStaleRunContexts()).toBe(0);

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
      } finally {
        setCommandLaneConcurrency(blockedLane, 1);
        await run.catch(() => {});
      }
    },
  );

  test("retains context past the TTL while worker placement admission is pending", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const replyOperation = createReplyOperation({
      sessionId: "queued-session",
      sessionKey: "agent:main:subagent:queued",
      resetTriggered: false,
    });
    const context = {
      agentId: "main",
      isControlUiVisible: false,
      registeredAt,
      sessionKey: "agent:main:subagent:queued",
    };
    const { params, enqueue } = createRunController(
      { replyOperation, sessionKey: replyOperation.key },
      context,
    );

    const placement = placementGate();
    const run = enqueue();

    try {
      await placement.entered;
      expect(replyOperation.phase).toBe("waiting_for_global_lane");
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);

      clock.mockReturnValue(admissionAt);
      expect(isReplyRunEvidenceStale(replyOperation)).toBe(false);
      expect(sweepStaleRunContexts()).toBe(0);
      expect(getAgentRunContext(params.runId)).toMatchObject(context);

      placement.resume();
      await run;
      expect(replyOperation.phase).toBe("running");
      expect(getAgentRunContext(params.runId)).toMatchObject({
        ...context,
        lastActiveAt: admissionAt,
      });

      clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    } finally {
      placement.resume();
      placement.uninstall();
      await run.catch(() => {});
      replyOperation.complete();
    }
  });

  test("releases remote queue ownership at worker admission, not after worker completion", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const onLaneWait = vi.fn();
    const { params, enqueue } = createRunController(
      { onLaneWait },
      { sessionKey: "agent:main:subagent:queued" },
    );
    const changed = vi.fn();
    onTestFinished(sessionChanges.subscribe(changed));

    const remoteStarted = createDeferred();
    const remoteFinished = createDeferred();
    const localTurn = vi.fn(async () => createRunResult());
    const placement = placementGate(async (_claim, _params, _runLocal, onAdmitted) => {
      onAdmitted?.();
      remoteStarted.resolve();
      await remoteFinished.promise;
      return createRunResult();
    });
    const run = enqueue(localTurn);

    try {
      await placement.entered;
      expect(onLaneWait).not.toHaveBeenCalledWith(expect.objectContaining({ waiting: false }));
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:main:subagent:queued",
        agentId: undefined,
        scope: "runtime",
      });
      changed.mockClear();
      clock.mockReturnValue(admissionAt);
      expect(sweepStaleRunContexts()).toBe(0);
      expect(getAgentRunContext(params.runId)).toBeDefined();

      placement.resume();
      await remoteStarted.promise;
      expect(onLaneWait).toHaveBeenCalledExactlyOnceWith({
        waitMs: 0,
        queuedAhead: 0,
        waiting: false,
      });
      expect(getAgentRunContext(params.runId)?.lastActiveAt).toBe(admissionAt);
      expect(changed.mock.calls).toEqual([
        [{ sessionKey: "agent:main:subagent:queued", agentId: undefined, scope: "runtime" }],
        [{ sessionKey: "agent:main:subagent:queued", agentId: undefined, scope: "runtime" }],
      ]);
      expect(localTurn).not.toHaveBeenCalled();

      clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);

      remoteFinished.resolve();
      await run;
    } finally {
      placement.resume();
      remoteFinished.resolve();
      placement.uninstall();
      await run.catch(() => {});
    }
  });

  test.each(["session", "global"] as const)(
    "releases %s waiting context when its caller aborts",
    async (queue) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const abort = new AbortController();
      const blocked = blockQueue(queue);
      const { controller, params } = createRunController({
        sessionKey: blocked.sessionKey,
        abortSignal: abort.signal,
      });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      const execute = vi.fn(async () => createRunResult());
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(execute, { onQueued: blocked.onQueued }),
      );
      const rejected = expect(run).rejects.toThrow("queued run canceled");
      try {
        await blocked.wait();
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(queue === "global");
        abort.abort(new Error("queued run canceled"));
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
        await rejected;
        expect(blocked.depth()).toBe(0);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        blocked.release();
        await run.catch(() => {});
      }
    },
  );

  test.each(["session", "global"] as const)(
    "releases %s waiting context when its source owner cancels pending work",
    async (queue) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const blocked = blockQueue(queue);
      const { controller, params } = createRunController({ sessionKey: blocked.sessionKey });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      const execute = vi.fn(async () => createRunResult());
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(execute, { onQueued: blocked.onQueued }),
      );
      const rejected = expect(run).rejects.toThrow();
      try {
        await blocked.wait();
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(blocked.cancel()).toBe(1);
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
        await rejected;
        expect(blocked.depth()).toBe(0);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        blocked.release();
        await run.catch(() => {});
      }
    },
  );

  test("releases ownership when a custom queue rejects admission synchronously", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { params, enqueue } = createRunController({
      enqueue: () => {
        throw new Error("custom lane rejected admission");
      },
    });

    await expect(enqueue()).rejects.toThrow("custom lane rejected admission");

    clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
    expect(sweepStaleRunContexts()).toBe(1);
    expect(getAgentRunContext(params.runId)).toBeUndefined();
  });

  test.each(["user", "cron"] as const)(
    "handles queued %s work from a retired lifecycle",
    async (trigger) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { params, enqueue } = createRunController({ trigger, sessionPersistence: "detached" });
      const localTurn = vi.fn(async () => createRunResult());
      setCommandLaneConcurrency(GLOBAL_LANE, 0);
      const run = enqueue(localTurn);
      try {
        await waitForQueuedLane(GLOBAL_LANE);
        if (trigger === "user") {
          clock.mockReturnValue(admissionAt);
          expect(sweepStaleRunContexts()).toBe(0);
        }
        const replacementGeneration = rotateAgentEventLifecycleGeneration();
        if (trigger === "cron") {
          clock.mockReturnValue(admissionAt);
        }
        expect(sweepStaleRunContexts()).toBe(1);
        if (trigger === "user") {
          expect(getAgentRunContext(params.runId)).toBeUndefined();
          const changed = vi.fn();
          onTestFinished(sessionChanges.subscribe(changed));
          setCommandLaneConcurrency(GLOBAL_LANE, 1);
          await run;
          expect(getAgentRunContext(params.runId)).toMatchObject({
            lifecycleGeneration: replacementGeneration,
            lastActiveAt: admissionAt,
            sessionId: params.sessionId,
          });
          expect(changed).toHaveBeenCalledExactlyOnceWith({
            all: true,
            scope: "agent-runs",
            runtimeSession: { sessionId: params.sessionId, agentId: undefined },
          });
          expect(localTurn).toHaveBeenCalledOnce();
          clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
          expect(sweepStaleRunContexts()).toBe(0);
        } else {
          setCommandLaneConcurrency(GLOBAL_LANE, 1);
          await expect(run).rejects.toThrow("stale gateway lifecycle");
          expect(getAgentRunContext(params.runId)).toBeUndefined();
        }
      } finally {
        setCommandLaneConcurrency(GLOBAL_LANE, 1);
        await run.catch(() => {});
      }
    },
  );

  test.each(["local", "remote"] as const)(
    "rejects %s execution when its lifecycle rotates during placement admission",
    async (execution) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { params, enqueue } = createRunController(
        { trigger: "user", sessionPersistence: "detached" },
        { sessionKey: "agent:main:original" },
      );
      const localTurn = vi.fn(async () => createRunResult());
      const placement = placementGate(async (_claim, _params, runLocal, onAdmitted) => {
        if (execution === "remote") {
          onAdmitted?.();
          return createRunResult();
        }
        return await runLocal();
      });
      const run = enqueue(localTurn);

      try {
        await placement.entered;
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        const replacementGeneration = rotateAgentEventLifecycleGeneration();
        expect(sweepStaleRunContexts()).toBe(1);
        registerAgentRunContext(params.runId, {
          lifecycleGeneration: replacementGeneration,
          registeredAt: Date.now(),
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        const changed = vi.fn();
        onTestFinished(sessionChanges.subscribe(changed));

        placement.resume();
        await expect(run).rejects.toThrow("stale gateway lifecycle");
        expect(getAgentRunContext(params.runId)).toMatchObject({
          lifecycleGeneration: replacementGeneration,
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        expect(changed).not.toHaveBeenCalled();
        expect(localTurn).not.toHaveBeenCalled();
      } finally {
        placement.resume();
        placement.uninstall();
        await run.catch(() => {});
      }
    },
  );
});

describe("scheduler capacity wait projection", () => {
  test.each([GLOBAL_LANE, undefined])(
    "publishes only actual %s queue waits and clears before placement setup",
    async (blockedLane) => {
      const sessionKey = "agent:main:capacity";
      const { controller, params } = createRunController({ sessionKey });
      registerAgentRunContext(params.runId, {
        sessionKey,
        sessionId: params.sessionId,
        lifecycleGeneration: params.lifecycleGeneration,
      });
      const events: boolean[] = [];
      const unsubscribe = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === sessionKey && event.reason === "run-capacity") {
          events.push(isAgentRunWaitingForCapacity(params.runId));
        }
      });
      const placementEntered = createDeferred();
      const resumePlacement = createDeferred();
      const uninstallPlacement = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: rejectUnexpectedCompactionSuccessor,
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal) => {
          placementEntered.resolve();
          await resumePlacement.promise;
          return await runLocal();
        },
      });
      if (blockedLane) {
        setCommandLaneConcurrency(blockedLane, 0);
      }
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => createRunResult()),
      );
      try {
        if (blockedLane) {
          await waitForQueuedLane(blockedLane);
          expect(events).toEqual([true]);
          setCommandLaneConcurrency(blockedLane, 1);
        }
        await placementEntered.promise;
        expect(isAgentRunWaitingForCapacity(params.runId)).toBe(false);
        expect(events).toEqual(blockedLane ? [true, false] : []);
      } finally {
        if (blockedLane) {
          setCommandLaneConcurrency(blockedLane, 1);
        }
        resumePlacement.resolve();
        try {
          await run;
        } finally {
          uninstallPlacement();
          unsubscribe();
        }
      }
    },
  );

  test.each([
    { name: "registration", replace: registerAgentRunContext },
    { name: "claim", replace: claimAgentRunContext },
  ])("old wait releases cannot clear a recycled run after $name", ({ replace }) => {
    const runId = "recycled-capacity-run";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, { lifecycleGeneration });
    const releaseOld = registerAgentRunCapacityWait(runId, lifecycleGeneration);
    const oldContext = getAgentRunContext(runId);
    clearAgentRunContext(runId);
    replace(runId, { ...oldContext, lifecycleGeneration });
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
    const releaseNew = registerAgentRunCapacityWait(runId, lifecycleGeneration);
    releaseOld?.();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(true);
    releaseNew?.();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
  });
});
