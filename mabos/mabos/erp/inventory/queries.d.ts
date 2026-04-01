import type { PgClient } from "../db/postgres.js";
export declare function createStockItem(
  pg: PgClient,
  params: {
    sku: string;
    name: string;
    quantity?: number;
    reorder_point?: number;
    warehouse_id?: string;
    status?: string;
    unit?: string;
  },
): Promise<unknown>;
export declare function getStockItem(pg: PgClient, id: string): Promise<unknown>;
export declare function listStockItems(
  pg: PgClient,
  params: {
    warehouse_id?: string;
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function adjustStock(
  pg: PgClient,
  params: {
    stock_item_id: string;
    type: "in" | "out" | "adjustment";
    quantity: number;
    reason?: string;
    reference?: string;
  },
): Promise<unknown>;
export declare function lowStockAlerts(pg: PgClient, threshold?: number): Promise<unknown[]>;
export declare function getStockMovements(
  pg: PgClient,
  stockItemId: string,
  limit?: number,
): Promise<unknown[]>;
//# sourceMappingURL=queries.d.ts.map
