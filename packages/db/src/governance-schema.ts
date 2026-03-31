/**
 * Governance module SQLite schema.
 * Moved from extensions/mabos/extensions-mabos/src/governance/budget-ledger.ts
 */
export const GOVERNANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'monthly', 'project')),
  period_key TEXT NOT NULL,
  limit_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, agent_id, period_type, period_key)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  company_id TEXT NOT NULL DEFAULT 'default',
  actor_type TEXT NOT NULL CHECK(actor_type IN ('agent', 'operator', 'system', 'hook')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail TEXT,
  outcome TEXT CHECK(outcome IN ('success', 'denied', 'error', 'pending'))
);

CREATE INDEX IF NOT EXISTS idx_budget_lookup ON budget_allocations(company_id, agent_id, period_type, period_key);
CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_events(company_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(company_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(company_id, action);
`;
