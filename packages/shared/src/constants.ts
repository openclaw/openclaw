/**
 * Shared constants across MABOS ecosystem.
 */

export const GATEWAY_DEFAULT_PORT = 18789;
export const GATEWAY_DEFAULT_HOST = "127.0.0.1";

export const MABOS_CONSOLE_BASE = "/mabos/console";
export const MABOS_API_BASE = "/mabos/api";
export const MABOS_AUTH_BASE = "/mabos/auth";

export const MC_API_PREFIX = "/mabos/api/mc";
export const ORCH_API_PREFIX = "/mabos/api/orch";
export const GOV_API_PREFIX = "/mabos/governance";

export const TASK_STATUS_ORDER: readonly string[] = [
  "pending_dispatch",
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "verification",
  "done",
] as const;

export const AGENT_ROLES = [
  "CEO",
  "CFO",
  "CMO",
  "COO",
  "CTO",
  "HR",
  "Legal",
  "Strategy",
  "Knowledge Manager",
  "E-Commerce Manager",
  "Lead Gen",
  "Sales Research",
  "Outreach",
  "Financial Analyst",
  "Operations Analyst",
  "TechOps",
] as const;
