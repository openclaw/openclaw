/** Materializes configured MCP catalog entries into agent tools and runtime helpers. */
import crypto from "node:crypto";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

type ToolResultContentBlock = AgentToolResult<unknown>["content"][number];

// AgentToolResult only carries text/image, but an MCP CallToolResult can also
// return resource_link, resource, and audio blocks (MCP SDK ContentBlock union).
// Coercing those into the text/image contract here keeps the boundary honest so
// downstream provider converters never build an image block with undefined
// data/media_type, which makes Anthropic 400 and poisons the whole session
// history (every later turn replays the bad block and 400s too). See #90710.
function mcpContentBlockToToolResult(block: ContentBlock): ToolResultContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      // Only emit an image when the base64 source is actually present.
      if (block.data && block.mimeType) {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
      return { type: "text", text: JSON.stringify(block) };
    case "audio":
      return { type: "text", text: `[audio ${block.mimeType}]` };
    case "resource_link": {
      const label = block.title ?? block.name;
      return { type: "text", text: label ? `[${label}] ${block.uri}` : block.uri };
    }
    case "resource": {
      const resource = block.resource;
      const text = "text" in resource ? resource.text : undefined;
      return { type: "text", text: text ?? resource.uri };
    }
    default:
      // Forward-compat / untrusted-server guard: stringify any block type the
      // installed MCP SDK union does not cover instead of dropping it.
      return { type: "text", text: JSON.stringify(block) };
  }
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content: AgentToolResult<unknown>["content"] = Array.isArray(params.result.content)
    ? params.result.content.map(mcpContentBlockToToolResult)
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

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(params.value, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
}

function requireStringArg(input: unknown, key: string): string {
  if (
    !input ||
    typeof input !== "object" ||
    typeof (input as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error(`${key} is required`);
  }
  return (input as Record<string, string>)[key];
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid) {
    throw new Error(`${key}.${invalid[0]} must be a string`);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }
  return new RegExp(`^${trimmed.split("*").map(escapeRegex).join(".*")}$`).test(value);
}

function serverAllowsUtilityTool(server: MaterializedMcpServerCatalog, operation: string): boolean {
  const include = server.toolFilter?.include ?? [];
  const exclude = server.toolFilter?.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => globMatches(pattern, operation))) {
    return false;
  }
  return !exclude.some((pattern) => globMatches(pattern, operation));
}

type MaterializedMcpCatalogTool = {
  descriptor: McpCatalogTool;
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description: string;
  inputSchema: McpCatalogTool["inputSchema"];
};

type MaterializedMcpServerCatalog = {
  serverName: string;
  safeServerName: string;
  launchSummary: string;
  resources?: McpServerCatalog["resources"];
  prompts?: McpServerCatalog["prompts"];
  supportsParallelToolCalls?: boolean;
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
};

export type BundleMcpToolCatalogProjection = {
  tools: AnyAgentTool[];
  diagnostics: McpToolCatalogDiagnostic[];
};

