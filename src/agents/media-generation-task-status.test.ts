// Verifies media-generation task lookup, duplicate guards, and prompt status text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  listMediaGenerationOperations,
  MediaGenerationOperation,
} from "./media-generation-activity.js";
import { recordRecentMediaGenerationTaskStartForSession } from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";
import {
  buildMediaTaskRuntimeContext,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findDuplicateGuardImageGenerationTaskForSession,
  IMAGE_GENERATION_TASK_KIND,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  VIDEO_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

const mediaActivityMocks = vi.hoisted(() => ({
  listOperations: vi.fn<typeof listMediaGenerationOperations>(),
}));

vi.mock("./media-generation-activity.js", () => ({
  listMediaGenerationOperations: mediaActivityMocks.listOperations,
}));

function makeTask(overrides: Partial<MediaGenerationOperation>): MediaGenerationOperation {
  return {
    taskId: "task-running",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourceId: "image_generate:openai",
    requesterSessionKey: "agent:main",
    task: "running task",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

type RecentStart = Parameters<typeof recordRecentMediaGenerationTaskStartForSession>[0];

function recordRecentImageStart(
  params: Pick<RecentStart, "taskId" | "taskLabel"> & Partial<RecentStart>,
) {
  recordRecentMediaGenerationTaskStartForSession({
    sessionKey: "agent:main",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: "image_generate",
    providerId: "xai",
    progressSummary: "Generating image",
    ...params,
  });
}

beforeEach(() => {
  mediaActivityMocks.listOperations.mockReset();
  mediaActivityMocks.listOperations.mockReturnValue([]);
  resetRecentMediaGenerationDuplicateGuardsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectActiveImageGenerationTask(
  task: Awaited<ReturnType<typeof findDuplicateGuardImageGenerationTaskForSession>>,
): NonNullable<Awaited<ReturnType<typeof findDuplicateGuardImageGenerationTaskForSession>>> {
  // Narrows optional lookups in tests that need status helper calls.
  if (task == null) {
    throw new Error("Expected active image generation task");
  }
  return task;
}

describe("image generation task status", () => {
  it("prefers a running task over queued session siblings", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        sourceId: "image_generate:google",
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        progressSummary: "Generating image",
      }),
    ]);

    const task = await findDuplicateGuardImageGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveImageGenerationTask(task);
    expect(buildImageGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not call image_generate again for this request.",
    );
    const details = buildImageGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(IMAGE_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating image");
  });

  it("preserves earlier recent request keys when another image request starts", async () => {
    // Multiple image requests can be active/recent in the same session; a new
    // request must not erase an older request key that can still match status.
    const now = Date.now();
    recordRecentImageStart({
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      progressSummary: "Generating first image",
      nowMs: now - 30_000,
    });
    recordRecentImageStart({
      taskId: "task-second",
      runId: "run-second",
      taskLabel: "second prompt",
      requestKey: "image-request:second",
      progressSummary: "Generating second image",
      nowMs: now - 20_000,
    });
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-first",
        runId: "run-first",
        sourceId: "image_generate:xai",
        task: "first prompt",
        status: "succeeded",
        createdAt: now - 30_000,
        endedAt: now - 15_000,
        progressSummary: "Generated first image",
      }),
      makeTask({
        taskId: "task-second",
        runId: "run-second",
        sourceId: "image_generate:xai",
        task: "second prompt",
        status: "succeeded",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated second image",
      }),
    ]);

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:other",
      }),
    ).toBeUndefined();

    expect(
      (
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          requestKey: "image-request:first",
        })
      )?.taskId,
    ).toBe("task-first");
    expect(
      (
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          requestKey: "image-request:second",
        })
      )?.taskId,
    ).toBe("task-second");
  });

  it("observes a newly admitted operation on the next owner lookup", async () => {
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", { prompt: "new image" }),
    ).toBeUndefined();
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-newly-started",
        runId: "run-newly-started",
        task: "new image",
      }),
    ]);
    recordRecentImageStart({
      taskId: "task-newly-started",
      runId: "run-newly-started",
      taskLabel: "new image",
    });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", { prompt: "new image" }),
    ).toMatchObject({ taskId: "task-newly-started", status: "running" });
  });

  it.each([[120_001, false]] as const)(
    "uses a completion aged %s ms as a duplicate guard: %s",
    async (ageMs, blocksDuplicate) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const completed = makeTask({
        taskId: "task-completed",
        runId: "run-completed",
        task: "completed prompt",
        status: "succeeded",
        createdAt: now - 3 * 60_000,
        endedAt: now - ageMs,
      });
      mediaActivityMocks.listOperations.mockReturnValue([completed]);
      recordRecentImageStart({
        taskId: "task-completed",
        runId: "run-completed",
        taskLabel: "completed prompt",
        requestKey: "image-request:completed",
        nowMs: now - 3 * 60_000,
      });

      expect(
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          prompt: "completed prompt",
          requestKey: "image-request:completed",
        }),
      ).toEqual(blocksDuplicate ? completed : undefined);
    },
  );

  it("does not block a distinct prompt from a retained operation's recent start", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-first",
        runId: "run-first",
        task: "first prompt",
      }),
    ]);
    recordRecentImageStart({
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      progressSummary: "Generating first image",
    });

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "first prompt",
      }),
    ).toMatchObject({ taskId: "task-first", status: "running" });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "second prompt",
      }),
    ).toBeUndefined();
  });

  it("uses a recent persisted completion instead of pruning a stale recent-start cache", async () => {
    const now = Date.now();
    recordRecentImageStart({
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:stale",
      nowMs: now - 3 * 60_000,
    });
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-completed",
        runId: "run-completed",
        sourceId: "image_generate:xai",
        task: "recent prompt",
        status: "succeeded",
        createdAt: now - 3 * 60_000,
        endedAt: now - 1_000,
        progressSummary: "Generated 1 image",
      }),
    ]);

    const task = await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:stale",
    });

    expect(task?.status).toBe("succeeded");
    expect(buildImageGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
  });
});

function expectActiveVideoGenerationTask(
  task: Awaited<ReturnType<typeof findActiveVideoGenerationTaskForSession>>,
): NonNullable<Awaited<ReturnType<typeof findActiveVideoGenerationTaskForSession>>> {
  if (task == null) {
    throw new Error("Expected active video generation task");
  }
  return task;
}

describe("video generation task status", () => {
  it("prefers a running task over queued session siblings", async () => {
    // Running work should suppress duplicate generation even when older queued
    // siblings still exist for the same session owner.
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:google",
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        progressSummary: "Generating video",
      }),
    ]);

    const task = await findActiveVideoGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveVideoGenerationTask(task);
    expect(buildVideoGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not call video_generate again for this request.",
    );
    const details = buildVideoGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(VIDEO_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating video");
  });

  it("builds prompt context for active session work", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterAgentId: "main",
        progressSummary: "Generating video",
      }),
    ]);

    const context = await buildMediaTaskRuntimeContext({
      capabilityToolNames: new Set(["video_generate"]),
      sessionKey: "agent:main",
      agentId: "main",
    });

    expect(context).toBe(
      '## Media Generation Tasks\n- tool=video_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating video"',
    );
  });
});
