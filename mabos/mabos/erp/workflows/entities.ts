import type { BaseEntity } from "../shared/types.js";

export interface Workflow extends BaseEntity {
  name: string;
  description: string | null;
  trigger: string;
  steps: Array<{
    order: number;
    action: string;
    config: Record<string, unknown>;
  }>;
  status: string;
  version: number;
}

export interface WorkflowRun extends BaseEntity {
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  currentStep: number;
  context: Record<string, unknown>;
  error: string | null;
}
