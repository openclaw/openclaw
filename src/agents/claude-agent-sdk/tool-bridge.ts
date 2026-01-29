/**
 * Bridge between Moltbot tools (AnyAgentTool) and the Claude Agent SDK's
 * MCP-based custom tool system.
 *
 * This module is pure facade/adapter code — no business logic is duplicated.
 * Each Moltbot tool's `execute()` function is called as-is; the bridge only
 * converts schemas, argument shapes, and result formats.
 *
 * Usage:
 * ```ts
 * const mcpConfig = await bridgeMoltbotToolsToMcpServer({
 *   name: "moltbot",
 *   tools: myMoltbotTools,
 * });
 * // Pass to SDK query():
 * query({ prompt, options: { mcpServers: { moltbot: mcpConfig } } })
 * ```
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import * as z from "zod/v4-mini";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeToolName } from "../tool-policy.js";
import type { AnyAgentTool } from "../tools/common.js";
import type {
  McpCallToolResult,
  McpContentBlock,
  McpRequestHandlerExtra,
  McpSdkServerConfig,
  McpServerConstructor,
  McpServerLike,
} from "./tool-bridge.types.js";

const log = createSubsystemLogger("agents/claude-agent-sdk/tool-bridge");

// ---------------------------------------------------------------------------
// Schema conversion: TypeBox → Zod v4 Mini schema
// ---------------------------------------------------------------------------

// Use z.ZodMiniType as the base type for all Zod Mini schemas
// biome-ignore lint/suspicious/noExplicitAny: Zod Mini type system is complex; any allows proper schema composition
type ZodMiniSchema = z.ZodMiniType<any, any>;

/**
 * Convert a TypeBox property schema to a Zod v4 Mini schema.
 * This recursive converter handles common TypeBox/JSON Schema types.
 */
function convertTypeBoxPropertyToZod(propSchema: TSchema): ZodMiniSchema {
  const type = (propSchema as { type?: string }).type;

  // Handle based on JSON Schema type
  switch (type) {
    case "string": {
      return z.string();
    }
    case "number":
    case "integer": {
      return z.number();
    }
    case "boolean": {
      return z.boolean();
    }
    case "array": {
      const items = (propSchema as { items?: TSchema }).items;
      const itemSchema = items ? convertTypeBoxPropertyToZod(items) : z.unknown();
      return z.array(itemSchema);
    }
    case "object": {
      // Nested object - recursively convert
      const nestedProps = (propSchema as { properties?: Record<string, TSchema> }).properties;
      const nestedRequired = (propSchema as { required?: string[] }).required ?? [];
      if (nestedProps) {
        const shape = buildZodShapeFromTypeBox(nestedProps, nestedRequired);
        return z.object(shape);
      }
      // Object without defined properties - use passthrough
      return z.record(z.string(), z.unknown());
    }
    case "null": {
      return z.null();
    }
    default: {
      // Check for enum/const
      const enumValues = (propSchema as { enum?: string[] }).enum;
      if (enumValues && Array.isArray(enumValues)) {
        // Create a union of literals for enum
        if (enumValues.length === 1) {
          return z.literal(enumValues[0]);
        }
        const literals = enumValues.map((v) => z.literal(v));
        // TypeScript requires explicit tuple type assertion for z.union
        return z.union(literals as unknown as [ZodMiniSchema, ZodMiniSchema, ...ZodMiniSchema[]]);
      }

      const constValue = (propSchema as { const?: unknown }).const;
      if (constValue !== undefined) {
        return z.literal(constValue as string | number | boolean);
      }

      // Fallback to unknown for unrecognized types
      return z.unknown();
    }
  }
}

/**
 * Build a Zod shape object from TypeBox properties.
 */
