import { beforeEach, expect, it, vi } from "vitest";
import type {
  listMediaGenerationOperations,
  MediaGenerationOperation,
} from "./media-generation-activity.js";
import {
  buildMediaTaskRuntimeContext,
  buildImageGenerationTaskStatusDetails as imageDetails,
  buildImageGenerationTaskStatusText as imageText,
  findDuplicateGuardImageGenerationTaskForSession as findImage,
  IMAGE_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

const { listOperations } = vi.hoisted(() => ({
  listOperations: vi.fn<typeof listMediaGenerationOperations>(),
}));

// mock-isolation: Status fixtures supply task rows without reading the live operation registry.
vi.mock("./media-generation-activity.js", () => ({
  listMediaGenerationOperations: listOperations,
}));

function makeTask(overrides: Partial<MediaGenerationOperation>): MediaGenerationOperation {
  return {
    taskId: "task-running",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourceId: "image_generate:openai",
    requesterSessionKey: "agent:main",
    task: "running task",
    status: "running",
    ...overrides,
  };
}

beforeEach(() => {
  listOperations.mockReset().mockReturnValue([]);
});

function completedImage(name: string) {
  return makeTask({
    taskId: `task-${name}`,
    requestKey: `image-request:${name}`,
    status: "succeeded",
  });
}

const findImageRequest = (requestKey: string) => findImage("agent:main", { requestKey });
it("prefers a running image task over queued session siblings", async () => {
  const findRunning = () => findImage("agent:main", { prompt: "running task" });
  expect(await findRunning()).toBeUndefined();
  listOperations.mockReturnValue([
    makeTask({ taskId: "task-queued", status: "queued" }),
    makeTask({ progressSummary: "Generating image" }),
  ]);
  const activeTask = await findRunning();
  expect(activeTask?.taskId).toBe("task-running");
  expect(imageText(activeTask!, { duplicateGuard: true })).toContain(
    "Do not call image_generate again for this request.",
  );
  expect(imageDetails(activeTask!)).toMatchObject({
    active: true,
    existingTask: true,
    status: "running",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    provider: "openai",
    progressSummary: "Generating image",
  });
});

it("preserves earlier recent request keys when another image request starts", async () => {
  listOperations.mockReturnValue([completedImage("first"), completedImage("second")]);

  expect(await findImageRequest("image-request:other")).toBeUndefined();
  expect((await findImageRequest("image-request:first"))?.taskId).toBe("task-first");
  expect((await findImageRequest("image-request:second"))?.taskId).toBe("task-second");
});

it("does not reuse an older success after a newer matching request failed", async () => {
  listOperations.mockReturnValue([
    completedImage("same"),
    { ...completedImage("same"), taskId: "task-retry", status: "failed" },
  ]);
  expect(await findImageRequest("image-request:same")).toBeUndefined();
});

it("builds video prompt context for active session work", async () => {
  listOperations.mockReturnValue([
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
