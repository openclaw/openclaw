import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Use globalThis to ensure a true singleton across Next.js module boundaries.
// Turbopack/webpack may re-instantiate module-level variables for different API routes.
const globalForDb = globalThis as typeof globalThis & {
  __missionControlDb?: Database.Database;
};

export function getDb(): Database.Database {
  if (globalForDb.__missionControlDb) {
    return globalForDb.__missionControlDb;
  }

  const dbPath = path.resolve(process.cwd(), "data", "mission-control.db");

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initializeSchema(db);
  globalForDb.__missionControlDb = db;
  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT DEFAULT '',
      applied_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'archived')),
      workspace_id TEXT DEFAULT 'golden',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'inbox' CHECK(status IN ('inbox', 'assigned', 'in_progress', 'review', 'done')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      mission_id TEXT,
      assigned_agent_id TEXT,
      employee_id TEXT,
      openclaw_session_key TEXT,
      tags TEXT DEFAULT '[]',
      due_date TEXT,
      cost_estimate REAL,
      workspace_id TEXT DEFAULT 'golden',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT,
      author_type TEXT DEFAULT 'agent' CHECK(author_type IN ('agent', 'user', 'system')),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      mission_id TEXT,
      workspace_id TEXT DEFAULT 'golden',
      message TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS specialist_feedback (
      id TEXT PRIMARY KEY,
      specialist_id TEXT NOT NULL,
      task_id TEXT,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      dimension TEXT DEFAULT 'overall',
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT 'user' CHECK(created_by IN ('user', 'system')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
    CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(type);
    CREATE INDEX IF NOT EXISTS idx_specialist_feedback_specialist ON specialist_feedback(specialist_id);
    CREATE INDEX IF NOT EXISTS idx_specialist_feedback_task ON specialist_feedback(task_id);
    CREATE INDEX IF NOT EXISTS idx_specialist_feedback_created ON specialist_feedback(created_at);
  `);
  // Run additive migrations after base tables/indexes are present.
  // Workspace-specific indexes are intentionally created in migrations so
  // legacy DBs without workspace_id columns can be upgraded safely.
  runMigrations(db);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

interface MigrationDefinition {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

function hasMigration(db: Database.Database, id: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get(id) as { 1?: number } | undefined;
  return !!row;
}

function markMigrationApplied(
  db: Database.Database,
  migration: MigrationDefinition
): void {
  db.prepare(
    "INSERT INTO schema_migrations (id, description) VALUES (?, ?)"
  ).run(migration.id, migration.description);
}

function getMigrations(): MigrationDefinition[] {
  return [
    {
      id: "2026-02-16-001-workspace-columns",
      description:
        "Ensure workspace_id exists across missions/tasks/activity_log with backfill.",
      up: (db) => {
        ensureColumn(db, "missions", "workspace_id", "TEXT DEFAULT 'golden'");
        ensureColumn(db, "tasks", "workspace_id", "TEXT DEFAULT 'golden'");
        ensureColumn(db, "activity_log", "workspace_id", "TEXT DEFAULT 'golden'");

        db.exec(`
          UPDATE missions SET workspace_id = 'golden' WHERE workspace_id IS NULL OR workspace_id = '';
          UPDATE tasks SET workspace_id = 'golden' WHERE workspace_id IS NULL OR workspace_id = '';
          UPDATE activity_log SET workspace_id = 'golden' WHERE workspace_id IS NULL OR workspace_id = '';
        `);
      },
    },
    {
      id: "2026-02-16-002-task-planning-fields",
      description: "Ensure tags, due_date, and cost_estimate exist on tasks.",
      up: (db) => {
        ensureColumn(db, "tasks", "tags", "TEXT DEFAULT '[]'");
        ensureColumn(db, "tasks", "due_date", "TEXT");
        ensureColumn(db, "tasks", "cost_estimate", "REAL");

        db.exec(`
          UPDATE tasks SET tags = '[]' WHERE tags IS NULL OR tags = '';
        `);
      },
    },
    {
      id: "2026-02-16-003-workspace-indexes",
      description:
        "Add workspace-aware indexes for tasks, missions, and activity_log.",
      up: (db) => {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log(workspace_id);
        `);
      },
    },
    {
      id: "2026-02-16-004-workspaces-table",
      description:
        "Create workspaces table and seed the four initial workspaces.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT 'slate',
            folder_path TEXT DEFAULT NULL,
            access_mode TEXT NOT NULL DEFAULT 'read-write' CHECK(access_mode IN ('read-only', 'read-write', 'full')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);

        // Seed the four existing hardcoded workspaces for backward compatibility.
        const insert = db.prepare(
          `INSERT OR IGNORE INTO workspaces (id, label, color) VALUES (?, ?, ?)`
        );
        const seeds: Array<[string, string, string]> = [
          ["golden", "Golden Investors", "amber"],
          ["ras", "RAS Logic", "emerald"],
          ["mustadem", "Mustadem", "sky"],
          ["anteja", "Anteja ECG", "rose"],
        ];
        for (const [id, label, color] of seeds) {
          insert.run(id, label, color);
        }
      },
    },
    {
      id: "2026-02-16-005-profiles",
      description:
        "Create profiles, profile_workspaces, and profile_integrations tables. Seed Abdulrahman and Abdulaziz profiles.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar_color TEXT NOT NULL DEFAULT 'blue',
            avatar_emoji TEXT NOT NULL DEFAULT '👤',
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS profile_workspaces (
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('owner','shared')) DEFAULT 'owner',
            PRIMARY KEY (profile_id, workspace_id)
          );
          CREATE TABLE IF NOT EXISTS profile_integrations (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            service TEXT NOT NULL,
            account_id TEXT,
            config TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(profile_id, service)
          );
          CREATE INDEX IF NOT EXISTS idx_profile_workspaces_profile ON profile_workspaces(profile_id);
          CREATE INDEX IF NOT EXISTS idx_profile_workspaces_workspace ON profile_workspaces(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_profile_integrations_profile ON profile_integrations(profile_id);
        `);

        const abdulrahmanId = "profile-abdulrahman";
        const abdulazizId = "profile-abdulaziz";

        db.prepare(
          `INSERT OR IGNORE INTO profiles (id, name, avatar_color, avatar_emoji, is_default) VALUES (?, ?, ?, ?, ?)`
        ).run(abdulrahmanId, "Abdulrahman", "blue", "👑", 1);

        db.prepare(
          `INSERT OR IGNORE INTO profiles (id, name, avatar_color, avatar_emoji, is_default) VALUES (?, ?, ?, ?, ?)`
        ).run(abdulazizId, "Abdulaziz", "emerald", "🦁", 0);

        const workspaces = db
          .prepare("SELECT id FROM workspaces")
          .all() as { id: string }[];
        const linkStmt = db.prepare(
          "INSERT OR IGNORE INTO profile_workspaces (profile_id, workspace_id, role) VALUES (?, ?, 'owner')"
        );
        for (const ws of workspaces) {
          linkStmt.run(abdulrahmanId, ws.id);
        }
      },
    },
    {
      id: "2026-02-16-006-employees-and-accounts",
      description:
        "Add employees, accounts, employee_account_access, and tasks.employee_id for Mission Control Employees view.",
      up: (db) => {
        // Employee id on tasks
        ensureColumn(db, "tasks", "employee_id", "TEXT");

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(employee_id);

          CREATE TABLE IF NOT EXISTS employees (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role_key TEXT NOT NULL,
            department TEXT NOT NULL DEFAULT 'operations',
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
            description TEXT DEFAULT '',
            manager_id TEXT DEFAULT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            workspace_id TEXT NOT NULL DEFAULT 'golden',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_employees_workspace ON employees(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
          CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
          CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
          CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_workspace_role ON employees(workspace_id, role_key);

          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            service TEXT NOT NULL,
            label TEXT NOT NULL,
            region TEXT DEFAULT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'golden',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_accounts_workspace ON accounts(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_accounts_service ON accounts(service);

          CREATE TABLE IF NOT EXISTS employee_account_access (
            employee_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'draft' CHECK(mode IN ('read','draft','execute')),
            requires_approval INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (employee_id, account_id),
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_employee_access_employee ON employee_account_access(employee_id);
          CREATE INDEX IF NOT EXISTS idx_employee_access_account ON employee_account_access(account_id);
        `);
      },
    },
    {
      id: "2026-02-16-007-employee-hierarchy",
      description: "Add manager_id + sort_order to employees and enforce unique role_key per workspace.",
      up: (db) => {
        ensureColumn(db, "employees", "manager_id", "TEXT DEFAULT NULL");
        ensureColumn(db, "employees", "sort_order", "INTEGER NOT NULL DEFAULT 0");

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
          CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_workspace_role ON employees(workspace_id, role_key);
        `);
      },
    },
    {
      id: "2026-02-16-008-settings-table",
      description: "Add key-value settings table for app configuration (e.g. risk_level).",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        // Seed default risk level
        db.prepare(
          "INSERT OR IGNORE INTO settings (key, value) VALUES ('risk_level', 'medium')"
        ).run();
      },
    },
    {
      id: "2026-02-16-009-api-keys-and-models",
      description: "Add api_keys and local_models tables for AI provider management.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT NOT NULL,
            api_key_encrypted TEXT NOT NULL,
            base_url TEXT DEFAULT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            last_tested_at TEXT DEFAULT NULL,
            last_test_status TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);
          CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

          CREATE TABLE IF NOT EXISTS local_models (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'ollama',
            model_id TEXT NOT NULL,
            base_url TEXT NOT NULL DEFAULT 'http://localhost:11434',
            is_active INTEGER NOT NULL DEFAULT 1,
            parameters TEXT NOT NULL DEFAULT '{}',
            last_health_at TEXT DEFAULT NULL,
            last_health_status TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE INDEX IF NOT EXISTS idx_local_models_provider ON local_models(provider);
          CREATE INDEX IF NOT EXISTS idx_local_models_active ON local_models(is_active);
        `);
      },
    },
    {
      id: "2026-02-16-010-employee-schedules",
      description: "Add employee_schedules table for cron-driven employee task scheduling.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS employee_schedules (
            id TEXT PRIMARY KEY,
            employee_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            cron_expression TEXT NOT NULL,
            timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
            agent_id TEXT NOT NULL DEFAULT 'main',
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
            category TEXT NOT NULL DEFAULT 'operations' CHECK(category IN ('social_media','finance','sales','operations','other')),
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run_at TEXT,
            next_run_at TEXT,
            workspace_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_schedules_employee ON employee_schedules(employee_id);
          CREATE INDEX IF NOT EXISTS idx_schedules_workspace ON employee_schedules(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON employee_schedules(enabled, next_run_at);
        `);
      },
    },
    {
      id: "2026-02-19-011-rate-limits-table",
      description: "Create rate_limits table for persistent rate limiting across server restarts.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 1,
            reset_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
        `);
      },
    },
    {
      id: "2026-02-19-012-abdulaziz-workspaces",
      description:
        "Link Abdulaziz profile to all existing workspaces (fixes missing seed from migration 005).",
      up: (db) => {
        const abdulazizId = "profile-abdulaziz";
        // Ensure the profile exists (it should from migration 005)
        const profile = db
          .prepare("SELECT id FROM profiles WHERE id = ?")
          .get(abdulazizId) as { id: string } | undefined;
        if (!profile) return; // Safety: skip if profile doesn't exist

        const workspaces = db
          .prepare("SELECT id FROM workspaces")
          .all() as { id: string }[];
        const linkStmt = db.prepare(
          "INSERT OR IGNORE INTO profile_workspaces (profile_id, workspace_id, role) VALUES (?, ?, 'owner')"
        );
        for (const ws of workspaces) {
          linkStmt.run(abdulazizId, ws.id);
        }
      },
    },
    {
      id: "2026-02-19-013-api-key-credits",
      description: "Create api_key_credits table for tracking provider credit balances.",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS api_key_credits (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL UNIQUE,
            balance REAL,
            currency TEXT NOT NULL DEFAULT 'USD',
            limit_total REAL,
            usage_total REAL,
            last_checked_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_credits_provider ON api_key_credits(provider);
        `);
      },
    },
  ];
}

function runMigrations(db: Database.Database): void {
  const migrations = getMigrations();

  for (const migration of migrations) {
    if (hasMigration(db, migration.id)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      markMigrationApplied(db, migration);
    });
    apply();
  }
}

// --- Workspace-scoped lookup helpers ---

/**
 * Fetch a task by ID and verify it belongs to the given workspace.
 * Returns the task if found and workspace matches, otherwise undefined.
 */
export function getTaskWithWorkspace(
  id: string,
  workspaceId: string
): Task | undefined {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as Task | undefined;
}

/**
 * Fetch a mission by ID and verify it belongs to the given workspace.
 * Returns the mission if found and workspace matches, otherwise undefined.
 */
export function getMissionWithWorkspace(
  id: string,
  workspaceId: string
): Mission | undefined {
  return getDb()
    .prepare("SELECT * FROM missions WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as Mission | undefined;
}

// --- Missions ---

export interface Mission {
  id: string;
  name: string;
  description: string;
  status: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export function listMissions(filters?: { workspace_id?: string }): Mission[] {
  let sql = "SELECT * FROM missions WHERE 1=1";
  const params: unknown[] = [];
  if (filters?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(filters.workspace_id);
  }
  sql += " ORDER BY created_at DESC";
  return getDb().prepare(sql).all(...params) as Mission[];
}

export function getMission(id: string): Mission | undefined {
  return getDb().prepare("SELECT * FROM missions WHERE id = ?").get(id) as
    | Mission
    | undefined;
}

export function createMission(data: {
  id: string;
  name: string;
  description?: string;
  workspace_id?: string;
}): Mission {
  getDb()
    .prepare(
      "INSERT INTO missions (id, name, description, workspace_id) VALUES (?, ?, ?, ?)"
    )
    .run(data.id, data.name, data.description ?? "", data.workspace_id ?? "golden");
  return getMission(data.id)!;
}

// Whitelist of allowed mission fields to prevent SQL injection via field names
const ALLOWED_MISSION_FIELDS = new Set(["name", "description", "status", "workspace_id"]);

export function updateMission(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    status: string;
    workspace_id: string;
  }>
): Mission | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_MISSION_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getMission(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE missions SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getMission(id);
}

export function deleteMission(id: string): void {
  getDb().prepare("DELETE FROM missions WHERE id = ?").run(id);
}

// --- Tasks ---

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  mission_id: string | null;
  assigned_agent_id: string | null;
  employee_id: string | null;
  openclaw_session_key: string | null;
  tags: string;
  due_date: string | null;
  cost_estimate: number | null;
  workspace_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function listTasks(filters?: {
  status?: string;
  mission_id?: string;
  assigned_agent_id?: string;
  workspace_id?: string;
}): Task[] {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.status) {
    sql += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.mission_id) {
    sql += " AND mission_id = ?";
    params.push(filters.mission_id);
  }
  if (filters?.assigned_agent_id) {
    sql += " AND assigned_agent_id = ?";
    params.push(filters.assigned_agent_id);
  }
  if (filters?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(filters.workspace_id);
  }

  sql += " ORDER BY sort_order ASC, created_at DESC";
  return getDb().prepare(sql).all(...params) as Task[];
}

export function getTask(id: string): Task | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

export function createTask(data: {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  mission_id?: string;
  assigned_agent_id?: string;
  employee_id?: string | null;
  tags?: string;
  due_date?: string | null;
  cost_estimate?: number | null;
  workspace_id?: string;
}): Task {
  const maxOrder = getDb()
    .prepare(
      "SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM tasks WHERE status = ?"
    )
    .get(data.status ?? "inbox") as { next: number };

  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, mission_id, assigned_agent_id, employee_id, tags, due_date, cost_estimate, workspace_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.title,
      data.description ?? "",
      data.status ?? "inbox",
      data.priority ?? "medium",
      data.mission_id ?? null,
      data.assigned_agent_id ?? null,
      data.employee_id ?? null,
      data.tags ?? "[]",
      data.due_date ?? null,
      data.cost_estimate ?? null,
      data.workspace_id ?? "golden",
      maxOrder.next
    );
  return getTask(data.id)!;
}

// Whitelist of allowed task fields to prevent SQL injection via field names
const ALLOWED_TASK_FIELDS = new Set([
  "title",
  "description",
  "status",
  "priority",
  "mission_id",
  "assigned_agent_id",
  "employee_id",
  "openclaw_session_key",
  "tags",
  "due_date",
  "cost_estimate",
  "workspace_id",
  "sort_order",
]);

export function updateTask(
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    status: string;
    priority: string;
    mission_id: string | null;
    assigned_agent_id: string | null;
    openclaw_session_key: string | null;
    tags: string;
    due_date: string | null;
    cost_estimate: number | null;
    workspace_id: string;
    sort_order: number;
  }>
): Task | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    // Security: Only allow whitelisted field names to prevent SQL injection
    if (value !== undefined && ALLOWED_TASK_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getTask(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getTask(id);
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// --- Comments ---

export interface TaskComment {
  id: string;
  task_id: string;
  agent_id: string | null;
  author_type: string;
  content: string;
  created_at: string;
}

export function listComments(taskId: string): TaskComment[] {
  return getDb()
    .prepare(
      "SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId) as TaskComment[];
}

export function addComment(data: {
  id: string;
  task_id: string;
  agent_id?: string;
  author_type?: string;
  content: string;
}): TaskComment {
  getDb()
    .prepare(
      `INSERT INTO task_comments (id, task_id, agent_id, author_type, content)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.task_id,
      data.agent_id ?? null,
      data.author_type ?? "agent",
      data.content
    );
  return getDb()
    .prepare("SELECT * FROM task_comments WHERE id = ?")
    .get(data.id) as TaskComment;
}

