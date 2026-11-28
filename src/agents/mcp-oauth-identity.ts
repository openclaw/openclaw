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
   * Whether operator config `mcp.servers` defines this server; false means a
   * plugin declares it, absent means unknown. Plugin CLI sign-in requires a running Gateway.
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

/** Terminal sign-in guidance for shared OAuth, including plugin servers while online. */
export function mcpOAuthCliLoginSteps(identity: McpOAuthIdentity): string | undefined {
  if (identity.principal !== "operator") {
    return undefined;
  }
  const login = formatCliCommand(`openclaw mcp login ${quoteCliArg(identity.serverName)}`);
  return `run ${login} (works while the Gateway runs), or ask the agent to connect in a direct chat`;
}

function mcpOAuthSettingsHint(identity: McpOAuthIdentity): string {
  return identity.configured === false
    ? "Select Connect on the plugin's page in Settings"
    : "Sign in from Settings → MCP";
}

/** Name-free recovery for the bounded model notice; the full error retains the CLI command. */
function mcpOAuthPromptSignInHint(identity: McpOAuthIdentity): string {
  return identity.principal === "requester"
    ? "Reconnect from the channel through the MCP connect flow."
    : `${mcpOAuthSettingsHint(identity)}, or ask the agent to connect in a direct chat.`;
}

/** Recovery sentence for MCP OAuth credential errors. */
function mcpOAuthSignInHint(identity: McpOAuthIdentity): string {
  if (identity.principal === "requester") {
    return mcpOAuthPromptSignInHint(identity);
  }
  const steps = mcpOAuthCliLoginSteps(identity);
  return `${mcpOAuthSettingsHint(identity)}, or from the Gateway's terminal: ${steps}.`;
}

/** Preserve the operator error while carrying a compact model-facing recovery fact. */
export class McpOAuthDiagnosticError extends Error {
  readonly promptMessage: string;

  constructor(identity: McpOAuthIdentity, reason: string) {
    super(`MCP server "${identity.serverName}" ${reason} ${mcpOAuthSignInHint(identity)}`);
    this.promptMessage = `${reason} ${mcpOAuthPromptSignInHint(identity)}`;
  }
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
