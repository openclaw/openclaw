export const WORKBOARD_STATUSES = [
  "backlog",
  "todo",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = (typeof WORKBOARD_EXECUTION_ENGINES)[number];
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type WorkboardListResult = {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
};
