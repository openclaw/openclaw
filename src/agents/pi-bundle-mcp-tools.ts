import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";

type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

type BundleMcpTransportType = "stdio" | "sse" | "streamable-http";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: BundleMcpTransportType;
  detachStderr?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function listAllTools(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const normalizedContent: AgentToolResult<unknown>["content"] =
    content.length > 0
      ? content
      : params.result.structuredContent !== undefined
        ? [
            {
              type: "text",
              text: JSON.stringify(params.result.structuredContent, null, 2),
            },
          ]
        : ([
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: params.result.isError === true ? "error" : "ok",
                  server: params.serverName,
                  tool: params.toolName,
                },
                null,
                2,
              ),
            },
          ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    for (const key of u.searchParams.keys()) {
      u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_.-]/g;
const TOOL_NAME_MAX_PREFIX = 30;
// Must match TOOL_CALL_NAME_MAX_CHARS in session-transcript-repair.ts
const TOOL_NAME_MAX_TOTAL = 64;

function sanitizeServerName(raw: string): string {
  const cleaned = raw.trim().replace(TOOL_NAME_SAFE_RE, "-");
  if (cleaned.length > TOOL_NAME_MAX_PREFIX) {
    return cleaned.slice(0, TOOL_NAME_MAX_PREFIX);
  }
  return cleaned || "mcp";
}

function resolveHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\$\{(\w+)\}/g, (_, envVar: string) => {
      const val = process.env[envVar];
      if (!val) {
        logWarn(`bundle-mcp: header "${key}": env var ${envVar} is not set`);
        return "";
      }
      return val;
    });
  }
  return resolved;
}

async function createHttpSession(
  serverName: string,
  config: { url: string; transport: string; headers?: Record<string, string> },
): Promise<{ client: Client; transport: Transport; transportType: BundleMcpTransportType }> {
  const url = new URL(config.url);
  const headers = resolveHeaders(config.headers);

  let transport: Transport;
  let transportType: BundleMcpTransportType;

  if (config.transport === "streamable-http") {
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    transportType = "streamable-http";
  } else if (config.transport === "sse") {
    transport = new SSEClientTransport(url, {
      requestInit: { headers },
    });
    transportType = "sse";
  } else {
    throw new Error(
      `unknown transport "${config.transport}" — use "streamable-http" or "sse"`,
    );
  }

  const client = new Client(
    { name: `openclaw-mcp-${serverName}`, version: "1.0.0" },
    {},
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
  return { client, transport, transportType };
}

function attachStderrLogging(serverName: string, transport: StdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message = String(chunk).trim();
    if (!message) {
      return;
    }
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  stderr.on("data", onData);
  return () => {
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
    }
  };
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  if (session.transportType === "streamable-http") {
    await (session.transport as StreamableHTTPClientTransport)
      .terminateSession()
      .catch(() => {});
  }
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
}

