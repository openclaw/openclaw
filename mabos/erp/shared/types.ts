/** ISO 4217 currency code. */
export type CurrencyCode = string;

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface SortParams {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type EntityStatus = "active" | "archived" | "draft" | "suspended";

export type ErpActionResult<T = unknown> =
  | { success: true; data: T }
  | { error: string; details?: string };

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AuditEntry {
  id: string;
  domain: string;
  entityType: string;
  entityId: string;
  action: string;
  agentId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
