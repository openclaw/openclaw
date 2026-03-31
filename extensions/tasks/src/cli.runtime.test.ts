import type {
  PluginOperationAuditFinding,
  PluginOperationRecord,
  PluginOperationsRuntime,
} from "openclaw/plugin-sdk/plugin-entry";
import { createLoggerBackedRuntime, type OutputRuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runTasksAudit,
  runTasksCancel,
  runTasksList,
  runTasksMaintenance,
  runTasksNotify,
  runTasksShow,
} from "./cli.runtime.js";

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = createLoggerBackedRuntime({
    logger: {
      info(message) {
        logs.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    exitError(code) {
      return new Error(`exit ${code}`);
    },
  }) as OutputRuntimeEnv;
  return { runtime, logs, errors };
}

function createOperationsMock(): PluginOperationsRuntime {
  return {
    dispatch: vi.fn().mockResolvedValue({
      matched: false,
      record: null,
    }),
    getById: vi.fn().mockResolvedValue(null),
    findByRunId: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    summarize: vi.fn().mockResolvedValue({
      total: 0,
      active: 0,
      terminal: 0,
      failures: 0,
      byNamespace: {},
      byKind: {},
      byStatus: {},
    }),
    audit: vi.fn().mockResolvedValue([]),
    maintenance: vi.fn().mockResolvedValue({
      reconciled: 0,
      cleanupStamped: 0,
      pruned: 0,
    }),
    cancel: vi.fn().mockResolvedValue({
      found: false,
      cancelled: false,
    }),
  };
}

const taskFixture: PluginOperationRecord = {
  operationId: "task-12345678",
  namespace: "tasks",
  kind: "acp",
  status: "running",
  sourceId: "run-12345678",
  requesterSessionKey: "agent:main:main",
  childSessionKey: "agent:codex:acp:child",
  runId: "run-12345678",
  title: "Task title",
  description: "Create a file",
  createdAt: Date.parse("2026-03-29T10:00:00.000Z"),
  updatedAt: Date.parse("2026-03-29T10:00:10.000Z"),
  progressSummary: "No output for 60s. It may be waiting for input.",
  metadata: {
    deliveryStatus: "pending",
    notifyPolicy: "state_changes",
  },
};

describe("tasks CLI runtime", () => {
  let operations: PluginOperationsRuntime;
  let logs: string[];
  let errors: string[];
  let runtime: OutputRuntimeEnv;
  let config: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;

  beforeEach(() => {
    operations = createOperationsMock();
    ({ runtime, logs, errors } = createRuntimeCapture());
    config = {};
  });

  it("lists task rows with progress summary fallback", async () => {
    vi.mocked(operations.list).mockResolvedValue([taskFixture]);

    await runTasksList(
      {
        runtime: "acp",
        status: "running",
      },
      {
        config,
        operations,
      },
      runtime,
    );

    expect(logs[0]).toContain("Background tasks: 1");
    expect(logs[1]).toContain("Task pressure: 0 queued · 1 running · 0 issues");
    expect(logs.join("\n")).toContain("No output for 60s. It may be waiting for input.");
  });

  it("shows detailed task fields including notify and recent events", async () => {
    vi.mocked(operations.findByRunId).mockResolvedValue(taskFixture);

    await runTasksShow(
      { lookup: "run-12345678" },
      {
        config: {},
        operations,
      },
      runtime,
    );

    expect(logs.join("\n")).toContain("notify: state_changes");
    expect(logs.join("\n")).toContain(
      "progressSummary: No output for 60s. It may be waiting for input.",
    );
  });

  it("updates notify policy for an existing task", async () => {
    vi.mocked(operations.findByRunId).mockResolvedValue(taskFixture);
    vi.mocked(operations.dispatch).mockResolvedValue({
      matched: true,
      record: {
        ...taskFixture,
        metadata: {
          ...taskFixture.metadata,
          notifyPolicy: "silent",
        },
      },
    });

    await runTasksNotify(
      { lookup: "run-12345678", notify: "silent" },
      {
        config: {},
        operations,
      },
      runtime,
    );

    expect(operations.dispatch).toHaveBeenCalledWith({
      type: "patch",
      operationId: "task-12345678",
      at: expect.any(Number),
      metadataPatch: {
        notifyPolicy: "silent",
      },
    });
    expect(logs[0]).toContain("Updated task-12345678 notify policy to silent.");
  });

  it("cancels a running task and reports the updated runtime", async () => {
    vi.mocked(operations.findByRunId).mockResolvedValue(taskFixture);
    vi.mocked(operations.cancel).mockResolvedValue({
      found: true,
      cancelled: true,
      record: {
        ...taskFixture,
        status: "cancelled",
      },
    });
    vi.mocked(operations.getById).mockResolvedValue({
      ...taskFixture,
      status: "cancelled",
    });

    await runTasksCancel(
      { lookup: "run-12345678" },
      {
        config,
        operations,
      },
      runtime,
    );

    expect(operations.cancel).toHaveBeenCalledWith({
      cfg: config,
      operationId: "task-12345678",
    });
    expect(logs[0]).toContain("Cancelled task-12345678 (acp) run run-12345678.");
    expect(errors).toEqual([]);
  });

  it("shows task audit findings with filters", async () => {
    const findings: PluginOperationAuditFinding[] = [
      {
        severity: "error",
        code: "stale_running",
        operation: taskFixture,
        ageMs: 45 * 60_000,
        detail: "running task appears stuck",
      },
      {
        severity: "warn",
        code: "delivery_failed",
        operation: {
          ...taskFixture,
          operationId: "task-87654321",
          status: "failed",
        },
        ageMs: 10 * 60_000,
        detail: "terminal update delivery failed",
      },
    ];
    vi.mocked(operations.audit)
      .mockResolvedValueOnce(findings)
      .mockResolvedValueOnce([findings[0]!]);

    await runTasksAudit(
      { severity: "error", code: "stale_running", limit: 1 },
      {
        config: {},
        operations,
      },
      runtime,
    );

    expect(logs[0]).toContain("Task audit: 2 findings · 1 errors · 1 warnings");
    expect(logs[1]).toContain("Showing 1 matching findings.");
    expect(logs.join("\n")).toContain("stale_running");
    expect(logs.join("\n")).toContain("running task appears stuck");
    expect(logs.join("\n")).not.toContain("delivery_failed");
  });

  it("previews task maintenance without applying changes", async () => {
    vi.mocked(operations.audit).mockResolvedValue([
      {
        severity: "error",
        code: "stale_running",
        operation: taskFixture,
        detail: "running task appears stuck",
      },
      {
        severity: "warn",
        code: "lost",
        operation: {
          ...taskFixture,
          operationId: "task-2",
          status: "lost",
        },
        detail: "backing session missing",
      },
    ]);
    vi.mocked(operations.maintenance).mockResolvedValue({
      reconciled: 2,
      cleanupStamped: 1,
      pruned: 3,
    });
    vi.mocked(operations.summarize).mockResolvedValue({
      total: 5,
      active: 2,
      terminal: 3,
      failures: 1,
      byNamespace: { tasks: 5 },
      byKind: { acp: 1, cron: 2, subagent: 1, cli: 1 },
      byStatus: {
        queued: 1,
        running: 1,
        succeeded: 1,
        lost: 1,
        failed: 1,
      },
    });

    await runTasksMaintenance(
      {},
      {
        config: {},
        operations,
      },
      runtime,
    );

    expect(logs[0]).toContain(
      "Task maintenance (preview): 2 reconcile · 1 cleanup stamp · 3 prune",
    );
    expect(logs[1]).toContain(
      "Task health: 1 queued · 1 running · 1 audit errors · 1 audit warnings",
    );
    expect(logs[2]).toContain("Dry run only.");
  });

  it("shows before and after audit health when applying maintenance", async () => {
    vi.mocked(operations.audit)
      .mockResolvedValueOnce([
        {
          severity: "error",
          code: "stale_running",
          operation: taskFixture,
          detail: "running task appears stuck",
        },
        {
          severity: "warn",
          code: "missing_cleanup",
          operation: {
            ...taskFixture,
            operationId: "task-2",
            status: "succeeded",
          },
          detail: "missing cleanupAfter",
        },
      ])
      .mockResolvedValueOnce([
        {
          severity: "warn",
          code: "lost",
          operation: {
            ...taskFixture,
            operationId: "task-2",
            status: "lost",
          },
          detail: "backing session missing",
        },
      ]);
    vi.mocked(operations.maintenance).mockResolvedValue({
      reconciled: 2,
      cleanupStamped: 1,
      pruned: 3,
    });
    vi.mocked(operations.summarize).mockResolvedValue({
      total: 4,
      active: 2,
      terminal: 2,
      failures: 1,
      byNamespace: { tasks: 4 },
      byKind: { acp: 1, cron: 2, subagent: 1 },
      byStatus: {
        queued: 1,
        running: 1,
        succeeded: 1,
        lost: 1,
      },
    });

    await runTasksMaintenance(
      { apply: true },
      {
        config: {},
        operations,
      },
      runtime,
    );

    expect(logs[0]).toContain(
      "Task maintenance (applied): 2 reconcile · 1 cleanup stamp · 3 prune",
    );
    expect(logs[1]).toContain(
      "Task health after apply: 1 queued · 1 running · 0 audit errors · 1 audit warnings",
    );
    expect(logs[2]).toContain("Task health before apply: 1 audit errors · 1 audit warnings");
  });
});
