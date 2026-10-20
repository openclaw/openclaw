import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  listMediaGenerationOperations,
  MediaGenerationOperation,
} from "./media-generation-activity.js";
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

beforeEach(() => {
  mediaActivityMocks.listOperations.mockReset().mockReturnValue([]);
});

afterEach(() => vi.restoreAllMocks());

function expectActiveTask(task: MediaGenerationOperation | undefined) {
  expect(task?.taskId).toBe("task-running");
  return task!;
}

function completedImage(name: string, createdAt: number, endedAt: number) {
  return makeTask({
    taskId: `task-${name}`,
    runId: `run-${name}`,
    sourceId: "image_generate:xai",
    task: `${name} prompt`,
    requestKey: `image-request:${name}`,
    status: "succeeded",
    createdAt,
    endedAt,
    progressSummary: `Generated ${name} image`,
  });
}

const findImageRequest = (requestKey: string) =>
  findDuplicateGuardImageGenerationTaskForSession("agent:main", { requestKey });
const findImagePrompt = (prompt: string) =>
  findDuplicateGuardImageGenerationTaskForSession("agent:main", { prompt });

it.each([
  [
    "image",
    IMAGE_GENERATION_TASK_KIND,
    findDuplicateGuardImageGenerationTaskForSession,
    buildImageGenerationTaskStatusText,
    buildImageGenerationTaskStatusDetails,
  ],
  [
    "video",
    VIDEO_GENERATION_TASK_KIND,
    findActiveVideoGenerationTaskForSession,
    buildVideoGenerationTaskStatusText,
    buildVideoGenerationTaskStatusDetails,
  ],
] as const)(
  "prefers a running %s task over queued session siblings",
  async (media, taskKind, findTask, buildText, buildDetails) => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        taskKind,
        sourceId: `${media}_generate:google`,
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        taskKind,
        sourceId: `${media}_generate:openai`,
        progressSummary: `Generating ${media}`,
      }),
    ]);

    const activeTask = expectActiveTask(await findTask("agent:main"));
    expect(buildText(activeTask, { duplicateGuard: true })).toContain(
      `Do not call ${media}_generate again for this request.`,
    );
    expect(buildDetails(activeTask)).toMatchObject({
      active: true,
      existingTask: true,
      status: "running",
      taskKind,
      provider: "openai",
      progressSummary: `Generating ${media}`,
    });
  },
);

describe("image generation task status", () => {
  it("preserves earlier recent request keys when another image request starts", async () => {
    const now = Date.now();
    mediaActivityMocks.listOperations.mockReturnValue([
      completedImage("first", now - 30_000, now - 15_000),
      completedImage("second", now - 20_000, now - 10_000),
    ]);

    expect(await findImageRequest("image-request:other")).toBeUndefined();
    expect((await findImageRequest("image-request:first"))?.taskId).toBe("task-first");
    expect((await findImageRequest("image-request:second"))?.taskId).toBe("task-second");
  });

  it("observes a newly admitted operation on the next owner lookup", async () => {
    expect(await findImagePrompt("new image")).toBeUndefined();
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-newly-started",
        runId: "run-newly-started",
        task: "new image",
      }),
    ]);
    expect(await findImagePrompt("new image")).toMatchObject({
      taskId: "task-newly-started",
      status: "running",
    });
  });

  it("does not block a distinct prompt from a retained operation's recent start", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-first",
        runId: "run-first",
        task: "first prompt",
      }),
    ]);

    expect(await findImagePrompt("first prompt")).toMatchObject({
      taskId: "task-first",
      status: "running",
    });
    expect(await findImagePrompt("second prompt")).toBeUndefined();
  });

  it("uses a retained completion after a long-running generation", async () => {
    const now = Date.now();
    mediaActivityMocks.listOperations.mockReturnValue([
      {
        ...completedImage("completed", now - 3 * 60_000, now - 1_000),
        task: "recent prompt",
        requestKey: "image-request:stale",
        progressSummary: "Generated 1 image",
      },
    ]);

    const task = await findImageRequest("image-request:stale");

    expect(task?.status).toBe("succeeded");
    expect(buildImageGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Image generation task task-completed recently succeeded with xai.",
    );
  });
  it("does not reuse an older success after a newer matching request failed", async () => {
    const now = Date.now();
    mediaActivityMocks.listOperations.mockReturnValue([
      completedImage("same", now - 30_000, now - 20_000),
      {
        ...completedImage("same", now - 10_000, now - 1_000),
        taskId: "task-retry",
        runId: "run-retry",
        status: "failed",
      },
    ]);
    expect(await findImageRequest("image-request:same")).toBeUndefined();
  });
});

it("builds video prompt context for active session work", async () => {
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
