import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";

/** Identity of one principal's OAuth state for one MCP server. */
export type McpOAuthIdentity = {
  storeKey: string;
  principal: "operator" | "requester";
  serverName: string;
  serverUrl: string;
  /**
   * Whether operator config `mcp.servers` defines this server (only those resolve in
   * `openclaw mcp login`); false means a plugin declares it, absent means unknown.
   */
  configured?: boolean;
};

/** Pass `cfg` when known so sign-in errors can name the CLI for `mcp.servers` entries. */
export function operatorMcpOAuthIdentity(
  serverName: string,
  serverUrl: string,
  cfg?: OpenClawConfig,
): McpOAuthIdentity {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const hash = sha256Hex(`${serverName}\0${serverUrl}`);
  return {
    storeKey: `${safeServerName}-${hash.slice(0, 16)}`,
    principal: "operator",
    serverName,
    serverUrl,
    ...(cfg ? { configured: Object.hasOwn(cfg.mcp?.servers ?? {}, serverName) } : {}),
  };
}

/**
 * Terminal sign-in steps, or undefined when the CLI cannot sign in: `openclaw mcp login`
 * runs offline only and resolves only operator `mcp.servers`, never plugin-declared servers.
 */
export function mcpOAuthCliLoginSteps(identity: McpOAuthIdentity): string | undefined {
  if (identity.principal !== "operator" || !identity.configured) {
    return undefined;
  }
  const login = formatCliCommand(`openclaw mcp login ${quoteCliArg(identity.serverName)}`);
  return `stop the Gateway with ${formatCliCommand("openclaw gateway stop")}, run ${login}, then start the Gateway again`;
}

/** Recovery sentence for MCP OAuth credential errors. */
export function mcpOAuthSignInHint(identity: McpOAuthIdentity): string {
  if (identity.principal === "requester") {
    return "Reconnect from the channel through the MCP connect flow.";
  }
  const steps = mcpOAuthCliLoginSteps(identity);
  if (steps) {
    return `Sign in from Settings → MCP, or from the Gateway's terminal: ${steps}.`;
  }
  return identity.configured === false
    ? "Select Connect on the plugin's page in Settings to sign in again."
    : "Sign in again from Settings: select Connect on the plugin's page, or Sign in on the MCP page.";
}

export function requesterMcpOAuthIdentity(
  serverName: string,
  serverUrl: string,
  scope: SessionMcpRequesterScope,
): McpOAuthIdentity {
  const operator = operatorMcpOAuthIdentity(serverName, serverUrl);
  // The requester tuple intentionally excludes session identity. Changing this
  // grammar would either leak credentials across principals or strand stored rows.
  const requesterHash = sha256Hex(
    `${scope.messageChannel ?? ""}\0${scope.agentAccountId ?? ""}\0${scope.requesterSenderId}`,
  );
  return {
    ...operator,
    storeKey: `${operator.storeKey}-r-${requesterHash.slice(0, 16)}`,
    principal: "requester",
  };
}

export function requesterMcpOAuthStoreKeyPrefix(serverName: string, serverUrl: string): string {
  return `${operatorMcpOAuthIdentity(serverName, serverUrl).storeKey}-r-`;
}

export function mcpOAuthStoreKeyFromLegacyFileName(fileName: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_-]{0,29}-[0-9a-f]{16}\.json$/u.test(fileName)
    ? fileName.slice(0, -".json".length)
    : null;
}
