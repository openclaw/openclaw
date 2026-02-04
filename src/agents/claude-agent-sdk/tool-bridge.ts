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
import type { AnyAgentTool } from "../tools/common.js";
import type {
  McpCallToolResult,
  McpContentBlock,
  McpSdkServerConfig,
  McpServerConstructor,
  McpServerLike,
  McpToolHandlerExtra,
} from "./tool-bridge.types.js";
import { logDebug, logError } from "../../logger.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { truncateForLog } from "../../logging/truncate.js";
import { normalizeToolName } from "../tool-policy.js";

// ---------------------------------------------------------------------------
// Schema conversion: TypeBox → JSON Schema → Zod
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

/**
 * Convert a JSON Schema property to a Zod schema.
 *
 * This handles the common JSON Schema types and patterns used by TypeBox,
 * ensuring Claude receives proper type information for tool parameters.
 */
function convertJsonSchemaPropertyToZod(
  propSchema: Record<string, unknown>,
  propName: string,
): z.ZodTypeAny {
  // Handle enums first (critical for action parameters)
  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    const enumValues = propSchema.enum.filter((v): v is string => typeof v === "string");
    if (enumValues.length > 0) {
      // Zod v4 enum requires at least one value
      const zodEnum = z.enum(enumValues as [string, ...string[]]);
      const desc = propSchema.description;
      return typeof desc === "string" ? zodEnum.describe(desc) : zodEnum;
    }
  }

  // Handle const (single allowed value)
  if ("const" in propSchema) {
    const constVal = propSchema.const;
    if (typeof constVal === "string") {
      return z.literal(constVal);
    }
    if (typeof constVal === "number") {
      return z.literal(constVal);
    }
    if (typeof constVal === "boolean") {
      return z.literal(constVal);
    }
  }

  // Handle type-based conversion
  const schemaType = propSchema.type;
  const description =
    typeof propSchema.description === "string" ? propSchema.description : undefined;

  switch (schemaType) {
    case "string": {
      let schema = z.string();
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }

    case "number":
    case "integer": {
      let schema = z.number();
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }

    case "boolean": {
      let schema = z.boolean();
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }

    case "array": {
      const itemsSchema = propSchema.items as Record<string, unknown> | undefined;
      let itemZod: z.ZodTypeAny = z.unknown();
      if (itemsSchema && typeof itemsSchema === "object") {
        itemZod = convertJsonSchemaPropertyToZod(itemsSchema, `${propName}[]`);
      }
      let schema = z.array(itemZod);
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }

    case "object": {
      const additionalProperties = propSchema.additionalProperties;
      const allowsAdditional =
        additionalProperties === true ||
        (typeof additionalProperties === "object" && additionalProperties !== null);

      // Nested object - recursively convert properties if available
      const nestedProps = propSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const hasNestedProps =
        nestedProps && typeof nestedProps === "object" && Object.keys(nestedProps).length > 0;

      if (hasNestedProps) {
        const nestedRequired = new Set(
          Array.isArray(propSchema.required)
            ? (propSchema.required as string[]).filter((k) => typeof k === "string")
            : [],
        );
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [nestedKey, nestedPropSchema] of Object.entries(nestedProps)) {
          if (!nestedPropSchema || typeof nestedPropSchema !== "object") {
            continue;
          }
          let nestedZod = convertJsonSchemaPropertyToZod(
            nestedPropSchema,
            `${propName}.${nestedKey}`,
          );
          if (!nestedRequired.has(nestedKey)) {
            nestedZod = nestedZod.optional();
          }
          shape[nestedKey] = nestedZod;
        }

        let schema = z.object(shape);
        // Preserve additionalProperties semantics so we don't silently strip
        // payload keys (critical for "any object" tool params like cron.job/patch).
        if (additionalProperties === true) {
          schema = schema.passthrough();
        } else if (typeof additionalProperties === "object" && additionalProperties !== null) {
          schema = schema.catchall(
            convertJsonSchemaPropertyToZod(
              additionalProperties as Record<string, unknown>,
              `${propName}.*`,
            ),
          );
        }

        if (description) {
          schema = schema.describe(description);
        }
        return schema;
      }

      // No defined properties: honor additionalProperties. If the schema
      // explicitly forbids additional properties, this represents an empty
      // object. Otherwise, accept an arbitrary key/value map.
      if (!allowsAdditional && additionalProperties === false) {
        let schema = z.object({});
        if (description) {
          schema = schema.describe(description);
        }
        return schema;
      }

      if (additionalProperties === true || additionalProperties === undefined) {
        let schema = z.record(z.string(), z.unknown());
        if (description) {
          schema = schema.describe(description);
        }
        return schema;
      }

      if (typeof additionalProperties === "object" && additionalProperties !== null) {
        let schema = z.record(
          z.string(),
          convertJsonSchemaPropertyToZod(
            additionalProperties as Record<string, unknown>,
            `${propName}.*`,
          ),
        );
        if (description) {
          schema = schema.describe(description);
        }
        return schema;
      }

      // Fallback: permissive object.
      let schema = z.record(z.string(), z.unknown());
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }

    default: {
      // Fallback for unknown types
      let schema = z.unknown();
      if (description) {
        schema = schema.describe(description);
      }
      return schema;
    }
  }
}

