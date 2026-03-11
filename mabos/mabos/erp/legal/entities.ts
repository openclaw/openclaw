import type { BaseEntity } from "../shared/types.js";

// ── Legacy types (kept for backward compatibility) ──────────

/** @deprecated Use PartnershipContract or FreelancerContract instead */
export interface Contract extends BaseEntity {
  title: string;
  counterparty: string;
  type: string;
  value: number | null;
  currency: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  terms: string | null;
}

/** @deprecated */
export interface LegalCase extends BaseEntity {
  title: string;
  caseType: string;
  status: string;
  priority: string;
  assignedTo: string | null;
  description: string | null;
  filedDate: string | null;
}

// ── New types ───────────────────────────────────────────────

export interface PartnershipContract extends BaseEntity {
  partnerName: string;
  partnerType: string | null;
  ownershipPct: number | null;
  revenueSharePct: number | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  terms: string | null;
  documentUrl: string | null;
}

export interface FreelancerContract extends BaseEntity {
  contractorName: string;
  scopeOfWork: string | null;
  rateType: "hourly" | "fixed" | "retainer";
  rateAmount: number;
  currency: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  deliverables: unknown[] | null;
  documentUrl: string | null;
}

export interface CorporateDocument extends BaseEntity {
  docType: string;
  title: string | null;
  filingDate: string | null;
  expiryDate: string | null;
  jurisdiction: string | null;
  status: string;
  documentUrl: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LegalStructure extends BaseEntity {
  businessName: string;
  legalName: string | null;
  entityType: string;
  stateOfFormation: string | null;
  ein: string | null;
  formationDate: string | null;
  registeredAgent: string | null;
  principalAddress: string | null;
}

export interface ComplianceGuardrail extends BaseEntity {
  name: string;
  category: string;
  description: string | null;
  ruleExpression: string | null;
  severity: "info" | "warning" | "critical";
  active: boolean;
}
