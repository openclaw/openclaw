import type { PgClient } from "../db/postgres.js";
export declare function createSupplier(pg: PgClient, params: {
    name: string;
    contact_email?: string;
    category?: string;
    rating?: number;
    terms?: string;
}): Promise<any>;
export declare function getSupplier(pg: PgClient, id: string): Promise<any>;
export declare function listSuppliers(pg: PgClient, params: {
    status?: string;
    category?: string;
    limit?: number;
}): Promise<any[]>;
export declare function updateSupplier(pg: PgClient, id: string, params: Partial<{
    name: string;
    contact_email: string;
    category: string;
    rating: number;
    status: string;
    terms: string;
}>): Promise<any>;
export declare function createPurchaseOrder(pg: PgClient, params: {
    supplier_id: string;
    items: Array<{
        description: string;
        quantity: number;
        unit_cost: number;
    }>;
    expected_delivery?: string;
}): Promise<any>;
export declare function getPurchaseOrder(pg: PgClient, id: string): Promise<any>;
export declare function listPurchaseOrders(pg: PgClient, params: {
    supplier_id?: string;
    status?: string;
    limit?: number;
}): Promise<any[]>;
export declare function receivePurchaseOrder(pg: PgClient, id: string): Promise<any>;
//# sourceMappingURL=queries.d.ts.map