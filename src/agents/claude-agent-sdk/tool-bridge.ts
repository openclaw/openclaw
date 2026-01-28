/**
 * Bridge between Clawdbrain tools (AnyAgentTool) and the Claude Agent SDK's
 * MCP-based custom tool system.
 *
 * This module is pure facade/adapter code — no business logic is duplicated.
 * Each Clawdbrain tool's `execute()` function is called as-is; the bridge only
 * converts schemas, argument shapes, and result formats.
 *
 * Usage:
 * ```ts
 * const mcpConfig = await bridgeClawdbrainToolsToMcpServer({
 *   name: "clawdbrain",
 *   tools: myClawdbrainTools,
 * });
 * // Pass to SDK query():
 * query({ prompt, options: { mcpServers: { clawdbrain: mcpConfig } } })
 * ```
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import * as z from "zod/v4";

import { logDebug, logError } from "../../logger.js";
import { normalizeToolName } from "../tool-policy.js";
import type { AnyAgentTool } from "../tools/common.js";
import type {
  McpCallToolResult,
  McpContentBlock,
  McpSdkServerConfig,
  McpServerConstructor,
  McpServerLike,
  McpToolHandlerExtra,
} from "./tool-bridge.types.js";

// ---------------------------------------------------------------------------
// Schema conversion: TypeBox → JSON Schema (passthrough)
// ---------------------------------------------------------------------------

/**
 * Extract a clean JSON Schema object from a TypeBox schema.
 *
 * TypeBox schemas *are* JSON Schema objects, but they carry internal Symbol
 * metadata and potentially circular references. A JSON round-trip strips those
 * cleanly. We also ensure a sensible fallback for tools with no schema.
 */
export function extractJsonSchema(tool: AnyAgentTool): Record<string, unknown> {
  const schema = tool.parameters;
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    // Schema is not serializable (shouldn't happen with TypeBox, but be safe).
    logDebug(`tool-bridge: schema for "${tool.name}" is not JSON-serializable, using empty schema`);
    return { type: "object", properties: {} };
  }
}

// ---------------------------------------------------------------------------
// Result conversion: AgentToolResult → McpCallToolResult
// ---------------------------------------------------------------------------

/**
 * Convert a Clawdbrain `AgentToolResult` to an MCP `CallToolResult`.
 *
 * Content block shapes are nearly identical between the two systems.
 * The main differences handled:
 * - `tool_error` blocks → text + `isError: true`
 * - `details` metadata → serialized as a `<tool-details>` text block
 * - Empty results → "(no output)" fallback
 */
export function convertToolResult(result: AgentToolResult<unknown>): McpCallToolResult {
  const content: McpContentBlock[] = [];
  let isError = false;

  for (const block of result.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: (block as { text: string }).text });
        break;
      case "image":
        content.push({
          type: "image",
          data: (block as { data: string }).data,
          mimeType: (block as { mimeType: string }).mimeType,
        });
        break;
      default: {
        // Handle tool_error or any other block type with an 'error' field.
        const maybeError = block as { type: string; error?: string; text?: string };
        if (maybeError.type === "tool_error" || maybeError.error) {
          const errorText = maybeError.error ?? maybeError.text ?? "Unknown tool error";
          content.push({ type: "text", text: errorText });
          isError = true;
        } else if (maybeError.text) {
          // Fallback: treat any block with a text field as text content.
          content.push({ type: "text", text: maybeError.text });
        }
      }
    }
  }

  // Serialize `details` as an additional text block when present.
  // The model benefits from structured metadata; we use an XML tag
  // wrapper so it's easy to parse and doesn't pollute the main output.
  if (result.details !== undefined && result.details !== null) {
    try {
      const serialized = JSON.stringify(result.details, null, 2);
      content.push({
        type: "text",
        text: `<tool-details>\n${serialized}\n</tool-details>`,
      });
    } catch {
      // details not serializable — skip
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "(no output)" });
  }

  return isError ? { content, isError: true } : { content };
}

// ---------------------------------------------------------------------------
// Handler wrapping: AnyAgentTool.execute → MCP handler
// ---------------------------------------------------------------------------

/**
 * MCP tool handler signature: receives (args, extra) where:
 * - args: The validated tool arguments (parsed from Zod schema)
 * - extra: Request handler context with signal, _meta, sessionId, etc.
 */
