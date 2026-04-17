import type { OpenClawPluginApi } from "../api.js";
import { jsonResult } from "../api.js";
import { executeQuery, resolveConfig } from "./mysql-client.js";
import { Type } from "@sinclair/typebox";

/** Tables allowed in QueryDatabase tool queries */
const ALLOWED_TABLES = new Set(["feed_monitor_item", "feed_monitor_item_data"]);

/** Dangerous SQL patterns that must never appear */
const DANGEROUS_PATTERNS = [
  /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i,
  /\bALTER\b/i, /\bCREATE\b/i, /\bTRUNCATE\b/i, /\bUNION\b/i,
  /\bGRANT\b/i, /\bREVOKE\b/i, /\bEXEC\b/i, /\bEXECUTE\b/i,
  /\bLOAD_FILE\b/i, /\bINTO\s+OUTFILE\b/i, /\bINTO\s+DUMPFILE\b/i,
  /\bBENCHMARK\b/i, /\bSLEEP\b/i, /\bWAITFOR\s+DELAY\b/i,
];

/**
 * Check that all tables referenced in a SQL query belong to the whitelist.
 */
function extractAndValidateTables(sql: string): { valid: boolean; tables: string[] } {
  const fromTables = [...sql.matchAll(/\bFROM\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  const joinTables = [...sql.matchAll(/\bJOIN\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  const tables = [...new Set([...fromTables, ...joinTables])];

  if (tables.length === 0) {
    return { valid: false, tables };
  }

  const allAllowed = tables.every((t) => ALLOWED_TABLES.has(t));
  return { valid: true, tables: allAllowed ? tables : [] };
}

/**
 * Register the QueryDatabase tool with the OpenClaw plugin API.
 * This tool allows the agent to execute read-only SELECT queries on allowed tables.
 */
export function registerFeedSearchTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "QueryDatabase",
      label: "Query Database",
      description:
        "Execute read-only SQL queries on allowed database tables " +
        "(feed_monitor_item, feed_monitor_item_data). Only SELECT queries are permitted.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "SQL SELECT query to execute. Only SELECT queries on feed_monitor_item or feed_monitor_item_data tables are allowed.",
        }),
      }),
      async execute(_toolCallId: string, params: { query: string }) {
        const sql = params.query.trim();
        const sqlUpper = sql.toUpperCase();

        // 1. Must be SELECT
        if (!sqlUpper.startsWith("SELECT")) {
          return jsonResult({ error: "Only SELECT queries are allowed." });
        }

        // 2. Table whitelist
        const { valid, tables } = extractAndValidateTables(sql);
        if (!valid || tables.length === 0) {
          return jsonResult({
            error: `Only feed_monitor_item and feed_monitor_item_data tables are allowed. Found: ${tables.join(", ")}`,
          });
        }

        // 3. Dangerous keyword check
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(sqlUpper)) {
            return jsonResult({ error: `Dangerous SQL pattern detected: ${pattern.source}` });
          }
        }

        try {
          const config = resolveConfig(api.pluginConfig as Record<string, unknown>);
          const rows = await executeQuery<Record<string, unknown>[]>(config, sql);
          return jsonResult({ rows, count: rows.length });
        } catch (error) {
          return jsonResult({ error: `Query execution failed: ${String(error)}` });
        }
      },
    },
    { name: "QueryDatabase" },
  );
}
