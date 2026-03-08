import type { VenturePriority } from "../../venture-core/src/types.js";
import type { WorkflowJobPayload, WorkflowJobRecord, WorkflowJobStatus } from "./job-types.js";

const PRIORITY_ORDER: Record<VenturePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface WorkflowQueue {
  enqueue(input: {
    id: string;
    payload: WorkflowJobPayload;
    priority: VenturePriority;
    dedupeKey?: string;
    availableAt?: number;
  }): Promise<WorkflowJobRecord>;
  leaseNext(input: { workerId: string; leaseMs: number; now?: number }): Promise<WorkflowJobRecord | null>;
  markStatus(input: {
    id: string;
    status: WorkflowJobStatus;
    attempts?: number;
    lastError?: string;
    availableAt?: number;
  }): Promise<WorkflowJobRecord | null>;
  get(id: string): Promise<WorkflowJobRecord | null>;
  list(input?: { status?: WorkflowJobStatus; limit?: number }): Promise<WorkflowJobRecord[]>;
}

export class InMemoryWorkflowQueue implements WorkflowQueue {
  private readonly jobs = new Map<string, WorkflowJobRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async enqueue(input: {
    id: string;
    payload: WorkflowJobPayload;
    priority: VenturePriority;
    dedupeKey?: string;
    availableAt?: number;
  }): Promise<WorkflowJobRecord> {
    const current = this.now();
    const record: WorkflowJobRecord = {
      id: input.id,
      dedupeKey: input.dedupeKey,
      status: "queued",
      payload: input.payload,
      priority: input.priority,
      attempts: 0,
      availableAt: input.availableAt ?? current,
      createdAt: current,
      updatedAt: current,
    };
    this.jobs.set(record.id, record);
    return { ...record };
  }

  async leaseNext(input: {
    workerId: string;
    leaseMs: number;
    now?: number;
  }): Promise<WorkflowJobRecord | null> {
    const current = input.now ?? this.now();
    let candidate: WorkflowJobRecord | null = null;
    for (const record of this.jobs.values()) {
      if (record.status !== "queued" && record.status !== "retrying") {
        continue;
      }
      if (record.availableAt > current) {
        continue;
      }
      if (!candidate) {
        candidate = record;
        continue;
      }
      const score = PRIORITY_ORDER[record.priority] - PRIORITY_ORDER[candidate.priority];
      if (score < 0 || (score === 0 && record.createdAt < candidate.createdAt)) {
        candidate = record;
      }
    }
    if (!candidate) {
      return null;
    }
    candidate.status = "leased";
    candidate.leasedBy = input.workerId;
    candidate.leaseExpiresAt = current + Math.max(1, input.leaseMs);
    candidate.updatedAt = current;
    return { ...candidate };
  }

  async markStatus(input: {
    id: string;
    status: WorkflowJobStatus;
    attempts?: number;
    lastError?: string;
    availableAt?: number;
  }): Promise<WorkflowJobRecord | null> {
    const record = this.jobs.get(input.id);
    if (!record) {
      return null;
    }
    record.status = input.status;
    if (typeof input.attempts === "number") {
      record.attempts = input.attempts;
    }
    if (typeof input.lastError === "string") {
      record.lastError = input.lastError;
    } else if (input.lastError === undefined && input.status === "succeeded") {
      record.lastError = undefined;
    }
    if (typeof input.availableAt === "number") {
      record.availableAt = input.availableAt;
    }
    if (input.status !== "leased") {
      record.leasedBy = undefined;
      record.leaseExpiresAt = undefined;
    }
    record.updatedAt = this.now();
    return { ...record };
  }

  async get(id: string): Promise<WorkflowJobRecord | null> {
    const value = this.jobs.get(id);
    return value ? { ...value } : null;
  }

  async list(input?: { status?: WorkflowJobStatus; limit?: number }): Promise<WorkflowJobRecord[]> {
    let values = [...this.jobs.values()];
    if (input?.status) {
      values = values.filter((v) => v.status === input.status);
    }
    values.sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = input?.limit && input.limit > 0 ? input.limit : values.length;
    return values.slice(0, limit).map((v) => ({ ...v }));
  }
}

