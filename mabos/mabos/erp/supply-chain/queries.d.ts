import type { PgClient } from "../db/postgres.js";
export declare function createShipment(pg: PgClient, params: {
    order_id?: string;
    supplier_id?: string;
    origin: string;
    destination: string;
    carrier?: string;
    tracking_number?: string;
    status?: string;
    estimated_arrival?: string;
}): Promise<any>;
export declare function getShipment(pg: PgClient, id: string): Promise<any>;
export declare function listShipments(pg: PgClient, params: {
    status?: string;
    supplier_id?: string;
    limit?: number;
}): Promise<any[]>;
export declare function updateShipmentStatus(pg: PgClient, id: string, status: string): Promise<any>;
export declare function trackShipment(pg: PgClient, trackingNumber: string): Promise<any>;
export declare function createRoute(pg: PgClient, params: {
    name: string;
    origin: string;
    destination: string;
    legs?: unknown[];
    status?: string;
}): Promise<any>;
export declare function listRoutes(pg: PgClient, params: {
    status?: string;
    limit?: number;
}): Promise<any[]>;
export declare function getRoute(pg: PgClient, id: string): Promise<any>;
//# sourceMappingURL=queries.d.ts.map