function buildZodShapeFromTypeBox(
  properties: Record<string, TSchema>,
  requiredProps: string[],
): Record<string, ZodMiniSchema> {
  const requiredSet = new Set(requiredProps);
  const shape: Record<string, ZodMiniSchema> = {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    let zodProp = convertTypeBoxPropertyToZod(propSchema);

    // Wrap in optional if not required
    if (!requiredSet.has(propName)) {
      zodProp = z.optional(zodProp);
    }

    shape[propName] = zodProp;
  }

  return shape;
}

/**
 * Convert a TypeBox object schema to a Zod v4 Mini object schema.
 *
 * The MCP SDK natively supports Zod v4 Mini schemas. By converting TypeBox
 * to real Zod schemas, we get proper JSON Schema generation for Claude
 * and validation that matches what the SDK expects.
 */
export function convertTypeBoxToZod(typeboxSchema: TSchema): ZodMiniSchema {
  const properties = (typeboxSchema as { properties?: Record<string, TSchema> }).properties;
  const requiredProps = (typeboxSchema as { required?: string[] }).required ?? [];

  if (!properties || typeof properties !== "object") {
    // No properties defined - return a permissive object schema
    return z.object({});
  }

  const shape = buildZodShapeFromTypeBox(properties, requiredProps);
  return z.object(shape);
}

/**
 * Create a Zod v4 Mini schema from a tool's TypeBox parameters.
 * Returns undefined if the tool has no parameters.
 */
export function extractZodSchema(tool: AnyAgentTool): ZodMiniSchema | undefined {
  const schema = tool.parameters as TSchema | undefined;
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  return convertTypeBoxToZod(schema);
}

// Legacy exports for backward compatibility
export type ZodCompatibleSchema = ZodMiniSchema;
export const createZodCompatibleSchema = convertTypeBoxToZod;
export const extractZodCompatibleSchema = extractZodSchema;

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
    log.debug(`Schema for "${tool.name}" is not JSON-serializable, using empty schema`);
    return { type: "object", properties: {} };
  }
}

// ---------------------------------------------------------------------------
// Result conversion: AgentToolResult → McpCallToolResult
// ---------------------------------------------------------------------------

/**
 * Convert a Moltbot `AgentToolResult` to an MCP `CallToolResult`.
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
 * Wrap a Moltbot tool's `execute()` as an MCP tool handler.
 *
 * Differences bridged:
 * - Moltbot: `execute(toolCallId, params, signal?, onUpdate?)`
 * - MCP:    `handler(args, extra) → Promise<CallToolResult>`
 *
 * When using registerTool() with inputSchema, the MCP SDK calls
 * the handler with (args, extra) where:
 * - args: the validated tool input parameters
 * - extra: RequestHandlerExtra with signal, sessionId, _meta, etc.
 *
 * Notable: MCP handlers have no native streaming update callback.
 * We pass the shared `abortSignal` (if provided) and create an `onUpdate`
 * that forwards to the provided callback.
 */
