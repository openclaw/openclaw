import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import type { AnyAgentTool, OpenClawPluginApi } from "../../runtime-api.js";
import { createDatabricksSqlClient } from "../client.js";
import { resolveDatabricksRuntimeConfig } from "../config.js";
import { DatabricksPolicyError } from "../errors.js";
import { logDatabricks } from "../logger.js";
import { assertAllowlistTarget, assertReadOnlySqlStatement } from "../security-policy.js";
import { resolveSqlTargets } from "../sql-target-resolution.js";

const DatabricksReadOnlySqlToolSchema = Type.Object(
  {
    sql: Type.String({
      description: "Single read-only SQL statement. Only SELECT or WITH ... SELECT are allowed.",
      minLength: 1,
    }),
    warehouse_id: Type.Optional(
      Type.String({
        description: "Optional warehouse override. Defaults to plugin config warehouseId.",
      }),
    ),
    catalog: Type.Optional(
      Type.String({
        description: "Optional catalog override used during SQL statement execution.",
      }),
    ),
    schema: Type.Optional(
      Type.String({
        description: "Optional schema override used during SQL statement execution.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({
        description: "Per-call timeout override in milliseconds (1000-120000).",
        minimum: 1000,
        maximum: 120000,
      }),
    ),
  },
  { additionalProperties: false },
);

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createDatabricksSqlReadOnlyTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "databricks_sql_readonly",
    label: "Databricks SQL Read-Only",
    description:
      "Execute a single read-only Databricks SQL statement. This runtime only supports SELECT and WITH ... SELECT.",
    parameters: DatabricksReadOnlySqlToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const sql = readStringParam(rawParams, "sql", { required: true });
      const warehouseOverride = normalizeOptionalString(readStringParam(rawParams, "warehouse_id"));
      const catalog = normalizeOptionalString(readStringParam(rawParams, "catalog"));
      const schema = normalizeOptionalString(readStringParam(rawParams, "schema"));
      const timeoutOverride = readNumberParam(rawParams, "timeout_ms", { integer: true });

      const config = resolveDatabricksRuntimeConfig({
        rawConfig: api.pluginConfig,
        config: api.config,
      });
      if (!config.readOnly) {
        throw new DatabricksPolicyError(
          "Databricks plugin is running in non-read-only mode, but this iteration only supports readOnly=true.",
        );
      }

      const safeSql = assertReadOnlySqlStatement(sql);
      const resolution = resolveSqlTargets(safeSql);
      assertAllowlistTarget({
        allowedCatalogs: config.allowedCatalogs,
        allowedSchemas: config.allowedSchemas,
        targets: resolution.targets,
        ambiguousTargets: resolution.ambiguous,
      });

      const client = createDatabricksSqlClient({
        config: {
          ...config,
          ...(typeof timeoutOverride === "number" ? { timeoutMs: timeoutOverride } : {}),
        },
        logger: api.logger,
      });

      const startedAt = Date.now();
      const payload = await client.executeStatement({
        statement: safeSql,
        warehouseId: warehouseOverride ?? config.warehouseId,
        catalog,
        schema,
      });
      const tookMs = Date.now() - startedAt;
      logDatabricks(api.logger, "info", "Executed read-only Databricks SQL statement.", {
        tookMs,
        warehouseId: warehouseOverride ?? config.warehouseId,
      });

      return jsonResult({
        provider: "databricks",
        mode: "read-only",
        tookMs,
        request: {
          warehouseId: warehouseOverride ?? config.warehouseId,
          catalog,
          schema,
        },
        sqlTargets: resolution.targets,
        response: payload,
      });
    },
  };
}
