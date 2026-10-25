import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
  isCommandLaneTaskTimeoutError,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type {
  CommandQueueEnqueueFn,
  CommandQueueEnqueueOptions,
} from "../../../process/command-queue.types.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import {
  getSessionControllerOperation,
  readSessionControllerOperationState,
} from "../../../sessions/session-controller.state.js";
import { testing } from "../../../sessions/session-controller.test-support.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { detachActiveEmbeddedRun, attachActiveEmbeddedRun } from "../runs.js";
import { createEmbeddedRunHandle } from "../runs.test-support.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import { EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS as GRACE_MS } from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";

// mock-isolation: Deadline and custody tests exercise raw work without durable writer admission.
vi.mock("./session-bootstrap.js", () => ({
  claimAgentSessionWriter: vi.fn(async () => undefined),
}));

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resetAgentEventsForTest();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetCommandQueueStateForTest();
  resetAgentEventsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

const key = "agent:main:controller-execution";
const globalLane = "test:controller-global";
function create(runId: string, overrides: Partial<RunEmbeddedAgentParams> = {}, lane = globalLane) {
  const params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: overrides.admittedRunContext ?? createTestAdmittedRunContext(runId),
    sessionKey: key,
    sessionId: "incarnation",
    runId,
    sessionFile: "controller-execution.jsonl",
    workspaceDir: "/tmp/controller-execution",
    prompt: "test",
    timeoutMs: 60_000,
    trigger: "user",
    ...overrides,
  };
  return createLaneControllerFixture(params, { globalLane: lane, configureRuntime: false });
}

function pauseSession(
  { controller }: ReturnType<typeof create>,
  options?: CommandQueueEnqueueOptions,
  resume = async () => controller.throwIfAborted(),
) {
  const entered = createDeferred();
  const finish = createDeferred();
  const run = controller.enqueueSession(async () => {
    entered.resolve();
    await finish.promise;
    await resume();
  }, options);
  return { entered: entered.promise, finish: finish.resolve, run };
}

const result = async () => ({ meta: { durationMs: 1 } });
const replyOperation = (sessionId = "incarnation") =>
  createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });

function pauseGlobal(
  { controller }: ReturnType<typeof create>,
  options?: CommandQueueEnqueueOptions,
  rawFailure?: Error,
) {
  const entered = createDeferred();
  const raw = createDeferred();
  const task = () =>
    controller.enqueueGlobal(async () => {
      entered.resolve();
      await raw.promise;
      if (rawFailure) {
        throw rawFailure;
      }
      controller.throwIfAborted();
      return { meta: { durationMs: 1 } };
    }, options);
  return { entered: entered.promise, raw, task };
}

async function tickAt(time: number, ...states: ReturnType<typeof create>[]) {
  vi.setSystemTime(time);
  for (const state of states) {
    await state.getParams().replyOperation!.watchdog.tick();
  }
}

