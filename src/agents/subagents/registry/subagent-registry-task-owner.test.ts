import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import type {
  DetachedTaskCreateParams,
  DetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime-contract.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../../../test-utils/task-registry-store.js";
import { captureQueuedSubagentTaskOwner } from "./subagent-registry-task-owner.js";

const registries: PluginRegistry[] = [];
let sql: ReturnType<typeof observeMainThreadSql>;
const params: DetachedTaskCreateParams = {
  runtime: "subagent",
  runId: "original-run",
  ownerKey: "agent:main:parent",
  scopeKind: "session",
  childSessionKey: "agent:main:child",
  task: "Synthetic captured task",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
};
const task: TaskRecord = {
  taskId: "created-task",
  runtime: "subagent",
  runId: "original-run",
  ownerKey: "agent:main:parent",
  scopeKind: "session",
  childSessionKey: "agent:main:child",
  task: params.task,
  requesterSessionKey: "agent:main:parent",
  status: "queued",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 1,
};

function registry() {
  const result = createEmptyPluginRegistry();
  registries.push(result);
  return result;
}

function backend() {
  const create = vi.fn<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]>(() =>
    structuredClone(task),
  );
  const finalize = vi.fn<NonNullable<DetachedTaskLifecycleRuntime["finalizeTaskRunByRunId"]>>(
    (terminal) => [{ ...task, status: terminal.status, endedAt: terminal.endedAt }],
  );
  const find = vi.fn((): never => {
    throw new Error("Captured task ownership must not use a new run lookup");
  });
  const runtime: DetachedTaskLifecycleRuntime = {
    createQueuedTaskRun: create,
    createRunningTaskRun: () => null,
    startTaskRunByRunId: () => [],
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: finalize,
    completeTaskRunByRunId: () => [],
    failTaskRunByRunId: (terminal) =>
      finalize({ ...terminal, status: terminal.status ?? "failed" }),
    setDetachedTaskDeliveryStatusByRunId: () => [],
    cancelDetachedTaskRunById: async () => ({ found: false, cancelled: false }),
    findTaskRun: find,
  };
  return { runtime, create, finalize, find };
}

function registered() {
  const selected = backend();
  const original = registry();
  const record = createPluginRecord({ id: "original-owner" });
  original.plugins.push(record);
  const instance = new PluginInstance(record.id, { registry: original, record });
  original.detachedTaskRuntimes.push({ pluginId: record.id, runtime: selected.runtime });
  markPluginRegistryActive(original);
  return { ...selected, original, record, instance };
}

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  sql = observeMainThreadSql();
});
afterEach(() => {
  try {
    sql.expectIdle();
  } finally {
    sql.restore();
    for (const current of registries.splice(0)) {
      markPluginRegistryRetired(current);
    }
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  }
});

it("retains the same loaded plugin instance across registry adoption", async () => {
  const selected = registered();
  const owner = withPluginRuntimeRegistryScope(selected.original, () =>
    captureQueuedSubagentTaskOwner(params, () => {}),
  );
  const adopted = registry();
  adopted.plugins.push(selected.record);
  adopted.detachedTaskRuntimes.push({
    pluginId: selected.record.id,
    runtime: selected.runtime,
  });
  markPluginRegistryActive(adopted);
  markPluginRegistryRetired(selected.original);

  expect(selected.instance.acceptingCalls).toBe(true);
  await withPluginRuntimeRegistryScope(adopted, async () => {
    expect((await owner.create())?.taskId).toBe(task.taskId);
    expect(await owner.finalize(task.taskId, 2, "launch failed")).toMatchObject([
      { taskId: task.taskId, status: "failed" },
    ]);
  });
  expect(selected.create).toHaveBeenCalledOnce();
  expect(selected.finalize).toHaveBeenCalledExactlyOnceWith({
    taskId: task.taskId,
    runId: params.runId,
    runtime: "subagent",
    sessionKey: params.childSessionKey,
    status: "failed",
    endedAt: 2,
    lastEventAt: 2,
    error: "launch failed",
    suppressDelivery: true,
  });
  expect(selected.find).not.toHaveBeenCalled();
});

