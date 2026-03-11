import type { BaseEntity } from "../shared/types.js";

export interface Report extends BaseEntity {
  name: string;
  type: string;
  query: string;
  parameters: Record<string, unknown>;
  schedule: string | null;
  lastRunAt: string | null;
  status: string;
}

export interface Dashboard extends BaseEntity {
  name: string;
  description: string | null;
  widgets: Array<{
    type: string;
    reportId: string;
    position: { x: number; y: number; w: number; h: number };
  }>;
  ownerId: string | null;
}

export interface DataSnapshot extends BaseEntity {
  reportId: string;
  data: Record<string, unknown>;
  generatedAt: string;
}
