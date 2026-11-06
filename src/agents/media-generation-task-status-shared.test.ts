vi.mock("./media-generation-activity.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./media-generation-activity.js")>()),
    listMediaGenerationOperations: listOperations,
  };
});
import { expect, it, vi } from "vitest";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import {
  buildActiveMediaGenerationTaskPromptContext,
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
} from "./media-generation-task-status-shared.js";

const listOperations = vi.hoisted(() => vi.fn());

const videoTaskStatusOwner = createMediaGenerationTaskStatusOwner({
  taskKind: "video_generation",
  toolName: "video_generate",
  nounLabel: "video",
  completionLabel: "video",
  promptCompletionLabel: "video",
});

function makeTask(overrides: Partial<MediaGenerationOperation> = {}): MediaGenerationOperation {
  return {
    taskId: "task-1",
    taskKind: "video_generation",
    sourceId: "video_generate:byteplus",
    requesterSessionKey: "session/A",
    status: "running",
    ...overrides,
  };
}

function prompt(...tasks: MediaGenerationOperation[]) {
  return buildActiveMediaGenerationTaskPromptContext({
    tasks,
    taskKind: "video_generation",
    sourcePrefix: "video_generate",
  });
}

it("does not warn about a task waiting only for completion delivery", () => {
  expect(
    prompt(makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS })),
  ).toBeUndefined();
});

it("carries only bounded single-line facts while media generation is running", () => {
  const task = makeTask({
    taskId: `task-${"t".repeat(150)}`,
    sourceId: `video_generate:${"p".repeat(150)}`,
    progressSummary: `Generating\nvideo\u2028${"x".repeat(400)}`,
  });
  expect(prompt(task)).toBe(
    `- tool=video_generate; task=task-${"t".repeat(123)}; status=running; provider_json="${"p".repeat(128)}"; progress_json="Generatingvideo${"x".repeat(305)}"`,
  );
});

it("keeps a bounded task snapshot stable across registry order", () => {
  const tasks = Array.from({ length: 10 }, (_, index) =>
    makeTask({
      taskId: `task-${index}`,
      sourceId: "video_generate",
      status: index % 2 === 0 ? "queued" : "running",
    }),
  );
  const context = prompt(...tasks);
  expect(context).toBe(
    [
      ...Array.from(
        { length: 8 },
        (_, i) =>
          `- tool=video_generate; task=task-${i}; status=${i % 2 === 0 ? "queued" : "running"}`,
      ),
      "- additional_tasks=2",
    ].join("\n"),
  );

  expect(prompt(...tasks.toReversed())).toBe(context);
});

it("keeps bare-session operations visible only to their explicit requester agent", async () => {
  const task = makeTask({
    requesterSessionKey: "global",
    requesterAgentId: "ops",
    progressSummary: "Generating video",
  });
  listOperations.mockReturnValue([task]);

  expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([task]);
  expect(await videoTaskStatusOwner.findActiveTaskForSession("global", { agentId: "ops" })).toEqual(
    task,
  );
  expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "research")).toEqual([]);
});
