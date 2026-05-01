import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";

/**
 * Default HTTP headers merged onto remote MCP servers (`url` transport) when an
 * owner-trusted layer opts that server in via `injectCallerContext: true`.
 * Values use `${VAR}` placeholders expanded by CLI backends from the prepared
 * run environment.
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
 * Adds OpenClaw caller identity headers to bundled HTTP/SSE MCP servers whose
 * NAME appears in `trustedServerNames`. Trust is decided by the caller (owner
 * config + OpenClaw runtime layers), NOT by the merged config — so plugin
 * `.mcp.json` entries cannot smuggle caller identity to a URL of their choice
 * just by setting `injectCallerContext: true`.
 *
 * `injectCallerContext` is always stripped from the emitted config, regardless
 * of source layer, so it never leaks downstream.
 *
 * Header merging is non-destructive and value-preserving:
 *  - The original `headers` object is copied verbatim, so non-string values
 *    permitted by `McpServerConfig.headers` (numbers, booleans) survive.
 *  - Caller placeholders are only added for header names not already present
 *    (compared case-insensitively, matching HTTP semantics) so a user-supplied
 *    `X-Session-Key` blocks the lowercase `x-session-key` injection.
 */
export function applyBundleMcpCallerContext(
  mergedConfig: BundleMcpConfig,
  trustedServerNames: ReadonlySet<string>,
): BundleMcpConfig {
  const mcpServers: BundleMcpConfig["mcpServers"] = {};
  for (const [name, raw] of Object.entries(mergedConfig.mcpServers)) {
    const server = { ...raw } as Record<string, unknown>;
    delete server.injectCallerContext;

    if (!trustedServerNames.has(name)) {
      mcpServers[name] = server as BundleMcpServerConfig;
      continue;
    }
    if (!hasRemoteMcpUrl(server as BundleMcpServerConfig)) {
      mcpServers[name] = server as BundleMcpServerConfig;
      continue;
    }

    const existingHeaders = isRecord(server.headers) ? server.headers : undefined;
    const existingLowercased = new Set(
      existingHeaders ? Object.keys(existingHeaders).map((key) => key.toLowerCase()) : [],
    );
    const headers: Record<string, unknown> = existingHeaders ? { ...existingHeaders } : {};
    for (const [headerName, placeholder] of Object.entries(OPENCLAW_MCP_CALLER_HEADERS)) {
      if (!existingLowercased.has(headerName.toLowerCase())) {
        headers[headerName] = placeholder;
      }
    }
    server.headers = headers;
    mcpServers[name] = server as BundleMcpServerConfig;
  }
  return { mcpServers };
}
