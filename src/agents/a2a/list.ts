import { listA2ATaskEventLogTaskTokens } from "./log.js";
import {
  buildA2ATaskProtocolStatus,
  buildA2ATaskStatusSnapshot,
  classifyA2AExecutionStatus,
  DEFAULT_STALE_CONFIG,
  isStaleCritical,
  loadA2ATaskScopedRecord,
  type A2ATaskStatusCategory,
  type A2ATaskStatusSnapshot,
  type A2ATaskWorkerView,
  type StaleConfig,
} from "./status.js";
import type { A2AExecutionStatus, A2ATaskProtocolStatus, A2ATaskRecord } from "./types.js";

export type A2ATaskReadModel = {
  taskId: string;
  record: A2ATaskRecord;
  snapshot: A2ATaskStatusSnapshot;
  protocolStatus: A2ATaskProtocolStatus;
  statusCategory: A2ATaskStatusCategory;
  workerView: A2ATaskWorkerView;
};

export type A2ATaskStatusIndexEntry = A2ATaskProtocolStatus & {
  statusCategory: A2ATaskStatusCategory;
  workerView: A2ATaskWorkerView;
  createdAt: number;
  acceptedAt?: number;
  completedAt?: number;
  priority?: NonNullable<A2ATaskRecord["envelope"]["constraints"]>["priority"];
  intent: A2ATaskRecord["envelope"]["task"]["intent"];
  errorCode?: string;
  errorMessage?: string;
};

export type A2ATaskStatusFilter = A2ATaskStatusCategory | A2AExecutionStatus;
export type A2ATaskWorkerViewFilter = A2ATaskWorkerView;

export type A2ATaskListResult = {
  tasks: A2ATaskStatusIndexEntry[];
  total: number;
  filtered: number;
  cursor?: string;
};

export type A2ADashboardAlert = {
  taskId: string;
  severity: "warning" | "critical";
  type: "stale-heartbeat" | "long-running" | "delivery-failed" | "repeated-failure";
  message: string;
  since: number;
};

export type A2ADashboardSummary = {
  timestamp: number;
  counts: {
    total: number;
    active: number;
    waitingExternal: number;
    stale: number;
    terminalSuccess: number;
    terminalFailure: number;
    canceled: number;
  };
  workerCounts: Record<A2ATaskWorkerView, number>;
  alerts: A2ADashboardAlert[];
  recentTasks: A2ATaskStatusIndexEntry[];
};

const ALL_WORKER_VIEWS: A2ATaskWorkerView[] = [
  "broker-queued",
  "worker-running",
  "worker-stale",
  "waiting-reply",
  "waiting-external",
  "announce-pending",
  "announce-sent",
  "remote-failure",
  "local-mismatch",
  "done",
];

function compareA2ATaskReadModels(a: A2ATaskReadModel, b: A2ATaskReadModel): number {
  return b.snapshot.updatedAt - a.snapshot.updatedAt || a.taskId.localeCompare(b.taskId);
}

function isA2ATaskStatusCategory(value: string): value is A2ATaskStatusCategory {
  return (
    value === "active" ||
    value === "terminal-success" ||
    value === "terminal-failure" ||
    value === "waiting-external" ||
    value === "canceled" ||
    value === "stale"
  );
}

function matchesA2ATaskStatusFilter(params: {
  model: A2ATaskReadModel;
  statusFilter?: A2ATaskStatusFilter | A2ATaskStatusFilter[];
  operatorView?: boolean;
}): boolean {
  if (!params.statusFilter) {
    return true;
  }

  const filters = Array.isArray(params.statusFilter) ? params.statusFilter : [params.statusFilter];
  const statusCategory = params.operatorView
    ? params.model.snapshot.statusCategory
    : classifyA2AExecutionStatus(params.model.protocolStatus.executionStatus);

  return filters.some((filter) => {
    if (isA2ATaskStatusCategory(filter)) {
      return statusCategory === filter;
    }
    return params.model.protocolStatus.executionStatus === filter;
  });
}

function matchesA2ATaskWorkerViewFilter(params: {
  model: A2ATaskReadModel;
  workerViewFilter?: A2ATaskWorkerViewFilter | A2ATaskWorkerViewFilter[];
}): boolean {
  if (!params.workerViewFilter) {
    return true;
  }
  const filters = Array.isArray(params.workerViewFilter)
    ? params.workerViewFilter
    : [params.workerViewFilter];
  return filters.includes(params.model.snapshot.workerView);
}

