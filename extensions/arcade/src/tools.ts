/**
 * Arcade Tool Registration
 *
 * Converts Arcade tool definitions to OpenClaw tools and handles
 * registration with the plugin API.
 */

import { Type, type TSchema, type TObject } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ArcadeClient, ArcadeToolDefinition, ArcadeToolParameter } from "./client.js";
import type { ArcadeConfig } from "./config.js";
import { matchesToolFilter, isApiToolkit } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export type ArcadeToolContext = {
  client: ArcadeClient;
  config: ArcadeConfig;
  logger: OpenClawPluginApi["logger"];
};

export type RegisteredTool = {
  name: string;
  arcadeName: string;
  toolkit: string;
  requiresAuth: boolean;
};

// ============================================================================
// Schema Conversion
// ============================================================================

/**
 * Convert Arcade parameter schema to TypeBox schema
 */
function convertParameterToTypebox(param: ArcadeToolParameter): TSchema {
  switch (param.type) {
    case "string":
      if (param.enum?.length) {
        // Use Type.Union with Type.Literal for enums
        return Type.Union(
          param.enum.map((v) => Type.Literal(v)),
          { description: param.description },
        );
      }
      return Type.String({ description: param.description, default: param.default as string });

    case "number":
    case "integer":
      return Type.Number({ description: param.description, default: param.default as number });

    case "boolean":
      return Type.Boolean({ description: param.description, default: param.default as boolean });

    case "array":
      if (param.items) {
        return Type.Array(convertParameterToTypebox(param.items), {
          description: param.description,
        });
      }
      return Type.Array(Type.Unknown(), { description: param.description });

    case "object":
      if (param.properties) {
        const properties: Record<string, TSchema> = {};
        for (const [key, prop] of Object.entries(param.properties)) {
          properties[key] = convertParameterToTypebox(prop);
        }
        return Type.Object(properties, { description: param.description });
      }
      return Type.Object({}, { description: param.description, additionalProperties: true });

    default:
      return Type.Unknown({ description: param.description });
  }
}

/**
 * Convert Arcade tool parameters to TypeBox object schema
 */
function convertToolParametersToTypebox(tool: ArcadeToolDefinition): TObject {
  if (!tool.parameters?.properties) {
    return Type.Object({});
  }

  const properties: Record<string, TSchema> = {};
  const required = new Set(tool.parameters.required ?? []);

  for (const [key, param] of Object.entries(tool.parameters.properties)) {
    let schema = convertParameterToTypebox(param);

    // Wrap in Optional if not required
    if (!required.has(key) && !param.required) {
      schema = Type.Optional(schema);
    }

    properties[key] = schema;
  }

  return Type.Object(properties);
}

// ============================================================================
// Tool Name Conversion
// ============================================================================

/**
 * Convert Arcade tool name to OpenClaw tool name
 * Arcade: "Gmail.SendEmail" -> OpenClaw: "arcade_gmail_send_email"
 */
export function toOpenClawToolName(arcadeName: string, prefix: string): string {
  // Split by dots or camelCase
  const parts = arcadeName.split(".");
  const converted = parts
    .map((part) =>
      // Convert CamelCase to snake_case
      part
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, ""),
    )
    .join("_");

  return `${prefix}_${converted}`;
}

/**
 * Convert OpenClaw tool name back to Arcade tool name
 */
