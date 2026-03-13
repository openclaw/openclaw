import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { query } from "./db.js";

type DbConfig = { databaseUrl?: string; maxPoolSize?: number };

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

export function createSaveEngineeringTaskTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "save_engineering_task",
    label: "Save Engineering Task",
    description: "Persist an engineering task linked to an approved product spec.",
    parameters: Type.Object({
      title: Type.String(),
      product_spec_id: Type.Optional(Type.Number()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String({ description: "critical, high, medium, low" })),
      task_type: Type.Optional(Type.String({ description: "feature, infra, api, schema, test, docs, devops" })),
      sequence_order: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        `INSERT INTO engineering_tasks (title, product_spec_id, description, priority, task_type, sequence_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, status, created_at`,
        [
          params.title,
          params.product_spec_id ?? null,
          params.description ?? "",
          params.priority ?? "medium",
          params.task_type ?? "feature",
          params.sequence_order ?? 0,
        ],
        dbConfig,
      );
      const row = result.rows[0];
      return textResult(`Task saved: id=${row?.id}, title="${row?.title}"`, row);
    },
  };
}

export function createGetEngineeringTasksTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "get_engineering_tasks",
    label: "Get Engineering Tasks",
    description: "Retrieve engineering tasks filtered by status and/or product spec.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "planned, in_progress, blocked, completed" })),
      product_spec_id: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : null;
      const specId = typeof params.product_spec_id === "number" ? params.product_spec_id : null;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 100) : 20;

      const conditions: string[] = [];
      const sqlParams: unknown[] = [];
      let paramIdx = 1;

      if (status) {
        conditions.push(`status = $${paramIdx++}`);
        sqlParams.push(status);
      }
      if (specId !== null) {
        conditions.push(`product_spec_id = $${paramIdx++}`);
        sqlParams.push(specId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      sqlParams.push(limit);
      const sql = `SELECT * FROM engineering_tasks ${where} ORDER BY sequence_order, created_at LIMIT $${paramIdx}`;
      const result = await query(sql, sqlParams, dbConfig);
      return textResult(JSON.stringify(result.rows, null, 2), { count: result.rowCount });
    },
  };
}

export function createUpdateTaskStatusTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "update_task_status",
    label: "Update Task Status",
    description: "Update the status of an engineering task by ID.",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.String({ description: "planned, in_progress, blocked, or completed" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        "UPDATE engineering_tasks SET status = $1 WHERE id = $2 RETURNING id, title, status",
        [params.status, params.id],
        dbConfig,
      );
      if (result.rowCount === 0) {
        return textResult(`No task found with id=${params.id}`);
      }
      const row = result.rows[0];
      return textResult(`Task ${row?.id} status updated to "${row?.status}"`, row);
    },
  };
}
