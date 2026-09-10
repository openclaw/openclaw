import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import type {
  McpToolCatalog,
  RequesterMcpConnect,
  RequesterMcpConnectDelivery,
  SessionMcpRequesterScope,
} from "./agent-bundle-mcp-types.js";
import { requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthCredentialsStatus, startMcpOAuthAuthorization } from "./mcp-oauth.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import type { AgentToolResult } from "./runtime/index.js";

type RequesterOAuthServer = Extract<
  NonNullable<ReturnType<typeof resolveMcpTransportConfig>>,
  { kind: "http" }
>;

async function connectRequesterOAuthServer(params: {
  serverName: string;
  server: RequesterOAuthServer;
  requesterScope: SessionMcpRequesterScope;
  publicOrigin?: string;
  delivery?: RequesterMcpConnectDelivery;
  signal?: AbortSignal;
}): Promise<AgentToolResult<unknown>> {
  const failure = (message: string): AgentToolResult<unknown> => ({
    content: [{ type: "text", text: message }],
    details: { status: "error", error: message, mcpServer: params.serverName },
  });
  if (!params.publicOrigin) {
    const message =
      `MCP server "${params.serverName}" needs requester sign-in, but gateway.publicOrigin is not configured. ` +
      "Ask the operator to set the public Gateway HTTP(S) origin.";
    return failure(message);
  }
  const delivery = params.delivery;
  if (!delivery) {
    return failure(
      `MCP server "${params.serverName}" needs a private sign-in link, but private delivery is unavailable for this request. ` +
        "Ask the operator to enable a supported private messaging route for your account, then try connecting again.",
    );
  }
  const assertActive = () => {
    params.signal?.throwIfAborted();
    delivery.assertActive();
  };
  assertActive();
  let result: Awaited<ReturnType<typeof startMcpOAuthAuthorization>>;
  try {
    result = await startMcpOAuthAuthorization(
      requesterMcpOAuthIdentity(params.serverName, params.server.url, params.requesterScope),
      params.server,
      { redirectUrl: new URL("/oauth/mcp/callback", params.publicOrigin).href },
    );
  } catch {
    assertActive();
    // Provider errors can include the bearer authorization URL. Never put them
    // into a shared tool result, transcript, or public reply.
    return failure(
      `Could not prepare sign-in for MCP server "${params.serverName}". Try connecting again or ask the operator to check the server's OAuth configuration.`,
    );
  }
  assertActive();
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
  let sent: Awaited<ReturnType<RequesterMcpConnectDelivery["send"]>>;
  try {
    sent = await delivery.send({
      serverName: params.serverName,
      authorizationUrl: result.authorizationUrl,
      assertActive,
    });
  } catch {
    assertActive();
    sent = { status: "failed" };
  }
  assertActive();
  if (sent.status !== "sent") {
    return failure(
      `Could not privately deliver the sign-in link for MCP server "${params.serverName}". ` +
        "Allow private messages from this bot and ask the operator to check its private messaging access, then try connecting again. No sign-in link was posted to this conversation.",
    );
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Sent you a private message with the sign-in link for MCP server "${params.serverName}". ` +
          "Complete sign-in there, then return to this conversation. The server's tools become available on the next message.",
      },
    ],
    details: { mcpServer: params.serverName, status: "link-sent" },
  };
}

function buildRequesterConnectCatalog(
  servers: ReadonlyMap<string, RequesterOAuthServer>,
  safeServerNamesByServer: ReadonlyMap<string, string>,
): McpToolCatalog {
  const entries = [...servers.entries()];
  return {
    version: 1,
    generatedAt: Date.now(),
    servers: Object.fromEntries(
      entries.map(([serverName]) => [
        serverName,
        {
          serverName,
          safeServerName: safeServerNamesByServer.get(serverName),
          launchSummary: "Requester OAuth",
          toolCount: 1,
        },
      ]),
    ),
    tools: entries.map(([serverName]) => ({
      serverName,
      safeServerName: safeServerNamesByServer.get(serverName) ?? serverName,
      toolName: "connect",
      description: `Connect your ${serverName} account with a private sign-in message.`,
      fallbackDescription: `Connect your ${serverName} account with a private sign-in message.`,
      inputSchema: Type.Object({}),
    })),
  };
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
  const servers = new Map<string, RequesterOAuthServer>();
  const authorizedServerNames: string[] = [];
  for (const serverName of [...params.serverNames].toSorted((a, b) => a.localeCompare(b))) {
    const resolved = resolveMcpTransportConfig(serverName, params.mcpServers[serverName], {
      logWarnings: false,
    });
    if (
      resolved?.kind !== "http" ||
      resolved.auth !== "oauth" ||
      resolved.oauth?.identity !== "per-requester"
    ) {
      continue;
    }
    servers.set(serverName, resolved);
    const status = await readMcpOAuthCredentialsStatus(
      requesterMcpOAuthIdentity(serverName, resolved.url, params.requesterScope),
    );
    if (status.state === "authorized") {
      authorizedServerNames.push(serverName);
    }
  }
  if (servers.size === 0) {
    return undefined;
  }
  const configFingerprint = JSON.stringify({
    config: params.configFingerprint,
    authorizedServerNames,
    publicOrigin: params.cfg?.gateway?.publicOrigin,
  });
  return {
    catalog: buildRequesterConnectCatalog(servers, params.safeServerNamesByServer),
    authorizedServerNames,
    configFingerprint,
    createExecute(serverName, delivery) {
      const server = servers.get(serverName);
      return server
        ? async (_toolCallId, _input, signal) =>
            await connectRequesterOAuthServer({
              serverName,
              server,
              requesterScope: params.requesterScope,
              publicOrigin: params.cfg?.gateway?.publicOrigin,
              delivery,
              signal,
            })
        : undefined;
    },
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
    ].toSorted(
      (left, right) =>
        left.safeServerName.localeCompare(right.safeServerName) ||
        left.toolName.localeCompare(right.toolName) ||
        left.serverName.localeCompare(right.serverName),
    ),
  };
}