export function toArcadeToolName(openclawName: string, prefix: string): string {
  // Remove prefix
  const withoutPrefix = openclawName.replace(new RegExp(`^${prefix}_`), "");

  // Split by underscore and convert to CamelCase
  const parts = withoutPrefix.split("_");

  // Group parts by toolkit.action pattern
  // arcade_gmail_send_email -> Gmail.SendEmail
  if (parts.length >= 2) {
    const toolkit = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const action = parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
    return `${toolkit}.${action}`;
  }

  return withoutPrefix;
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Create an OpenClaw tool from an Arcade tool definition
 */
export function createOpenClawTool(
  arcadeTool: ArcadeToolDefinition,
  ctx: ArcadeToolContext,
) {
  const { client, config, logger } = ctx;
  const openclawName = toOpenClawToolName(arcadeTool.name, config.toolPrefix);

  return {
    name: openclawName,
    label: arcadeTool.name,
    description: `[Arcade] ${arcadeTool.description}`,
    parameters: convertToolParametersToTypebox(arcadeTool),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        // Check if client is configured
        if (!client.isConfigured()) {
          return json({
            error: "Arcade API key not configured",
            help: "Set ARCADE_API_KEY or configure plugins.entries.arcade.config.apiKey",
          });
        }

        logger.info(`[arcade] Executing tool: ${arcadeTool.name}`);

        // Execute with automatic authorization handling
        const result = await client.executeWithAuth(arcadeTool.name, params, {
          onAuthRequired: async (authUrl) => {
            logger.info(`[arcade] Authorization required: ${authUrl}`);
            // Return false to indicate auth wasn't completed
            // The error response will include the URL
            return false;
          },
        });

        if (!result.success) {
          if (result.authorization_required && result.authorization_url) {
            return json({
              error: "Authorization required",
              message: `Please authorize this tool by visiting: ${result.authorization_url}`,
              authorization_url: result.authorization_url,
              tool: arcadeTool.name,
            });
          }

          return json({
            error: result.error?.message ?? "Tool execution failed",
            code: result.error?.code,
            details: result.error?.details,
          });
        }

        return json({
          success: true,
          output: result.output,
          tool: arcadeTool.name,
        });
      } catch (err) {
        logger.error(`[arcade] Tool error: ${err instanceof Error ? err.message : String(err)}`);
        return json({
          error: err instanceof Error ? err.message : String(err),
          tool: arcadeTool.name,
        });
      }
    },
  };
}

/**
 * Register all available Arcade tools with OpenClaw
 */
