/**
 * Tool Bridge — Converts between OpenClaw tool definitions and runtime-specific formats.
 *
 * OpenClaw tools use pi-agent's TypeBox-based `AgentTool` format.
 * The Claude Agent SDK uses MCP tools with Zod schemas.
 * This bridge handles conversion in both directions.
 */

import type { RuntimeToolDefinition, RuntimeToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// From pi-agent AgentTool → RuntimeToolDefinition
// ---------------------------------------------------------------------------

/**
 * Convert a pi-agent `AgentTool` to the abstract `RuntimeToolDefinition`.
 *
 * Accepts the tool as `unknown` to avoid importing pi-agent types directly.
 * Expects the tool to have: name, label, description, parameters (TypeBox schema), execute.
 */
export function fromPiAgentTool(tool: unknown): RuntimeToolDefinition {
  const t = tool as {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (partial: unknown) => void,
    ) => Promise<unknown>;
  };

  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameterSchema: typeboxToJsonSchema(t.parameters),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await t.execute(
        toolCallId,
        params,
        signal,
        onUpdate
          ? (partial: unknown) => {
              onUpdate(normalizeToolResult(partial));
            }
          : undefined,
      );
      return normalizeToolResult(result);
    },
  };
}

/**
 * Convert a batch of pi-agent tools to RuntimeToolDefinitions.
 */
export function fromPiAgentTools(tools: unknown[]): RuntimeToolDefinition[] {
  return tools.map(fromPiAgentTool);
}

// ---------------------------------------------------------------------------
// To Claude Agent SDK MCP tool format
// ---------------------------------------------------------------------------

/**
 * Convert a RuntimeToolDefinition to the shape expected by `createSdkMcpServer`.
 *
 * Returns a plain object with `name`, `description`, `inputSchema` (as a Zod-like shape),
 * and `handler`.
 *
 * Note: The Claude Agent SDK's `createSdkMcpServer` expects Zod schemas for inputSchema.
 * Since we have JSON Schema from TypeBox, we use a passthrough approach:
 * the MCP protocol uses JSON Schema natively, so we define a "raw JSON Schema" tool.
 */
export function toClaudeSdkMcpTool(tool: RuntimeToolDefinition): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameterSchema,
    handler: async (args) => {
      const result = await tool.execute(
        `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        args,
      );
      return {
        content: result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => ({ type: "text" as const, text: c.text })),
        isError: result.isError,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a TypeBox schema to JSON Schema.
 * TypeBox schemas ARE JSON Schema (by design), so this is mostly a passthrough.
 * We just strip TypeBox-specific metadata keys.
 */
function typeboxToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const s = schema as Record<string, unknown>;
  // TypeBox schemas are already JSON Schema compliant.
  // Remove internal TypeBox keys that aren't part of JSON Schema.
  const { [Symbol.for("TypeBox.Kind") as unknown as string]: _kind, ...rest } = s;
  return rest as Record<string, unknown>;
}

/**
 * Normalize a pi-agent tool result to RuntimeToolResult.
 */
function normalizeToolResult(result: unknown): RuntimeToolResult {
  if (!result || typeof result !== "object") {
    const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
    return { content: [{ type: "text", text }] };
  }

  const r = result as {
    content?: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
    details?: unknown;
    isError?: boolean;
  };

  if (!r.content || !Array.isArray(r.content)) {
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: r.details };
  }

  return {
    content: r.content.map((c) => {
      if (c.type === "image" && c.data && c.mediaType) {
        return { type: "image" as const, mediaType: c.mediaType, data: c.data };
      }
      return { type: "text" as const, text: c.text ?? "" };
    }),
    details: r.details,
    isError: r.isError,
  };
}
