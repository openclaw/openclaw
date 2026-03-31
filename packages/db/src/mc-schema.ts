/**
 * Mission Control SQLite schema.
 * Migrated from mabos-mission-control/src/lib/db/schema.ts
 */
export const MC_SCHEMA = `
CREATE TABLE IF NOT EXISTS mc_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mc_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  priority TEXT NOT NULL DEFAULT 'medium',
  assigned_agent_id TEXT,
  origin TEXT NOT NULL DEFAULT 'mc',
  dispatch_session_key TEXT,
  planning_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES mc_workspaces(id)
);

CREATE TABLE IF NOT EXISTS mc_planning_questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  answered_at TEXT,
  FOREIGN KEY (task_id) REFERENCES mc_tasks(id)
);

CREATE TABLE IF NOT EXISTS mc_planning_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  spec_content TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT 0,
  approved_at TEXT,
  FOREIGN KEY (task_id) REFERENCES mc_tasks(id)
);

CREATE TABLE IF NOT EXISTS mc_knowledge_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mc_kanban_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  tier TEXT NOT NULL DEFAULT 'strategic',
  status TEXT NOT NULL DEFAULT 'active',
  progress REAL NOT NULL DEFAULT 0,
  owner_agent_id TEXT,
  parent_goal_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mc_kanban_campaigns (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  progress REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (goal_id) REFERENCES mc_kanban_goals(id)
);

CREATE TABLE IF NOT EXISTS mc_kanban_initiatives (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  progress REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id) REFERENCES mc_kanban_campaigns(id)
);

CREATE TABLE IF NOT EXISTS mc_task_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  activity_type TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES mc_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_mc_tasks_workspace ON mc_tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mc_tasks_agent ON mc_tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_mc_knowledge_workspace ON mc_knowledge_entries(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_mc_goals_tier ON mc_kanban_goals(tier, status);
`;
