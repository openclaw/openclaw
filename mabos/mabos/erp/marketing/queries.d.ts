import type { PgClient } from "../db/postgres.js";
export declare function createCampaign(
  pg: PgClient,
  params: {
    name: string;
    type: string;
    status?: string;
    budget?: number;
    start_date?: string;
    end_date?: string;
    target_audience?: string;
    channels?: string[];
  },
): Promise<unknown>;
export declare function getCampaign(pg: PgClient, id: string): Promise<unknown>;
export declare function listCampaigns(
  pg: PgClient,
  params: {
    status?: string;
    type?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateCampaign(
  pg: PgClient,
  id: string,
  params: Record<string, unknown>,
): Promise<unknown>;
export declare function recordMetric(
  pg: PgClient,
  params: {
    campaign_id: string;
    metric_type: string;
    value: number;
  },
): Promise<unknown>;
export declare function getCampaignMetrics(
  pg: PgClient,
  campaignId: string,
  limit?: number,
): Promise<unknown[]>;
export declare function createKpi(
  pg: PgClient,
  params: {
    name: string;
    target: number;
    current?: number;
    unit?: string;
    period?: string;
    status?: string;
  },
): Promise<unknown>;
export declare function listKpis(
  pg: PgClient,
  params: {
    status?: string;
    period?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateKpi(
  pg: PgClient,
  id: string,
  params: Record<string, unknown>,
): Promise<unknown>;
//# sourceMappingURL=queries.d.ts.map
