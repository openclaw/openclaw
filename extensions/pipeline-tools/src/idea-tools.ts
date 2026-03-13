import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { query } from "./db.js";

type DbConfig = { databaseUrl?: string; maxPoolSize?: number };

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

export function createSaveIdeaTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "save_idea",
    label: "Save Idea",
    description: "Persist a new product/app idea linked to an optional trend.",
    parameters: Type.Object({
      title: Type.String(),
      pitch: Type.String(),
      trend_id: Type.Optional(Type.Number({ description: "Link to a trend record." })),
      target_user: Type.Optional(Type.String()),
      problem: Type.Optional(Type.String()),
      why_now: Type.Optional(Type.String()),
      monetization: Type.Optional(Type.String()),
      opportunity_score: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        `INSERT INTO ideas (title, pitch, trend_id, target_user, problem, why_now, monetization, opportunity_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, status, created_at`,
        [
          params.title,
          params.pitch ?? "",
          params.trend_id ?? null,
          params.target_user ?? null,
          params.problem ?? null,
          params.why_now ?? null,
          params.monetization ?? null,
          params.opportunity_score ?? null,
        ],
        dbConfig,
      );
      const row = result.rows[0];
      return textResult(`Idea saved: id=${row?.id}, title="${row?.title}"`, row);
    },
  };
}

export function createGetIdeasTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "get_ideas",
    label: "Get Ideas",
    description: "Retrieve ideas filtered by status. Default returns generated ideas for review.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "generated, shortlisted, selected, rejected" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : null;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 100) : 20;
      const sql = status
        ? "SELECT * FROM ideas WHERE status = $1 ORDER BY created_at DESC LIMIT $2"
        : "SELECT * FROM ideas ORDER BY created_at DESC LIMIT $1";
      const sqlParams = status ? [status, limit] : [limit];
      const result = await query(sql, sqlParams, dbConfig);
      return textResult(JSON.stringify(result.rows, null, 2), { count: result.rowCount });
    },
  };
}

export function createUpdateIdeaStatusTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "update_idea_status",
    label: "Update Idea Status",
    description: "Update the status of an idea by ID.",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.String({ description: "generated, shortlisted, selected, or rejected" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        "UPDATE ideas SET status = $1 WHERE id = $2 RETURNING id, title, status",
        [params.status, params.id],
        dbConfig,
      );
      if (result.rowCount === 0) {
        return textResult(`No idea found with id=${params.id}`);
      }
      const row = result.rows[0];
      return textResult(`Idea ${row?.id} status updated to "${row?.status}"`, row);
    },
  };
}
