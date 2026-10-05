import {
  normalizeToolParameterSchema,
  ToolSchemaDepthExceededError,
} from "@openclaw/ai/internal/tool-schema";
import { logWarn } from "../logger.js";

/**
 * Normalizes one MCP catalog tool schema while containing depth rejection at
 * the tool boundary: a pathological external schema must not abort
 * materialization of every healthy sibling tool. Returns the original schema
 * for the rejected tool so it stays registered (flagged by a warning) while
 * the runtime view survives.
 */
export function normalizeMcpCatalogSchema(
  meta: { serverName: string; toolName: string },
  inputSchema: unknown,
  kind: "tool" | "App-only tool" = "tool",
): unknown {
  try {
    return normalizeToolParameterSchema(inputSchema);
  } catch (error) {
    if (!(error instanceof ToolSchemaDepthExceededError)) {
      throw error;
    }
    logWarn(
      `bundle-mcp: ${kind} "${meta.toolName}" from server "${meta.serverName}" kept with its original schema: ${error.message}`,
    );
    return inputSchema;
  }
}