export async function registerArcadeTools(
  api: OpenClawPluginApi,
  client: ArcadeClient,
  config: ArcadeConfig,
): Promise<RegisteredTool[]> {
  const registered: RegisteredTool[] = [];

  if (!client.isConfigured()) {
    api.logger.warn("[arcade] API key not configured, skipping tool registration");
    return registered;
  }

  try {
    // Fetch available tools from Arcade
    const tools = await client.listTools();
    api.logger.info(`[arcade] Found ${tools.length} tools from Arcade`);

    const ctx: ArcadeToolContext = { client, config, logger: api.logger };

    for (const arcadeTool of tools) {
      // Check if tool is allowed by filter
      if (!matchesToolFilter(arcadeTool.name, config.tools)) {
        continue;
      }

      // Check if toolkit is enabled
      const toolkitName = typeof arcadeTool.toolkit === "string"
        ? arcadeTool.toolkit
        : arcadeTool.toolkit?.name ?? "";

      // Skip *Api toolkits unless useApiTools is enabled
      if (!config.useApiTools && isApiToolkit(toolkitName)) {
        continue;
      }

      const toolkitConfig = config.toolkits?.[toolkitName.toLowerCase()];
      if (toolkitConfig?.enabled === false) {
        continue;
      }

      // Check if specific tool is enabled within toolkit
      if (toolkitConfig?.tools?.length) {
        const toolBaseName = arcadeTool.name.split(".").pop() ?? arcadeTool.name;
        if (
          !toolkitConfig.tools.includes(arcadeTool.name) &&
          !toolkitConfig.tools.includes(toolBaseName)
        ) {
          continue;
        }
      }

      // Create and register the tool
      const openclawTool = createOpenClawTool(arcadeTool, ctx);

      api.registerTool(openclawTool, { optional: true });

      registered.push({
        name: openclawTool.name,
        arcadeName: arcadeTool.name,
        toolkit: toolkitName,
        requiresAuth: arcadeTool.requires_auth ?? false,
      });
    }

    return registered;
  } catch (err) {
    api.logger.error(
      `[arcade] Failed to register tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return registered;
  }
}

/**
 * Register Arcade tools from local cache (no API calls)
 */
export function registerArcadeToolsFromCache(
  api: OpenClawPluginApi,
  client: ArcadeClient,
  config: ArcadeConfig,
): RegisteredTool[] {
  const registered: RegisteredTool[] = [];

  // Import cache functions inline to avoid circular deps
  const { getCachedTools, toToolDefinition } = require("./cache.js");

  const cachedTools = getCachedTools();
  if (cachedTools.length === 0) {
    return registered;
  }

  const ctx: ArcadeToolContext = { client, config, logger: api.logger };

  for (const cached of cachedTools) {
    // Check if tool is allowed by filter
    if (!matchesToolFilter(cached.name, config.tools)) {
      continue;
    }

    // Skip *Api toolkits unless useApiTools is enabled
    if (!config.useApiTools && isApiToolkit(cached.toolkit)) {
      continue;
    }

    // Check if toolkit is enabled
    const toolkitConfig = config.toolkits?.[cached.toolkit.toLowerCase()];
    if (toolkitConfig?.enabled === false) {
      continue;
    }

    // Check if specific tool is enabled within toolkit
    if (toolkitConfig?.tools?.length) {
      const toolBaseName = cached.name.split(".").pop() ?? cached.name;
      if (
        !toolkitConfig.tools.includes(cached.name) &&
        !toolkitConfig.tools.includes(toolBaseName)
      ) {
        continue;
      }
    }

    // Convert cached tool to ArcadeToolDefinition format
    const arcadeTool = toToolDefinition(cached);

    // Create and register the tool
    const openclawTool = createOpenClawTool(arcadeTool, ctx);

    api.registerTool(openclawTool, { optional: true });

    registered.push({
      name: openclawTool.name,
      arcadeName: cached.name,
      toolkit: cached.toolkit,
      requiresAuth: cached.requires_auth ?? false,
    });
  }

  return registered;
}

// ============================================================================
// Static Tool Registration (fallback)
// ============================================================================

/**
 * Register a minimal set of static tools for when API is unavailable
 */
export function registerStaticTools(
  api: OpenClawPluginApi,
  client: ArcadeClient,
  config: ArcadeConfig,
): RegisteredTool[] {
  const ctx: ArcadeToolContext = { client, config, logger: api.logger };
  const registered: RegisteredTool[] = [];

  // Override execute handler for arcade.list_tools
  const listToolsHandler = {
    name: "arcade_list_tools",
    label: "List Arcade Tools",
    description: "List available Arcade tools and their capabilities",
    parameters: Type.Object({
      toolkit: Type.Optional(
        Type.String({ description: "Filter by toolkit name (e.g., gmail, slack, github)" }),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const toolkit = params.toolkit as string | undefined;
        const tools = await client.listTools({ toolkit, forceRefresh: true });

        return json({
          success: true,
          count: tools.length,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            toolkit: t.toolkit,
            requires_auth: t.requires_auth,
          })),
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  // Override execute handler for arcade.authorize
  const authorizeHandler = {
    name: "arcade_authorize",
    label: "Authorize Arcade Tool",
    description: "Initiate authorization for an Arcade tool",
    parameters: Type.Object({
      tool_name: Type.String({ description: "The Arcade tool name (e.g., Gmail.SendEmail)" }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const toolName = params.tool_name as string;
        const response = await client.authorize(toolName);

        return json({
          success: true,
          status: response.status,
          authorization_url: response.authorization_url,
          message:
            response.status === "completed"
              ? "Already authorized"
              : `Please authorize by visiting: ${response.authorization_url}`,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  // Override execute handler for arcade.execute
  const executeHandler = {
    name: "arcade_execute",
    label: "Execute Arcade Tool",
    description: "Execute any Arcade tool by name with given parameters",
    parameters: Type.Object({
      tool_name: Type.String({ description: "The Arcade tool name (e.g., Gmail.SendEmail)" }),
      input: Type.Object({}, {
        description: "Tool input parameters",
        additionalProperties: true,
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const toolName = params.tool_name as string;
        const input = (params.input as Record<string, unknown>) ?? {};

        const result = await client.executeWithAuth(toolName, input, {
          onAuthRequired: async (authUrl) => {
            ctx.logger.info(`[arcade] Authorization required: ${authUrl}`);
            return false;
          },
        });

        if (!result.success && result.authorization_required) {
          return json({
            error: "Authorization required",
            authorization_url: result.authorization_url,
            message: `Please authorize by visiting: ${result.authorization_url}`,
          });
        }

        return json({
          success: result.success,
          output: result.output,
          error: result.error,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  // Register static tools
  api.registerTool(listToolsHandler, { optional: true });
  registered.push({
    name: "arcade_list_tools",
    arcadeName: "arcade.list_tools",
    toolkit: "arcade",
    requiresAuth: false,
  });

  api.registerTool(authorizeHandler, { optional: true });
  registered.push({
    name: "arcade_authorize",
    arcadeName: "arcade.authorize",
    toolkit: "arcade",
    requiresAuth: false,
  });

  api.registerTool(executeHandler, { optional: true });
  registered.push({
    name: "arcade_execute",
    arcadeName: "arcade.execute",
    toolkit: "arcade",
    requiresAuth: false,
  });

  return registered;
}
