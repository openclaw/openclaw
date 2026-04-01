import type { PgClient } from "../db/postgres.js";
export declare function createContract(
  pg: PgClient,
  params: {
    title: string;
    counterparty: string;
    type: string;
    value?: number;
    currency?: string;
    start_date?: string;
    end_date?: string;
    terms?: string;
  },
): Promise<unknown>;
export declare function getContract(pg: PgClient, id: string): Promise<unknown>;
export declare function listContracts(
  pg: PgClient,
  params: {
    status?: string;
    counterparty?: string;
    type?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateContract(
  pg: PgClient,
  id: string,
  params: Partial<{
    title: string;
    counterparty: string;
    type: string;
    value: number;
    currency: string;
    status: string;
    start_date: string;
    end_date: string;
    terms: string;
  }>,
): Promise<unknown>;
export declare function expiringContracts(pg: PgClient, withinDays: number): Promise<unknown[]>;
export declare function createCase(
  pg: PgClient,
  params: {
    title: string;
    case_type: string;
    priority?: string;
    assigned_to?: string;
    description?: string;
    filed_date?: string;
  },
): Promise<unknown>;
export declare function getCase(pg: PgClient, id: string): Promise<unknown>;
export declare function listCases(
  pg: PgClient,
  params: {
    status?: string;
    case_type?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function updateCase(
  pg: PgClient,
  id: string,
  params: Partial<{
    title: string;
    case_type: string;
    status: string;
    priority: string;
    assigned_to: string;
    description: string;
  }>,
): Promise<unknown>;
export declare function listPartnershipContracts(
  pg: PgClient,
  params: {
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function createPartnershipContract(
  pg: PgClient,
  params: {
    partner_name: string;
    partner_type?: string;
    ownership_pct?: number;
    revenue_share_pct?: number;
    start_date?: string;
    end_date?: string;
    terms?: string;
    document_url?: string;
  },
): Promise<unknown>;
export declare function listFreelancerContracts(
  pg: PgClient,
  params: {
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function createFreelancerContract(
  pg: PgClient,
  params: {
    contractor_name: string;
    scope_of_work?: string;
    rate_type?: string;
    rate_amount: number;
    currency?: string;
    start_date?: string;
    end_date?: string;
    deliverables?: unknown[];
    document_url?: string;
  },
): Promise<unknown>;
export declare function listCorporateDocuments(
  pg: PgClient,
  params: {
    doc_type?: string;
    status?: string;
    limit?: number;
  },
): Promise<unknown[]>;
export declare function getLegalStructure(pg: PgClient): Promise<unknown>;
export declare function listComplianceGuardrails(
  pg: PgClient,
  params: {
    active?: boolean;
    category?: string;
    limit?: number;
  },
): Promise<unknown[]>;
//# sourceMappingURL=queries.d.ts.map