function resolveHttpServerConfig(
  rawServer: unknown,
): { ok: true; url: string; transport: string; headers?: Record<string, string> } | { ok: false; reason: string } {
  if (!isRecord(rawServer)) {
    return { ok: false, reason: "server config must be an object" };
  }
  const url = rawServer.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, reason: "url is missing or empty" };
  }
  const transport = rawServer.transport;
  if (typeof transport !== "string" || (transport !== "sse" && transport !== "streamable-http")) {
    return {
      ok: false,
      reason: `HTTP MCP server requires explicit transport: "streamable-http" or "sse" (got ${JSON.stringify(transport)})`,
    };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  const headers = isRecord(rawServer.headers)
    ? Object.fromEntries(
        Object.entries(rawServer.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  return { ok: true, url, transport, headers };
}

function registerTools(params: {
  serverName: string;
  client: Client;
  listedTools: Awaited<ReturnType<typeof listAllTools>>;
  reservedNames: Set<string>;
  tools: AnyAgentTool[];
  descriptionFallback: string;
}) {
  for (const tool of params.listedTools) {
    const originalName = tool.name.trim();
    if (!originalName) {
      continue;
    }
    const prefixedName = `${params.serverName}:${originalName}`;
    if (prefixedName.length > TOOL_NAME_MAX_TOTAL) {
      logWarn(
        `bundle-mcp: skipped tool "${originalName}" from server "${params.serverName}" because the namespaced name exceeds ${TOOL_NAME_MAX_TOTAL} characters.`,
      );
      continue;
    }
    const normalizedName = prefixedName.toLowerCase();
    if (params.reservedNames.has(normalizedName)) {
      logWarn(
        `bundle-mcp: skipped tool "${originalName}" from server "${params.serverName}" because the name "${prefixedName}" already exists.`,
      );
      continue;
    }
    params.reservedNames.add(normalizedName);
    params.tools.push({
      name: prefixedName,
      label: tool.title ?? originalName,
      description: tool.description?.trim() || params.descriptionFallback,
      parameters: tool.inputSchema,
      execute: async (_toolCallId, input) => {
        const result = (await params.client.callTool({
          name: originalName,
          arguments: isRecord(input) ? input : {},
        })) as CallToolResult;
        return toAgentToolResult({
          serverName: params.serverName,
          toolName: originalName,
          result,
        });
      },
    });
  }
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const sessions: BundleMcpSession[] = [];
  const tools: AnyAgentTool[] = [];

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
      // Detect transport mode: command → stdio, url → HTTP
      const hasCommand =
        isRecord(rawServer) && typeof rawServer.command === "string" && rawServer.command.trim().length > 0;
      const hasUrl =
        isRecord(rawServer) && typeof rawServer.url === "string" && rawServer.url.trim().length > 0;

      if (hasCommand && hasUrl) {
        logWarn(
          `bundle-mcp: skipped server "${serverName}" because it has both "command" and "url" — use one.`,
        );
        continue;
      }

      if (hasUrl) {
        // HTTP transport path
        const httpConfig = resolveHttpServerConfig(rawServer);
        if (!httpConfig.ok) {
          logWarn(`bundle-mcp: skipped server "${serverName}" because ${httpConfig.reason}.`);
          continue;
        }

        const safeServerName = sanitizeServerName(serverName);
        if (safeServerName !== serverName) {
          logWarn(
            `bundle-mcp: server key "${serverName}" sanitized to "${safeServerName}" for tool namespacing.`,
          );
        }

        try {
          const { client, transport, transportType } = await createHttpSession(
            serverName,
            httpConfig,
          );
          const session: BundleMcpSession = {
            serverName,
            client,
            transport,
            transportType,
          };
          try {
            const listedTools = await listAllTools(client);
            sessions.push(session);
            registerTools({
              serverName: safeServerName,
              client,
              listedTools,
              reservedNames,
              tools,
              descriptionFallback: `Provided by MCP server "${safeServerName}" (${redactUrl(httpConfig.url)}).`,
            });
          } catch (error) {
            logWarn(
              `bundle-mcp: failed to list tools from server "${serverName}" (${redactUrl(httpConfig.url)}): ${String(error)}`,
            );
            await disposeSession(session);
          }
        } catch (error) {
          logWarn(
            `bundle-mcp: failed to connect to server "${serverName}" (${redactUrl(httpConfig.url)}): ${String(error)}`,
          );
        }
        continue;
      }

      // Stdio transport path (existing behavior)
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-mcp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;

      const safeStdioName = sanitizeServerName(serverName);
      if (safeStdioName !== serverName) {
        logWarn(
          `bundle-mcp: server key "${serverName}" sanitized to "${safeStdioName}" for tool namespacing.`,
        );
      }

      const transport = new StdioClientTransport({
        command: launchConfig.command,
        args: launchConfig.args,
        env: launchConfig.env,
        cwd: launchConfig.cwd,
        stderr: "pipe",
      });
      const client = new Client(
        {
          name: "openclaw-bundle-mcp",
          version: "0.0.0",
        },
        {},
      );
      const session: BundleMcpSession = {
        serverName,
        client,
        transport,
        transportType: "stdio",
        detachStderr: attachStderrLogging(serverName, transport),
      };

      try {
        await client.connect(transport);
        const listedTools = await listAllTools(client);
        sessions.push(session);
        registerTools({
          serverName: safeStdioName,
          client,
          listedTools,
          reservedNames,
          tools,
          descriptionFallback: `Provided by bundle MCP server "${safeStdioName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}).`,
        });
      } catch (error) {
        logWarn(
          `bundle-mcp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`,
        );
        await disposeSession(session);
      }
    }

    return {
      tools,
      dispose: async () => {
        await Promise.allSettled(sessions.map((session) => disposeSession(session)));
      },
    };
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => disposeSession(session)));
    throw error;
  }
}