export function wrapToolHandler(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
  onToolUpdate?: OnToolUpdateCallback,
): (args: Record<string, unknown>, extra: McpRequestHandlerExtra) => Promise<McpCallToolResult> {
  const normalizedName = normalizeToolName(tool.name);

  return async (
    args: Record<string, unknown>,
    extra: McpRequestHandlerExtra,
  ): Promise<McpCallToolResult> => {
    // Generate a synthetic toolCallId. The Claude Agent SDK doesn't expose its
    // internal tool call ID to MCP handlers, so we create a unique one for
    // internal tracking/logging. This is safe because Moltbot tools only use
    // toolCallId for logging and scoping, not for cross-referencing with the
    // model's response.
    const toolCallId = `mcp-bridge-${normalizedName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Debug: log received arguments to diagnose parameter passing issues
    log.debug(`Tool ${normalizedName} received args`, {
      argsKeys: Object.keys(args),
      argsType: typeof args,
      argsPreview: JSON.stringify(args).slice(0, 500),
    });

    // Use the signal from extra if available, fall back to the shared abortSignal
    const signal = extra?.signal ?? abortSignal;

    // Create an onUpdate callback that forwards to the bridge callback.
    const onUpdate = onToolUpdate
      ? (update: unknown) => {
          void Promise.resolve(
            onToolUpdate({ toolCallId, toolName: normalizedName, update }),
          ).catch(() => {
            // Don't let async callback errors break tool execution.
          });
        }
      : undefined;

    try {
      const result = await tool.execute(toolCallId, args, signal, onUpdate);
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
      log.error(`Tool ${normalizedName} failed: ${message}`);
      if (err instanceof Error && err.stack) {
        log.debug(`Tool ${normalizedName} stack:\n${err.stack}`);
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
 * The MCP SDK (`@modelcontextprotocol/sdk`) is a transitive dependency of
 * `@anthropic-ai/claude-agent-sdk`. When the Claude Agent SDK is installed,
 * the MCP SDK is available. We import it lazily to avoid build-time deps.
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
      `Failed to load MCP SDK. Ensure @anthropic-ai/claude-agent-sdk is installed ` +
        `(it includes @modelcontextprotocol/sdk as a dependency).\n\nError: ${message}`,
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
// Main bridge: Moltbot tools → MCP server config
// ---------------------------------------------------------------------------

/** Callback for tool execution updates (streaming progress). */
export type OnToolUpdateCallback = (params: {
  toolCallId: string;
  toolName: string;
  update: unknown;
}) => void | Promise<void>;

export type BridgeOptions = {
  /** MCP server name (used in mcp__{name}__{tool} naming). */
  name: string;
  /** Moltbot tools to bridge. These should already be policy-filtered. */
  tools: AnyAgentTool[];
  /** Optional shared abort signal for all tool executions. */
  abortSignal?: AbortSignal;
  /** Optional callback for tool execution updates (streaming progress). */
  onToolUpdate?: OnToolUpdateCallback;
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
 * Bridge Moltbot tools into an in-process MCP server config for the Claude Agent SDK.
 *
 * This is the main entry point. It:
 * 1. Dynamically loads the MCP SDK's McpServer class.
 * 2. For each Moltbot tool, extracts JSON Schema, wraps the handler, and registers.
 * 3. Returns a config object ready for `query({ options: { mcpServers } })`.
 *
 * No business logic is duplicated — each tool's `execute()` is called directly.
 */
export async function bridgeMoltbotToolsToMcpServer(options: BridgeOptions): Promise<BridgeResult> {
  const McpServer = await loadMcpServerClass();
  const server: McpServerLike = new McpServer({
    name: options.name,
    version: "1.0.0",
  });

  const registered: string[] = [];
  const skipped: string[] = [];

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      log.debug("Skipping tool with empty name");
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const inputSchema = extractZodCompatibleSchema(tool);
      const handler = wrapToolHandler(tool, options.abortSignal, options.onToolUpdate);

      // Use registerTool() which properly handles inputSchema.
      // The MCP SDK will call handler(args, extra) when inputSchema is set,
      // and validate the args against the schema before calling the handler.
      server.registerTool(
        toolName,
        {
          description: tool.description ?? `Moltbot tool: ${toolName}`,
          inputSchema,
        },
        handler,
      );

      registered.push(toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to register tool "${toolName}": ${message}`);
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
export function bridgeMoltbotToolsSync(
  options: BridgeOptions & { McpServer: McpServerConstructor },
): BridgeResult {
  const server: McpServerLike = new options.McpServer({
    name: options.name,
    version: "1.0.0",
  });

  const registered: string[] = [];
  const skipped: string[] = [];

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const inputSchema = extractZodCompatibleSchema(tool);
      const handler = wrapToolHandler(tool, options.abortSignal, options.onToolUpdate);

      server.registerTool(
        toolName,
        {
          description: tool.description ?? `Moltbot tool: ${toolName}`,
          inputSchema,
        },
        handler,
      );

      registered.push(toolName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to register tool "${toolName}": ${message}`);
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

/**
 * Reset the cached MCP server constructor (for testing).
 */
export function resetMcpServerCache(): void {
  cachedMcpServerConstructor = undefined;
}
