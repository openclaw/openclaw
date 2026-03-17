/**
 * Per-Agent Tool Filtering
 *
 * Provides role-based tool scoping so each agent only sees tools
 * relevant to its domain. All agents share BDI, communication,
 * memory, cognitive, and reasoning tools.
 */

// ── Shared Tool Patterns (every agent gets these) ────────────

export const SHARED_TOOL_PATTERNS: string[] = [
  // BDI cognitive core
  "belief_*",
  "goal_*",
  "desire_*",
  "intention_*",
  "bdi_cycle",
  "plan_*",
  "skill_inventory",
  "action_log",
  // Reasoning & knowledge
  "reason",
  "reason_*",
  "knowledge_*",
  "fact_*",
  "infer_*",
  "htn_*",
  // Memory
  "memory_*",
  // Communication
  "agent_message",
  "agent_spawn",
  "contract_net_*",
  "decision_*",
  "handoff",
  "notify_*",
  "request_*",
  // Cognitive router
  "cognitive_*",
  // Case-based reasoning
  "cbr_*",
  // Capabilities sync
  "capabilities_sync",
];

// ── Role-Scoped Tool Patterns ────────────────────────────────

export const ROLE_TOOL_SCOPE: Record<string, string[]> = {
  cfo: ["metrics_*", "financial_*", "forecast_*", "rule_*", "constraint_*", "report_*"],
  cmo: [
    "marketing_*",
    "content_*",
    "ad_*",
    "email_*",
    "seo_*",
    "audience_*",
    "crm_*",
    "lead_*",
    "product_catalog_*",
    "le_waitlist",
    "le_drip_*",
    "le_email_*",
    "le_scarcity_*",
    "competitor_*",
  ],
  cto: [
    "cloudflare_*",
    "integration_*",
    "typedb_*",
    "shopify_*",
    "webhook_*",
    "setup_*",
    "cicd_*",
    "security_*",
    "apm_*",
  ],
  coo: [
    "workflow_*",
    "bpmn_*",
    "work_package_*",
    "integration_*",
    "report_*",
    "supply_chain_*",
    "vendor_*",
    "sla_*",
    "capacity_*",
    "inventory_*",
    "product_catalog_*",
    "le_inventory",
    "le_scarcity_*",
    "pictorem_*",
  ],
  ceo: ["decision_*", "report_*", "metrics_*", "stakeholder_*", "directive_*"],
  legal: ["compliance_*", "contract_*", "rule_*", "policy_*"],
  hr: ["employee_*", "recruitment_*", "performance_*", "policy_*", "contractor_*", "workforce_*"],
  strategy: ["decision_*", "scenario_*", "competitive_*", "market_*"],
  knowledge: ["knowledge_*", "typedb_*", "fact_*", "ontology_*"],
  ecommerce: ["shopify_*", "product_*", "order_*", "inventory_*", "collection_*", "pictorem_*"],
  "lead-gen": ["lead_*", "crm_*", "outreach_*"],
  "sales-research": ["lead_*", "crm_*", "market_*", "competitive_*"],
  outreach: ["outreach_*", "email_*", "lead_*", "crm_*"],
};

// ── Pattern Matching ─────────────────────────────────────────

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return pattern === toolName;
  // Convert glob to regex: "metrics_*" → /^metrics_.*$/
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.split("*").join(".*")}$`);
  return re.test(toolName);
}

function matchesAnyPattern(toolName: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(toolName, p));
}

// ── Public API ───────────────────────────────────────────────

/**
 * Check whether a specific tool is allowed for a given role.
 * Unknown roles get all tools (permissive fallback).
 */
export function isToolAllowedForRole(role: string, toolName: string): boolean {
  // Shared tools are always allowed
  if (matchesAnyPattern(toolName, SHARED_TOOL_PATTERNS)) return true;

  // Unknown role = allow everything
  const rolePatterns = ROLE_TOOL_SCOPE[role];
  if (!rolePatterns) return true;

  return matchesAnyPattern(toolName, rolePatterns);
}

/**
 * Filter a list of tool names down to those allowed for a role.
 * Unknown roles get all tools.
 */
export function getToolsForRole(role: string, allToolNames: string[]): string[] {
  if (!ROLE_TOOL_SCOPE[role]) return [...allToolNames];
  return allToolNames.filter((name) => isToolAllowedForRole(role, name));
}
