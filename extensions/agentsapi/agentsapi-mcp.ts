import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import {
  decodeHeaderEnvPlaceholder,
  embeddedAgentLog,
  formatErrorMessage,
  loadAgentHarnessMcpConfig,
  resolveOpenClawMcpTransportAlias,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

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
  for (const name of loaded.requesterScopedServerNames) {
    skipUnsupportedServer(name, "requester-scoped connections are not supported");
  }
  return Object.entries(loaded.config.mcpServers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, server]) => {
      // Command-bearing definitions belong to the deferred executor stdio path.
      if (server.command || server.transport === "stdio" || server.type === "stdio") {
        return skipUnsupportedServer(name, "stdio forwarding is not supported");
      }
      if (typeof server.url !== "string" || !server.url.trim()) {
        return skipUnsupportedServer(name, "an HTTP URL is required");
      }
      const transport =
        normalizeLowercaseStringOrEmpty(server.transport) ||
        resolveOpenClawMcpTransportAlias(server.type) ||
        "sse";
      if (transport !== "streamable-http") {
        return skipUnsupportedServer(name, "an explicit Streamable HTTP transport is required");
      }
      if (server.auth === "oauth" || server.oauth) {
        return skipUnsupportedServer(
          name,
          "Gateway OAuth is not supported; configure HTTP authentication headers",
        );
      }
      if (server.clientCert || server.clientKey || server.sslVerify === false) {
        return skipUnsupportedServer(name, "custom TLS settings are not supported");
      }
      const filter = isRecord(server.toolFilter) ? server.toolFilter : {};
      const include = normalizeTrimmedStringList(filter.include);
      const exclude = [
        ...normalizeTrimmedStringList(filter.exclude),
        ...(params.toolOverrides?.mcpToolsDeny?.[name] ?? []),
      ];
      if ([...include, ...exclude].some((tool) => tool.includes("*"))) {
        return skipUnsupportedServer(name, "tool filters require exact tool names");
      }
      if (exclude.length && !include.length) {
        return skipUnsupportedServer(
          name,
          "toolFilter.include is required to enforce tool exclusions",
        );
      }
      const allowedTools = include.length
        ? include.filter((tool) => !exclude.includes(tool)).toSorted()
        : undefined;
      let headers: Record<string, string> | undefined;
      try {
        headers = resolveHeaders(name, server.headers);
      } catch (error) {
        return skipUnsupportedServer(name, formatErrorMessage(error));
      }
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

function skipUnsupportedServer(name: string, reason: string): never[] {
  embeddedAgentLog.error(`Agents API MCP server ${name} skipped: ${reason}`);
  return [];
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
