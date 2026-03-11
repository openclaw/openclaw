import type { PgClient } from "../db/postgres.js";
export declare function createPolicy(pg: PgClient, params: {
    title: string;
    category: string;
    version?: string;
    effective_date?: string;
    content?: string;
}): Promise<any>;
export declare function getPolicy(pg: PgClient, id: string): Promise<any>;
export declare function listPolicies(pg: PgClient, params: {
    status?: string;
    category?: string;
    limit?: number;
}): Promise<any[]>;
export declare function updatePolicy(pg: PgClient, id: string, params: Partial<{
    title: string;
    category: string;
    version: string;
    status: string;
    effective_date: string;
    content: string;
}>): Promise<any>;
export declare function reportViolation(pg: PgClient, params: {
    policy_id?: string;
    severity: string;
    description: string;
    reported_by?: string;
}): Promise<any>;
export declare function getViolation(pg: PgClient, id: string): Promise<any>;
export declare function listViolations(pg: PgClient, params: {
    status?: string;
    severity?: string;
    policy_id?: string;
    limit?: number;
}): Promise<any[]>;
export declare function resolveViolation(pg: PgClient, id: string, resolution: string): Promise<any>;
//# sourceMappingURL=queries.d.ts.map