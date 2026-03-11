import type { BaseEntity } from "../shared/types.js";

export interface Campaign extends BaseEntity {
  name: string;
  type: string;
  status: string;
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
  targetAudience: string | null;
  channels: string[];
}

export interface CampaignMetric extends BaseEntity {
  campaignId: string;
  metricType: string;
  value: number;
  recordedAt: string;
}

export interface Kpi extends BaseEntity {
  name: string;
  target: number;
  current: number;
  unit: string | null;
  period: string | null;
  status: string;
}