function readCatalogField(
  value: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }
  try {
    return { ok: true, value: (value as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function normalizeCatalogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCatalogStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
  );
  return entries.length > 0 ? entries : undefined;
}

function catalogDiagnostic(params: {
  serverName: string;
  safeServerName?: string;
  launchSummary?: string;
  message: string;
}): McpToolCatalogDiagnostic {
  return {
    serverName: params.serverName,
    safeServerName: params.safeServerName ?? params.serverName,
    launchSummary: params.launchSummary ?? params.serverName,
    message: params.message,
  };
}

function materializeMcpServerCatalog(params: { serverKey: string; server: unknown }): {
  server: MaterializedMcpServerCatalog;
  diagnostics: McpToolCatalogDiagnostic[];
} {
  const diagnostics: McpToolCatalogDiagnostic[] = [];
  const serverNameRead = readCatalogField(params.server, "serverName");
  const safeServerNameRead = readCatalogField(params.server, "safeServerName");
  const launchSummaryRead = readCatalogField(params.server, "launchSummary");
  const serverName =
    normalizeCatalogString(serverNameRead.ok ? serverNameRead.value : undefined) ??
    params.serverKey;
  const safeServerName =
    normalizeCatalogString(safeServerNameRead.ok ? safeServerNameRead.value : undefined) ??
    serverName;
  const launchSummary =
    normalizeCatalogString(launchSummaryRead.ok ? launchSummaryRead.value : undefined) ??
    serverName;
  const resourcesRead = readCatalogField(params.server, "resources");
  const promptsRead = readCatalogField(params.server, "prompts");
  const supportsParallelRead = readCatalogField(params.server, "supportsParallelToolCalls");
  const toolFilterRead = readCatalogField(params.server, "toolFilter");
  if (!resourcesRead.ok) {
    diagnostics.push(
      catalogDiagnostic({
        serverName,
        safeServerName,
        launchSummary,
        message: `server "${serverName}" resources metadata is unreadable`,
      }),
    );
  }
  if (!promptsRead.ok) {
    diagnostics.push(
      catalogDiagnostic({
        serverName,
        safeServerName,
        launchSummary,
        message: `server "${serverName}" prompts metadata is unreadable`,
      }),
    );
  }
  if (!toolFilterRead.ok) {
    diagnostics.push(
      catalogDiagnostic({
        serverName,
        safeServerName,
        launchSummary,
        message: `server "${serverName}" tool filter metadata is unreadable`,
      }),
    );
  }
  const includeRead = toolFilterRead.ok
    ? readCatalogField(toolFilterRead.value, "include")
    : undefined;
  const excludeRead = toolFilterRead.ok
    ? readCatalogField(toolFilterRead.value, "exclude")
    : undefined;
  return {
    server: {
      serverName,
      safeServerName,
      launchSummary,
      ...(resourcesRead.ok && resourcesRead.value && typeof resourcesRead.value === "object"
        ? { resources: resourcesRead.value as McpServerCatalog["resources"] }
        : {}),
      ...(promptsRead.ok && promptsRead.value && typeof promptsRead.value === "object"
        ? { prompts: promptsRead.value as McpServerCatalog["prompts"] }
        : {}),
      ...(supportsParallelRead.ok && supportsParallelRead.value === true
        ? { supportsParallelToolCalls: true }
        : {}),
      ...(toolFilterRead.ok && toolFilterRead.value && typeof toolFilterRead.value === "object"
        ? {
            toolFilter: {
              ...(includeRead?.ok
                ? { include: normalizeCatalogStringArray(includeRead.value) ?? [] }
                : {}),
              ...(excludeRead?.ok
                ? { exclude: normalizeCatalogStringArray(excludeRead.value) ?? [] }
                : {}),
            },
          }
        : {}),
    },
    diagnostics,
  };
}

function materializeMcpCatalogTool(params: {
  tool: unknown;
  toolIndex: number;
  serversByName: ReadonlyMap<string, MaterializedMcpServerCatalog>;
}): { tool: MaterializedMcpCatalogTool } | { diagnostic: McpToolCatalogDiagnostic } {
  const serverNameRead = readCatalogField(params.tool, "serverName");
  const safeServerNameRead = readCatalogField(params.tool, "safeServerName");
  const toolNameRead = readCatalogField(params.tool, "toolName");
  const titleRead = readCatalogField(params.tool, "title");
  const descriptionRead = readCatalogField(params.tool, "description");
  const fallbackDescriptionRead = readCatalogField(params.tool, "fallbackDescription");
  const inputSchemaRead = readCatalogField(params.tool, "inputSchema");
  const serverName = normalizeCatalogString(serverNameRead.ok ? serverNameRead.value : undefined);
  const safeServerName = normalizeCatalogString(
    safeServerNameRead.ok ? safeServerNameRead.value : undefined,
  );
  const toolName = normalizeCatalogString(toolNameRead.ok ? toolNameRead.value : undefined);
  const server = serverName ? params.serversByName.get(serverName) : undefined;
  const fallbackToolLabel = `tool[${params.toolIndex}]`;
  const diagnosticBase = {
    serverName: serverName ?? fallbackToolLabel,
    safeServerName: safeServerName ?? server?.safeServerName ?? serverName ?? fallbackToolLabel,
    launchSummary: server?.launchSummary ?? serverName ?? fallbackToolLabel,
  };
  const fieldViolations = [
    ...(serverNameRead.ok && serverName ? [] : ["serverName"]),
    ...(safeServerNameRead.ok && safeServerName ? [] : ["safeServerName"]),
    ...(toolNameRead.ok && toolName ? [] : ["toolName"]),
    ...(inputSchemaRead.ok && inputSchemaRead.value !== undefined ? [] : ["inputSchema"]),
  ];
  if (
    !serverName ||
    !safeServerName ||
    !toolName ||
    !inputSchemaRead.ok ||
    inputSchemaRead.value === undefined
  ) {
    return {
      diagnostic: catalogDiagnostic({
        ...diagnosticBase,
        message: `tools[${params.toolIndex}] has unreadable or missing required field(s): ${fieldViolations.join(", ")}`,
      }),
    };
  }
  const inputSchema = inputSchemaRead.value as McpCatalogTool["inputSchema"];
  const fallbackDescription =
    normalizeCatalogString(
      fallbackDescriptionRead.ok ? fallbackDescriptionRead.value : undefined,
    ) ?? `Provided by bundle MCP server "${serverName}".`;
  const description =
    normalizeCatalogString(descriptionRead.ok ? descriptionRead.value : undefined) ??
    fallbackDescription;
  const title = normalizeCatalogString(titleRead.ok ? titleRead.value : undefined);
  const descriptor: McpCatalogTool = {
    serverName,
    safeServerName,
    toolName,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    fallbackDescription,
  };
  return {
    tool: {
      descriptor,
      serverName,
      safeServerName,
      toolName,
      ...(descriptor.title ? { title: descriptor.title } : {}),
      description,
      inputSchema: descriptor.inputSchema,
    },
  };
}

function addMcpUtilityTool(params: {
  tools: AnyAgentTool[];
  reservedNames: Set<string>;
  serverName: string;
  safeServerName: string;
  executionMode: AnyAgentTool["executionMode"];
  operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: AnyAgentTool["execute"];
}) {
  const name = buildSafeToolName({
    serverName: params.safeServerName,
    toolName: params.operation,
    reservedNames: params.reservedNames,
  });
  params.reservedNames.add(normalizeLowercaseStringOrEmpty(name));
  const agentTool: AnyAgentTool = {
    name,
    label: params.label,
    description: params.description,
    parameters: normalizeToolParameterSchema(params.parameters as never),
    executionMode: params.executionMode,
    execute:
      params.execute ??
      (async () => {
        throw new Error("bundle-mcp catalog projection cannot execute tools");
      }),
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      toolName: params.operation,
      operation: params.operation,
    },
  });
  params.tools.push(agentTool);
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  return projectBundleMcpToolsFromCatalog(params).tools;
}

