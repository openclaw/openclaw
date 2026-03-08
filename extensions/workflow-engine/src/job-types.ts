import type { VentureModuleId, VenturePriority } from "../../venture-core/src/types.js";

export type WorkflowJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "canceled";

export type WorkflowJobPayload = {
  moduleId: VentureModuleId;
  input: unknown;
  traceId?: string;
  tags?: Record<string, string>;
};

export type WorkflowRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type WorkflowJobRecord = {
  id: string;
  dedupeKey?: string;
  status: WorkflowJobStatus;
  payload: WorkflowJobPayload;
  priority: VenturePriority;
  attempts: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastError?: string;
};

export type WorkflowJobResult = {
  ok: boolean;
  summary: string;
  output?: unknown;
  error?: string;
};

