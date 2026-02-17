/**
 * Converts openclaw's custom AgentTool instances into an in-process MCP server
 * compatible with the claude-agent-sdk's `mcpServers` option.
 *
 * Only non-built-in tools (messaging, browser, canvas, cron, etc.) are wrapped.
 * The SDK's own built-in tools (Read, Write, Edit, Bash, Glob, Grep) are used
 * directly and intercepted via hooks for sandbox/policy enforcement.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { isSdkBuiltinTool } from "./types.js";

/**
 * Convert a JSON Schema `properties` object into a Zod shape.
 *
 * We use `z.any()` for each property because the JSON Schema coming from
 * TypeBox is arbitrarily complex (unions, enums, nested objects). The MCP
 * layer validates the schema server-side; we just need a Zod shape to
 * satisfy the `tool()` type signature.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown> | undefined,
): Record<string, z.ZodType> {
  if (!schema || typeof schema !== "object") {
    return {};
  }
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const required = new Set(
    Array.isArray((schema as { required?: unknown[] }).required)
      ? (schema as { required: string[] }).required
      : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const key of Object.keys(properties)) {
    shape[key] = required.has(key) ? z.any() : z.any().optional();
  }
  return shape;
}

/**
 * Extract text from an AgentToolResult's content array.
 */
function extractTextFromResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "(no output)";
  }
  const r = result as { content?: unknown[]; details?: unknown };
  if (!Array.isArray(r.content)) {
    // Fall back to stringifying details if present
    if (r.details != null) {
      return typeof r.details === "string" ? r.details : JSON.stringify(r.details, null, 2);
    }
    return "(no output)";
  }
  const texts: string[] = [];
  for (const block of r.content) {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as { type: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
  }
  return texts.join("\n") || "(no output)";
}

/**
 * Build an in-process MCP server from a list of openclaw AgentTool instances.
 * Only custom tools (not SDK built-ins) are included.
 */
export function buildOpenClawMcpServer(tools: AnyAgentTool[]): McpSdkServerConfigWithInstance {
  const customTools = tools.filter((t) => !isSdkBuiltinTool(t.name));

  const mcpTools = customTools.map((agentTool) => {
    const shape = jsonSchemaToZodShape(agentTool.parameters as Record<string, unknown>);

    return tool(
      agentTool.name,
      agentTool.description ?? `OpenClaw tool: ${agentTool.name}`,
      shape,
      async (args) => {
        try {
          const toolCallId = crypto.randomUUID();
          const result = await agentTool.execute(toolCallId, args, undefined, undefined);
          const text = extractTextFromResult(result);
          return {
            content: [{ type: "text" as const, text }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  });

  return createSdkMcpServer({
    name: "openclaw",
    version: "1.0.0",
    tools: mcpTools,
  });
}
