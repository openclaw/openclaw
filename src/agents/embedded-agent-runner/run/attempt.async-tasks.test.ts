import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const emptyResult = { waitedRunIds: [], timedOutRunIds: [], terminalTasks: [] };
function taskMeta(task: ReturnType<typeof startTask>): AsyncStartedToolMeta {
  return { asyncStarted: true, asyncTaskRunId: task.runId, asyncTaskId: task.taskId };
}
function terminalTask(taskId: string) {
  return { taskId, status: "succeeded", terminalSummary: "Generated media." };
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
    createdAt: 1,
    startedAt: 1,
    lastEventAt: 1,
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
    lastEventAt: endedAt,
    terminalSummary: "Generated media.",
  });
  clearGeneratedMediaTaskActivity(runId);
}
function wait(params: Partial<Parameters<typeof waitForCompletionRequiredAsyncTasks>[0]>) {
  return waitForCompletionRequiredAsyncTasks({
    sessionKey,
    getToolMetas: () => [],
    getDeadlineAtMs: () => undefined,
    pollIntervalMs: 500,
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
    completeTask(task.taskId, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({
      waitedRunIds: [task.runId],
      timedOutRunIds: [],
      terminalTasks: [terminalTask(task.taskId)],
    });
  });

  it.each(["image", "music", "video"])("releases durably queued %s completion", async (kind) => {
    const task = startTask(kind);
    const toolMetas = [{ asyncStarted: true, asyncTaskRunId: task.runId }];
    const result = wait({ getToolMetas: () => toolMetas });
    updateMediaGenerationOperation(task.taskId, { completionDelivery: "queued" });
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ ...emptyResult, waitedRunIds: [task.runId] });
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
      pollIntervalMs: 2,
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(await result).toMatchObject({
      waitedRunIds: [first.runId, "tool:music_generate:run-123"],
      timedOutRunIds: [],
      terminalTasks: [
        terminalTask(first.taskId),
        { taskId: "tool:music_generate:run-123", status: "succeeded" },
      ],
    });
    expect(Date.now()).toBe(startedAt + 4);
  });

  it("rereads paused and resumed deadlines beyond the former finite sentinel", async () => {
    const task = startTask();
    const startedAt = MAX_TIMER_TIMEOUT_MS + 1;
    vi.setSystemTime(startedAt);
    let deadlineAtMs: number | undefined = startedAt + 750;
    setTimeout(() => {
      deadlineAtMs = undefined;
    }, 500);
    setTimeout(() => {
      deadlineAtMs = Date.now() + 250;
    }, 1_500);
    const getDeadlineAtMs = vi.fn(() => deadlineAtMs);
    const result = wait({
      getDeadlineAtMs,
    });
    await vi.advanceTimersByTimeAsync(1_750);
    expect(await result).toMatchObject({
      waitedRunIds: [task.runId],
      timedOutRunIds: [task.runId],
    });
    expect(Date.now()).toBe(startedAt + 1_750);
    expect(getDeadlineAtMs).toHaveBeenCalledTimes(5);
  });

  it("stops an unlimited in-flight task poll promptly on abort", async () => {
    startTask();
    const controller = new AbortController();
    const reason = new Error("run cancelled during task poll");
    const result = wait({ abortSignal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toMatchObject({ name: "AbortError", cause: reason });
    expect(vi.getTimerCount()).toBe(0);
  });
});