export type McpToolHandler = (
  args: Record<string, unknown>,
  extra: McpToolHandlerExtra,
) => Promise<McpCallToolResult>;

/**
 * Wrap a Clawdbrain tool's `execute()` as an MCP tool handler.
 *
 * Differences bridged:
 * - Clawdbrain: `execute(toolCallId, params, signal?, onUpdate?)`
 * - MCP:      `handler(args, extra) → Promise<CallToolResult>`
 *
 * The MCP SDK passes args as the first parameter and context (signal, etc.)
 * as the second parameter when using registerTool() with an inputSchema.
 */
export function wrapToolHandler(tool: AnyAgentTool, abortSignal?: AbortSignal): McpToolHandler {
  const normalizedName = normalizeToolName(tool.name);

  return async (
    rawArgs: Record<string, unknown>,
    extra: McpToolHandlerExtra,
  ): Promise<McpCallToolResult> => {
    // Generate a synthetic toolCallId. The Claude Agent SDK doesn't expose its
    // internal tool call ID to MCP handlers, so we create a unique one for
    // internal tracking/logging. This is safe because Clawdbrain tools only use
    // toolCallId for logging and scoping, not for cross-referencing with the
    // model's response.
    const toolCallId = `mcp-bridge-${normalizedName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Debug: log received args for troubleshooting parameter issues
    logDebug(`[tool-bridge] ${normalizedName} received args: ${JSON.stringify(rawArgs)}`);

    // Use the abort signal from extra if available, falling back to the shared one
    const effectiveSignal = extra?.signal ?? abortSignal;

    try {
      const result = await tool.execute(
        toolCallId,
        rawArgs,
        effectiveSignal, // 3rd arg: AbortSignal
        undefined, // 4th arg: onUpdate — not supported in MCP tool protocol
      );
      return convertToolResult(result);
    } catch (err) {
      // Propagate AbortError so the SDK runner can handle cancellation.
      if (err instanceof Error && err.name === "AbortError") {
        return {
          content: [{ type: "text", text: `Tool "${normalizedName}" was aborted.` }],
          isError: true,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      logError(`[tool-bridge] ${normalizedName} failed: ${message}`);
      if (err instanceof Error && err.stack) {
        logDebug(`[tool-bridge] ${normalizedName} stack:\n${err.stack}`);
      }

      return {
        content: [{ type: "text", text: `Tool error (${normalizedName}): ${message}` }],
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// MCP Server loading (dynamic import — SDK is optional)
// ---------------------------------------------------------------------------

let cachedMcpServerConstructor: McpServerConstructor | undefined;

/**
 * Dynamically load the McpServer class from the MCP SDK.
 *
 * The MCP SDK (`@modelcontextprotocol/sdk`) is a direct dependency used
 * alongside `@anthropic-ai/claude-agent-sdk` for tool bridging.
 * We import it lazily to avoid build-time deps.
 */
async function loadMcpServerClass(): Promise<McpServerConstructor> {
  if (cachedMcpServerConstructor) return cachedMcpServerConstructor;

  // The MCP SDK exports McpServer from this path.
  const moduleName: string = "@modelcontextprotocol/sdk/server/mcp.js";
  try {
    const mod = (await import(moduleName)) as { McpServer?: McpServerConstructor };
    if (!mod.McpServer || typeof mod.McpServer !== "function") {
      throw new Error("McpServer class not found in @modelcontextprotocol/sdk");
    }
    cachedMcpServerConstructor = mod.McpServer;
    return mod.McpServer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load MCP SDK. Ensure @modelcontextprotocol/sdk is installed ` +
        `(required for Claude Agent SDK tool bridging).\n\nError: ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool name utilities
// ---------------------------------------------------------------------------

/** MCP tool naming convention: mcp__{server}__{tool} */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Build the allowedTools list for the Claude Agent SDK from bridged tools. */
export function buildMcpAllowedTools(serverName: string, tools: AnyAgentTool[]): string[] {
  return tools.map((t) => mcpToolName(serverName, t.name));
}

// ---------------------------------------------------------------------------
// Main bridge: Clawdbrain tools → MCP server config
// ---------------------------------------------------------------------------

export type BridgeOptions = {
  /** MCP server name (used in mcp__{name}__{tool} naming). */
  name: string;
  /** Clawdbrain tools to bridge. These should already be policy-filtered. */
  tools: AnyAgentTool[];
  /** Optional shared abort signal for all tool executions. */
  abortSignal?: AbortSignal;
};

export type BridgeResult = {
  /** MCP server config ready for `query({ options: { mcpServers } })`. */
  serverConfig: McpSdkServerConfig;
  /** Pre-built `allowedTools` list for the SDK options. */
  allowedTools: string[];
  /** Number of tools registered. */
  toolCount: number;
  /** Tool names that were registered. */
  registeredTools: string[];
  /** Tool names that were skipped (e.g., schema extraction failed). */
  skippedTools: string[];
};

/**
 * Bridge Clawdbrain tools into an in-process MCP server config for the Claude Agent SDK.
 *
 * This is the main entry point. It:
 * 1. Dynamically loads the MCP SDK's McpServer class.
 * 2. For each Clawdbrain tool, extracts JSON Schema, wraps the handler, and registers.
 * 3. Returns a config object ready for `query({ options: { mcpServers } })`.
 *
 * No business logic is duplicated — each tool's `execute()` is called directly.
 */
export async function bridgeClawdbrainToolsToMcpServer(
  options: BridgeOptions,
): Promise<BridgeResult> {
  const McpServer = await loadMcpServerClass();
  const server: McpServerLike = new McpServer({
    name: options.name,
    version: "1.0.0",
  });

  const registered: string[] = [];
  const skipped: string[] = [];

  // Create a permissive Zod schema that accepts any object.
  // The MCP SDK requires Zod schemas (not JSON Schema) for input validation.
  // We use a passthrough object schema so all arguments flow through to our handlers,
  // which perform their own validation via TypeBox schemas.
  const passthroughSchema = z.record(z.string(), z.unknown());

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      logDebug("[tool-bridge] Skipping tool with empty name");
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const handler = wrapToolHandler(tool, options.abortSignal);

      // Use registerTool() (the recommended API) instead of deprecated tool().
      // The inputSchema must be a Zod schema - we use a passthrough schema that
      // accepts any object, since our tools do their own validation.
      server.registerTool(
        toolName,
        {
          description: tool.description ?? `Clawdbrain tool: ${toolName}`,
          inputSchema: passthroughSchema,
        },
        handler,
      );

      registered.push(toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[tool-bridge] Failed to register tool "${toolName}": ${message}`);
      skipped.push(toolName);
    }
  }

  const serverConfig: McpSdkServerConfig = {
    type: "sdk",
    name: options.name,
    instance: server,
  };

  return {
    serverConfig,
    allowedTools: buildMcpAllowedTools(options.name, options.tools),
    toolCount: registered.length,
    registeredTools: registered,
    skippedTools: skipped,
  };
}

