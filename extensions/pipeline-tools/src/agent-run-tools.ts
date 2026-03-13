import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { query } from "./db.js";

type DbConfig = { databaseUrl?: string; maxPoolSize?: number };

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

export function createLogAgentRunTool(dbConfig: DbConfig): AnyAgentTool {
  return {
    name: "log_agent_run",
    label: "Log Agent Run",
    description: "Record an agent execution event for audit and lineage tracking.",
    parameters: Type.Object({
      agent_name: Type.String(),
      input_ref_type: Type.Optional(Type.String({ description: "Table name of the input record (trends, ideas, etc.)." })),
      input_ref_id: Type.Optional(Type.Number()),
      output_ref_type: Type.Optional(Type.String()),
      output_ref_id: Type.Optional(Type.Number()),
      summary: Type.Optional(Type.String()),
      status: Type.Optional(Type.String({ description: "running, completed, or failed" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const status = typeof params.status === "string" ? params.status : "completed";
      const result = await query(
        `INSERT INTO agent_runs (agent_name, input_ref_type, input_ref_id, output_ref_type, output_ref_id, summary, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 != 'running' THEN NOW() ELSE NULL END)
         RETURNING id, agent_name, status`,
        [
          params.agent_name,
          params.input_ref_type ?? null,
          params.input_ref_id ?? null,
          params.output_ref_type ?? null,
          params.output_ref_id ?? null,
          params.summary ?? null,
          status,
        ],
        dbConfig,
      );
      const row = result.rows[0];
      return textResult(`Agent run logged: id=${row?.id}, agent=${row?.agent_name}`, row);
    },
  };
}