// --- Activity Log ---

export interface ActivityEntry {
  id: string;
  type: string;
  agent_id: string | null;
  task_id: string | null;
  mission_id: string | null;
  workspace_id: string;
  message: string;
  metadata: string;
  created_at: string;
}

export function logActivity(data: {
  id: string;
  type: string;
  agent_id?: string;
  task_id?: string;
  mission_id?: string;
  workspace_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO activity_log (id, type, agent_id, task_id, mission_id, workspace_id, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.type,
      data.agent_id ?? null,
      data.task_id ?? null,
      data.mission_id ?? null,
      data.workspace_id ?? "golden",
      data.message,
      JSON.stringify(data.metadata ?? {})
    );
}

/**
 * Delete activity log entries older than the given number of days.
 * Returns the number of deleted rows.
 */
export function pruneActivityLog(retentionDays = 90): number {
  const result = getDb()
    .prepare(
      `DELETE FROM activity_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    )
    .run(retentionDays);
  return result.changes;
}

/**
 * Check if a specific activity type exists for a given task + agent.
 * Uses indexed lookup instead of loading thousands of rows.
 */
export function hasActivityForTask(
  type: string,
  taskId: string,
  agentId: string
): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM activity_log WHERE type = ? AND task_id = ? AND agent_id = ? LIMIT 1"
    )
    .get(type, taskId, agentId);
  return !!row;
}

// --- Settings (key-value store) ---

/**
 * Get a setting value by key. Returns undefined if not found.
 */
export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Set a setting value. Creates or updates.
 */
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, value);
}

/**
 * Run database maintenance: prune old activity, ANALYZE, then VACUUM.
 * Call periodically (e.g. daily via cron or on startup).
 */
export function runDatabaseMaintenance(opts?: { retentionDays?: number }): {
  pruned: number;
} {
  const pruned = pruneActivityLog(opts?.retentionDays ?? 90);
  const db = getDb();
  db.pragma("analysis_limit = 1000");
  db.pragma("optimize");
  return { pruned };
}

export function listActivity(opts?: {
  limit?: number;
  type?: string;
  workspace_id?: string;
}): ActivityEntry[] {
  let sql = "SELECT * FROM activity_log WHERE 1=1";
  const params: unknown[] = [];

  if (opts?.type) {
    sql += " AND type = ?";
    params.push(opts.type);
  }
  if (opts?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(opts.workspace_id);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(opts?.limit ?? 50);

  return getDb().prepare(sql).all(...params) as ActivityEntry[];
}

// --- Specialist Feedback ---

export interface SpecialistFeedback {
  id: string;
  specialist_id: string;
  task_id: string | null;
  rating: number;
  dimension: string;
  note: string;
  created_by: "user" | "system";
  created_at: string;
}

export function addSpecialistFeedback(data: {
  id: string;
  specialist_id: string;
  task_id?: string | null;
  rating: number;
  dimension?: string;
  note?: string;
  created_by?: "user" | "system";
}): SpecialistFeedback {
  getDb()
    .prepare(
      `INSERT INTO specialist_feedback
      (id, specialist_id, task_id, rating, dimension, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.specialist_id,
      data.task_id ?? null,
      data.rating,
      data.dimension ?? "overall",
      data.note ?? "",
      data.created_by ?? "user"
    );

  return getDb()
    .prepare("SELECT * FROM specialist_feedback WHERE id = ?")
    .get(data.id) as SpecialistFeedback;
}

export function listSpecialistFeedback(filters?: {
  specialist_id?: string;
  task_id?: string;
  dimension?: string;
  limit?: number;
}): SpecialistFeedback[] {
  let sql = "SELECT * FROM specialist_feedback WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.specialist_id) {
    sql += " AND specialist_id = ?";
    params.push(filters.specialist_id);
  }
  if (filters?.task_id) {
    sql += " AND task_id = ?";
    params.push(filters.task_id);
  }
  if (filters?.dimension) {
    sql += " AND dimension = ?";
    params.push(filters.dimension);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(filters?.limit ?? 100);

  return getDb().prepare(sql).all(...params) as SpecialistFeedback[];
}

// --- Workspaces ---

export interface Workspace {
  id: string;
  label: string;
  color: string;
  folder_path: string | null;
  access_mode: string;
  created_at: string;
  updated_at: string;
}

// --- Profiles ---

export interface Profile {
  id: string;
  name: string;
  avatar_color: string;
  avatar_emoji: string;
  is_default: number;
  created_at: string;
}

export interface ProfileWorkspace {
  profile_id: string;
  workspace_id: string;
  role: string;
}

export interface ProfileIntegration {
  id: string;
  profile_id: string;
  service: string;
  account_id: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

export function listWorkspaces(): Workspace[] {
  return getDb()
    .prepare("SELECT * FROM workspaces ORDER BY created_at")
    .all() as Workspace[];
}

export function getWorkspace(id: string): Workspace | undefined {
  return getDb()
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as Workspace | undefined;
}

export function createWorkspace(data: {
  id: string;
  label: string;
  color?: string;
  folder_path?: string | null;
  access_mode?: string;
}): Workspace {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, label, color, folder_path, access_mode)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.label,
      data.color ?? "slate",
      data.folder_path ?? null,
      data.access_mode ?? "read-write"
    );
  return getWorkspace(data.id)!;
}

// Whitelist of allowed workspace fields to prevent SQL injection via field names
const ALLOWED_WORKSPACE_FIELDS = new Set([
  "label",
  "color",
  "folder_path",
  "access_mode",
]);

export function updateWorkspace(
  id: string,
  patch: Partial<{
    label: string;
    color: string;
    folder_path: string | null;
    access_mode: string;
  }>
): Workspace | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_WORKSPACE_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getWorkspace(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getWorkspace(id);
}

export function deleteWorkspace(id: string): void {
  getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

// --- Profiles CRUD ---

export function listProfiles(): Profile[] {
  return getDb()
    .prepare("SELECT * FROM profiles ORDER BY is_default DESC, created_at")
    .all() as Profile[];
}

export function getProfile(id: string): Profile | undefined {
  return getDb()
    .prepare("SELECT * FROM profiles WHERE id = ?")
    .get(id) as Profile | undefined;
}

export function createProfile(data: {
  id: string;
  name: string;
  avatar_color?: string;
  avatar_emoji?: string;
}): Profile {
  getDb()
    .prepare(
      `INSERT INTO profiles (id, name, avatar_color, avatar_emoji)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.name,
      data.avatar_color ?? "blue",
      data.avatar_emoji ?? "👤"
    );
  return getProfile(data.id)!;
}

// Whitelist of allowed profile fields to prevent SQL injection via field names
const ALLOWED_PROFILE_FIELDS = new Set([
  "name",
  "avatar_color",
  "avatar_emoji",
  "is_default",
]);

export function updateProfile(
  id: string,
  patch: Partial<{
    name: string;
    avatar_color: string;
    avatar_emoji: string;
    is_default: number;
  }>
): Profile | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_PROFILE_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getProfile(id);

  values.push(id);

  getDb()
    .prepare(`UPDATE profiles SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getProfile(id);
}

export function deleteProfile(id: string): void {
  getDb().prepare("DELETE FROM profiles WHERE id = ?").run(id);
}

// --- Profile Workspaces ---

export function listProfileWorkspaces(
  profileId: string
): (ProfileWorkspace & { label: string; color: string })[] {
  return getDb()
    .prepare(
      `SELECT pw.profile_id, pw.workspace_id, pw.role, w.label, w.color
       FROM profile_workspaces pw
       JOIN workspaces w ON w.id = pw.workspace_id
       WHERE pw.profile_id = ?
       ORDER BY w.label`
    )
    .all(profileId) as (ProfileWorkspace & { label: string; color: string })[];
}

export function linkProfileWorkspace(
  profileId: string,
  workspaceId: string,
  role: string = "owner"
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO profile_workspaces (profile_id, workspace_id, role)
       VALUES (?, ?, ?)`
    )
    .run(profileId, workspaceId, role);
}

export function unlinkProfileWorkspace(
  profileId: string,
  workspaceId: string
): void {
  getDb()
    .prepare(
      "DELETE FROM profile_workspaces WHERE profile_id = ? AND workspace_id = ?"
    )
    .run(profileId, workspaceId);
}

// --- Profile Integrations ---

export function listProfileIntegrations(
  profileId: string
): ProfileIntegration[] {
  return getDb()
    .prepare(
      "SELECT * FROM profile_integrations WHERE profile_id = ? ORDER BY service"
    )
    .all(profileId) as ProfileIntegration[];
}

export function upsertProfileIntegration(data: {
  id: string;
  profile_id: string;
  service: string;
  account_id?: string | null;
  config?: string;
}): ProfileIntegration {
  getDb()
    .prepare(
      `INSERT INTO profile_integrations (id, profile_id, service, account_id, config)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, service) DO UPDATE SET
         account_id = excluded.account_id,
         config = excluded.config,
         updated_at = datetime('now')`
    )
    .run(
      data.id,
      data.profile_id,
      data.service,
      data.account_id ?? null,
      data.config ?? "{}"
    );
  return getDb()
    .prepare("SELECT * FROM profile_integrations WHERE id = ?")
    .get(data.id) as ProfileIntegration;
}

export function deleteProfileIntegration(id: string): void {
  getDb()
    .prepare("DELETE FROM profile_integrations WHERE id = ?")
    .run(id);
}

// --- Employees ---

export interface Employee {
  id: string;
  name: string;
  role_key: string;
  department: string;
  status: string;
  description: string;
  manager_id: string | null;
  sort_order: number;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export function listEmployees(filters?: {
  workspace_id?: string;
  status?: string;
}): Employee[] {
  let sql = "SELECT * FROM employees WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(filters.workspace_id);
  }
  if (filters?.status) {
    sql += " AND status = ?";
    params.push(filters.status);
  }

  sql += " ORDER BY sort_order ASC, department ASC, name ASC";
  return getDb().prepare(sql).all(...params) as Employee[];
}

export function getEmployee(id: string): Employee | undefined {
  return getDb()
    .prepare("SELECT * FROM employees WHERE id = ?")
    .get(id) as Employee | undefined;
}

export function getEmployeeByRoleKey(params: {
  workspace_id: string;
  role_key: string;
}): Employee | undefined {
  return getDb()
    .prepare("SELECT * FROM employees WHERE workspace_id = ? AND role_key = ?")
    .get(params.workspace_id, params.role_key) as Employee | undefined;
}

export function createEmployee(data: {
  id: string;
  name: string;
  role_key: string;
  department?: string;
  status?: string;
  description?: string;
  manager_id?: string | null;
  sort_order?: number;
  workspace_id: string;
}): Employee {
  getDb()
    .prepare(
      `INSERT INTO employees (id, name, role_key, department, status, description, manager_id, sort_order, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.name,
      data.role_key,
      data.department ?? "operations",
      data.status ?? "active",
      data.description ?? "",
      data.manager_id ?? null,
      data.sort_order ?? 0,
      data.workspace_id
    );
  return getEmployee(data.id)!;
}

const ALLOWED_EMPLOYEE_FIELDS = new Set([
  "name",
  "role_key",
  "department",
  "status",
  "description",
  "manager_id",
  "sort_order",
  "workspace_id",
]);

export function updateEmployee(
  id: string,
  patch: Partial<{
    name: string;
    role_key: string;
    department: string;
    status: string;
    description: string;
    manager_id: string | null;
    sort_order: number;
    workspace_id: string;
  }>
): Employee | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_EMPLOYEE_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getEmployee(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb().prepare(`UPDATE employees SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getEmployee(id);
}

export function deleteEmployee(id: string): void {
  getDb().prepare("DELETE FROM employees WHERE id = ?").run(id);
}

// --- Employee Schedules ---

export interface EmployeeSchedule {
  id: string;
  employee_id: string;
  title: string;
  description: string;
  cron_expression: string;
  timezone: string;
  agent_id: string;
  priority: string;
  category: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export function listEmployeeSchedules(filters?: {
  employee_id?: string;
  workspace_id?: string;
  enabled?: boolean;
}): EmployeeSchedule[] {
  let sql = "SELECT * FROM employee_schedules WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.employee_id) {
    sql += " AND employee_id = ?";
    params.push(filters.employee_id);
  }
  if (filters?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(filters.workspace_id);
  }
  if (filters?.enabled !== undefined) {
    sql += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }

  sql += " ORDER BY created_at DESC";
  return getDb().prepare(sql).all(...params) as EmployeeSchedule[];
}

export function getEmployeeSchedule(id: string): EmployeeSchedule | undefined {
  return getDb()
    .prepare("SELECT * FROM employee_schedules WHERE id = ?")
    .get(id) as EmployeeSchedule | undefined;
}

export function getEmployeeScheduleWithWorkspace(
  id: string,
  workspaceId: string
): EmployeeSchedule | undefined {
  return getDb()
    .prepare("SELECT * FROM employee_schedules WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as EmployeeSchedule | undefined;
}

export function createEmployeeSchedule(data: {
  id: string;
  employee_id: string;
  title: string;
  description?: string;
  cron_expression: string;
  timezone?: string;
  agent_id?: string;
  priority?: string;
  category?: string;
  workspace_id: string;
  next_run_at?: string | null;
}): EmployeeSchedule {
  getDb()
    .prepare(
      `INSERT INTO employee_schedules (id, employee_id, title, description, cron_expression, timezone, agent_id, priority, category, workspace_id, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.employee_id,
      data.title,
      data.description ?? "",
      data.cron_expression,
      data.timezone ?? "Asia/Riyadh",
      data.agent_id ?? "main",
      data.priority ?? "medium",
      data.category ?? "operations",
      data.workspace_id,
      data.next_run_at ?? null
    );
  return getEmployeeSchedule(data.id)!;
}

const ALLOWED_SCHEDULE_FIELDS = new Set([
  "employee_id",
  "title",
  "description",
  "cron_expression",
  "timezone",
  "agent_id",
  "priority",
  "category",
  "enabled",
  "last_run_at",
  "next_run_at",
  "workspace_id",
]);

export function updateEmployeeSchedule(
  id: string,
  patch: Partial<EmployeeSchedule>
): EmployeeSchedule | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_SCHEDULE_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getEmployeeSchedule(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE employee_schedules SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getEmployeeSchedule(id);
}

export function deleteEmployeeSchedule(id: string): void {
  getDb().prepare("DELETE FROM employee_schedules WHERE id = ?").run(id);
}

export function getDueSchedules(): EmployeeSchedule[] {
  return getDb()
    .prepare(
      "SELECT * FROM employee_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= datetime('now')"
    )
    .all() as EmployeeSchedule[];
}

export function markScheduleRun(id: string, lastRunAt: string, nextRunAt: string): void {
  getDb()
    .prepare(
      "UPDATE employee_schedules SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(lastRunAt, nextRunAt, id);
}

// --- Accounts (metadata-only v1; secret storage comes later) ---

export interface Account {
  id: string;
  service: string;
  label: string;
  region: string | null;
  workspace_id: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export function listAccounts(filters?: { workspace_id?: string; service?: string }): Account[] {
  let sql = "SELECT * FROM accounts WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.workspace_id) {
    sql += " AND workspace_id = ?";
    params.push(filters.workspace_id);
  }
  if (filters?.service) {
    sql += " AND service = ?";
    params.push(filters.service);
  }

  sql += " ORDER BY service ASC, label ASC";
  return getDb().prepare(sql).all(...params) as Account[];
}

export function createAccount(data: {
  id: string;
  service: string;
  label: string;
  region?: string | null;
  workspace_id: string;
  notes?: string;
}): Account {
  getDb()
    .prepare(
      `INSERT INTO accounts (id, service, label, region, workspace_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.service,
      data.label,
      data.region ?? null,
      data.workspace_id,
      data.notes ?? ""
    );
  return getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(data.id) as Account;
}

export function upsertEmployeeAccountAccess(data: {
  employee_id: string;
  account_id: string;
  mode: "read" | "draft" | "execute";
  requires_approval: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO employee_account_access (employee_id, account_id, mode, requires_approval)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(employee_id, account_id) DO UPDATE SET
         mode = excluded.mode,
         requires_approval = excluded.requires_approval,
         updated_at = datetime('now')`
    )
    .run(
      data.employee_id,
      data.account_id,
      data.mode,
      data.requires_approval ? 1 : 0
    );
}

export function getEmployeeAccessSummary(workspaceId: string): Record<
  string,
  { accountCount: number; executeCount: number; draftCount: number; readCount: number }
> {
  const rows = getDb()
    .prepare(
      `SELECT e.id as employee_id,
              COUNT(a.id) as accountCount,
              SUM(CASE WHEN x.mode = 'execute' THEN 1 ELSE 0 END) as executeCount,
              SUM(CASE WHEN x.mode = 'draft' THEN 1 ELSE 0 END) as draftCount,
              SUM(CASE WHEN x.mode = 'read' THEN 1 ELSE 0 END) as readCount
       FROM employees e
       LEFT JOIN employee_account_access x ON x.employee_id = e.id
       LEFT JOIN accounts a ON a.id = x.account_id
       WHERE e.workspace_id = ?
       GROUP BY e.id`
    )
    .all(workspaceId) as Array<{
      employee_id: string;
      accountCount: number;
      executeCount: number;
      draftCount: number;
      readCount: number;
    }>;

  const out: Record<string, { accountCount: number; executeCount: number; draftCount: number; readCount: number }> = {};
  for (const r of rows) {
    out[r.employee_id] = {
      accountCount: Number(r.accountCount ?? 0),
      executeCount: Number(r.executeCount ?? 0),
      draftCount: Number(r.draftCount ?? 0),
      readCount: Number(r.readCount ?? 0),
    };
  }
  return out;
}

export interface EmployeeAccountAccessRow {
  employee_id: string;
  account_id: string;
  mode: "read" | "draft" | "execute";
  requires_approval: number;
  service: string;
  label: string;
  region: string | null;
  notes: string;
}

export function listEmployeeAccountAccess(employeeId: string): EmployeeAccountAccessRow[] {
  return getDb()
    .prepare(
      `SELECT x.employee_id, x.account_id, x.mode, x.requires_approval,
              a.service, a.label, a.region, a.notes
       FROM employee_account_access x
       JOIN accounts a ON a.id = x.account_id
       WHERE x.employee_id = ?
       ORDER BY a.service ASC, a.label ASC`
    )
    .all(employeeId) as EmployeeAccountAccessRow[];
}

// --- API Keys ---

export interface ApiKey {
  id: string;
  provider: string;
  label: string;
  api_key_encrypted: string;
  base_url: string | null;
  is_active: number;
  last_tested_at: string | null;
  last_test_status: string | null;
  created_at: string;
  updated_at: string;
}

export function listApiKeys(): ApiKey[] {
  return getDb()
    .prepare("SELECT * FROM api_keys ORDER BY provider ASC, label ASC")
    .all() as ApiKey[];
}

export function getApiKey(id: string): ApiKey | undefined {
  return getDb()
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(id) as ApiKey | undefined;
}

export function createApiKey(data: {
  id: string;
  provider: string;
  label: string;
  api_key_encrypted: string;
  base_url?: string | null;
}): ApiKey {
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, provider, label, api_key_encrypted, base_url)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.provider,
      data.label,
      data.api_key_encrypted,
      data.base_url ?? null
    );
  return getApiKey(data.id)!;
}

const ALLOWED_API_KEY_FIELDS = new Set([
  "label",
  "api_key_encrypted",
  "base_url",
  "is_active",
  "last_tested_at",
  "last_test_status",
]);

export function updateApiKey(
  id: string,
  patch: Partial<{
    label: string;
    api_key_encrypted: string;
    base_url: string | null;
    is_active: number;
    last_tested_at: string;
    last_test_status: string;
  }>
): ApiKey | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_API_KEY_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getApiKey(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getApiKey(id);
}

export function deleteApiKey(id: string): void {
  getDb().prepare("DELETE FROM api_keys WHERE id = ?").run(id);
}

// --- Local Models ---

export interface LocalModel {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  base_url: string;
  is_active: number;
  parameters: string;
  last_health_at: string | null;
  last_health_status: string | null;
  created_at: string;
  updated_at: string;
}

export function listLocalModels(): LocalModel[] {
  return getDb()
    .prepare("SELECT * FROM local_models ORDER BY provider ASC, name ASC")
    .all() as LocalModel[];
}

export function getLocalModel(id: string): LocalModel | undefined {
  return getDb()
    .prepare("SELECT * FROM local_models WHERE id = ?")
    .get(id) as LocalModel | undefined;
}

export function createLocalModel(data: {
  id: string;
  name: string;
  provider?: string;
  model_id: string;
  base_url?: string;
  parameters?: string;
}): LocalModel {
  getDb()
    .prepare(
      `INSERT INTO local_models (id, name, provider, model_id, base_url, parameters)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.name,
      data.provider ?? "ollama",
      data.model_id,
      data.base_url ?? "http://localhost:11434",
      data.parameters ?? "{}"
    );
  return getLocalModel(data.id)!;
}

const ALLOWED_LOCAL_MODEL_FIELDS = new Set([
  "name",
  "model_id",
  "base_url",
  "is_active",
  "parameters",
  "last_health_at",
  "last_health_status",
]);

export function updateLocalModel(
  id: string,
  patch: Partial<{
    name: string;
    model_id: string;
    base_url: string;
    is_active: number;
    parameters: string;
    last_health_at: string;
    last_health_status: string;
  }>
): LocalModel | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && ALLOWED_LOCAL_MODEL_FIELDS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getLocalModel(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE local_models SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getLocalModel(id);
}

export function deleteLocalModel(id: string): void {
  getDb().prepare("DELETE FROM local_models WHERE id = ?").run(id);
}

// --- API Key Credits ---

export interface ApiKeyCredit {
  id: string;
  provider: string;
  balance: number | null;
  currency: string;
  limit_total: number | null;
  usage_total: number | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listCredits(): ApiKeyCredit[] {
  return getDb()
    .prepare("SELECT * FROM api_key_credits ORDER BY provider ASC")
    .all() as ApiKeyCredit[];
}

export function getCredit(provider: string): ApiKeyCredit | undefined {
  return getDb()
    .prepare("SELECT * FROM api_key_credits WHERE provider = ?")
    .get(provider) as ApiKeyCredit | undefined;
}

export function upsertCredit(data: {
  id: string;
  provider: string;
  balance?: number | null;
  currency?: string;
  limit_total?: number | null;
  usage_total?: number | null;
}): ApiKeyCredit {
  const existing = getCredit(data.provider);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE api_key_credits SET
           balance = COALESCE(?, balance),
           currency = COALESCE(?, currency),
           limit_total = COALESCE(?, limit_total),
           usage_total = COALESCE(?, usage_total),
           last_checked_at = datetime('now'),
           updated_at = datetime('now')
         WHERE provider = ?`
      )
      .run(
        data.balance ?? null,
        data.currency ?? null,
        data.limit_total ?? null,
        data.usage_total ?? null,
        data.provider
      );
    return getCredit(data.provider)!;
  }
  getDb()
    .prepare(
      `INSERT INTO api_key_credits (id, provider, balance, currency, limit_total, usage_total, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      data.id,
      data.provider,
      data.balance ?? null,
      data.currency ?? "USD",
      data.limit_total ?? null,
      data.usage_total ?? null
    );
  return getCredit(data.provider)!;
}

export function deleteCredit(provider: string): void {
  getDb().prepare("DELETE FROM api_key_credits WHERE provider = ?").run(provider);
}
