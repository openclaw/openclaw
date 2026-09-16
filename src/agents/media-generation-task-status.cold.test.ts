import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import {
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  listActiveImageGenerationTasksForSession,
  findDuplicateGuardImageGenerationTaskForSession,
  IMAGE_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "media-task-status-cold-",
  });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  await state.cleanup();
});

describe("cold media generation task status", () => {
  it("resolves legacy requester identity from cold config without parent SQLite through close", async () => {
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
    closeOpenClawStateDatabase();
    const native = requireNodeSqlite();
    const counters = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["iterate", "get", "all", "run"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    expect(getRuntimeConfigSnapshot()).toBeNull();
    await withPluginCache(createPluginCache(), async () => {
      expect(
        (await listActiveImageGenerationTasksForSession("global", "ops")).map(
          (entry) => entry.taskId,
        ),
      ).toEqual(["legacy-media"]);
      expect(await listActiveImageGenerationTasksForSession("global", "research")).toEqual([]);
      expect(
        (await findDuplicateGuardImageGenerationTaskForSession("global", { agentId: "ops" }))
          ?.taskId,
      ).toBe("legacy-media");
    });
    await closeOpenClawStateDatabaseAsync();
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
