import type { PgClient } from "../db/postgres.js";
export declare function createContact(pg: PgClient, params: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    segment?: string;
    lifecycle_stage?: string;
    metadata?: Record<string, unknown>;
}): Promise<any>;
export declare function getContact(pg: PgClient, id: string): Promise<any>;
export declare function listContacts(pg: PgClient, params: {
    segment?: string;
    lifecycle_stage?: string;
    limit?: number;
    offset?: number;
}): Promise<any[]>;
export declare function searchContacts(pg: PgClient, q: string, limit?: number): Promise<any[]>;
export declare function logInteraction(pg: PgClient, params: {
    contact_id: string;
    channel: string;
    type: string;
    summary: string;
    sentiment?: number;
    agent_id?: string;
}): Promise<any>;
export declare function updateContact(pg: PgClient, id: string, params: Record<string, unknown>): Promise<any>;
export declare function deleteContact(pg: PgClient, id: string): Promise<any>;
//# sourceMappingURL=queries.d.ts.map