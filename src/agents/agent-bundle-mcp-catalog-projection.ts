/** Projects MCP catalog metadata without owning transport or catalog lifetime. */
import type { Client, Tool } from "@modelcontextprotocol/client";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
} from "./agent-bundle-mcp-types.js";
import {
  readMcpAppIcons,
  readMcpAppSettingsCapability,
  readMcpAppToolExtensions,
} from "./mcp-app-extension-metadata.js";
import {
  normalizeMcpCodexToolAnnotations,
  resolveProjectedMcpCodexToolApprovalMode,
} from "./mcp-codex-tool-approval.js";
import {
  normalizeToolUiVisibility,
  sanitizeMcpMetadataText,
  summarizeServerCapabilities,
} from "./mcp-metadata.js";
import { isMcpToolAllowed, normalizeMcpToolFilter } from "./mcp-tool-filter.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

export function projectBundleMcpCatalogFailure(
  catalog: McpToolCatalog | undefined,
  diagnostic: McpToolCatalogDiagnostic,
): McpToolCatalog {
  return {
    ...(catalog ?? { version: 1, servers: {}, tools: [] }),
    generatedAt: Date.now(),
    diagnostics: [diagnostic],
  };
}

export function projectBundleMcpServerCatalog({
  serverName,
  safeServerName,
  launchDescription,
  rawServer,
  listedTools,
  schemaValidator,
  denialMap,
  capabilities,
  serverVersion,
  serverCapabilities,
  pluginId,
  connection,
}: {
  serverName: string;
  safeServerName: string;
  launchDescription: string;
  rawServer: McpServerConfig;
  listedTools: Tool[];
  schemaValidator: Parameters<typeof normalizeMcpToolCatalog>[1];
  denialMap: SessionToolOverrides["mcpToolsDeny"];
  capabilities: ReturnType<typeof summarizeServerCapabilities>;
  serverVersion: ReturnType<Client["getServerVersion"]>;
  serverCapabilities: ReturnType<Client["getServerCapabilities"]>;
  pluginId?: string;
  connection: { requestTimeoutMs: number; supportsParallelToolCalls: boolean };
}): { catalog: McpToolCatalog; metadata: ReturnType<typeof normalizeMcpToolCatalog>["metadata"] } {
  const toolFilter = normalizeMcpToolFilter(rawServer.toolFilter);
  const deniedToolNames = new Set(
    denialMap && Object.hasOwn(denialMap, serverName) ? denialMap[serverName] : [],
  );
  const normalizedTools = normalizeMcpToolCatalog(listedTools, schemaValidator, (toolName) => {
    if (!isMcpToolAllowed(toolFilter, toolName)) {
      return "exclude";
    }
    return deniedToolNames.has(toolName) ? "denied" : "include";
  });
  const exposedTools = normalizedTools.tools;
  const serverEntry: McpServerCatalog = {
    serverName,
    safeServerName,
    launchSummary: launchDescription,
    pluginId,
    title: serverVersion?.title,
    icons: readMcpAppIcons(serverVersion?.icons),
    settings: readMcpAppSettingsCapability(serverCapabilities),
    toolCount: exposedTools.length,
    requestTimeoutMs: connection.requestTimeoutMs,
    supportsParallelToolCalls: connection.supportsParallelToolCalls,
    ...(capabilities.resources ? { resources: capabilities.resources } : {}),
    ...(capabilities.prompts ? { prompts: capabilities.prompts } : {}),
    ...(capabilities.tools
      ? {
          tools: {
            ...capabilities.tools,
            ...(exposedTools.length !== listedTools.length
              ? { filteredCount: listedTools.length - exposedTools.length }
              : {}),
          },
        }
      : {}),
    ...(toolFilter ? { toolFilter } : {}),
    ...(deniedToolNames.size > 0 ? { deniedToolNames: [...deniedToolNames].toSorted() } : {}),
    codexApprovalMode: resolveProjectedMcpCodexToolApprovalMode(serverName, rawServer),
  };
  const toolEntries: McpCatalogTool[] = [];
  const policyToolEntries: McpCatalogTool[] = [];
  for (const [tool, excludedFromOpenClawCatalog, deniedBySession] of [
    ...normalizedTools.tools.map((entry) => [entry, false, false] as const),
    ...normalizedTools.deniedTools.map((entry) => [entry, false, true] as const),
    ...normalizedTools.excludedTools.map(
      (entry) => [entry, true, deniedToolNames.has(entry.name)] as const,
    ),
  ]) {
    const { _meta: metadata } = tool;
    const uiMeta = asOptionalRecord(metadata?.ui);
    const rawResourceUri = uiMeta?.resourceUri ?? metadata?.["ui/resourceUri"];
    const uiResourceUri =
      typeof rawResourceUri === "string" && rawResourceUri.startsWith("ui://")
        ? rawResourceUri
        : undefined;
    const uiVisibility = normalizeToolUiVisibility(uiMeta?.visibility);
    const entry: McpCatalogTool = {
      serverName,
      safeServerName,
      toolName: tool.name,
      title: tool.title ?? tool.annotations?.title,
      appExtensions: readMcpAppToolExtensions(tool),
      description: sanitizeMcpMetadataText(tool.description),
      inputSchema: tool.inputSchema,
      fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchDescription}).`,
      ...(uiResourceUri ? { uiResourceUri } : {}),
      ...(uiVisibility ? { uiVisibility } : {}),
      ...(excludedFromOpenClawCatalog ? { excludedFromOpenClawCatalog: true as const } : {}),
      ...(deniedBySession ? { deniedBySession: true } : {}),
      codexAnnotations: normalizeMcpCodexToolAnnotations(tool.annotations),
    };
    policyToolEntries.push(entry);
    if (!entry.excludedFromOpenClawCatalog) {
      toolEntries.push(entry);
    }
  }
  const projectedTools = {
    tools: toolEntries.filter((tool) => !tool.deniedBySession),
    policyTools: policyToolEntries,
    sessionDeniedTools: toolEntries.filter((tool) => tool.deniedBySession),
  };
  return {
    metadata: normalizedTools.metadata,
    catalog: {
      version: 1,
      generatedAt: Date.now(),
      servers: { [serverName]: serverEntry },
      ...projectedTools,
    },
  };
}