describe("controller-owned execution guard", () => {
  it.each([
    ["same physical session", false, false, false, true],
    ["different session ID", true, false, false, false],
    ["different store", false, true, false, false],
    ["explicit detached run", false, false, true, false],
  ] as const)(
    "preserves sessionless admission for %s",
    async (_name, otherId, otherStore, detached, queued) => {
      const sessionId = "native-sessionless-owner";
      const storePath = "/synthetic/native-sessionless/sessions.sqlite";
      const first = create("native-sessionless-first", {
        sessionKey: undefined,
        sessionId,
        sessionFile: sessionId,
        sessionTarget: { storePath },
      });
      const entered = createDeferred();
      const finish = createDeferred();
      const order: string[] = [];
      const firstHandle = createEmbeddedRunHandle({ runId: "native-sessionless-first" });
      const predecessor = first.controller.enqueueSession(async () => {
        // Native registration keeps its keyless public identity while borrowing host admission.
        attachActiveEmbeddedRun(
          sessionId,
          firstHandle,
          undefined,
          sessionId,
          undefined,
          first.getParams().replyOperation,
        );
        try {
          expect(first.getParams().sessionKey).toBeUndefined();
          order.push("first");
          entered.resolve();
          await finish.promise;
          order.push("first settled");
        } finally {
          detachActiveEmbeddedRun(sessionId, firstHandle);
        }
      });
      await Promise.race([entered.promise, predecessor]);
      const second = create("native-sessionless-second", {
        sessionKey: undefined,
        sessionId: otherId ? "native-sessionless-other" : sessionId,
        sessionFile: otherId ? "native-sessionless-other" : sessionId,
        sessionTarget: {
          storePath: otherStore ? "/synthetic/native-sessionless-other/sessions.sqlite" : storePath,
        },
        ...(detached ? { sessionPersistence: "detached" } : {}),
      });
      const successor = second.controller.enqueueSession(async () => {
        expect(second.getParams().sessionKey).toBeUndefined();
        order.push("second");
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(queued ? ["first"] : ["first", "second"]);
        finish.resolve();
        await Promise.all([predecessor, successor]);
        expect(order).toEqual(
          queued ? ["first", "first settled", "second"] : ["first", "second", "first settled"],
        );
      } finally {
        finish.resolve();
        await Promise.allSettled([predecessor, successor]);
      }
    },
  );

  it("registers a keyless native attempt borrowed from a routable outer turn", async () => {
    const sessionId = "native-sessionless-borrowed";
    const operation = replyOperation(sessionId);
    const owned = create("native-sessionless-borrowed", {
      sessionKey: undefined,
      sessionId,
      sessionFile: sessionId,
      replyOperation: operation,
    });
    const handle = createEmbeddedRunHandle({ runId: "native-sessionless-borrowed" });
    try {
      await owned.controller.enqueueSession(async () => {
        attachActiveEmbeddedRun(sessionId, handle, undefined, sessionId, undefined, operation);
        expect(owned.getParams().sessionKey).toBeUndefined();
        detachActiveEmbeddedRun(sessionId, handle);
      });
      expect(operation.result).toBeNull();
    } finally {
      detachActiveEmbeddedRun(sessionId, handle);
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("keeps a borrowed outer turn active when its nested caller cancels", async () => {
    const operation = replyOperation();
    const caller = new AbortController();
    const state = create("nested", {
      replyOperation: operation,
      abortSignal: caller.signal,
    });
    const { controller, getParams } = state;
    const { entered, finish, run: nested } = pauseSession(state);
    const reason = new Error("nested caller cancelled");
    const rejected = expect(nested).rejects.toBe(reason);
    try {
      await entered;
      caller.abort(reason);
      expect(getParams().abortSignal?.reason).toBe(reason);
      expect(controller.abortSignal.reason).toBe(reason);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(operation.result).toBeNull();
      expect(operation.watchdog.snapshot().phase).not.toBe("terminal");
      finish();
      await rejected;
      expect(getSessionControllerOperation(key)).toBe(operation);
      expect(operation.result).toBeNull();
    } finally {
      finish();
      await nested.catch(() => {});
      operation.complete();
    }
  });

  it("starts the preflight deadline after mailbox admission, not before its queue wait", async () => {
    const first = pauseSession(create("deadline-predecessor"), undefined, async () => {});
    await first.entered;
    const second = create("deadline-successor");
    const successor = pauseSession(second, { taskTimeoutMs: 25 });
    const outcome = successor.run.catch((error: unknown) => error);
    try {
      vi.setSystemTime(2_000);
      first.finish();
      await first.run;
      await successor.entered;
      const operation = second.getParams().replyOperation;
      if (!operation) {
        throw new Error("Successor did not own a controller operation");
      }
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(false);
      vi.setSystemTime(2_025);
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(true);
    } finally {
      first.finish();
      successor.finish();
      await Promise.allSettled([first.run, outcome]);
    }
  });

  it.each([
    [false, "user", "spawn"],
    [true, "cron", "cron"],
  ] as const)(
    "propagates capacity refusal (async=%s, trigger=%s)",
    async (async, trigger, taskKind) => {
      const refused = new Error("queue admission refused");
      let identity: Parameters<CommandQueueEnqueueFn>[1];
      const { controller } = create("child-run", {
        trigger,
        sessionKey: "agent:example:subagent:child",
        spawnedBy: "agent:example:main",
        enqueue: (_task, options) => {
          identity = options;
          if (async) {
            return Promise.reject(refused);
          }
          throw refused;
        },
      });
      await expect(controller.enqueueSession(() => controller.enqueueGlobal(result))).rejects.toBe(
        refused,
      );
      expect(identity?.taskIdentity).toEqual({
        taskKind,
        sessionKey: "agent:example:subagent:child",
        runId: "child-run",
        requesterSessionKey: "agent:example:main",
      });
    },
  );

  it("uses injected queues only for global capacity, never session admission or timeout races", async () => {
    const enqueue = vi.fn<(opts: Parameters<CommandQueueEnqueueFn>[1]) => void>();
    const { controller, getParams } = create("direct", {
      enqueue: async (task, opts) => {
        enqueue(opts);
        return await task();
      },
    });
    await controller.enqueueSession(async () => {
      expect(enqueue).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(key)).toBe(getParams().replyOperation);
      return controller.enqueueGlobal(result);
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      taskIdentity: { runId: "direct", taskKind: "turn", sessionKey: key },
    });
    expect(enqueue.mock.calls[0]?.[0]?.taskTimeoutMs).toBeUndefined();
  });

  it("retains successor custody and fences late preflight after the deadline until raw settlement", async () => {
    const first = create("first");
    const execute = vi.fn(result);
    const { entered, finish, run } = pauseSession(first, { taskTimeoutMs: 25 }, async () => {
      first.controller.throwIfAborted();
      await first.controller.enqueueGlobal(execute);
    });
    const failed = expect(run).rejects.toThrow();
    await entered;
    const operation = first.getParams().replyOperation!;
    const dispatch = vi.fn(async () => "successor");
    const second = create("second").controller.enqueueSession(dispatch);
    await tickAt(1_025, first);
    expect(first.controller.abortSignal.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(key)).toBe(operation);
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
    let settled = false;
    void operation.ownerSettlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await failed;
    expect(execute).not.toHaveBeenCalled();
    await expect(second).resolves.toBe("successor");
    expect(settled).toBe(true);
  });

  it("keeps a queued session alive while another session's stalled global producer settles", async () => {
    setCommandLaneConcurrency(globalLane, 1);
    const first = create("stalled-global-owner");
    const second = create("global-successor", {
      sessionKey: "agent:main:global-successor",
      sessionId: "global-successor",
      sessionFile: "global-successor.jsonl",
    });
    const queued = createDeferred();
    const { entered, raw, task } = pauseGlobal(first, { taskTimeoutMs: 25 });
    const stalled = first.controller.enqueueSession(task);
    const failed = expect(stalled).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    await entered;
    const successor = second.controller.enqueueSession(
      () =>
        second.controller.enqueueGlobal(result, {
          onQueued: () => queued.resolve(),
        }),
      { taskTimeoutMs: 25 },
    );
    try {
      await queued.promise;
      await tickAt(1_024, first, second);
      expect(first.controller.abortSignal.aborted).toBe(false);
      expect(second.controller.abortSignal.aborted).toBe(false);
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 1, queuedCount: 1 });

      await tickAt(1_025, first, second);
      expect(first.controller.abortSignal.aborted).toBe(true);
      expect(second.controller.abortSignal.aborted).toBe(false);
      // A deadline requests cancellation; raw settlement still owns global capacity.
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      await tickAt(3_600_000, second);
      expect(second.controller.abortSignal.aborted).toBe(false);
      raw.resolve();
      await failed;
      await expect(successor).resolves.toEqual({ meta: { durationMs: 1 } });
      expect(second.controller.abortSignal.aborted).toBe(false);
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
    } finally {
      raw.resolve();
      await Promise.allSettled([stalled, successor]);
    }
  });

  it("does not let another queued global task shield an active stalled producer or release its capacity", async () => {
    const state = create("parallel-capacity");
    const { controller } = state;
    const { entered, raw, task } = pauseGlobal(state, { taskTimeoutMs: 25 });
    const secondTask = vi.fn(async () => ({ meta: { durationMs: 2 } }));
    const run = controller.enqueueSession(async () => {
      const first = task();
      const second = controller.enqueueGlobal(secondTask);
      return await Promise.allSettled([first, second]);
    });
    await entered;
    await tickAt(1_025, state);
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(1);
    expect(secondTask).not.toHaveBeenCalled();
    raw.resolve();
    const outcomes = await run;
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
  });
});

describe("exact attempt deadline transfer", () => {
  const attemptLane = "test:attempt-owner-deadline";
  const cleanups: Array<() => void | Promise<void>> = [];
  async function setup(rawFailure?: Error, assertSourceCurrent?: () => void) {
    const runId = "attempt-owner";
    const admission = prepareSystemAgentRunAdmission(
      {},
      runId,
      "main",
      "watchdog-controls",
      assertSourceCurrent,
    );
    cleanups.push(admission.close);
    const admittedRunContext = await admission.admit("embedded");
    const state = create(
      runId,
      {
        admittedRunContext,
        sessionId: "attempt-owner-incarnation",
        sessionKey: "agent:main:attempt-owner",
        sessionFile: "attempt-owner.jsonl",
        workspaceDir: "/tmp/attempt-owner",
        timeoutMs: 1_000,
        trigger: undefined,
      },
      attemptLane,
    );
    const { controller, getParams } = state;
    const { entered, raw, task } = pauseGlobal(state, undefined, rawFailure);
    const run = controller.enqueueSession(task);
    cleanups.push(async () => {
      raw.resolve();
      await run.catch(() => {});
    });
    await entered;
    const operation = getParams().replyOperation!;
    const controls = (
      options: Omit<
        Parameters<typeof controller.createAttemptControls>[0],
        "admittedRunContext"
      > = {},
    ) => {
      const value = controller.createAttemptControls({ ...options, admittedRunContext });
      cleanups.push(value.close);
      return value;
    };
    return { controller, operation, controls, admission, runId, raw, run };
  }
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it.each([
    ["Stop", 0],
    ["Stop", GRACE_MS - 1],
    ["Stop", GRACE_MS],
    ["runtime timeout", GRACE_MS],
  ] as const)(
    "preserves %s classification after %sms while retaining raw capacity",
    async (source, elapsedMs) => {
      const rawFailure = new Error("native abort");
      rawFailure.name = "AbortError";
      const { operation, controls, controller, raw, run } = await setup(rawFailure);
      const control = controls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS });
      const outcome = run.catch((error: unknown) => error);
      const settled = vi.fn();
      void operation.ownerSettlement.then(settled);
      if (source === "Stop") {
        control.onAttemptAbort();
        expect(controller.abortSignal.reason).toMatchObject({ name: "AbortError" });
      } else {
        control.onAttemptTimeout(new Error("runtime timeout"));
      }
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(controller.abortSignal.aborted).toBe(true);
      expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(1);
      expect(settled).not.toHaveBeenCalled();
      raw.resolve();
      const error = await outcome;
      if (elapsedMs < GRACE_MS) {
        expect(error).toBe(rawFailure);
        expect(isCommandLaneTaskTimeoutError(error)).toBe(false);
      } else {
        expect(isCommandLaneTaskTimeoutError(error, attemptLane)).toBe(true);
      }
      await operation.ownerSettlement;
      expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(0);
    },
  );

  it.each(["seeded", "published"] as const)(
    "transfers %s bounded deadlines with cleanup grace into the owner",
    async (mode) => {
      const { operation, controls, controller, raw, run } = await setup();
      const control = controls(mode === "seeded" ? { initialTimeoutMs: 120_000 } : {});
      if (mode === "published") {
        control.onAttemptDeadlineChanged({ kind: "bounded", deadlineAtMs: 121_000 });
      }
      expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(121_000 + GRACE_MS);
      vi.setSystemTime(150_999);
      await operation.watchdog.tick();
      expect(controller.abortSignal.aborted).toBe(false);
      vi.setSystemTime(151_000);
      await operation.watchdog.tick();
      expect(controller.abortSignal.aborted).toBe(true);
      expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(1);
      expect(operation.result).toMatchObject({ code: "run_stalled" });
      raw.resolve();
      await Promise.allSettled([run]);
      await operation.ownerSettlement;
      expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(0);
    },
  );

  it("does not let delayed timeout fencing retire a successor attempt on the same operation", async () => {
    const { operation, controls, controller, raw, run } = await setup();
    const old = controls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS });
    const entered = createDeferred();
    const release = createDeferred();
    const effects: string[] = [];
    const state = readSessionControllerOperationState(operation)!;
    const unregisterOld = state.registerTerminalProducerFence(async (isCurrent) => {
      entered.resolve();
      await release.promise;
      if (!isCurrent()) {
        return false;
      }
      effects.push("old writer revoked");
      return true;
    });
    cleanups.push(unregisterOld);
    old.onAttemptTimeout(new Error("native timeout"));
    vi.setSystemTime(Date.now() + GRACE_MS);
    const recovery = operation.watchdog.tick();
    await entered.promise;
    old.close();
    unregisterOld();
    controls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS });
    cleanups.push(
      operation.registerTerminalProducerFence(async () => {
        effects.push("successor writer revoked");
        return true;
      }),
    );
    release.resolve();
    await recovery;
    expect(effects).toEqual([]);
    expect(operation.admissionRetired).toBe(false);
    expect(operation.result).toBeNull();
    expect(controller.abortSignal.aborted).toBe(false);
    expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(1);
    raw.resolve();
    await run;
  });

  it("keeps unlimited execution separate from semantic liveness and restores the fallback only once", async () => {
    const { operation, controls, controller } = await setup();
    const control = controls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS });
    expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBeUndefined();
    vi.setSystemTime(60_000);
    await operation.watchdog.tick();
    expect(controller.abortSignal.aborted).toBe(false);
    control.close();
    expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(91_000);
    vi.setSystemTime(70_000);
    control.close();
    expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(91_000);
  });

  it("does not clear an enforced maintenance deadline that this attempt never published", async () => {
    const { operation, controls, controller } = await setup();
    controller.setLaneTaskDeadline({ kind: "bounded", deadlineAtMs: 100_000 });
    controls().close();
    expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(130_000);
  });

  it.each([
    "closed",
    "superseded",
    "revoked",
    "replaced admission",
    "rotated lifecycle",
    "aborted input",
  ] as const)("rejects callbacks retained after %s", async (invalidation) => {
    const { operation, controls, admission, runId, controller } = await setup();
    const abort = new AbortController();
    const onAbort = vi.fn();
    const old = controls({ abortSignal: abort.signal, initialTimeoutMs: 120_000, onAbort });
    switch (invalidation) {
      case "closed":
        old.close();
        controls({ initialTimeoutMs: 120_000 });
        break;
      case "superseded":
        controls({ initialTimeoutMs: 120_000 });
        break;
      case "revoked":
        admission.close();
        break;
      case "replaced admission": {
        const next = prepareSystemAgentRunAdmission({}, runId, "main", "replacement");
        cleanups.push(next.close);
        await next.admit("embedded");
        break;
      }
      case "rotated lifecycle":
        rotateAgentEventLifecycleGeneration();
        break;
      case "aborted input":
        abort.abort();
        break;
    }
    const deadline = operation.watchdog.snapshot().executionDeadlineAtMs;
    old.onAttemptDeadlineChanged({ kind: "bounded", deadlineAtMs: Date.now() });
    old.onAttemptTimeout(new Error("late timeout"));
    old.onAttemptAbort();
    expect(onAbort).not.toHaveBeenCalled();
    expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(deadline);
    if (invalidation !== "rotated lifecycle") {
      expect(controller.abortSignal.aborted).toBe(false);
    }
  });

  it.each(["closed", "replaced"] as const)(
    "refuses an attempt %s during synchronous source validation",
    async (change) => {
      let onValidate: (() => void) | undefined;
      const { controls } = await setup(undefined, () => onValidate?.());
      const old = controls();
      onValidate = () => {
        onValidate = undefined;
        if (change === "closed") {
          old.close();
        } else {
          controls();
        }
      };
      expect(old.isCurrent()).toBe(false);
    },
  );

  it("commits Stop before reentrant creation of successor controls", async () => {
    const { controller, controls } = await setup();
    const nextAbort = vi.fn();
    const onAbort = vi.fn(() => {
      expect(controller.abortSignal.aborted).toBe(true);
      const next = controls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS, onAbort: nextAbort });
      next.onAttemptAbort();
      next.onAttemptDeadlineChanged({ kind: "unlimited" });
    });
    const control = controls({ onAbort });
    control.onAttemptAbort();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(nextAbort).not.toHaveBeenCalled();
    expect(getCommandLaneSnapshot(attemptLane).activeCount).toBe(1);
  });
});
