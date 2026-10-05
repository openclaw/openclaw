/** Projects MCP catalog metadata without owning transport or catalog lifetime. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-types.js";
import { readMcpAppToolExtensions } from "./mcp-app-extension-metadata.js";
import { normalizeMcpCodexToolAnnotations } from "./mcp-codex-tool-approval.js";
import { normalizeToolUiVisibility, sanitizeMcpMetadataText } from "./mcp-metadata.js";
import type { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

export function projectUnavailableBundleMcpCatalog(
  catalog: McpToolCatalog | null,
  serverName: string,
  message: string,
): McpToolCatalog | null {
  const server = catalog?.servers[serverName];
  const diagnostic =
    catalog?.diagnostics?.[0] ??
    (server
      ? {
          serverName,
          safeServerName: server.safeServerName ?? serverName,
          launchSummary: server.launchSummary,
          message,
        }
      : undefined);
  if (!diagnostic) {
    return null;
  }
  return {
    version: 1,
    generatedAt: Date.now(),
    servers: {},
    tools: [],
    diagnostics: [{ ...diagnostic, message }],
  };
}

export function projectBundleMcpCatalogTools({
  normalizedTools,
  deniedToolNames,
  serverName,
  safeServerName,
  launchDescription,
}: {
  normalizedTools: ReturnType<typeof normalizeMcpToolCatalog>;
  deniedToolNames: ReadonlySet<string>;
  serverName: string;
  safeServerName: string;
  launchDescription: string;
}): Pick<McpToolCatalog, "tools" | "policyTools" | "sessionDeniedTools"> {
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
  return {
    tools: toolEntries.filter((tool) => !tool.deniedBySession),
    policyTools: policyToolEntries,
    sessionDeniedTools: toolEntries.filter((tool) => tool.deniedBySession),
  };
}
