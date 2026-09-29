import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import {
  decodeHeaderEnvPlaceholder,
  embeddedAgentLog,
  loadAgentHarnessMcpConfig,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord, normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";

export async function buildAgentsApiMcpTools(
  params: AgentHarnessAttemptParamsV2,
): Promise<AgentToolParam.AgentToolConfigParamMcp[]> {
  const loaded = await loadAgentHarnessMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolOverrides: params.toolOverrides,
  });
  for (const diagnostic of loaded.diagnostics) {
    embeddedAgentLog.warn(`Agents API MCP: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (loaded.requesterScopedServerNames.length) {
    embeddedAgentLog.warn(
      `Agents API does not support requester-scoped MCP connections: ${loaded.requesterScopedServerNames.join(", ")}`,
    );
  }
  return Object.entries(loaded.config.mcpServers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, server]) => {
      // Command-bearing definitions belong to the deferred executor stdio path.
      if (server.command || server.transport === "stdio" || server.type === "stdio") {
        return [];
      }
      if (typeof server.url !== "string" || !server.url.trim()) {
        return [];
      }
      if (server.transport === "sse" || server.type === "sse") {
        throw new Error(`Agents API MCP server ${name} requires Streamable HTTP, not legacy SSE`);
      }
      if (server.auth === "oauth" || server.oauth) {
        throw new Error(
          `Agents API MCP server ${name} cannot use Gateway OAuth; configure HTTP authentication headers`,
        );
      }
      if (server.clientCert || server.clientKey || server.sslVerify === false) {
        throw new Error(`Agents API MCP server ${name} cannot forward custom TLS settings`);
      }
      const filter = isRecord(server.toolFilter) ? server.toolFilter : {};
      const include = normalizeTrimmedStringList(filter.include);
      const exclude = [
        ...normalizeTrimmedStringList(filter.exclude),
        ...(params.toolOverrides?.mcpToolsDeny?.[name] ?? []),
      ];
      if ([...include, ...exclude].some((tool) => tool.includes("*"))) {
        throw new Error(`Agents API MCP server ${name} requires exact tool names in tool filters`);
      }
      if (exclude.length && !include.length) {
        throw new Error(
          `Agents API MCP server ${name} requires toolFilter.include to enforce tool exclusions`,
        );
      }
      const allowedTools = include.length
        ? include.filter((tool) => !exclude.includes(tool)).toSorted()
        : undefined;
      const headers = resolveHeaders(name, server.headers);
      return [
        {
          type: "mcp",
          server_label: name,
          transport: {
            type: "http",
            server_url: server.url,
            ...(headers && { headers }),
          },
          // Preserve executor-local network reachability for configured services.
          connection_origin: "environment",
          required: true,
          ...(allowedTools && { allowed_tools: allowedTools }),
        } satisfies AgentToolParam.AgentToolConfigParamMcp,
      ];
    });
}

function resolveHeaders(serverName: string, raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`Agents API MCP server ${serverName} requires an object of HTTP headers`);
  }
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`Agents API MCP server ${serverName} has an invalid HTTP header ${name}`);
      }
      const text = String(value);
      const placeholder = decodeHeaderEnvPlaceholder(text);
      if (!placeholder) {
        return [name, text];
      }
      const resolved = process.env[placeholder.envVar];
      if (!resolved) {
        throw new Error(
          `Agents API MCP server ${serverName} requires environment variable ${placeholder.envVar}`,
        );
      }
      return [name, placeholder.bearer ? `Bearer ${resolved}` : resolved];
    }),
  );
}