it.each(["record revoked", "registry retired", "contribution replaced", "run retired"] as const)(
  "does not invoke a captured or replacement backend after %s",
  (change) => {
    const selected = registered();
    const replacement = backend();
    let runCurrent = true;
    const owner = withPluginRuntimeRegistryScope(selected.original, () =>
      captureQueuedSubagentTaskOwner(params, () => {
        if (!runCurrent) {
          throw new Error("Original registry run retired");
        }
      }),
    );
    if (change === "record revoked") {
      revokePluginRecord(selected.original, selected.record);
    } else if (change === "registry retired") {
      markPluginRegistryRetired(selected.original);
    } else if (change === "contribution replaced") {
      selected.original.detachedTaskRuntimes.splice(0, 1, {
        pluginId: selected.record.id,
        runtime: replacement.runtime,
      });
    } else {
      runCurrent = false;
    }
    expect(() => owner.create()).toThrow(/retired|no longer active/);
    expect(() => owner.finalize(task.taskId, 2, "failed")).toThrow(/retired|no longer active/);
    expect(selected.create).not.toHaveBeenCalled();
    expect(selected.finalize).not.toHaveBeenCalled();
    expect(replacement.create).not.toHaveBeenCalled();
    expect(replacement.finalize).not.toHaveBeenCalled();
  },
);

it("retains the original bound methods and refuses an empty task selector", async () => {
  const selected = registered();
  const owner = withPluginRuntimeRegistryScope(selected.original, () =>
    captureQueuedSubagentTaskOwner(params, () => {}),
  );
  const replacement = backend();
  selected.runtime.createQueuedTaskRun = replacement.create;
  selected.runtime.finalizeTaskRunByRunId = replacement.finalize;
  expect((await owner.create())?.taskId).toBe(task.taskId);
  expect(() => owner.finalize(" ", 2, "failed")).toThrow(/exact task ID/);
  expect(selected.finalize).not.toHaveBeenCalled();
  await owner.finalize(task.taskId, 2, "failed");
  expect(selected.create).toHaveBeenCalledOnce();
  expect(selected.finalize).toHaveBeenCalledOnce();
  expect(replacement.create).not.toHaveBeenCalled();
  expect(replacement.finalize).not.toHaveBeenCalled();
});

it.each(["task", "flow"] as const)("rejects original core %s store replacement", (changed) => {
  const original = registry();
  markPluginRegistryActive(original);
  const store = createInMemoryTaskRegistryStore();
  configureTaskRegistryRuntime({ store });
  const owner = withPluginRuntimeRegistryScope(original, () =>
    captureQueuedSubagentTaskOwner(params, () => {}),
  );
  const replacement = createInMemoryTaskRegistryStore();
  if (changed === "task") {
    configureTaskRegistryRuntime({ store: replacement });
  } else {
    configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  }
  expect(() => owner.create()).toThrow(/stores are no longer current/);
  expect(() => owner.finalize(task.taskId, 2, "failed")).toThrow(/stores are no longer current/);
  expect(store.loadSnapshot().tasks.size).toBe(0);
  expect(replacement.loadSnapshot().tasks.size).toBe(0);
});

it("keeps the captured core backend when a plugin becomes selected", async () => {
  const original = registry();
  markPluginRegistryActive(original);
  const flows = createInMemoryTaskFlowRegistryStore();
  const store = createInMemoryTaskRegistryStore(undefined, flows);
  configureTaskFlowRegistryRuntime({ store: flows });
  configureTaskRegistryRuntime({ store });
  const owner = withPluginRuntimeRegistryScope(original, () =>
    captureQueuedSubagentTaskOwner({ ...params, deliveryStatus: "pending" }, () => {}),
  );
  const replacement = backend();
  const record = createPluginRecord({ id: "newly-selected" });
  original.plugins.push(record);
  original.detachedTaskRuntimes.push({ pluginId: record.id, runtime: replacement.runtime });
  markPluginRegistryActive(original);
  await withPluginRuntimeRegistryScope(original, async () => {
    const created = await owner.create();
    expect(created).not.toBeNull();
    if (!created) {
      throw new Error("Expected the captured core task");
    }
    expect(store.loadSnapshot().tasks.get(created.taskId)?.status).toBe("queued");
    expect(await owner.finalize(created.taskId, 2, "failed")).toMatchObject([
      {
        taskId: created.taskId,
        status: "failed",
        endedAt: 2,
        error: "failed",
        deliveryStatus: "not_applicable",
      },
    ]);
    expect(store.loadSnapshot().tasks.get(created.taskId)?.status).toBe("failed");
  });
  expect(replacement.create).not.toHaveBeenCalled();
  expect(replacement.finalize).not.toHaveBeenCalled();
});

it("does not turn a missing plugin record into registry-wide authority", () => {
  const selected = registered();
  selected.original.plugins.splice(0, 1);
  expect(() =>
    withPluginRuntimeRegistryScope(selected.original, () =>
      captureQueuedSubagentTaskOwner(params, () => {}),
    ),
  ).toThrow(/no plugin owner/);
  expect(selected.create).not.toHaveBeenCalled();
  expect(selected.finalize).not.toHaveBeenCalled();
});
