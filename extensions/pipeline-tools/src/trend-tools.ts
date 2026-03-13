import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { query } from "./db.js";

type DbConfig = { databaseUrl?: string; maxPoolSize?: number };

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

export function createSaveTrendTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "save_trend",
    label: "Save Trend",
    description: "Persist a new trend record to the pipeline database.",
    parameters: Type.Object({
      title: Type.String(),
      summary: Type.String(),
      source_type: Type.Optional(Type.String()),
      source_ref: Type.Optional(Type.String()),
      why_it_matters: Type.Optional(Type.String()),
      confidence_score: Type.Optional(Type.Number()),
      novelty_score: Type.Optional(Type.Number()),
      momentum_score: Type.Optional(Type.Number()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        `INSERT INTO trends (title, summary, source_type, source_ref, why_it_matters,
         confidence_score, novelty_score, momentum_score, tags_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, title, status, created_at`,
        [
          params.title,
          params.summary ?? "",
          params.source_type ?? "manual",
          params.source_ref ?? null,
          params.why_it_matters ?? null,
          params.confidence_score ?? null,
          params.novelty_score ?? null,
          params.momentum_score ?? null,
          JSON.stringify(params.tags ?? []),
        ],
        dbConfig,
      );
      const row = result.rows[0];
      return textResult(`Trend saved: id=${row?.id}, title="${row?.title}"`, row);
    },
  };
}

export function createGetTrendsTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "get_trends",
    label: "Get Trends",
    description: "Retrieve trends filtered by status. Returns up to `limit` records ordered by detected_at DESC.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status (new, reviewed, used, archived). Omit for all." })),
      limit: Type.Optional(Type.Number({ description: "Max rows to return (default 20)." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : null;
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 100) : 20;
      const sql = status
        ? "SELECT * FROM trends WHERE status = $1 ORDER BY detected_at DESC LIMIT $2"
        : "SELECT * FROM trends ORDER BY detected_at DESC LIMIT $1";
      const sqlParams = status ? [status, limit] : [limit];
      const result = await query(sql, sqlParams, dbConfig);
      return textResult(JSON.stringify(result.rows, null, 2), { count: result.rowCount });
    },
  };
}

export function createUpdateTrendStatusTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "update_trend_status",
    label: "Update Trend Status",
    description: "Update the status of a trend by ID.",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.String({ description: "new, reviewed, used, or archived" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const result = await query(
        "UPDATE trends SET status = $1 WHERE id = $2 RETURNING id, title, status",
        [params.status, params.id],
        dbConfig,
      );
      if (result.rowCount === 0) {
        return textResult(`No trend found with id=${params.id}`);
      }
      const row = result.rows[0];
      return textResult(`Trend ${row?.id} status updated to "${row?.status}"`, row);
    },
  };
}
