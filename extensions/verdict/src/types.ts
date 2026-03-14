/**
 * Verdict policy engine request/response types.
 *
 * These types mirror the Verdict gateway's Go structs in
 * `gateway/internal/model/{request,response}.go`. Any schema changes in
 * Verdict must be reflected here to keep the contract in sync.
 */

// --- Request types ---

/**
 * Context sent alongside every policy evaluation request.
 *
 * - `principal`: identity of the user/entity initiating the action.
 * - `agent_role`: role of the agent (used by policies for role-based gating).
 * - `session_id`: current conversation/session identifier.
 * - `identity_verified`: whether the principal's identity has been verified.
 * - `extra`: open-ended bag for domain-specific context (e.g. customer tier,
 *   consent flags, department). Policies reference these via `input.context.extra.*`.
 */
export type ActionContext = {
  principal: string;
  agent_role: string;
  session_id: string;
  identity_verified: boolean;
  extra?: Record<string, unknown>;
};

export type EntityState = {
  stateName?: string;
  fields?: Record<string, unknown>;
};

export type ActionRequest = {
  action_id: string;
  agent_id: string;
  tool: string;
  args: Record<string, unknown>;
  context: ActionContext;
  timestamp: string;
  entity_state?: EntityState;
};

// --- Response types ---

export type Decision = "ALLOW" | "DENY" | "REQUIRE_CHANGES";

export type Violation = {
  policy_id: string;
  severity: string;
  message: string;
  failed_constraints?: string[];
  sop_ref?: string;
};

/**
 * A suggested repair action returned by a REQUIRE_CHANGES decision.
 *
 * Only `op` is guaranteed by the Verdict schema. All other fields are
 * policy-defined and vary by repair operation. Common fields are typed
 * explicitly for convenience; domain-specific fields land in the index
 * signature. See Verdict's `gateway/internal/model/response.go` RepairAction.
 */
export type RepairAction = {
  /** Repair operation identifier (e.g. "cap_value", "redact", "add_approval", "escalate"). */
  op: string;
  /** Human-readable explanation of why the repair is needed. */
  reason?: string;
  /** Affected argument fields (e.g. ["args.amount"]). */
  fields?: string[];
  /** Numeric ceiling for cap_value repairs. */
  max_value?: number;
  /** Role required for approval/escalation repairs. */
  role?: string;
  /** Target queue/entity for escalation. */
  target?: string;
  /** Additional policy-defined properties. */
  [key: string]: unknown;
};

export type Obligation = {
  type: string;
  target?: string;
  fields?: string[];
  disclosure_id?: string;
};

export type AuditInfo = {
  eval_id: string;
  bundle_digest: string;
  input_hash: string;
  timestamp: string;
  sop_refs?: string[];
  shadow_mode: boolean;
};

export type PolicyDecision = {
  decision: Decision;
  eval_duration_ms: number;
  violations?: Violation[];
  suggested_repairs?: RepairAction[];
  obligations?: Obligation[];
  audit: AuditInfo;
};

// --- Discovery types ---

export type PolicyRule = {
  id: string;
  decision: Decision;
  severity?: string;
  sop_ref?: string;
};

export type PolicyInfo = {
  name: string;
  description?: string;
  source: "yaml" | "rego";
  sop_ref?: string;
  tools?: string[];
  rules?: PolicyRule[];
  obligations?: string[];
  arg_refs?: string[];
};

export type DiscoveryResponse = {
  bundle_digest: string;
  policy_count: number;
  policies: PolicyInfo[];
  coverage?: {
    tools_with_policies: string[];
    tools_without_policies: string[];
    coverage_percent: number;
  };
};

export type PolicyExplanation = {
  name: string;
  description?: string;
  source: "yaml" | "rego";
  sop_ref?: string;
  summary?: string;
  trigger?: {
    tools?: string[];
    conditions?: Array<{
      field: string;
      op: string;
      value: string;
      description?: string;
    }>;
  };
  rules?: Array<{
    id: string;
    decision: Decision;
    severity?: string;
    sop_ref?: string;
    conditions?: Array<{ field: string; op: string; value: string; description?: string }>;
    repairs?: Array<{ op: string; description?: string; fields?: Record<string, string> }>;
  }>;
  obligations?: Array<{ type: string; target?: string; fields?: string[] }>;
};

export type HealthResponse = {
  status: string;
  bundle_digest: string;
  eval_count: number;
  p50_ms: number;
  p99_ms: number;
  shadow_mode: boolean;
};

export type TraceSummaryResponse = {
  time_range: { from: string; to: string };
  total_evaluations: number;
  decisions: Record<Decision, { count: number; pct: number }>;
  top_violated_policies: Array<{ policy_id: string; count: number }>;
  top_tools_by_denial_rate: Array<{
    tool: string;
    total: number;
    denied: number;
    denial_rate_pct: number;
  }>;
};
