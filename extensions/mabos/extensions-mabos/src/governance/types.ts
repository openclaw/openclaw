/**
 * Governance module types — budget control, RBAC, audit logging, multi-company.
 */

export interface GovernanceConfig {
  governanceEnabled?: boolean;
  budget?: {
    enabled?: boolean;
    defaultDailyLimitUsd?: number;
    defaultMonthlyLimitUsd?: number;
    hardCeilingUsd?: number;
    alertThresholdPercent?: number;
    requireApprovalAboveUsd?: number;
  };
  rbac?: {
    enabled?: boolean;
    defaultRole?: "operator" | "agent" | "viewer" | "admin";
    policyPath?: string;
  };
  audit?: {
    enabled?: boolean;
    retentionDays?: number;
    dbPath?: string;
  };
  multiCompany?: { enabled?: boolean };
}

export interface BudgetAllocation {
  id: string;
  companyId: string;
  agentId: string;
  periodType: "daily" | "monthly" | "project";
  periodKey: string;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  sessionId: string | null;
  eventType: "llm_input" | "llm_output" | "tool_call" | "api_call" | "reservation" | "release";
  amountUsd: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolName: string | null;
  metadata: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  companyId: string;
  actorType: "agent" | "operator" | "system" | "hook";
  actorId: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: string | null;
  outcome: "success" | "denied" | "error" | "pending";
}

export interface BudgetStatus {
  agentId: string;
  daily: {
    limit: number;
    spent: number;
    reserved: number;
    remaining: number;
  } | null;
  monthly: {
    limit: number;
    spent: number;
    reserved: number;
    remaining: number;
  } | null;
  canSpend: boolean;
}

export class BudgetExhaustedError extends Error {
  constructor(
    public agentId: string,
    public periodType: string,
    public limitUsd: number,
    public currentSpend: number,
    public requested: number,
  ) {
    super(
      `Budget exhausted: agent "${agentId}" ${periodType} limit $${limitUsd}, spent $${currentSpend}, requested $${requested}`,
    );
    this.name = "BudgetExhaustedError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(
    public role: string,
    public action: string,
  ) {
    super(`Permission denied: role "${role}" cannot perform "${action}"`);
    this.name = "PermissionDeniedError";
  }
}
