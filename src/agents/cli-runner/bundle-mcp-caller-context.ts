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

/**
 * Adds OpenClaw caller identity headers to bundled HTTP/SSE MCP servers whose
 * NAME appears in `trustedServerUrls` AND whose merged `url` exactly matches
 * the URL the owner-trusted layer declared for that name.
 *
 * Trust is decided by the caller (owner config + OpenClaw runtime layers),
 * NOT by the merged config — so plugin `.mcp.json` entries cannot smuggle
 * caller identity to a URL of their choice just by setting
 * `injectCallerContext: true`. The post-merge URL match also blocks the case
 * where an unrelated earlier merge layer supplied a different URL for the
 * same name as an owner opt-in: if the merged URL has been changed, no
 * caller headers are injected.
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
  trustedServerUrls: ReadonlyMap<string, string>,
): BundleMcpConfig {
  const mcpServers: BundleMcpConfig["mcpServers"] = {};
  for (const [name, raw] of Object.entries(mergedConfig.mcpServers)) {
    const server = { ...raw } as Record<string, unknown>;
    delete server.injectCallerContext;

    const trustedUrl = trustedServerUrls.get(name);
    if (trustedUrl === undefined) {
      mcpServers[name] = server as BundleMcpServerConfig;
      continue;
    }
    // Defense in depth: even though owner-managed config is the rightmost
    // scalar in deep merge-patch (so its `url` should win), still require
    // exact equality between the trusted URL and the merged URL before
    // attaching caller identity. If something stripped or changed the URL
    // along the way, refuse to inject.
    const mergedUrl = server.url;
    if (typeof mergedUrl !== "string" || mergedUrl !== trustedUrl) {
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
