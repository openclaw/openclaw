import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { query } from "./db.js";

type DbConfig = { databaseUrl?: string; maxPoolSize?: number };

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

export function createSaveProductSpecTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "save_product_spec",
    label: "Save Product Spec",
    description: "Persist a product specification linked to a selected idea.",
    parameters: Type.Object({
      title: Type.String(),
      idea_id: Type.Optional(Type.Number()),
      problem_statement: Type.Optional(Type.String()),
      solution_summary: Type.Optional(Type.String()),
      target_user: Type.Optional(Type.String()),
      mvp_scope: Type.Optional(Type.String()),
      features: Type.Optional(Type.Array(Type.String())),
      non_goals: Type.Optional(Type.Array(Type.String())),
      architecture: Type.Optional(Type.Unknown()),
      risks: Type.Optional(Type.Array(Type.String())),
      rollout_phases: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        `INSERT INTO product_specs
         (title, idea_id, problem_statement, solution_summary, target_user, mvp_scope,
          features_json, non_goals_json, architecture_json, risks_json, rollout_phases_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, title, status, created_at`,
        [
          params.title,
          params.idea_id ?? null,
          params.problem_statement ?? null,
          params.solution_summary ?? null,
          params.target_user ?? null,
          params.mvp_scope ?? null,
          JSON.stringify(params.features ?? []),
          JSON.stringify(params.non_goals ?? []),
          JSON.stringify(params.architecture ?? {}),
          JSON.stringify(params.risks ?? []),
          JSON.stringify(params.rollout_phases ?? []),
        ],
        dbConfig,
      );
      const row = result.rows[0];
      return textResult(`Product spec saved: id=${row?.id}, title="${row?.title}"`, row);
    },
  };
}

export function createGetProductSpecsTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "get_product_specs",
    label: "Get Product Specs",
    description: "Retrieve product specs filtered by status.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "drafted, approved, ready_for_engineering, archived" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : null;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 100) : 20;
      const sql = status
        ? "SELECT * FROM product_specs WHERE status = $1 ORDER BY created_at DESC LIMIT $2"
        : "SELECT * FROM product_specs ORDER BY created_at DESC LIMIT $1";
      const sqlParams = status ? [status, limit] : [limit];
      const result = await query(sql, sqlParams, dbConfig);
      return textResult(JSON.stringify(result.rows, null, 2), { count: result.rowCount });
    },
  };
}

export function createUpdateSpecStatusTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "update_spec_status",
    label: "Update Spec Status",
    description: "Update the status of a product spec by ID.",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.String({ description: "drafted, approved, ready_for_engineering, or archived" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        "UPDATE product_specs SET status = $1 WHERE id = $2 RETURNING id, title, status",
        [params.status, params.id],
        dbConfig,
      );
      if (result.rowCount === 0) {
        return textResult(`No product spec found with id=${params.id}`);
      }
      const row = result.rows[0];
      return textResult(`Spec ${row?.id} status updated to "${row?.status}"`, row);
    },
  };
}
