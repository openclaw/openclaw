import { listA2ATaskEventLogTaskTokens } from "./log.js";
import {
  buildA2ATaskProtocolStatus,
  buildA2ATaskStatusSnapshot,
  classifyA2AExecutionStatus,
  loadA2ATaskScopedRecord,
  type A2ATaskStatusCategory,
  type A2ATaskStatusSnapshot,
} from "./status.js";
import type { A2AExecutionStatus, A2ATaskProtocolStatus, A2ATaskRecord } from "./types.js";

export type A2ATaskReadModel = {
  taskId: string;
  record: A2ATaskRecord;
  snapshot: A2ATaskStatusSnapshot;
  protocolStatus: A2ATaskProtocolStatus;
  statusCategory: A2ATaskStatusCategory;
};

export type A2ATaskStatusIndexEntry = A2ATaskProtocolStatus & {
  statusCategory: A2ATaskStatusCategory;
};

export type A2ATaskStatusFilter = A2ATaskStatusCategory | A2AExecutionStatus;

function compareA2ATaskReadModels(a: A2ATaskReadModel, b: A2ATaskReadModel): number {
  return b.snapshot.updatedAt - a.snapshot.updatedAt || a.taskId.localeCompare(b.taskId);
}

function isA2ATaskStatusCategory(value: string): value is A2ATaskStatusCategory {
  return value === "active" || value === "terminal-success" || value === "terminal-failure";
}

function matchesA2ATaskStatusFilter(params: {
  model: A2ATaskReadModel;
  statusFilter?: A2ATaskStatusFilter | A2ATaskStatusFilter[];
}): boolean {
  if (!params.statusFilter) {
    return true;
  }

  const filters = Array.isArray(params.statusFilter) ? params.statusFilter : [params.statusFilter];
  return filters.some((filter) => {
    if (isA2ATaskStatusCategory(filter)) {
      return params.model.statusCategory === filter;
    }
    return params.model.protocolStatus.executionStatus === filter;
  });
}

export async function loadA2ATaskReadModel(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskReadModel | undefined> {
  const record = await loadA2ATaskScopedRecord(params);
  if (!record) {
    return undefined;
  }

  const snapshot = buildA2ATaskStatusSnapshot(record);
  const protocolStatus = buildA2ATaskProtocolStatus(record);

  return {
    taskId: record.taskId,
    record,
    snapshot,
    protocolStatus,
    statusCategory: classifyA2AExecutionStatus(protocolStatus.executionStatus),
  };
}

export async function loadA2ATaskStatusIndex(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  statusFilter?: A2ATaskStatusFilter | A2ATaskStatusFilter[];
}): Promise<A2ATaskStatusIndexEntry[]> {
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

      const snapshot = buildA2ATaskStatusSnapshot(record);
      const protocolStatus = buildA2ATaskProtocolStatus(record);

      return {
        taskId: record.taskId,
        record,
        snapshot,
        protocolStatus,
        statusCategory: classifyA2AExecutionStatus(protocolStatus.executionStatus),
      } satisfies A2ATaskReadModel;
    }),
  );

  const sorted = models
    .filter((model): model is A2ATaskReadModel => Boolean(model))
    .toSorted(compareA2ATaskReadModels)
    .filter((model) => matchesA2ATaskStatusFilter({ model, statusFilter: params.statusFilter }));

  const limited =
    typeof params.limit === "number" && params.limit >= 0 ? sorted.slice(0, params.limit) : sorted;

  return limited.map((model) => ({
    ...model.protocolStatus,
    statusCategory: model.statusCategory,
  }));
}

export async function listA2ATaskIds(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const index = await loadA2ATaskStatusIndex(params);
  return index.map((entry) => entry.taskId);
}
