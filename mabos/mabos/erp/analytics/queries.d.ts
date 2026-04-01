import type { PgClient } from "../db/postgres.js";
export declare function createReport(
  pg: PgClient,
  params: {
    name: string;
    type: string;
    query: string;
    parameters?: Record<string, unknown>;
    schedule?: string | null;
  },
): Promise<unknown>;
export declare function getReport(pg: PgClient, id: string): Promise<unknown>;
export declare function listReports(
  pg: PgClient,
  params: {
    type?: string;
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function runReport(pg: PgClient, reportId: string): Promise<unknown>;
export declare function deleteReport(pg: PgClient, id: string): Promise<unknown>;
export declare function createDashboard(
  pg: PgClient,
  params: {
    name: string;
    description?: string | null;
    widgets?: Array<{
      type: string;
      reportId: string;
      position: {
        x: number;
        y: number;
        w: number;
        h: number;
      };
    }>;
    owner_id?: string | null;
  },
): Promise<unknown>;
export declare function getDashboard(pg: PgClient, id: string): Promise<unknown>;
export declare function listDashboards(
  pg: PgClient,
  params: {
    owner_id?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function getSnapshots(
  pg: PgClient,
  reportId: string,
  limit?: number,
): Promise<unknown[]>;
//# sourceMappingURL=queries.d.ts.map
