import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

type McpToolCatalogDiagnostic = NonNullable<McpToolCatalog["diagnostics"]>[number];

type BundleMcpCatalogSanitization = {
  catalog: McpToolCatalog;
  diagnostics: McpToolCatalogDiagnostic[];
};

function readCatalogToolProperty(
  tool: McpCatalogTool,
  property: keyof McpCatalogTool,
  toolIndex: number,
): { value?: unknown; message?: string } {
  try {
    return { value: tool[property] };
  } catch (error) {
    return {
      message: `tools[${toolIndex}].${property} is unreadable: ${redactSensitiveUrlLikeString(String(error))}`,
    };
  }
}

function createCatalogToolDiagnostic(params: {
  serverName: string;
  safeServerName: string;
  message: string;
}): McpToolCatalogDiagnostic {
  return {
    serverName: params.serverName,
    safeServerName: params.safeServerName,
    launchSummary: params.serverName || "bundle MCP catalog",
    message: params.message,
  };
}

function sanitizeBundleMcpToolCatalog(catalog: McpToolCatalog): BundleMcpCatalogSanitization {
  const tools: McpCatalogTool[] = [];
  const diagnostics: McpToolCatalogDiagnostic[] = [];
  for (const [toolIndex, tool] of catalog.tools.entries()) {
    const serverNameRead = readCatalogToolProperty(tool, "serverName", toolIndex);
    const safeServerNameRead = readCatalogToolProperty(tool, "safeServerName", toolIndex);
    const rawServerName = serverNameRead.value;
    const serverName =
      typeof rawServerName === "string" && rawServerName.length > 0 ? rawServerName : undefined;
    const safeServerName = normalizeOptionalString(safeServerNameRead.value);
    if (serverNameRead.message || !serverName) {
      diagnostics.push(
        createCatalogToolDiagnostic({
          serverName: "bundle-mcp",
          safeServerName: safeServerName ?? "bundle-mcp",
          message:
            serverNameRead.message ?? `tools[${toolIndex}].serverName expected non-empty string`,
        }),
      );
      continue;
    }
    if (safeServerNameRead.message || !safeServerName) {
      diagnostics.push(
        createCatalogToolDiagnostic({
          serverName,
          safeServerName: "bundle-mcp",
          message:
            safeServerNameRead.message ??
            `tools[${toolIndex}].safeServerName expected non-empty string`,
        }),
      );
      continue;
    }

    const toolNameRead = readCatalogToolProperty(tool, "toolName", toolIndex);
    const toolName = normalizeOptionalString(toolNameRead.value);
    if (toolNameRead.message || !toolName) {
      diagnostics.push(
        createCatalogToolDiagnostic({
          serverName,
          safeServerName,
          message: toolNameRead.message ?? `tools[${toolIndex}].toolName expected non-empty string`,
        }),
      );
      continue;
    }

    const inputSchemaRead = readCatalogToolProperty(tool, "inputSchema", toolIndex);
    const inputSchema = inputSchemaRead.value;
    if (inputSchemaRead.message || !inputSchema || typeof inputSchema !== "object") {
      diagnostics.push(
        createCatalogToolDiagnostic({
          serverName,
          safeServerName,
          message: inputSchemaRead.message ?? `tools[${toolIndex}].inputSchema expected object`,
        }),
      );
      continue;
    }

    const titleRead = readCatalogToolProperty(tool, "title", toolIndex);
    const descriptionRead = readCatalogToolProperty(tool, "description", toolIndex);
    const fallbackDescriptionRead = readCatalogToolProperty(tool, "fallbackDescription", toolIndex);
    for (const read of [titleRead, descriptionRead, fallbackDescriptionRead]) {
      if (read.message) {
        diagnostics.push(
          createCatalogToolDiagnostic({ serverName, safeServerName, message: read.message }),
        );
      }
    }

    tools.push({
      serverName,
      safeServerName,
      toolName,
      title: normalizeOptionalString(titleRead.value),
      description: normalizeOptionalString(descriptionRead.value),
      inputSchema: inputSchema as McpCatalogTool["inputSchema"],
      fallbackDescription:
        normalizeOptionalString(fallbackDescriptionRead.value) ??
        `Provided by bundle MCP server "${serverName}".`,
    });
  }
  return {
    catalog: {
      ...catalog,
      tools,
    },
    diagnostics,
  };
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const structuredContentBlock =
    params.result.structuredContent !== undefined
      ? ({
          type: "text",
          text: `structuredContent:\n${JSON.stringify(params.result.structuredContent, null, 2)}`,
        } as const)
      : null;
  // Structured MCP results are the canonical model payload here; replacing
  // mirrored content avoids duplicating large tool output in the prompt.
  const normalizedContent: AgentToolResult<unknown>["content"] = structuredContentBlock
    ? [structuredContentBlock]
    : content.length > 0
      ? content
      : ([
          {
            type: "text",
            text: JSON.stringify(
              {
                status: params.result.isError === true ? "error" : "ok",
                server: params.serverName,
                tool: params.toolName,
              },
              null,
              2,
            ),
          },
        ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  const { catalog } = sanitizeBundleMcpToolCatalog(params.catalog);
  return buildSanitizedBundleMcpToolsFromCatalog({ ...params, catalog });
}

function buildSanitizedBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const sortedCatalogTools = [...params.catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      execute:
        params.createExecute?.(tool) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
    });
    tools.push(agentTool);
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }
  const sanitized = sanitizeBundleMcpToolCatalog(catalog);
  const tools = buildSanitizedBundleMcpToolsFromCatalog({
    catalog: sanitized.catalog,
    reservedToolNames: params.reservedToolNames,
    createExecute: (tool) => async (_toolCallId: string, input: unknown) => {
      params.runtime.markUsed();
      const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
      return toAgentToolResult({
        serverName: tool.serverName,
        toolName: tool.toolName,
        result,
      });
    },
  });

  const diagnostics = [...(catalog.diagnostics ?? []), ...sanitized.diagnostics];
  return {
    tools,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./agent-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
  });
  return materialized;
}
