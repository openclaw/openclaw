import { getEventListeners } from "node:events";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangeListeners } from "../../../shared/listeners.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  findMediaGenerationOperation,
  updateMediaGenerationOperation,
} from "../../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";

const sessionKey = "agent:main:cron:daily-media:run:run-123";
const emptyResult = { timedOutRunIds: [] };
function taskMeta(task: ReturnType<typeof startTask>): AsyncStartedToolMeta {
  return { asyncStarted: true, asyncTaskRunId: task.runId, asyncTaskId: task.taskId };
}
function startTask(kind = "image", requesterSessionKey = sessionKey) {
  const runId = `tool:${kind}_generate:run-123`;
  const task = createMediaGenerationOperation({
    taskId: runId,
    runId,
    taskKind: `${kind}_generation`,
    sourceId: `${kind}_generate:test`,
    requesterSessionKey,
    status: "running",
  });
  if (!task) {
    throw new Error("expected native media task");
  }
  return task;
}
function completeTask(runId: string, endedAt: number) {
  updateMediaGenerationOperation(runId, {
    status: "succeeded",
    endedAt,
  });
  clearGeneratedMediaTaskActivity(runId);
}
function wait(params: Partial<Parameters<typeof waitForCompletionRequiredAsyncTasks>[0]>) {
  return waitForCompletionRequiredAsyncTasks({
    sessionKey,
    getToolMetas: () => [],
    getDeadlineAtMs: () => undefined,
    onDeadlineChanged: () => () => {},
    ...params,
  });
}

describe("waitForCompletionRequiredAsyncTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGeneratedMediaTaskActivityForTests();
  });
  afterEach(() => {
    resetGeneratedMediaTaskActivityForTests();
    vi.useRealTimers();
  });

  it.each([true, false])("waits before yieldDetected=%s", (yieldDetected) => {
    const task = startTask();
    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: yieldDetected ? [{ asyncStarted: true, asyncTaskRunId: task.runId }] : [],
        yieldDetected,
      }),
    ).toBe(!yieldDetected);
  });

  it("waits for active cron tasks discovered from native media operations", async () => {
    const task = startTask();
    const result = wait({});
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    completeTask(task.taskId, Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(await result).toEqual(emptyResult);
    expect(findMediaGenerationOperation(task.taskId)?.status).toBe("succeeded");
  });

  it.each(["image", "music", "video"])("releases durably queued %s completion", async (kind) => {
    const task = startTask(kind);
    const toolMetas = [{ asyncStarted: true, asyncTaskRunId: task.runId }];
    const result = wait({ getToolMetas: () => toolMetas });
    const settled = vi.fn();
    void result.then(settled);
    updateMediaGenerationOperation(task.taskId, { completionDelivery: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(await result).toEqual(emptyResult);
    expect(findMediaGenerationOperation(task.taskId)?.status).toBe("running");
    expect(requiresCompletionRequiredAsyncTaskWait({ sessionKey, toolMetas })).toBe(false);
    expect(await wait({ getToolMetas: () => toolMetas, getDeadlineAtMs: () => 0 })).toEqual(
      emptyResult,
    );
  });

  it("ignores media operations owned by another requester", async () => {
    startTask("image", "agent:main:parent");
    expect(requiresCompletionRequiredAsyncTaskWait({ sessionKey, toolMetas: [] })).toBe(false);
    expect(await wait({ getDeadlineAtMs: () => 0 })).toEqual(emptyResult);
  });

  it("does not repeatedly read an unchanged task's deadline", async () => {
    const task = startTask();
    const getDeadlineAtMs = vi.fn(() => undefined);
    const result = wait({ getDeadlineAtMs });
    const unrelated = startTask("music", "agent:main:other");
    completeTask(unrelated.taskId, Date.now());
    await vi.advanceTimersByTimeAsync(1_250);
    expect(getDeadlineAtMs).toHaveBeenCalledOnce();
    completeTask(task.taskId, Date.now());
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual(emptyResult);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes registration of a task whose metadata arrived first", async () => {
    const runId = "late-registry-task";
    const result = wait({
      getToolMetas: () => [{ asyncStarted: true, asyncTaskRunId: runId }],
    });
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    createMediaGenerationOperation({
      runId,
      taskId: runId,
      taskKind: "image_generation",
      requesterSessionKey: sessionKey,
      status: "succeeded",
      endedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(await result).toEqual(emptyResult);
  });

  it("waits for async task ids discovered after an earlier async completion", async () => {
    const first = startTask();
    const metas = [taskMeta(first)];
    // Registry admission prunes completed records against the real epoch.
    const startedAt = Date.now();
    setTimeout(() => {
      completeTask(first.taskId, Date.now());
      metas.push(taskMeta(startTask("music")));
    }, 2);
    setTimeout(() => completeTask("tool:music_generate:run-123", Date.now()), 4);
    const result = wait({
      sessionKey: undefined,
      getToolMetas: () => metas,
      getDeadlineAtMs: () => startedAt + 19,
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(await result).toEqual(emptyResult);
    expect(findMediaGenerationOperation(first.taskId)?.status).toBe("succeeded");
    expect(findMediaGenerationOperation("tool:music_generate:run-123")?.status).toBe("succeeded");
    expect(Date.now()).toBe(startedAt + 4);
  });

  it("rereads paused and resumed deadlines beyond the former finite sentinel", async () => {
    const task = startTask();
    const startedAt = MAX_TIMER_TIMEOUT_MS + 1;
    vi.setSystemTime(startedAt);
    let deadlineAtMs: number | undefined = startedAt + 750;
    const changes = createChangeListeners();
    setTimeout(() => {
      deadlineAtMs = undefined;
      changes.publish();
    }, 500);
    setTimeout(() => {
      deadlineAtMs = Date.now() + 250;
      changes.publish();
    }, 1_500);
    const getDeadlineAtMs = vi.fn(() => deadlineAtMs);
    const result = wait({
      getDeadlineAtMs,
      onDeadlineChanged: changes.subscribe,
    });
    await vi.advanceTimersByTimeAsync(1_750);
    expect(await result).toMatchObject({
      timedOutRunIds: [task.runId],
    });
    expect(Date.now()).toBe(startedAt + 1_750);
    expect(getDeadlineAtMs).toHaveBeenCalledTimes(4);
  });

  it("stops an unlimited in-flight task poll promptly on abort", async () => {
    startTask();
    const controller = new AbortController();
    const reason = new Error("run cancelled during task poll");
    const unsubscribe = vi.fn();
    const result = wait({
      abortSignal: controller.signal,
      onDeadlineChanged: () => unsubscribe,
    });
    controller.abort(reason);
    await expect(result).rejects.toMatchObject({ name: "AbortError", cause: reason });
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
