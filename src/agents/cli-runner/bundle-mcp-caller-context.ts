import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { normalizeStringRecord } from "./bundle-mcp-adapter-shared.js";

/**
 * Default HTTP headers merged onto remote MCP servers (`url` transport) when that
 * entry has `injectCallerContext: true`. Values use `${VAR}` placeholders expanded
 * by CLI backends from the prepared run environment.
 */
export const OPENCLAW_MCP_CALLER_HEADERS: Record<string, string> = {
  "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
  "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
  "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
  "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
};

function hasRemoteMcpUrl(server: BundleMcpServerConfig): boolean {
  return typeof server.url === "string" && server.url.trim().length > 0;
}

/**
 * Adds OpenClaw caller identity headers to bundled HTTP/SSE MCP servers that
 * set `injectCallerContext: true`. Strips `injectCallerContext` from each server
 * before returning. Existing header names are not overwritten.
 */
export function applyBundleMcpCallerContext(mergedConfig: BundleMcpConfig): BundleMcpConfig {
  const mcpServers: BundleMcpConfig["mcpServers"] = {};
  for (const [name, raw] of Object.entries(mergedConfig.mcpServers)) {
    const server = { ...raw } as Record<string, unknown>;
    const inject = server.injectCallerContext === true;
    delete server.injectCallerContext;

    if (!hasRemoteMcpUrl(server as BundleMcpServerConfig)) {
      mcpServers[name] = server as BundleMcpServerConfig;
      continue;
    }
    if (!inject) {
      mcpServers[name] = server as BundleMcpServerConfig;
      continue;
    }

    const existing = normalizeStringRecord(server.headers) ?? {};
    const headers = { ...existing };
    for (const [headerName, placeholder] of Object.entries(OPENCLAW_MCP_CALLER_HEADERS)) {
      if (!(headerName in headers)) {
        headers[headerName] = placeholder;
      }
    }
    server.headers = headers;
    mcpServers[name] = server as BundleMcpServerConfig;
  }
  return { mcpServers };
}