// ---------------------------------------------------------------------------
// Convenience: bridge without async (for tests / when McpServer is provided)
// ---------------------------------------------------------------------------

/**
 * Synchronous variant for when the McpServer class is already available.
 * Useful in tests where you can provide a mock McpServer constructor.
 */
export function bridgeClawdbrainToolsSync(
  options: BridgeOptions & { McpServer: McpServerConstructor },
): BridgeResult {
  const server: McpServerLike = new options.McpServer({
    name: options.name,
    version: "1.0.0",
  });

  const registered: string[] = [];
  const skipped: string[] = [];

  // Create a permissive Zod schema that accepts any object
  const passthroughSchema = z.record(z.string(), z.unknown());

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const handler = wrapToolHandler(tool, options.abortSignal);
      server.registerTool(
        toolName,
        {
          description: tool.description ?? `Clawdbrain tool: ${toolName}`,
          inputSchema: passthroughSchema,
        },
        handler,
      );
      registered.push(toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[tool-bridge] Failed to register tool "${toolName}": ${message}`);
      skipped.push(toolName);
    }
  }

  return {
    serverConfig: { type: "sdk", name: options.name, instance: server },
    allowedTools: buildMcpAllowedTools(options.name, options.tools),
    toolCount: registered.length,
    registeredTools: registered,
    skippedTools: skipped,
  };
}
