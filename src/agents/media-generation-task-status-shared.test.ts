import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS,
  recordRecentMediaGenerationTaskStartForSession,
} from "./media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "./media-generation-task-status-shared.test-support.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listFreshTasksForOwnerKey: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  readConfig: vi.fn<() => Promise<OpenClawConfig>>(),
  assertSourceCurrent: vi.fn(),
  captureRuntimeConfigAsyncReader:
    vi.fn<typeof import("../config/io.runtime.js").captureRuntimeConfigAsyncReader>(),
}));

const ownerMocks = vi.hoisted(() => ({
  assertTaskRegistryOwnerCurrent: vi.fn(),
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
  assertTaskRegistryOwnerCurrent: ownerMocks.assertTaskRegistryOwnerCurrent,
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

const fixedStoreConfig: OpenClawConfig = {
  session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
  agents: {
    ownership: "explicit",
    defaults: { sessionStore: { agentId: "ops" } },
    entries: { ops: {}, research: {} },
  },
};

beforeEach(() => {
  resetRecentMediaGenerationDuplicateGuardsForTests();
  taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReset();
  configMocks.readConfig.mockReset().mockResolvedValue(fixedStoreConfig);
  configMocks.assertSourceCurrent.mockReset();
  configMocks.captureRuntimeConfigAsyncReader.mockReset().mockImplementation((options = {}) => {
    const assertCurrent = () => {
      options.assertCurrent?.();
      configMocks.assertSourceCurrent();
    };
    return Object.assign(
      () => {
        assertCurrent();
        return configMocks.readConfig();
      },
      { assertCurrent },
    );
  });
  ownerMocks.assertTaskRegistryOwnerCurrent.mockReset();
  ownerMocks.context.admission.assertCurrent.mockReset();
});

describe("media generation delivery-phase prompt guard", () => {
  it("does not warn about a task waiting only for completion delivery", async () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ progressSummary: MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS }),
    ]);

    expect(
      await videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A"),
    ).toBeUndefined();
  });

  it("carries only bounded single-line facts while media generation is running", async () => {
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({
        taskId: `task-${"t".repeat(150)}`,
        sourceId: `video_generate:${"p".repeat(150)}`,
        progressSummary: `Generating\nvideo\u2028${"x".repeat(400)}`,
      }),
    ]);

    expect(await videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A")).toBe(
      `- tool=video_generate; task=task-${"t".repeat(123)}; status=running; provider_json="${"p".repeat(128)}"; progress_json="Generatingvideo${"x".repeat(305)}"`,
    );
  });

  it("keeps a bounded task snapshot stable across registry order and elapsed time", async () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeTask({
        taskId: `task-${index}`,
        sourceId: "video_generate",
        status: index % 2 === 0 ? "queued" : "running",
      }),
    );
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue(tasks.toReversed());

    const context = await videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A");
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
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue(tasks);
    expect(await videoTaskStatusOwner.buildActiveTaskPromptContextForSession("session/A")).toBe(
      context,
    );
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
    expect(configMocks.readConfig).toHaveBeenCalled();
    configMocks.readConfig.mockResolvedValue({
      ...fixedStoreConfig,
      agents: { ...fixedStoreConfig.agents, entries: { research: {} } },
    });
    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "research")).toEqual([]);
  });

  it.each([
    { ownerKey: "global", requesterAgentId: "ops" },
    { ownerKey: "agent:ops:main", requesterAgentId: undefined },
  ])("uses recorded requester identity without loading config for $ownerKey", async (identity) => {
    configMocks.assertSourceCurrent.mockImplementation(() => {
      throw new Error("unused config selector retired");
    });
    const task = makeTask({ ...identity, agentId: "research" });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
      makeTask({ taskId: "unrelated", taskKind: "image_generation" }),
      task,
    ]);

    expect(await videoTaskStatusOwner.listActiveTasksForSession(identity.ownerKey, "ops")).toEqual([
      task,
    ]);
    expect(configMocks.readConfig).not.toHaveBeenCalled();
    expect(configMocks.assertSourceCurrent).not.toHaveBeenCalled();
    expect(taskRuntimeInternalMocks.listFreshTasksForOwnerKey).toHaveBeenCalledOnce();
  });

  it("keeps known requester tasks visible when legacy config cannot be prepared", async () => {
    const known = makeTask({ taskId: "known", ownerKey: "global", requesterAgentId: "ops" });
    const legacy = makeTask({ taskId: "legacy", ownerKey: "global", agentId: "ops" });
    const updated = { ...known, progressSummary: "Rendering final frames" };
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey
      .mockReturnValueOnce([legacy, known])
      .mockReturnValue([legacy, updated]);
    configMocks.readConfig.mockRejectedValue(new Error("config unavailable"));

    expect(await videoTaskStatusOwner.listActiveTasksForSession("global", "ops")).toEqual([
      updated,
    ]);
  });

  it.each(
    (["active", "duplicate"] as const).flatMap((lookup) =>
      (["completed", "deleted"] as const).flatMap((change) =>
        (["resolves", "rejects"] as const).map((completion) => ({ lookup, change, completion })),
      ),
    ),
  )(
    "refreshes $lookup selection after a task is $change while config $completion",
    async ({ lookup, change, completion }) => {
      const started = createDeferred();
      const config = createDeferred<OpenClawConfig>();
      configMocks.readConfig.mockImplementation(() => {
        started.resolve();
        return config.promise;
      });
      const legacy = makeTask({ taskId: "legacy", ownerKey: "global", status: "succeeded" });
      const known = makeTask({ taskId: "known", ownerKey: "global", requesterAgentId: "ops" });
      let records = [legacy, known];
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation(() => records);
      const pending =
        lookup === "active"
          ? videoTaskStatusOwner.listActiveTasksForSession("global", "ops")
          : videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", { agentId: "ops" });
      await started.promise;
      records = change === "deleted" ? [legacy] : [legacy, { ...known, status: "succeeded" }];
      if (completion === "resolves") {
        config.resolve(fixedStoreConfig);
      } else {
        config.reject(new Error("config unavailable"));
      }

      expect(await pending).toEqual(lookup === "active" ? [] : undefined);
      expect(taskRuntimeInternalMocks.listFreshTasksForOwnerKey).toHaveBeenNthCalledWith(
        2,
        ownerMocks.context,
        "global",
      );
    },
  );

  it.each(
    (["task owner", "config source"] as const).flatMap((authority) =>
      (["resolves", "rejects"] as const).map((completion) => ({ authority, completion })),
    ),
  )(
    "propagates retired $authority during refreshed selection after config $completion",
    async ({ authority, completion }) => {
      const retired = new Error(`${authority} retired`);
      const assertion =
        authority === "task owner"
          ? ownerMocks.assertTaskRegistryOwnerCurrent
          : configMocks.assertSourceCurrent;
      const legacy = makeTask({ taskId: "legacy", ownerKey: "global" });
      const known = makeTask({ taskId: "known", ownerKey: "global", requesterAgentId: "ops" });
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey
        .mockReturnValueOnce([legacy, known])
        .mockImplementationOnce(async () => {
          assertion.mockImplementation(() => {
            throw retired;
          });
          return [known];
        });
      if (completion === "rejects") {
        configMocks.readConfig.mockRejectedValue(new Error("config unavailable"));
      }

      await expect(
        videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", { agentId: "ops" }),
      ).rejects.toBe(retired);
    },
  );

  it.each([
    { authority: "task owner", completion: "resolves" },
    { authority: "task owner", completion: "rejects" },
    { authority: "config source", completion: "resolves" },
    { authority: "config source", completion: "rejects" },
  ] as const)(
    "propagates retired $authority when pending config $completion",
    async ({ authority, completion }) => {
      const started = createDeferred();
      const config = createDeferred<OpenClawConfig>();
      configMocks.readConfig.mockImplementation(() => {
        started.resolve();
        return config.promise;
      });
      taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
        makeTask({ ownerKey: "global" }),
      ]);
      const pending = videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", {
        agentId: "ops",
      });
      await started.promise;
      const retired = new Error(`${authority} retired`);
      const assertion =
        authority === "task owner"
          ? ownerMocks.assertTaskRegistryOwnerCurrent
          : configMocks.assertSourceCurrent;
      assertion.mockImplementation(() => {
        throw retired;
      });
      const rejected = expect(pending).rejects.toBe(retired);
      if (completion === "resolves") {
        config.resolve(fixedStoreConfig);
      } else {
        config.reject(new Error("config unavailable"));
      }
      await rejected;
    },
  );

  it("keeps a recent start added while requester config is being prepared", async () => {
    const started = createDeferred();
    const config = createDeferred<OpenClawConfig>();
    configMocks.readConfig.mockImplementation(() => {
      started.resolve();
      return config.promise;
    });
    taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockReturnValue([
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
      runId: "recent-run",
      taskLabel: "new request",
      requestKey: "new-request-key",
      progressSummary: "Generating video",
    });
    config.resolve(fixedStoreConfig);

    expect(await pending).toMatchObject({ taskId: "recent-start", status: "running" });
  });

  it.each([
    { lookup: "active", prepared: "tasks" },
    { lookup: "duplicate", prepared: "tasks" },
    { lookup: "active", prepared: "config" },
    { lookup: "duplicate", prepared: "config" },
  ] as const)(
    "revalidates $lookup ownership when $prepared preparation settles before its caller resumes",
    async ({ lookup, prepared }) => {
      let settled = false;
      let queued = false;
      let retired = false;
      let lateSelections = 0;
      const retirement = new Error(`${prepared} owner retired after preparation`);
      const task: TaskRecord = {
        ...makeTask({
          ownerKey: "global",
          requesterAgentId: prepared === "tasks" ? "ops" : undefined,
        }),
        get taskKind() {
          if (retired) {
            lateSelections += 1;
          }
          return "video_generation";
        },
      };
      const assertCurrent = () => {
        if (retired) {
          throw retirement;
        }
        if (settled && !queued) {
          queued = true;
          queueMicrotask(() => {
            retired = true;
          });
        }
      };
      if (prepared === "tasks") {
        taskRuntimeInternalMocks.listFreshTasksForOwnerKey.mockImplementation(() =>
          Promise.resolve([task]).then((tasks) => {
            settled = true;
            return tasks;
          }),
        );
        ownerMocks.assertTaskRegistryOwnerCurrent.mockImplementation(assertCurrent);
      } else {
        taskRuntimeInternalMocks.listFreshTasksForOwnerKey
          .mockResolvedValueOnce([task])
          .mockImplementationOnce(() =>
            Promise.resolve([task]).then((tasks) => {
              settled = true;
              return tasks;
            }),
          );
        configMocks.assertSourceCurrent.mockImplementation(assertCurrent);
      }
      if (lookup === "duplicate") {
        recordRecentMediaGenerationTaskStartForSession({
          sessionKey: "global",
          agentId: "ops",
          taskKind: "video_generation",
          sourcePrefix: "video_generate",
          taskId: task.taskId,
          runId: task.runId,
          taskLabel: task.task,
          progressSummary: "Generating video",
        });
      }
      const pending =
        lookup === "active"
          ? videoTaskStatusOwner.listActiveTasksForSession("global", "ops")
          : videoTaskStatusOwner.findDuplicateGuardTaskForSession("global", { agentId: "ops" });

      await expect(pending).rejects.toBe(retirement);
      expect(lateSelections).toBe(0);
      if (prepared === "tasks") {
        expect(configMocks.readConfig).not.toHaveBeenCalled();
        expect(configMocks.assertSourceCurrent).not.toHaveBeenCalled();
      }
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