function buildA2ATaskStatusIndexEntry(params: {
  model: A2ATaskReadModel;
  operatorView?: boolean;
}): A2ATaskStatusIndexEntry {
  const { model } = params;
  return {
    ...model.protocolStatus,
    statusCategory: params.operatorView
      ? model.snapshot.statusCategory
      : classifyA2AExecutionStatus(model.protocolStatus.executionStatus),
    workerView: model.snapshot.workerView,
    createdAt: model.snapshot.createdAt,
    acceptedAt: model.snapshot.acceptedAt,
    completedAt: model.snapshot.completedAt,
    priority: model.snapshot.priority,
    intent: model.snapshot.intent,
    errorCode: model.snapshot.errorCode,
    errorMessage: model.snapshot.errorMessage,
  };
}

async function collectA2ATaskReadModels(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskReadModel[]> {
  const taskTokens = await listA2ATaskEventLogTaskTokens({
    sessionKey: params.sessionKey,
    env: params.env,
  });
  const models = await Promise.all(
    taskTokens.map(async (taskId) => {
      const record = await loadA2ATaskScopedRecord({
        sessionKey: params.sessionKey,
        taskId,
        env: params.env,
        allowTaskToken: true,
      });
      if (!record) {
        return undefined;
      }

      const snapshot = buildA2ATaskStatusSnapshot(
        record,
        params.now,
        params.staleConfig ?? DEFAULT_STALE_CONFIG,
      );
      const protocolStatus = buildA2ATaskProtocolStatus(record);

      return {
        taskId: record.taskId,
        record,
        snapshot,
        protocolStatus,
        statusCategory: classifyA2AExecutionStatus(protocolStatus.executionStatus),
        workerView: snapshot.workerView,
      } satisfies A2ATaskReadModel;
    }),
  );

  return models
    .filter((model): model is A2ATaskReadModel => Boolean(model))
    .toSorted(compareA2ATaskReadModels);
}

function applyCursorToModels(models: A2ATaskReadModel[], cursor?: string): A2ATaskReadModel[] {
  if (!cursor) {
    return models;
  }
  const index = models.findIndex((model) => model.taskId === cursor);
  return index >= 0 ? models.slice(index + 1) : models;
}

export async function loadA2ATaskReadModel(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskReadModel | undefined> {
  const record = await loadA2ATaskScopedRecord(params);
  if (!record) {
    return undefined;
  }

  const snapshot = buildA2ATaskStatusSnapshot(record, params.now, params.staleConfig);
  const protocolStatus = buildA2ATaskProtocolStatus(record);

  return {
    taskId: record.taskId,
    record,
    snapshot,
    protocolStatus,
    statusCategory: classifyA2AExecutionStatus(protocolStatus.executionStatus),
    workerView: snapshot.workerView,
  };
}

export async function loadA2ATaskStatusIndex(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  cursor?: string;
  statusFilter?: A2ATaskStatusFilter | A2ATaskStatusFilter[];
  workerViewFilter?: A2ATaskWorkerViewFilter | A2ATaskWorkerViewFilter[];
  operatorView?: boolean;
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskStatusIndexEntry[]> {
  const models = await collectA2ATaskReadModels(params);
  const filtered = applyCursorToModels(models, params.cursor).filter((model) => {
    return (
      matchesA2ATaskStatusFilter({
        model,
        statusFilter: params.statusFilter,
        operatorView: params.operatorView,
      }) && matchesA2ATaskWorkerViewFilter({ model, workerViewFilter: params.workerViewFilter })
    );
  });

  const limited =
    typeof params.limit === "number" && params.limit >= 0
      ? filtered.slice(0, params.limit)
      : filtered;

  return limited.map((model) =>
    buildA2ATaskStatusIndexEntry({ model, operatorView: params.operatorView }),
  );
}

export async function loadA2ATaskListResult(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  cursor?: string;
  statusFilter?: A2ATaskStatusFilter | A2ATaskStatusFilter[];
  workerViewFilter?: A2ATaskWorkerViewFilter | A2ATaskWorkerViewFilter[];
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskListResult> {
  const models = await collectA2ATaskReadModels(params);
  const total = models.length;
  const filteredModels = applyCursorToModels(models, params.cursor).filter((model) => {
    return (
      matchesA2ATaskStatusFilter({
        model,
        statusFilter: params.statusFilter,
        operatorView: true,
      }) && matchesA2ATaskWorkerViewFilter({ model, workerViewFilter: params.workerViewFilter })
    );
  });
  const filtered = filteredModels.length;
  const limitedModels =
    typeof params.limit === "number" && params.limit >= 0
      ? filteredModels.slice(0, params.limit)
      : filteredModels;
  const tasks = limitedModels.map((model) =>
    buildA2ATaskStatusIndexEntry({ model, operatorView: true }),
  );
  const cursor =
    limitedModels.length > 0 && limitedModels.length < filteredModels.length
      ? limitedModels.at(-1)?.taskId
      : undefined;

  return { tasks, total, filtered, cursor };
}

export async function loadA2ATaskDashboard(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  staleConfig?: StaleConfig;
  recentLimit?: number;
}): Promise<A2ADashboardSummary> {
  const now = params.now ?? Date.now();
  const config = params.staleConfig ?? DEFAULT_STALE_CONFIG;
  const models = await collectA2ATaskReadModels({
    sessionKey: params.sessionKey,
    env: params.env,
    now,
    staleConfig: config,
  });
  const recentLimit = params.recentLimit ?? 10;
  const recentTasks = models
    .slice(0, recentLimit)
    .map((model) => buildA2ATaskStatusIndexEntry({ model, operatorView: true }));

  const workerCounts = Object.fromEntries(ALL_WORKER_VIEWS.map((view) => [view, 0])) as Record<
    A2ATaskWorkerView,
    number
  >;
  const counts = {
    total: models.length,
    active: 0,
    waitingExternal: 0,
    stale: 0,
    terminalSuccess: 0,
    terminalFailure: 0,
    canceled: 0,
  };
  const alerts: A2ADashboardAlert[] = [];
  const failureCountsByTarget = new Map<string, number>();

  for (const model of models) {
    const { snapshot, record } = model;
    workerCounts[snapshot.workerView] += 1;
    switch (snapshot.statusCategory) {
      case "active":
        counts.active += 1;
        break;
      case "waiting-external":
        counts.waitingExternal += 1;
        break;
      case "stale":
        counts.stale += 1;
        break;
      case "terminal-success":
        counts.terminalSuccess += 1;
        break;
      case "terminal-failure":
        counts.terminalFailure += 1;
        break;
      case "canceled":
        counts.canceled += 1;
        break;
    }

    if (snapshot.statusCategory === "terminal-failure") {
      const targetKey = record.envelope.target.sessionKey;
      failureCountsByTarget.set(targetKey, (failureCountsByTarget.get(targetKey) ?? 0) + 1);
    }

    if (snapshot.statusCategory === "stale") {
      const since = snapshot.heartbeatAt ?? snapshot.startedAt ?? snapshot.updatedAt;
      alerts.push({
        taskId: snapshot.taskId,
        severity: isStaleCritical(record, now, config) ? "critical" : "warning",
        type: "stale-heartbeat",
        message: `Task ${snapshot.taskId} looks stale (${snapshot.workerView})`,
        since,
      });
    }

    if (record.delivery.status === "failed") {
      alerts.push({
        taskId: snapshot.taskId,
        severity: "critical",
        type: "delivery-failed",
        message: `Task ${snapshot.taskId} failed while delivering the final result`,
        since: record.delivery.updatedAt ?? snapshot.updatedAt,
      });
    }

    if (
      typeof record.envelope.constraints?.timeoutSeconds === "number" &&
      typeof snapshot.startedAt === "number" &&
      now - snapshot.startedAt > record.envelope.constraints.timeoutSeconds * 1000
    ) {
      alerts.push({
        taskId: snapshot.taskId,
        severity: "critical",
        type: "long-running",
        message: `Task ${snapshot.taskId} is running beyond its timeout budget`,
        since: snapshot.startedAt,
      });
    }
  }

  for (const model of models) {
    const targetKey = model.record.envelope.target.sessionKey;
    if (
      (failureCountsByTarget.get(targetKey) ?? 0) >= 3 &&
      model.snapshot.statusCategory === "terminal-failure"
    ) {
      alerts.push({
        taskId: model.taskId,
        severity: "warning",
        type: "repeated-failure",
        message: `Target ${targetKey} has repeated recent A2A failures`,
        since: model.snapshot.updatedAt,
      });
    }
  }

  alerts.sort((a, b) => b.since - a.since || a.taskId.localeCompare(b.taskId));

  return {
    timestamp: now,
    counts,
    workerCounts,
    alerts,
    recentTasks,
  };
}

export async function listA2ATaskIds(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const index = await loadA2ATaskStatusIndex(params);
  return index.map((entry) => entry.taskId);
}
