import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
    now: () => 0,
    pollIntervalMs: 500,
    ...params,
  });
}

describe("waitForCompletionRequiredAsyncTasks", () => {
  beforeEach(() => resetGeneratedMediaTaskActivityForTests());
  afterEach(() => resetGeneratedMediaTaskActivityForTests());

  it("skips media task waiting after sessions_yield pauses the attempt", () => {
    const task = startTask();
    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [{ asyncStarted: true, asyncTaskRunId: task.runId }],
        yieldDetected: true,
      }),
    ).toBe(false);
    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [],
        yieldDetected: false,
      }),
    ).toBe(true);
  });

  it("waits for active cron tasks discovered from native media operations", async () => {
    const task = startTask();
    await expect(wait({ sleep: async () => completeTask(task.taskId, 2) })).resolves.toMatchObject({
      waitedRunIds: [task.runId],
      timedOutRunIds: [],
      terminalTasks: [
        { taskId: task.taskId, status: "succeeded", terminalSummary: "Generated media." },
      ],
    });
  });

  it.each(["image", "music", "video"])(
    "releases the cron lane when the durable queue takes %s completion custody",
    async (kind) => {
      const task = startTask(kind);
      const toolMetas = [{ asyncStarted: true, asyncTaskRunId: task.runId }];
      await expect(
        wait({
          getToolMetas: () => toolMetas,
          sleep: async () => {
            updateMediaGenerationOperation(task.taskId, { completionDelivery: "queued" });
          },
        }),
      ).resolves.toEqual({ waitedRunIds: [task.runId], timedOutRunIds: [], terminalTasks: [] });
      expect(findMediaGenerationOperation(task.taskId)?.status).toBe("running");
      expect(requiresCompletionRequiredAsyncTaskWait({ sessionKey, toolMetas })).toBe(false);
      await expect(
        wait({ getToolMetas: () => toolMetas, getDeadlineAtMs: () => 0 }),
      ).resolves.toEqual({
        waitedRunIds: [],
        timedOutRunIds: [],
        terminalTasks: [],
      });
    },
  );

  it("ignores media operations owned by another requester", async () => {
    startTask("image", "agent:main:parent");
    expect(requiresCompletionRequiredAsyncTaskWait({ sessionKey, toolMetas: [] })).toBe(false);
    await expect(wait({ getDeadlineAtMs: () => 0 })).resolves.toEqual({
      waitedRunIds: [],
      timedOutRunIds: [],
      terminalTasks: [],
    });
  });

  it("waits for async task ids discovered after an earlier async completion", async () => {
    const first = startTask();
    const metas: AsyncStartedToolMeta[] = [
      {
        asyncStarted: true,
        asyncTaskRunId: first.runId,
        asyncTaskId: first.taskId,
      },
    ];
    // Registry admission prunes completed records against the real epoch.
    const startedAt = Date.now();
    let now = startedAt;
    let polls = 0;
    await expect(
      wait({
        sessionKey: undefined,
        getToolMetas: () => metas,
        getDeadlineAtMs: () => startedAt + 19,
        now: () => now,
        pollIntervalMs: 2,
        sleep: async (ms) => {
          now += ms;
          if (++polls === 1) {
            completeTask(first.taskId, now);
            const next = startTask("music");
            metas.push({
              asyncStarted: true,
              asyncTaskRunId: next.runId,
              asyncTaskId: next.taskId,
            });
          } else {
            completeTask("tool:music_generate:run-123", now);
          }
        },
      }),
    ).resolves.toMatchObject({
      waitedRunIds: [first.runId, "tool:music_generate:run-123"],
      timedOutRunIds: [],
      terminalTasks: [
        { taskId: first.taskId, status: "succeeded", terminalSummary: "Generated media." },
        { taskId: "tool:music_generate:run-123", status: "succeeded" },
      ],
    });
    expect(polls).toBe(2);
  });

  it("rereads paused and resumed deadlines beyond the former finite sentinel", async () => {
    const task = startTask();
    const startedAt = MAX_TIMER_TIMEOUT_MS + 1;
    let now = startedAt;
    let deadlineAtMs: number | undefined = now + 750;
    const expectedSleeps = [500, 500, 500, 250];
    let polls = 0;
    const getDeadlineAtMs = vi.fn(() => deadlineAtMs);
    await expect(
      wait({
        getDeadlineAtMs,
        now: () => now,
        sleep: async (ms) => {
          expect(ms).toBe(expectedSleeps[polls]);
          now += ms;
          polls += 1;
          if (polls === 1) {
            deadlineAtMs = undefined;
          } else if (polls === 3) {
            deadlineAtMs = now + 250;
          }
        },
      }),
    ).resolves.toMatchObject({ waitedRunIds: [task.runId], timedOutRunIds: [task.runId] });
    expect(now).toBe(startedAt + 1_750);
    expect(polls).toBe(expectedSleeps.length);
    expect(getDeadlineAtMs).toHaveBeenCalledTimes(5);
  });

  it("stops an unlimited in-flight task poll promptly on abort", async () => {
    startTask();
    const controller = new AbortController();
    const reason = new Error("run cancelled during task poll");
    const sleeping = createDeferred();
    try {
      await expect(
        wait({
          abortSignal: controller.signal,
          sleep: async (ms) => {
            expect(ms).toBe(500);
            controller.abort(reason);
            await sleeping.promise;
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError", cause: reason });
    } finally {
      sleeping.resolve();
      await sleeping.promise;
    }
  });
});
