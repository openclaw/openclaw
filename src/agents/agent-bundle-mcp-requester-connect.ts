import { expectDefined } from "@openclaw/normalization-core/expect";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.types.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import { compareMcpCatalogTools } from "./agent-bundle-mcp-names.js";
import type { RequesterMcpConnect, SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
import type { McpOAuthLinkStart } from "./mcp-oauth-link.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import type { AgentToolResult } from "./runtime/index.js";

async function connectRequesterOAuthServer(params: {
  serverName: string;
  publicOrigin?: string;
  authorize: (
    redirectUrl: string,
  ) => ReturnType<(typeof import("./mcp-oauth.js"))["startMcpOAuthAuthorization"]>;
}): Promise<AgentToolResult<unknown>> {
  if (!params.publicOrigin) {
    const message =
      `MCP server "${params.serverName}" needs requester sign-in, but gateway.publicOrigin is not configured. ` +
      "Ask the operator to set the public Gateway HTTP(S) origin.";
    return {
      content: [{ type: "text", text: message }],
      details: { status: "error", error: message, mcpServer: params.serverName },
    };
  }
  const result = await params.authorize(new URL("/oauth/mcp/callback", params.publicOrigin).href);
  if (result.status === "authorized") {
    return {
      content: [
        {
          type: "text",
          text: `MCP server "${params.serverName}" is connected. Its tools become available on the next message.`,
        },
      ],
      details: { mcpServer: params.serverName },
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Connect MCP server "${params.serverName}" at ${result.authorizationUrl}\n` +
          "After sign-in completes, the server's tools become available on the next message.",
      },
    ],
    details: {
      mcpConnect: { serverName: params.serverName, authorizationUrl: result.authorizationUrl },
    },
  };
}

export function buildRequesterConnectCatalog(
  serverNames: Iterable<string>,
  safeServerNamesByServer: ReadonlyMap<string, string>,
  identity: "requester" | "operator" = "requester",
): McpToolCatalog {
  const entries = [...serverNames];
  return {
    version: 1,
    generatedAt: Date.now(),
    servers: Object.fromEntries(
      entries.map((serverName) => [
        serverName,
        {
          serverName,
          safeServerName: safeServerNamesByServer.get(serverName),
          launchSummary: identity === "requester" ? "Requester OAuth" : "Shared OAuth",
          toolCount: 1,
        },
      ]),
    ),
    tools: entries.map((serverName) => ({
      serverName,
      safeServerName: safeServerNamesByServer.get(serverName) ?? serverName,
      toolName: "connect",
      description:
        identity === "operator"
          ? `Connect your ${serverName} account or complete sign-in with a pasted callback URL.`
          : `Connect your ${serverName} account.`,
      fallbackDescription: `Connect your ${serverName} account.`,
      inputSchema:
        identity === "operator"
          ? Type.Object({
              callbackUrl: Type.Optional(
                Type.String({
                  description: "The redirect address pasted after approving sign-in.",
                }),
              ),
            })
          : Type.Object({}),
      oauthConnectBootstrap: true,
    })),
  };
}

export function listOAuthServers(
  serverNames: Iterable<string>,
  mcpServers: Record<string, BundleMcpServerConfig>,
  identity: "per-requester" | "shared" = "per-requester",
) {
  return [...serverNames]
    .toSorted((a, b) => a.localeCompare(b))
    .flatMap((serverName) => {
      const resolved = resolveMcpTransportConfig(serverName, mcpServers[serverName], {
        logWarnings: false,
      });
      return resolved?.kind === "http" &&
        resolved.auth === "oauth" &&
        (resolved.oauth?.identity === "per-requester") === (identity === "per-requester")
        ? [{ serverName, resolved }]
        : [];
    });
}

/** Shared sign-in returns a link, never credentials or an authorization claim. */
export function formatOperatorMcpOAuthLinkResult(
  result: McpOAuthLinkStart,
): AgentToolResult<unknown> {
  const text =
    result.status === "authorized"
      ? `MCP server "${result.serverName}" is connected. Send any message and I'll use ${result.serverName}.`
      : `Connect MCP server "${result.serverName}" at ${result.authorizationUrl}\n` +
        `After the page says you're connected, send any message and I'll use ${result.serverName}.` +
        (result.usesPublicOrigin
          ? ""
          : "\nIf the page doesn't load because you're on another device, paste the address from your browser here.");
  return {
    content: [{ type: "text", text }],
    details: {
      mcpServer: result.serverName,
      ...(result.status === "redirect"
        ? {
            mcpConnect: {
              serverName: result.serverName,
              authorizationUrl: result.authorizationUrl,
            },
          }
        : {}),
    },
  };
}

/**
 * The sign-in surface a requester sees before connecting, built from config
 * alone. Turns without a verified requester list it so their catalog matches.
 */
export function buildConfiguredRequesterConnectCatalog(params: {
  serverNames: Iterable<string>;
  mcpServers: Record<string, BundleMcpServerConfig>;
  safeServerNamesByServer: ReadonlyMap<string, string>;
}): McpToolCatalog | undefined {
  const configured = listOAuthServers(params.serverNames, params.mcpServers);
  return configured.length > 0
    ? buildRequesterConnectCatalog(
        configured.map(({ serverName }) => serverName),
        params.safeServerNamesByServer,
      )
    : undefined;
}

/** Builds the per-message requester sign-in surface without opening MCP transports. */
export async function createRequesterMcpConnect(params: {
  serverNames: ReadonlySet<string>;
  mcpServers: Record<string, BundleMcpServerConfig>;
  safeServerNamesByServer: ReadonlyMap<string, string>;
  requesterScope: SessionMcpRequesterScope;
  cfg?: OpenClawConfig;
  configFingerprint: string;
}): Promise<RequesterMcpConnect | undefined> {
  const configured = listOAuthServers(params.serverNames, params.mcpServers);
  if (configured.length === 0) {
    return undefined;
  }
  const { requesterMcpOAuthIdentity } = await import("./mcp-oauth-identity.js");
  const { readMcpOAuthCredentialsStatuses, startMcpOAuthAuthorization } =
    await import("./mcp-oauth.js");
  const identities = configured.map(({ serverName, resolved }) =>
    requesterMcpOAuthIdentity(serverName, resolved.url, params.requesterScope),
  );
  const statuses = await readMcpOAuthCredentialsStatuses(identities);
  const servers = new Map<string, () => Promise<AgentToolResult<unknown>>>();
  const authorizedServerNames: string[] = [];
  for (const [index, { serverName, resolved }] of configured.entries()) {
    const status = expectDefined(statuses[index], "requester MCP OAuth status");
    servers.set(serverName, () =>
      connectRequesterOAuthServer({
        serverName,
        publicOrigin: params.cfg?.gateway?.publicOrigin,
        authorize: (redirectUrl) =>
          startMcpOAuthAuthorization(
            requesterMcpOAuthIdentity(serverName, resolved.url, params.requesterScope),
            resolved,
            { redirectUrl },
          ),
      }),
    );
    if (status.state === "authorized") {
      authorizedServerNames.push(serverName);
    }
  }
  const configFingerprint = JSON.stringify({
    config: params.configFingerprint,
    authorizedServerNames,
    publicOrigin: params.cfg?.gateway?.publicOrigin,
  });
  return {
    catalog: buildRequesterConnectCatalog(servers.keys(), params.safeServerNamesByServer),
    authorizedServerNames,
    configFingerprint,
    createExecute: (serverName) => servers.get(serverName),
  };
}

/** Adds transient connect entries only for servers absent from the live catalog. */
export function mergeMcpConnectCatalog(
  liveCatalog: McpToolCatalog,
  requesterConnect?: RequesterMcpConnect,
): McpToolCatalog {
  const connectCatalog = requesterConnect?.catalog;
  if (!connectCatalog) {
    return liveCatalog;
  }
  const missingServerNames = new Set(
    Object.keys(connectCatalog.servers).filter(
      (serverName) => !Object.hasOwn(liveCatalog.servers, serverName),
    ),
  );
  if (missingServerNames.size === 0) {
    return liveCatalog;
  }
  return {
    ...liveCatalog,
    generatedAt: Math.max(liveCatalog.generatedAt, connectCatalog.generatedAt),
    servers: {
      ...liveCatalog.servers,
      ...Object.fromEntries(
        Object.entries(connectCatalog.servers).filter(([serverName]) =>
          missingServerNames.has(serverName),
        ),
      ),
    },
    tools: [
      ...liveCatalog.tools,
      ...connectCatalog.tools.filter((tool) => missingServerNames.has(tool.serverName)),
    ].toSorted(compareMcpCatalogTools),
  };
}