/**
 * Convert a JSON Schema (from TypeBox) to a Zod schema.
 *
 * This is the key function that ensures Claude receives proper parameter
 * information including:
 * - Parameter names and types
 * - Required vs optional fields
 * - Enum values (critical for action parameters)
 * - Descriptions for each parameter
 *
 * The MCP SDK converts Zod schemas to JSON Schema for the wire protocol,
 * so this round-trip preserves all the type information for Claude.
 */
export function jsonSchemaToZod(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
  // Handle object schemas (the common case for tool parameters)
  if (jsonSchema.type === "object" || jsonSchema.properties) {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== "object") {
      // No properties defined - return a permissive record schema
      return z.record(z.string(), z.unknown());
    }

    const required = new Set(
      Array.isArray(jsonSchema.required)
        ? (jsonSchema.required as string[]).filter((k) => typeof k === "string")
        : [],
    );

    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [propName, propSchema] of Object.entries(properties)) {
      if (!propSchema || typeof propSchema !== "object") {
        continue;
      }

      let zodType = convertJsonSchemaPropertyToZod(propSchema, propName);

      // Mark as optional if not in required list
      if (!required.has(propName)) {
        zodType = zodType.optional();
      }

      shape[propName] = zodType;
    }

    // If we have properties, create an object schema
    if (Object.keys(shape).length > 0) {
      return z.object(shape);
    }

    // Fallback to permissive schema
    return z.record(z.string(), z.unknown());
  }

  // Non-object root schema (rare for tools, but handle it)
  return z.record(z.string(), z.unknown());
}

/**
 * Build a Zod schema for a tool from its TypeBox parameters.
 *
 * This extracts the JSON Schema from the tool and converts it to Zod,
 * ensuring Claude receives full parameter information.
 */
