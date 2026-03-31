import type {
  OpenClawConfig,
  PluginOperationAuditFinding,
  PluginOperationRecord,
  PluginOperationsRuntime,
} from "openclaw/plugin-sdk/plugin-entry";
import { info, type RuntimeEnv } from "openclaw/plugin-sdk/runtime";

type TasksCliDeps = {
  config: OpenClawConfig;
  operations: PluginOperationsRuntime;
};

type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

const KIND_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function readStringMetadata(record: PluginOperationRecord, key: string): string | undefined {
  const value = record.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumberMetadata(record: PluginOperationRecord, key: string): number | undefined {
  const value = record.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTaskRows(tasks: PluginOperationRecord[]) {
  const header = [
    "Task".padEnd(ID_PAD),
    "Kind".padEnd(KIND_PAD),
    "Status".padEnd(STATUS_PAD),
    "Delivery".padEnd(DELIVERY_PAD),
    "Run".padEnd(RUN_PAD),
    "Child Session".padEnd(36),
    "Summary",
  ].join(" ");
  const lines = [header];
  for (const task of tasks) {
    const summary = truncate(
      task.terminalSummary?.trim() ||
        task.progressSummary?.trim() ||
        task.title?.trim() ||
        task.description.trim(),
      80,
    );
    const line = [
      shortToken(task.operationId).padEnd(ID_PAD),
      task.kind.padEnd(KIND_PAD),
      task.status.padEnd(STATUS_PAD),
      (readStringMetadata(task, "deliveryStatus") ?? "n/a").padEnd(DELIVERY_PAD),
      shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
      truncate(task.childSessionKey?.trim() || "n/a", 36).padEnd(36),
      summary,
    ].join(" ");
    lines.push(line.trimEnd());
  }
  return lines;
}

function formatAgeMs(ageMs: number | undefined): string {
  if (typeof ageMs !== "number" || ageMs < 1000) {
    return "fresh";
  }
  const totalSeconds = Math.floor(ageMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) {
    return `${days}d${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSeconds}s`;
}

function formatAuditRows(findings: PluginOperationAuditFinding[]) {
  const header = [
    "Severity".padEnd(8),
    "Code".padEnd(22),
    "Task".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Age".padEnd(8),
    "Detail",
  ].join(" ");
  const lines = [header];
  for (const finding of findings) {
    lines.push(
      [
        finding.severity.padEnd(8),
        finding.code.padEnd(22),
        shortToken(finding.operation.operationId).padEnd(ID_PAD),
        finding.operation.status.padEnd(STATUS_PAD),
        formatAgeMs(finding.ageMs).padEnd(8),
        truncate(finding.detail, 88),
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  return lines;
}

function summarizeAuditFindings(findings: Iterable<PluginOperationAuditFinding>) {
  const summary = {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {} as Record<string, number>,
  };
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] = (summary.byCode[finding.code] ?? 0) + 1;
    if (finding.severity === "error") {
      summary.errors += 1;
      continue;
    }
    summary.warnings += 1;
  }
  return summary;
}

function formatTaskListSummary(tasks: PluginOperationRecord[]) {
  const queued = tasks.filter((task) => task.status === "queued").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const failures = tasks.filter(
    (task) => task.status === "failed" || task.status === "timed_out" || task.status === "lost",
  ).length;
  return `${queued} queued · ${running} running · ${failures} issues`;
}

async function resolveTaskLookupToken(
  operations: PluginOperationsRuntime,
  lookup: string,
): Promise<PluginOperationRecord | null> {
  const token = lookup.trim();
  if (!token) {
    return null;
  }
  const byId = await operations.getById(token);
  if (byId?.namespace === "tasks") {
    return byId;
  }
  const byRunId = await operations.findByRunId(token);
  if (byRunId?.namespace === "tasks") {
    return byRunId;
  }
  const bySession = await operations.list({
    namespace: "tasks",
    sessionKey: token,
    limit: 1,
  });
  return bySession[0] ?? null;
}

export async function runTasksList(
  opts: { json?: boolean; runtime?: string; status?: string },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const tasks = await deps.operations.list({
    namespace: "tasks",
    ...(opts.runtime ? { kind: opts.runtime.trim() } : {}),
    ...(opts.status ? { status: opts.status.trim() } : {}),
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: tasks.length,
          runtime: opts.runtime ?? null,
          status: opts.status ?? null,
          tasks,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Background tasks: ${tasks.length}`));
  runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
  if (opts.runtime) {
    runtime.log(info(`Runtime filter: ${opts.runtime}`));
  }
  if (opts.status) {
    runtime.log(info(`Status filter: ${opts.status}`));
  }
  if (tasks.length === 0) {
    runtime.log("No background tasks found.");
    return;
  }
  for (const line of formatTaskRows(tasks)) {
    runtime.log(line);
  }
}

export async function runTasksShow(
  opts: { json?: boolean; lookup: string },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const task = await resolveTaskLookupToken(deps.operations, opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    runtime.log(JSON.stringify(task, null, 2));
    return;
  }

  const lines = [
    "Background task:",
    `taskId: ${task.operationId}`,
    `kind: ${task.kind}`,
    `sourceId: ${task.sourceId ?? "n/a"}`,
    `status: ${task.status}`,
    `result: ${readStringMetadata(task, "terminalOutcome") ?? "n/a"}`,
    `delivery: ${readStringMetadata(task, "deliveryStatus") ?? "n/a"}`,
    `notify: ${readStringMetadata(task, "notifyPolicy") ?? "n/a"}`,
    `requesterSessionKey: ${task.requesterSessionKey ?? "n/a"}`,
    `childSessionKey: ${task.childSessionKey ?? "n/a"}`,
    `parentTaskId: ${task.parentOperationId ?? "n/a"}`,
    `agentId: ${task.agentId ?? "n/a"}`,
    `runId: ${task.runId ?? "n/a"}`,
    `label: ${task.title ?? "n/a"}`,
    `task: ${task.description}`,
    `createdAt: ${new Date(task.createdAt).toISOString()}`,
    `startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "n/a"}`,
    `endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : "n/a"}`,
    `lastEventAt: ${new Date(task.updatedAt).toISOString()}`,
    `cleanupAfter: ${(() => {
      const cleanupAfter = readNumberMetadata(task, "cleanupAfter");
      return cleanupAfter ? new Date(cleanupAfter).toISOString() : "n/a";
    })()}`,
    ...(task.error ? [`error: ${task.error}`] : []),
    ...(task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : []),
    ...(task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []),
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}

export async function runTasksNotify(
  opts: { lookup: string; notify: TaskNotifyPolicy },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const task = await resolveTaskLookupToken(deps.operations, opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = await deps.operations.dispatch({
    type: "patch",
    operationId: task.operationId,
    at: Date.now(),
    metadataPatch: {
      notifyPolicy: opts.notify,
    },
  });
  if (!updated.matched || !updated.record) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  runtime.log(`Updated ${updated.record.operationId} notify policy to ${opts.notify}.`);
}

export async function runTasksCancel(
  opts: { lookup: string },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const task = await resolveTaskLookupToken(deps.operations, opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const result = await deps.operations.cancel({
    cfg: deps.config,
    operationId: task.operationId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? `Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel task: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = await deps.operations.getById(task.operationId);
  runtime.log(
    `Cancelled ${updated?.operationId ?? task.operationId} (${updated?.kind ?? task.kind})${updated?.runId ? ` run ${updated.runId}` : ""}.`,
  );
}

export async function runTasksAudit(
  opts: {
    json?: boolean;
    severity?: "warn" | "error";
    code?: string;
    limit?: number;
  },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const allFindings = await deps.operations.audit({
    namespace: "tasks",
  });
  const findings = await deps.operations.audit({
    namespace: "tasks",
    ...(opts.severity ? { severity: opts.severity } : {}),
    ...(opts.code ? { code: opts.code.trim() } : {}),
  });
  const displayed =
    typeof opts.limit === "number" && opts.limit > 0 ? findings.slice(0, opts.limit) : findings;
  const summary = summarizeAuditFindings(allFindings);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: allFindings.length,
          filteredCount: findings.length,
          displayed: displayed.length,
          filters: {
            severity: opts.severity ?? null,
            code: opts.code ?? null,
            limit: opts.limit ?? null,
          },
          summary,
          findings: displayed,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Task audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`,
    ),
  );
  if (opts.severity || opts.code) {
    runtime.log(info(`Showing ${findings.length} matching findings.`));
  }
  if (opts.severity) {
    runtime.log(info(`Severity filter: ${opts.severity}`));
  }
  if (opts.code) {
    runtime.log(info(`Code filter: ${opts.code}`));
  }
  if (typeof opts.limit === "number" && opts.limit > 0) {
    runtime.log(info(`Limit: ${opts.limit}`));
  }
  if (displayed.length === 0) {
    runtime.log("No task audit findings.");
    return;
  }
  for (const line of formatAuditRows(displayed)) {
    runtime.log(line);
  }
}

export async function runTasksMaintenance(
  opts: { json?: boolean; apply?: boolean },
  deps: TasksCliDeps,
  runtime: RuntimeEnv,
) {
  const auditBeforeFindings = await deps.operations.audit({
    namespace: "tasks",
  });
  const maintenance = await deps.operations.maintenance({
    namespace: "tasks",
    apply: Boolean(opts.apply),
  });
  const summary = await deps.operations.summarize({
    namespace: "tasks",
  });
  const auditAfterFindings = opts.apply
    ? await deps.operations.audit({
        namespace: "tasks",
      })
    : auditBeforeFindings;
  const auditBefore = summarizeAuditFindings(auditBeforeFindings);
  const auditAfter = summarizeAuditFindings(auditAfterFindings);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          mode: opts.apply ? "apply" : "preview",
          maintenance,
          tasks: summary,
          auditBefore,
          auditAfter,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Task maintenance (${opts.apply ? "applied" : "preview"}): ${maintenance.reconciled} reconcile · ${maintenance.cleanupStamped} cleanup stamp · ${maintenance.pruned} prune`,
    ),
  );
  runtime.log(
    info(
      `${opts.apply ? "Task health after apply" : "Task health"}: ${summary.byStatus.queued ?? 0} queued · ${summary.byStatus.running ?? 0} running · ${auditAfter.errors} audit errors · ${auditAfter.warnings} audit warnings`,
    ),
  );
  if (opts.apply) {
    runtime.log(
      info(
        `Task health before apply: ${auditBefore.errors} audit errors · ${auditBefore.warnings} audit warnings`,
      ),
    );
  }
  if (!opts.apply) {
    runtime.log("Dry run only. Re-run with `openclaw tasks maintenance --apply` to write changes.");
  }
}
