import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as taskRuntime from "../tasks/runtime-internal.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import {
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  buildMediaTaskRuntimeContext,
  IMAGE_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";
import {
  createImageGenerateDuplicateGuardResult,
  createImageGenerateStatusActionResult,
} from "./tools/image-generate-tool.actions.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "media-task-status-cold-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await state.writeConfig({
    gateway: { mode: "local" },
    session: { scope: "global", store: state.statePath("legacy-sessions.sqlite") },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  });
  vi.spyOn(process, "cwd").mockReturnValue(state.workspaceDir);
  upsertTaskWithDeliveryStateToSqlite({
    task: {
      taskId: "legacy-media",
      runtime: "cli",
      requesterSessionKey: "global",
      ownerKey: "global",
      scopeKind: "session",
      task: "Synthetic restore",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 10,
      runId: "legacy-media-run",
      agentId: "research",
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourceId: "image_generate:synthetic",
    },
  });
  await closeOpenClawStateDatabaseAsync();
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  await state.cleanup();
});

describe("cold media generation task status", () => {
  it("resolves legacy requester identity from cold config without parent SQLite through close", async () => {
    const mainSql = observeMainThreadSql();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(
      await buildMediaTaskRuntimeContext({
        capabilityToolNames: new Set(["image_generate"]),
        sessionKey: "global",
        agentId: "ops",
      }),
    ).toBe(
      '## Media Generation Tasks\n- tool=image_generate; task=legacy-media; status=running; provider_json="synthetic"',
    );
    await withPluginCache(createPluginCache(), async () => {
      expect((await createImageGenerateStatusActionResult("global", "ops")).details).toMatchObject({
        active: true,
        task: { taskId: "legacy-media" },
      });
      expect(
        (await createImageGenerateStatusActionResult("global", "research")).details,
      ).toMatchObject({
        active: false,
      });
      expect(
        (await createImageGenerateDuplicateGuardResult("global", { agentId: "ops" }))?.details,
      ).toMatchObject({ task: { taskId: "legacy-media" } });
    });
    await closeOpenClawStateDatabaseAsync();
    mainSql.expectIdle();
  });

  it.each([1, 2])("rejects a changed config source during task read %i", async (readToChange) => {
    const listTasks = taskRuntime.listFreshTasksForOwnerKey;
    let reads = 0;
    vi.spyOn(taskRuntime, "listFreshTasksForOwnerKey").mockImplementation(async (ownerKey) => {
      const tasks = await listTasks(ownerKey);
      if (++reads === readToChange) {
        process.env.OPENCLAW_CONFIG_PATH = state.statePath("replacement.json");
      }
      return tasks;
    });

    await expect(
      buildMediaTaskRuntimeContext({
        capabilityToolNames: new Set(["image_generate"]),
        sessionKey: "global",
        agentId: "ops",
      }),
    ).rejects.toThrow("Runtime config source changed");
    expect(reads).toBe(readToChange);
  });

  it("retains its captured requester across an ordinary same-source config reload", async () => {
    const listTasks = taskRuntime.listFreshTasksForOwnerKey;
    let reads = 0;
    vi.spyOn(taskRuntime, "listFreshTasksForOwnerKey").mockImplementation(async (ownerKey) => {
      const tasks = await listTasks(ownerKey);
      if (++reads === 2) {
        setRuntimeConfigSnapshot({
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "research" } },
            entries: { ops: {}, research: {} },
          },
        });
      }
      return tasks;
    });

    expect(
      await buildMediaTaskRuntimeContext({
        capabilityToolNames: new Set(["image_generate"]),
        sessionKey: "global",
        agentId: "ops",
      }),
    ).toContain("task=legacy-media; status=running");
    expect(reads).toBe(2);
  });
});
