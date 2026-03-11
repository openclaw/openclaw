import type { PgClient } from "../db/postgres.js";

export async function createProject(
  pg: PgClient,
  params: {
    name: string;
    description?: string;
    status?: string;
    priority?: number;
    budget?: number;
    start_date?: string;
    end_date?: string;
    owner_id?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.projects (id, name, description, status, priority, budget, start_date, end_date, owner_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      params.name,
      params.description ?? null,
      params.status ?? "draft",
      params.priority ?? 0,
      params.budget ?? null,
      params.start_date ?? null,
      params.end_date ?? null,
      params.owner_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function getProject(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.projects WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listProjects(
  pg: PgClient,
  params: { status?: string; owner_id?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.owner_id) {
    conditions.push(`owner_id = $${idx++}`);
    values.push(params.owner_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.projects ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateProject(pg: PgClient, id: string, params: Record<string, unknown>) {
  const allowed = [
    "name",
    "description",
    "status",
    "priority",
    "budget",
    "start_date",
    "end_date",
    "owner_id",
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in params) {
      sets.push(`${key} = $${idx++}`);
      values.push(params[key]);
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(id);
  const result = await pg.query(
    `UPDATE erp.projects SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function createTask(
  pg: PgClient,
  params: {
    project_id: string;
    title: string;
    description?: string;
    status?: string;
    priority?: number;
    assignee_id?: string;
    due_date?: string;
    estimated_hours?: number;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.tasks (id, project_id, title, description, status, priority, assignee_id, due_date, estimated_hours)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      params.project_id,
      params.title,
      params.description ?? null,
      params.status ?? "todo",
      params.priority ?? 0,
      params.assignee_id ?? null,
      params.due_date ?? null,
      params.estimated_hours ?? null,
    ],
  );
  return result.rows[0];
}

export async function getTask(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.tasks WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listTasks(
  pg: PgClient,
  params: { project_id?: string; status?: string; assignee_id?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.project_id) {
    conditions.push(`project_id = $${idx++}`);
    values.push(params.project_id);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.assignee_id) {
    conditions.push(`assignee_id = $${idx++}`);
    values.push(params.assignee_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.tasks ${where} ORDER BY priority DESC, created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateTask(pg: PgClient, id: string, params: Record<string, unknown>) {
  const allowed = [
    "title",
    "description",
    "status",
    "priority",
    "assignee_id",
    "due_date",
    "estimated_hours",
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in params) {
      sets.push(`${key} = $${idx++}`);
      values.push(params[key]);
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(id);
  const result = await pg.query(
    `UPDATE erp.tasks SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function createMilestone(
  pg: PgClient,
  params: {
    project_id: string;
    title: string;
    due_date?: string;
    status?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.milestones (id, project_id, title, due_date, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING *`,
    [params.project_id, params.title, params.due_date ?? null, params.status ?? "pending"],
  );
  return result.rows[0];
}

export async function listMilestones(pg: PgClient, projectId: string) {
  const result = await pg.query(
    "SELECT * FROM erp.milestones WHERE project_id = $1 ORDER BY due_date ASC NULLS LAST",
    [projectId],
  );
  return result.rows;
}

export async function completeMilestone(pg: PgClient, id: string) {
  const result = await pg.query(
    `UPDATE erp.milestones SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}
