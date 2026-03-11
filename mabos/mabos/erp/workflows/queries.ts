import type { PgClient } from "../db/postgres.js";

/* ── Workflows ──────────────────────────────────────────────────────── */

export async function createWorkflow(
  pg: PgClient,
  params: {
    name: string;
    description?: string | null;
    trigger: string;
    steps: Array<{
      order: number;
      action: string;
      config: Record<string, unknown>;
    }>;
    status?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.workflows (name, description, trigger, steps, status, version)
     VALUES ($1, $2, $3, $4, $5, 1)
     RETURNING *`,
    [
      params.name,
      params.description ?? null,
      params.trigger,
      JSON.stringify(params.steps),
      params.status ?? "active",
    ],
  );
  return result.rows[0];
}

export async function getWorkflow(pg: PgClient, id: string) {
  const result = await pg.query(`SELECT * FROM erp.workflows WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listWorkflows(
  pg: PgClient,
  params: { status?: string; trigger?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.trigger) {
    conditions.push(`trigger = $${idx++}`);
    values.push(params.trigger);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;

  const result = await pg.query(
    `SELECT * FROM erp.workflows ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, limit],
  );
  return result.rows;
}

export async function updateWorkflow(
  pg: PgClient,
  id: string,
  params: {
    name?: string;
    description?: string | null;
    trigger?: string;
    steps?: Array<{
      order: number;
      action: string;
      config: Record<string, unknown>;
    }>;
    status?: string;
  },
) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(params.name);
  }
  if (params.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(params.description);
  }
  if (params.trigger !== undefined) {
    sets.push(`trigger = $${idx++}`);
    values.push(params.trigger);
  }
  if (params.steps !== undefined) {
    sets.push(`steps = $${idx++}`);
    values.push(JSON.stringify(params.steps));
  }
  if (params.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(params.status);
  }

  if (sets.length === 0) return getWorkflow(pg, id);

  /* Always bump version on update */
  sets.push(`version = version + 1`);

  const result = await pg.query(
    `UPDATE erp.workflows SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    [...values, id],
  );
  return result.rows[0] ?? null;
}

/* ── Workflow Runs ──────────────────────────────────────────────────── */

export async function createRun(
  pg: PgClient,
  params: { workflow_id: string; context?: Record<string, unknown> },
) {
  const result = await pg.query(
    `INSERT INTO erp.workflow_runs
       (workflow_id, status, started_at, current_step, context)
     VALUES ($1, 'running', now(), 0, $2)
     RETURNING *`,
    [params.workflow_id, JSON.stringify(params.context ?? {})],
  );
  return result.rows[0];
}

export async function getRun(pg: PgClient, id: string) {
  const result = await pg.query(`SELECT * FROM erp.workflow_runs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listRuns(
  pg: PgClient,
  params: { workflow_id?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.workflow_id) {
    conditions.push(`workflow_id = $${idx++}`);
    values.push(params.workflow_id);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;

  const result = await pg.query(
    `SELECT * FROM erp.workflow_runs ${where} ORDER BY started_at DESC LIMIT $${idx}`,
    [...values, limit],
  );
  return result.rows;
}

export async function advanceStep(pg: PgClient, runId: string) {
  /* Fetch the run and its parent workflow to check total steps */
  const run = await getRun(pg, runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const workflow = await getWorkflow(pg, run.workflow_id);
  if (!workflow) throw new Error(`Workflow ${run.workflow_id} not found`);

  const nextStep = (run.current_step ?? 0) + 1;
  const totalSteps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;

  if (nextStep >= totalSteps) {
    /* All steps completed */
    return completeRun(pg, runId);
  }

  const result = await pg.query(
    `UPDATE erp.workflow_runs
     SET current_step = current_step + 1
     WHERE id = $1
     RETURNING *`,
    [runId],
  );
  return result.rows[0];
}

export async function failRun(pg: PgClient, runId: string, error: string) {
  const result = await pg.query(
    `UPDATE erp.workflow_runs
     SET status = 'failed', error = $2
     WHERE id = $1
     RETURNING *`,
    [runId, error],
  );
  return result.rows[0] ?? null;
}

export async function completeRun(pg: PgClient, runId: string) {
  const result = await pg.query(
    `UPDATE erp.workflow_runs
     SET status = 'completed', completed_at = now()
     WHERE id = $1
     RETURNING *`,
    [runId],
  );
  return result.rows[0] ?? null;
}