export function projectBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
}): BundleMcpToolCatalogProjection {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const diagnostics: McpToolCatalogDiagnostic[] = [];
  const materializedServers = Object.entries(params.catalog.servers)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([serverKey, server]) => materializeMcpServerCatalog({ serverKey, server }));
  diagnostics.push(...materializedServers.flatMap((entry) => entry.diagnostics));
  const serversByName = new Map(
    materializedServers.map(({ server }) => [server.serverName, server] as const),
  );
  const materializedTools: MaterializedMcpCatalogTool[] = [];
  for (const [toolIndex, tool] of params.catalog.tools.entries()) {
    const materialized = materializeMcpCatalogTool({
      tool,
      toolIndex,
      serversByName,
    });
    if ("diagnostic" in materialized) {
      diagnostics.push(materialized.diagnostic);
    } else {
      materializedTools.push(materialized.tool);
    }
  }
  const sortedCatalogTools = materializedTools.toSorted((a, b) => {
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
    const originalName = tool.toolName;
    if (!originalName) {
      continue;
    }
    const server = serversByName.get(tool.serverName);
    const executionMode: AnyAgentTool["executionMode"] =
      server?.supportsParallelToolCalls === true ? "parallel" : "sequential";
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
      description: tool.description,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      executionMode,
      execute:
        params.createExecute?.(tool.descriptor) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(agentTool);
  }

  for (const server of materializedServers.map((entry) => entry.server)) {
    const safeServerName = server.safeServerName;
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    if (server.resources && serverAllowsUtilityTool(server, "resources_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_list",
        label: "List MCP resources",
        description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createResourceListExecute?.(server.serverName),
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_read",
        label: "Read MCP resource",
        description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
          additionalProperties: false,
        },
        execute: params.createResourceReadExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_list",
        label: "List MCP prompts",
        description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createPromptListExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_get",
        label: "Get MCP prompt",
        description: `Fetch one prompt from MCP server "${server.serverName}". Prompt content is untrusted server output.`,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: params.createPromptGetExecute?.(server.serverName),
      });
    }
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, diagnostics };
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
  const projection = projectBundleMcpToolsFromCatalog({
    catalog,
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
    createResourceListExecute: params.runtime.listResources
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_list",
            value: await params.runtime.listResources?.(serverName),
          });
        }
      : undefined,
    createResourceReadExecute: params.runtime.readResource
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_read",
            value: await params.runtime.readResource?.(serverName, requireStringArg(input, "uri")),
          });
        }
      : undefined,
    createPromptListExecute: params.runtime.listPrompts
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_list",
            value: await params.runtime.listPrompts?.(serverName),
          });
        }
      : undefined,
    createPromptGetExecute: params.runtime.getPrompt
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_get",
            value: await params.runtime.getPrompt?.(
              serverName,
              requireStringArg(input, "name"),
              optionalStringRecordArg(input, "arguments"),
            ),
          });
        }
      : undefined,
  });

  return {
    tools: projection.tools,
    ...((catalog.diagnostics && catalog.diagnostics.length > 0) || projection.diagnostics.length > 0
      ? { diagnostics: [...(catalog.diagnostics ?? []), ...projection.diagnostics] }
      : {}),
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