export function buildZodSchemaForTool(tool: AnyAgentTool): z.ZodTypeAny {
  const jsonSchema = extractJsonSchema(tool);
  try {
    const zodSchema = jsonSchemaToZod(jsonSchema);
    logDebug(
      `[tool-bridge] Built Zod schema for "${tool.name}" with ${Object.keys((jsonSchema.properties as object) ?? {}).length} properties`,
    );
    return zodSchema;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDebug(
      `[tool-bridge] Failed to convert schema for "${tool.name}": ${message}, using passthrough`,
    );
    return z.record(z.string(), z.unknown());
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
    try {
      const argsJson = JSON.stringify(rawArgs);
      const redacted = redactSensitiveText(argsJson);
      logDebug(`[tool-bridge] ${normalizedName} received args: ${truncateForLog(redacted)}`);
    } catch {
      logDebug(`[tool-bridge] ${normalizedName} received args: (unserializable)`);
    }

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
      const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : undefined;
      const execCommand = normalizedName === "exec" ? rawArgs.command : undefined;
      const execWorkdir = normalizedName === "exec" ? rawArgs.workdir : undefined;
      const execCommandText = typeof execCommand === "string" ? execCommand : undefined;
      const execWorkdirText = typeof execWorkdir === "string" ? execWorkdir : undefined;
      const execCommandRedacted = execCommandText
        ? redactSensitiveText(execCommandText).trim()
        : undefined;
      const execCommandPreview =
        execCommandRedacted && execCommandRedacted.length > 240
          ? `${execCommandRedacted.slice(0, 240)}…`
          : execCommandRedacted;

      const contextParts: string[] = [`toolCallId=${toolCallId}`];
      if (sessionId) {
        contextParts.push(`sessionId=${sessionId}`);
      }
      if (execCommandPreview) {
        contextParts.push(`cmd=${JSON.stringify(execCommandPreview)}`);
      }
      if (execWorkdirText) {
        contextParts.push(`cwd=${JSON.stringify(execWorkdirText)}`);
      }

      logError(`[tool-bridge] ${normalizedName} failed: ${message} (${contextParts.join(" ")})`);

      // Log debug details if available (e.g., wrapped error content from web_fetch)
      const debugDetail =
        err instanceof Error ? (err as unknown as Record<string, unknown>)._debugDetail : undefined;
      if (typeof debugDetail === "string") {
        logDebug(`[tool-bridge] ${normalizedName} debug detail:\n${truncateForLog(debugDetail)}`);
      }

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
  if (cachedMcpServerConstructor) {
    logDebug("[tool-bridge] Using cached McpServer constructor");
    return cachedMcpServerConstructor;
  }

  // The MCP SDK exports McpServer from this path.
  // Note: The SDK's package.json exports "./*" which maps to "./dist/esm/*"
  const moduleName: string = "@modelcontextprotocol/sdk/server/mcp.js";
  try {
    logDebug(`[tool-bridge] Loading MCP SDK from ${moduleName}`);
    const mod = (await import(moduleName)) as { McpServer?: McpServerConstructor };
    if (!mod.McpServer || typeof mod.McpServer !== "function") {
      const exportedKeys = Object.keys(mod);
      throw new Error(
        `McpServer class not found in @modelcontextprotocol/sdk. ` +
          `Available exports: [${exportedKeys.join(", ")}]. ` +
          `The MCP SDK version may be incompatible.`,
      );
    }
    cachedMcpServerConstructor = mod.McpServer;
    logDebug("[tool-bridge] MCP SDK loaded successfully");
    return mod.McpServer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isModuleNotFound =
      message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND");
    const hint = isModuleNotFound
      ? "Install with: npm install @modelcontextprotocol/sdk"
      : "Check MCP SDK version compatibility";
    throw new Error(`Failed to load MCP SDK (${hint}).\nModule: ${moduleName}\nError: ${message}`, {
      cause: err,
    });
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
  logDebug(`[tool-bridge] Bridging ${options.tools.length} tools to MCP server "${options.name}"`);

  const McpServer = await loadMcpServerClass();

  let server: McpServerLike;
  try {
    server = new McpServer({
      name: options.name,
      version: "1.0.0",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create MCP server instance: ${message}`, { cause: err });
  }

  const registered: string[] = [];
  const skipped: string[] = [];

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      logDebug("[tool-bridge] Skipping tool with empty name");
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const handler = wrapToolHandler(tool, options.abortSignal);

      // Convert TypeBox schema to Zod so Claude receives proper parameter information.
      // This ensures the model knows parameter names, types, required fields, and enum values.
      const inputSchema = buildZodSchemaForTool(tool);

      // Phase #1: Build enhanced description for Clawdbrain tools
      const enhancedDesc =
        tool.description ??
        `${toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} (Clawdbrain native tool)`;

      // Use registerTool() (the recommended API) instead of deprecated tool().
      server.registerTool(
        toolName,
        {
          description: enhancedDesc,
          inputSchema,
        },
        handler,
      );

      registered.push(toolName);
      logDebug(`[tool-bridge] Registered tool: ${toolName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logError(`[tool-bridge] Failed to register tool "${toolName}": ${message}`);
      if (stack) {
        logDebug(`[tool-bridge] Stack trace for "${toolName}":\n${stack}`);
      }
      skipped.push(toolName);
    }
  }

  const serverConfig: McpSdkServerConfig = {
    type: "sdk",
    name: options.name,
    instance: server,
  };

  logDebug(
    `[tool-bridge] Bridge complete: ${registered.length} registered, ${skipped.length} skipped` +
      (skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""),
  );

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
  logDebug(
    `[tool-bridge] Bridging ${options.tools.length} tools (sync) to MCP server "${options.name}"`,
  );

  let server: McpServerLike;
  try {
    server = new options.McpServer({
      name: options.name,
      version: "1.0.0",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create MCP server instance: ${message}`, { cause: err });
  }

  const registered: string[] = [];
  const skipped: string[] = [];

  for (const tool of options.tools) {
    const toolName = tool.name;
    if (!toolName?.trim()) {
      logDebug("[tool-bridge] Skipping tool with empty name");
      skipped.push("(unnamed)");
      continue;
    }

    try {
      const handler = wrapToolHandler(tool, options.abortSignal);

      // Convert TypeBox schema to Zod so Claude receives proper parameter information.
      const inputSchema = buildZodSchemaForTool(tool);

      server.registerTool(
        toolName,
        {
          description: tool.description ?? `${toolName} (Clawdbrain native tool)`,
          inputSchema,
        },
        handler,
      );
      registered.push(toolName);
      logDebug(`[tool-bridge] Registered tool: ${toolName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logError(`[tool-bridge] Failed to register tool "${toolName}": ${message}`);
      if (stack) {
        logDebug(`[tool-bridge] Stack trace for "${toolName}":\n${stack}`);
      }
      skipped.push(toolName);
    }
  }

  logDebug(
    `[tool-bridge] Bridge complete (sync): ${registered.length} registered, ${skipped.length} skipped` +
      (skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""),
  );

  return {
    serverConfig: { type: "sdk", name: options.name, instance: server },
    allowedTools: buildMcpAllowedTools(options.name, options.tools),
    toolCount: registered.length,
    registeredTools: registered,
    skippedTools: skipped,
  };
}
