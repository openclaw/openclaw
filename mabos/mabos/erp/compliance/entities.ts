import type { BaseEntity } from "../shared/types.js";

export interface Policy extends BaseEntity {
  title: string;
  category: string;
  version: string;
  status: string;
  effectiveDate: string | null;
  content: string | null;
}

export interface Violation extends BaseEntity {
  policyId: string | null;
  severity: string;
  status: string;
  description: string;
  reportedBy: string | null;
  resolvedAt: string | null;
}
