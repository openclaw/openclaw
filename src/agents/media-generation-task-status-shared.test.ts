import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CapturedRuntimeConfigRead } from "../config/runtime-config-capture-state.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContext,
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
  recordRecentMediaGenerationTaskStartForSession,
} from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";
import { buildMediaTaskRuntimeContext } from "./media-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listFreshTasksForOwnerKey: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  readConfig: Object.assign(vi.fn<() => Promise<CapturedRuntimeConfigRead>>(), {
    assertCurrent: vi.fn(),
  }),
  captureRuntimeConfigAsyncReader: vi.fn(),
}));

const ownerMocks = vi.hoisted(() => ({
  assertCurrent: vi.fn(),
  context: {
    admission: {
      databasePath: "/synthetic/media/state.sqlite",
      identity: { key: "media-test", canonicalPath: "/synthetic/media/state.sqlite" },
      assertCurrent: vi.fn(),
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/media" },
    coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
  } satisfies OpenClawStateWorkerContext,
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../config/io.runtime.js", () => ({
  captureRuntimeConfigAsyncReader: configMocks.captureRuntimeConfigAsyncReader,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ownerMocks.context,
}));
vi.mock("../tasks/task-registry-state.js", () => ({
  assertTaskRegistryOwnerCurrent: ownerMocks.assertCurrent,
}));
vi.mock("../tasks/task-registry.store.js", () => ({
  getTaskRegistryStore: () => ({}),
}));

const videoTaskStatusOwner = createMediaGenerationTaskStatusOwner({
  taskKind: "video_generation",
  toolName: "video_generate",
  nounLabel: "video",
  completionLabel: "video",
  promptCompletionLabel: "video",
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-1",
    runtime: "cli",
    taskKind: "video_generation",
    sourceId: "video_generate:byteplus",
    requesterSessionKey: "session/A",
    ownerKey: "session/A",
    scopeKind: "session",
    runId: "run-1",
    task: "generate clip 01",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now,
    startedAt: now,
    lastEventAt: now,
    ...overrides,
  };
}

const capturedConfig: CapturedRuntimeConfigRead = {
  config: {
    session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  },
  env: {},
};

beforeEach(() => {
  resetRecentMediaGenerationDuplicateGuardsForTests();
  taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
  configMocks.readConfig.mockReset().mockResolvedValue(capturedConfig);
  configMocks.readConfig.assertCurrent.mockReset();
  configMocks.captureRuntimeConfigAsyncReader.mockReset().mockReturnValue(configMocks.readConfig);
  ownerMocks.assertCurrent.mockReset();
});

describe("media generation provider attribution", () => {
  it.each([
    {
      name: "successful generation metadata",
      detail: { mediaGeneration: { provider: "fallback", model: "fallback-v1" } },
      attribution: { selectedProvider: "byteplus", provider: "fallback", model: "fallback-v1" },
      statusSuffix: " with fallback",
      promptSuffix: '; provider_json="fallback"; model_json="fallback-v1"',
    },
    {
      name: "a legacy task without generation metadata",
      detail: undefined,
      attribution: { selectedProvider: "byteplus" },
      statusSuffix: " (initial provider: byteplus)",
      promptSuffix: "",
    },
    {
      name: "malformed generation metadata",
      detail: { mediaGeneration: { provider: 42, model: "fallback-v1" } },
      attribution: { selectedProvider: "byteplus" },
      statusSuffix: " (initial provider: byteplus)",
      promptSuffix: "",
    },
  ])("presents $name consistently", ({ detail, attribution, statusSuffix, promptSuffix }) => {
    const task = makeTask({ detail });
    const expectedDetails = {
      async: true,
      active: true,
      existingTask: true,
      status: "running",
      task: { taskId: "task-1", runId: "run-1" },
      taskKind: "video_generation",
      sourceId: "video_generate:byteplus",
      ...attribution,
    };

    expect(videoTaskStatusOwner.buildTaskStatusDetails(task)).toEqual(expectedDetails);
    expect(videoTaskStatusOwner.buildTaskStatusListDetails([task])).toMatchObject({
      tasks: [expectedDetails],
    });
    expect(videoTaskStatusOwner.buildTaskStatusText(task)).toContain(
      `video task task-1 is already running${statusSuffix}.`,
    );
    expect(videoTaskStatusOwner.buildTaskStatusListText([task])).toContain(
      `- Task task-1 (run run-1) is running${statusSuffix}.`,
    );
    expect(
      buildActiveMediaGenerationTaskPromptContext({
        tasks: [task],
        taskKind: "video_generation",
        sourcePrefix: "video_generate",
      }),
    ).toBe(
      `- tool=video_generate; task=task-1; status=running; selected_provider_json="byteplus"${promptSuffix}`,
    );
  });
});

describe("media generation delivery-phase prompt guard", () => {
  it("does not warn about a task waiting only for completion delivery", () => {
    const tasks = [makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS })];

    expect(
      buildActiveMediaGenerationTaskPromptContext({
        tasks,
        taskKind: "video_generation",
        sourcePrefix: "video_generate",
      }),
    ).toBeUndefined();
  });

  it("carries only bounded single-line facts while media generation is running", () => {
    const tasks = [
      makeTask({
        taskId: `task-${"t".repeat(150)}`,
        sourceId: `video_generate:${"p".repeat(150)}`,
        detail: {
          mediaGeneration: {
            provider: `actual\n${"a".repeat(150)}`,
            model: `model\u2028${"m".repeat(150)}`,
          },
        },
        progressSummary: `Generating\nvideo\u2028${"x".repeat(400)}`,
      }),
    ];

    expect(
      buildActiveMediaGenerationTaskPromptContext({
        tasks,
        taskKind: "video_generation",
        sourcePrefix: "video_generate",
      }),
    ).toBe(
      `- tool=video_generate; task=task-${"t".repeat(123)}; status=running; selected_provider_json="${"p".repeat(128)}"; provider_json="actual${"a".repeat(122)}"; model_json="model${"m".repeat(123)}"; progress_json="Generatingvideo${"x".repeat(305)}"`,
    );
  });

  it("keeps a bounded task snapshot stable across registry order and elapsed time", () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeTask({
        taskId: `task-${index}`,
        sourceId: "video_generate",
        status: index % 2 === 0 ? "queued" : "running",
      }),
    );
    const context = buildActiveMediaGenerationTaskPromptContext({
      tasks,
      taskKind: "video_generation",
      sourcePrefix: "video_generate",
    });
    expect(context).toBe(
      [
        "- tool=video_generate; task=task-0; status=queued",
        "- tool=video_generate; task=task-1; status=running",
        "- tool=video_generate; task=task-2; status=queued",
        "- tool=video_generate; task=task-3; status=running",
        "- tool=video_generate; task=task-4; status=queued",
        "- tool=video_generate; task=task-5; status=running",
        "- tool=video_generate; task=task-6; status=queued",
        "- tool=video_generate; task=task-7; status=running",
        "- additional_tasks=2",
      ].join("\n"),
    );

    for (const task of tasks) {
      task.lastEventAt = task.createdAt + 60_000;
    }
    expect(
      buildActiveMediaGenerationTaskPromptContext({
        tasks: tasks.toReversed(),
        taskKind: "video_generation",
        sourcePrefix: "video_generate",
      }),
    ).toBe(context);
  });

  it("keeps delivery-phase tasks available to duplicate/status lookups", async () => {
    const task = makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(await videoTaskStatusOwner.listActiveTasksForSession("session/A")).toEqual([task]);
    expect(await videoTaskStatusOwner.findActiveTaskForSession("session/A")).toEqual(task);
  });

  it("keeps restored legacy bare tasks visible only to their persisted requester owner", async () => {
    const task = makeTask({
      requesterSessionKey: "global",
      ownerKey: "global",
      requesterAgentId: undefined,
      agentId: "research",
      progressSummary: "Generating video",
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([task]);
    expect(
      await videoTaskStatusOwner.findActiveTaskForSession("global", { agentId: "ops" }),
    ).toEqual(task);
    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "research")).toEqual([]);
    configMocks.readConfig.mockResolvedValue({
      ...capturedConfig,
      config: {
        ...capturedConfig.config,
        agents: { ...capturedConfig.config.agents, entries: { research: {} } },
      },
    });
    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "research")).toEqual([]);
  });

  it.each([
    { ownerKey: "global", requesterAgentId: "ops" },
    { ownerKey: "agent:ops:main", requesterAgentId: undefined },
  ])("uses recorded requester identity without loading config for $ownerKey", async (identity) => {
    const task = makeTask({ ...identity, agentId: "research" });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([
      makeTask({ taskId: "unrelated", taskKind: "image_generation" }),
      task,
    ]);

    expect(await videoTaskStatusOwner.listActiveTasksForSession(identity.ownerKey, "ops")).toEqual([
      task,
    ]);
    expect(configMocks.readConfig).not.toHaveBeenCalled();
  });

  it("keeps known requesters visible when legacy config cannot be prepared", async () => {
    const known = makeTask({ taskId: "known", ownerKey: "global", requesterAgentId: "ops" });
    const legacy = makeTask({ taskId: "legacy", ownerKey: "global", agentId: "ops" });
    const updated = { ...known, progressSummary: "Rendering final frames" };
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey
      .mockResolvedValueOnce([legacy, known])
      .mockResolvedValue([legacy, updated]);
    configMocks.readConfig.mockRejectedValue(new Error("config unavailable"));

    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([
      updated,
    ]);
  });

  it("includes restored legacy media in the shared prompt only for its requester", async () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([
      makeTask({ ownerKey: "global", agentId: "research" }),
      makeTask({
        taskId: "music-1",
        ownerKey: "global",
        taskKind: "music_generation",
        sourceId: "music_generate",
      }),
    ]);
    const params = {
      capabilityToolNames: new Set(["video_generate", "music_generate"]),
      sessionKey: "global",
    };
    expect(await buildMediaTaskRuntimeContext({ ...params, agentId: "ops" })).toBe(
      '## Media Generation Tasks\n- tool=music_generate; task=music-1; status=running\n- tool=video_generate; task=task-1; status=running; selected_provider_json="byteplus"',
    );
    expect(configMocks.readConfig).toHaveBeenCalledTimes(1);
    expect(await buildMediaTaskRuntimeContext({ ...params, agentId: "research" })).toBe(
      "## Media Generation Tasks\n- tool=music_generate; none\n- tool=video_generate; none",
    );
  });

  it.each(["succeeded", "failed"] as const)(
    "skips requester config for terminal-only %s status and prompt lookups",
    async (status) => {
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([
        makeTask({ ownerKey: "global", status }),
      ]);

      expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([]);
      expect(
        await buildMediaTaskRuntimeContext({
          capabilityToolNames: new Set(["video_generate"]),
          sessionKey: "global",
          agentId: "ops",
        }),
      ).toBe("## Media Generation Tasks\n- tool=video_generate; none");
      expect(configMocks.readConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["succeeded", "failed"] as const)(
    "resolves a persisted legacy %s task before applying a cached duplicate guard",
    async (status) => {
      const task = makeTask({ ownerKey: "global", status });
      recordRecentMediaGenerationTaskStartForSession({
        sessionKey: "global",
        agentId: "ops",
        taskKind: "video_generation",
        sourcePrefix: "video_generate",
        taskId: task.taskId,
        runId: task.runId,
        taskLabel: task.task,
        requestKey: "same-request",
        progressSummary: "Generating video",
      });
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([task]);

      const duplicate = await videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", {
        agentId: "ops",
        requestKey: "same-request",
      });
      expect(duplicate).toEqual(status === "succeeded" ? task : undefined);
    },
  );

  it.each(
    (["active", "duplicate", "prompt"] as const).flatMap((lookup) =>
      (["completed", "deleted"] as const).flatMap((change) =>
        (["resolves", "rejects"] as const).map((completion) => ({ lookup, change, completion })),
      ),
    ),
  )(
    "refreshes $lookup selection after a task is $change while config $completion",
    async ({ lookup, change, completion }) => {
      const started = createDeferred();
      const config = createDeferred<CapturedRuntimeConfigRead>();
      configMocks.readConfig.mockImplementation(() => {
        started.resolve();
        return config.promise;
      });
      const legacy = makeTask({ taskId: "legacy", ownerKey: "global" });
      const known = makeTask({ taskId: "known", ownerKey: "global", requesterAgentId: "ops" });
      let records = [legacy, known];
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation(async () => records);
      const pending =
        lookup === "active"
          ? videoTaskStatusOwner.listActiveTasksForSession("global", "ops")
          : lookup === "prompt"
            ? buildMediaTaskRuntimeContext({
                capabilityToolNames: new Set(["video_generate"]),
                sessionKey: "global",
                agentId: "ops",
              })
            : videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", { agentId: "ops" });
      await started.promise;
      records =
        change === "deleted"
          ? []
          : records.map((task) => Object.assign({}, task, { status: "succeeded" as const }));
      if (completion === "resolves") {
        config.resolve(capturedConfig);
      } else {
        config.reject(new Error("config unavailable"));
      }

      expect(await pending).toEqual(
        lookup === "active"
          ? []
          : lookup === "prompt"
            ? "## Media Generation Tasks\n- tool=video_generate; none"
            : undefined,
      );
    },
  );

  it.each(["resolves", "rejects"])(
    "propagates retired task ownership when pending config %s",
    async (completion) => {
      const started = createDeferred();
      const config = createDeferred<CapturedRuntimeConfigRead>();
      configMocks.readConfig.mockImplementation(() => {
        started.resolve();
        return config.promise;
      });
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([
        makeTask({ ownerKey: "global" }),
      ]);
      const pending = videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", {
        agentId: "ops",
      });
      await started.promise;
      const retired = new Error("task owner retired");
      ownerMocks.assertCurrent.mockImplementation(() => {
        throw retired;
      });
      const rejected = expect(pending).rejects.toBe(retired);
      if (completion === "resolves") {
        config.resolve(capturedConfig);
      } else {
        config.reject(new Error("config unavailable"));
      }
      await rejected;
    },
  );

  it("keeps a recent start added while requester config is being prepared", async () => {
    const started = createDeferred();
    const config = createDeferred<CapturedRuntimeConfigRead>();
    configMocks.readConfig.mockImplementation(() => {
      started.resolve();
      return config.promise;
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockResolvedValue([
      makeTask({ ownerKey: "global", task: "different prompt" }),
    ]);
    const pending = videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", {
      agentId: "ops",
      prompt: "new request",
      requestKey: "new-request-key",
    });
    await started.promise;
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "global",
      agentId: "ops",
      taskKind: "video_generation",
      sourcePrefix: "video_generate",
      taskId: "recent-start",
      taskLabel: "new request",
      requestKey: "new-request-key",
      progressSummary: "Generating video",
    });
    config.resolve(capturedConfig);

    expect(await pending).toMatchObject({ taskId: "recent-start", status: "running" });
  });

  it.each(["active", "duplicate", "prompt"] as const)(
    "rejects %s selection after ownership retires between preparation and continuation",
    async (lookup) => {
      let settled = false;
      let queued = false;
      let retired = false;
      const retirement = new Error("task owner retired after preparation");
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation(async () => {
        settled = true;
        return [makeTask({ ownerKey: "global", requesterAgentId: "ops" })];
      });
      ownerMocks.assertCurrent.mockImplementation(() => {
        if (retired) {
          throw retirement;
        }
        if (settled && !queued) {
          queued = true;
          queueMicrotask(() => {
            retired = true;
          });
        }
      });
      const pending =
        lookup === "active"
          ? videoTaskStatusOwner.listActiveTasksForSession("global", "ops")
          : lookup === "prompt"
            ? buildMediaTaskRuntimeContext({
                capabilityToolNames: new Set(["video_generate"]),
                sessionKey: "global",
                agentId: "ops",
              })
            : videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", { agentId: "ops" });

      await expect(pending).rejects.toBe(retirement);
    },
  );

  it("blocks the same prompt while allowing a distinct prompt", async () => {
    const task = makeTask({
      task: "generate clip 01",
      progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([task]);

    expect(
      await videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 01",
      }),
    ).toEqual(task);
    expect(
      await videoTaskStatusOwner.findDuplicateGuardTaskForSession("session/A", {
        prompt: "generate clip 02",
      }),
    ).toBeUndefined();
  });
});
