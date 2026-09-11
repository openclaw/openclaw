// Verifies media-generation task lookup, duplicate guards, and prompt status text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { recordRecentMediaGenerationTaskStartForSession } from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";
import {
  buildActiveImageGenerationTaskPromptContextForSession,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findDuplicateGuardImageGenerationTaskForSession,
  IMAGE_GENERATION_TASK_KIND,
  buildActiveVideoGenerationTaskPromptContextForSession,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  VIDEO_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => {
  const mocks = {
    listTasksForOwnerKey: vi.fn(),
    listFreshTasksForOwnerKey: vi.fn(),
    reloadTaskRegistryFromStore: vi.fn(),
  };
  mocks.listFreshTasksForOwnerKey.mockImplementation((ownerKey) =>
    mocks.listTasksForOwnerKey(ownerKey),
  );
  return mocks;
});

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

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
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation((ownerKey) =>
      taskRuntimeInternalMocks.listTasksForOwnerKey(ownerKey),
    );
    taskRuntimeInternalMocks.reloadTaskRegistryFromStore.mockReset();
    resetRecentMediaGenerationDuplicateGuardsForTests();
  });

  it("prefers a running task over queued session siblings", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-queued",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:google",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
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

  it("can restrict active lookup to the matching image prompt", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-first",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "First diagram prompt",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-second",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "Second diagram prompt",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
    ]);

    expect(
      (
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          prompt: "Second diagram prompt",
        })
      )?.taskId,
    ).toBe("task-second");
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "Third diagram prompt",
      }),
    ).toBeUndefined();
  });

  it("uses a matching recent-start request key as a succeeded duplicate guard", async () => {
    // The request key ties a tool call to its persisted completion so the
    // model gets status guidance instead of starting the same image twice.
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:a",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    const task = await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:a",
    });

    expect(task?.taskId).toBe("task-completed");
    const statusText = buildImageGenerationTaskStatusText(task!, { duplicateGuard: true });
    expect(statusText).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
    expect(statusText).toContain(
      "Do not call image_generate again for the same request; this recent image generation already completed.",
    );
  });

  it("does not use a delivery-blocked image task as a succeeded duplicate guard", async () => {
    // If completion delivery failed, suppressing a retry would strand the
    // requester without an image even though the provider task succeeded.
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-blocked-delivery",
      runId: "run-blocked-delivery",
      taskLabel: "recent prompt",
      requestKey: "image-request:blocked",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-blocked-delivery",
        runId: "run-blocked-delivery",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Required completion delivery failed before reaching the requester.",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:blocked",
      }),
    ).toBeUndefined();
  });

  it("does not use a recent succeeded image task without a matching request key", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:a",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        requestKey: "image-request:b",
      }),
    ).toBeUndefined();
  });

  it("preserves earlier recent request keys when another image request starts", async () => {
    // Multiple image requests can be active/recent in the same session; a new
    // request must not erase an older request key that can still match status.
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      providerId: "xai",
      progressSummary: "Generating first image",
      nowMs: now - 30_000,
    });
    const lookup = createDeferred<TaskRecord[]>();
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValueOnce(lookup.promise);
    const pending = findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:other",
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-second",
      runId: "run-second",
      taskLabel: "second prompt",
      requestKey: "image-request:second",
      providerId: "xai",
      progressSummary: "Generating second image",
      nowMs: now - 20_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-first",
        runId: "run-first",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "first prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 30_000,
        endedAt: now - 15_000,
        progressSummary: "Generated first image",
      },
      {
        taskId: "task-second",
        runId: "run-second",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "second prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated second image",
      },
    ]);

    lookup.resolve(taskRuntimeInternalMocks.listTasksForOwnerKey("agent:main"));
    expect(await pending).toBeUndefined();

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

  it("observes a recent start recorded while the first owner lookup is pending", async () => {
    const lookup = createDeferred<TaskRecord[]>();
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValueOnce(lookup.promise);
    const pending = findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      prompt: "new image",
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-started-during-read",
      taskLabel: "new image",
      progressSummary: "Generating image",
    });
    lookup.resolve([]);
    expect(await pending).toMatchObject({ taskId: "task-started-during-read", status: "running" });
  });

  it("prunes stale same-session recent starts when another image request starts", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-stale",
      runId: "run-stale",
      taskLabel: "stale prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating stale image",
      nowMs: now - 3 * 60_000,
    });
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-fresh",
      runId: "run-fresh",
      taskLabel: "fresh prompt",
      requestKey: "image-request:fresh",
      providerId: "xai",
      progressSummary: "Generating fresh image",
      nowMs: now,
    });

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "stale prompt",
        requestKey: "image-request:stale",
      }),
    ).toBeUndefined();
    expect(
      (
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          prompt: "fresh prompt",
          requestKey: "image-request:fresh",
        })
      )?.taskId,
    ).toBe("task-fresh");
  });

  it("expires recent image starts after the canonical 120-second guard window", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-stale",
      runId: "run-stale",
      taskLabel: "stale prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating stale image",
      nowMs: now - 2 * 60_000 - 1,
    });

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "stale prompt",
        requestKey: "image-request:stale",
      }),
    ).toBeUndefined();
  });

  it("does not block a distinct prompt from a cached active recent start", async () => {
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-first",
      runId: "run-first",
      taskLabel: "first prompt",
      requestKey: "image-request:first",
      providerId: "xai",
      progressSummary: "Generating first image",
    });

    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "second prompt",
      }),
    ).toBeUndefined();
  });

  it("uses a recent persisted completion instead of pruning a stale recent-start cache", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-completed",
      runId: "run-completed",
      taskLabel: "recent prompt",
      requestKey: "image-request:stale",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 3 * 60_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-completed",
        runId: "run-completed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "recent prompt",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 3 * 60_000,
        endedAt: now - 1_000,
        progressSummary: "Generated 1 image",
      },
    ]);

    const task = await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
      requestKey: "image-request:stale",
    });

    expect(task?.status).toBe("succeeded");
    expect(buildImageGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
  });

  it("clears the recent-start cache when the persisted task has failed", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourcePrefix: "image_generate",
      taskId: "task-failed",
      runId: "run-failed",
      taskLabel: "retryable prompt",
      providerId: "xai",
      progressSummary: "Generating image",
      nowMs: now - 5_000,
    });
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-failed",
        runId: "run-failed",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:xai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "retryable prompt",
        status: "failed",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 5_000,
        endedAt: now - 1_000,
        progressSummary: "Image generation failed",
      },
    ]);

    expect(await findDuplicateGuardImageGenerationTaskForSession("agent:main")).toBeUndefined();
  });

  it("builds prompt context for active session work", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: IMAGE_GENERATION_TASK_KIND,
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating image",
      },
    ]);

    const context = await buildActiveImageGenerationTaskPromptContextForSession("agent:main");

    expect(context).toBe(
      '- tool=image_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating image"',
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
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation((ownerKey) =>
      taskRuntimeInternalMocks.listTasksForOwnerKey(ownerKey),
    );
    taskRuntimeInternalMocks.reloadTaskRegistryFromStore.mockReset();
    resetRecentMediaGenerationDuplicateGuardsForTests();
  });

  it("recognizes active session-backed video generation tasks", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-1",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-2",
        runtime: "cron",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "make lobster video",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
    ]);

    expect((await findActiveVideoGenerationTaskForSession("agent:main"))?.taskId).toBe("task-1");
  });

  it("prefers a running task over queued session siblings", async () => {
    // Running work should suppress duplicate generation even when older queued
    // siblings still exist for the same session owner.
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-queued",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:google",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "queued task",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
      },
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
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
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        taskId: "task-running",
        runtime: "cli",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main",
        ownerKey: "agent:main",
        scopeKind: "session",
        task: "running task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating video",
      },
    ]);

    const context = await buildActiveVideoGenerationTaskPromptContextForSession("agent:main");

    expect(context).toBe(
      '- tool=video_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating video"',
    );
  });
});
