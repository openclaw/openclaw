import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";

/** Identity of one principal's OAuth state for one MCP server. */
export type McpOAuthIdentity = {
  storeKey: string;
  principal: "operator" | "requester";
  serverName: string;
  serverUrl: string;
};

export function operatorMcpOAuthIdentity(serverName: string, serverUrl: string): McpOAuthIdentity {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const hash = sha256Hex(`${serverName}\0${serverUrl}`);
  return {
    storeKey: `${safeServerName}-${hash.slice(0, 16)}`,
    principal: "operator",
    serverName,
    serverUrl,
  };
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
