import type { PgClient } from "../db/postgres.js";
export declare function createProduct(
  pg: PgClient,
  params: {
    name: string;
    sku: string;
    price: number;
    currency?: string;
    category?: string;
    stock_qty?: number;
  },
): Promise<unknown>;
export declare function getProduct(pg: PgClient, id: string): Promise<unknown>;
export declare function listProducts(
  pg: PgClient,
  params: {
    category?: string;
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateProduct(
  pg: PgClient,
  id: string,
  params: Partial<{
    name: string;
    sku: string;
    price: number;
    currency: string;
    category: string;
    stock_qty: number;
    status: string;
  }>,
): Promise<unknown>;
export declare function createOrder(
  pg: PgClient,
  params: {
    customer_id: string;
    items: Array<{
      product_id: string;
      quantity: number;
      unit_price: number;
    }>;
    currency?: string;
  },
): Promise<unknown>;
export declare function getOrder(pg: PgClient, id: string): Promise<unknown>;
export declare function listOrders(
  pg: PgClient,
  params: {
    status?: string;
    customer_id?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateOrderStatus(
  pg: PgClient,
  id: string,
  status: string,
): Promise<unknown>;
//# sourceMappingURL=queries.d.ts.map
