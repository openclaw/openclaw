import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { describeSseMcpServerLaunchConfig, resolveSseMcpServerLaunchConfig } from "./mcp-sse.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";

type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
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
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
}

/** Try to create a stdio or SSE transport for the given raw server config. */
function resolveTransport(
  serverName: string,
  rawServer: unknown,
): {
  transport: Transport;
  description: string;
  detachStderr?: () => void;
} | null {
  // Try stdio first (command-based servers).
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer);
  if (stdioLaunch.ok) {
    const transport = new StdioClientTransport({
      command: stdioLaunch.config.command,
      args: stdioLaunch.config.args,
      env: stdioLaunch.config.env,
      cwd: stdioLaunch.config.cwd,
      stderr: "pipe",
    });
    return {
      transport,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }

  // Try SSE (url-based servers).
  const sseLaunch = resolveSseMcpServerLaunchConfig(rawServer, {
    onDroppedHeader: (key) => {
      logWarn(
        `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
      );
    },
    onMalformedHeaders: () => {
      logWarn(
        `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
      );
    },
  });
  if (sseLaunch.ok) {
    const headers: Record<string, string> = {
      ...sseLaunch.config.headers,
    };
    const hasHeaders = Object.keys(headers).length > 0;
    const transport = new SSEClientTransport(new URL(sseLaunch.config.url), {
      // Apply headers to POST requests (tool calls, listTools, etc.).
      requestInit: hasHeaders ? { headers } : undefined,
      // Apply headers to the initial SSE GET handshake (required for auth).
      eventSourceInit: hasHeaders
        ? {
            fetch: (url, init) =>
              fetch(url, {
                ...init,
                headers: { ...(init?.headers as Record<string, string>), ...headers },
              }),
          }
        : undefined,
    });
    return {
      transport,
      description: describeSseMcpServerLaunchConfig(sseLaunch.config),
    };
  }

  logWarn(
    `bundle-mcp: skipped server "${serverName}" because ${stdioLaunch.reason} and ${sseLaunch.reason}.`,
  );
  return null;
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
  // Skip spawning when no MCP servers are configured.
  if (Object.keys(loaded.mcpServers).length === 0) {
    return { tools: [], dispose: async () => {} };
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const sessions: BundleMcpSession[] = [];
  const tools: AnyAgentTool[] = [];

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
      const resolved = resolveTransport(serverName, rawServer);
      if (!resolved) {
        continue;
      }

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
        transport: resolved.transport,
        detachStderr: resolved.detachStderr,
      };

      try {
        await client.connect(resolved.transport);
        const listedTools = await listAllTools(client);
        sessions.push(session);
        for (const tool of listedTools) {
          const normalizedName = tool.name.trim().toLowerCase();
          if (!normalizedName) {
            continue;
          }
          if (reservedNames.has(normalizedName)) {
            logWarn(
              `bundle-mcp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
            );
            continue;
          }
          reservedNames.add(normalizedName);
          tools.push({
            name: tool.name,
            label: tool.title ?? tool.name,
            description:
              tool.description?.trim() ||
              `Provided by bundle MCP server "${serverName}" (${resolved.description}).`,
            parameters: tool.inputSchema,
            execute: async (_toolCallId, input) => {
              const result = (await client.callTool({
                name: tool.name,
                arguments: isRecord(input) ? input : {},
              })) as CallToolResult;
              return toAgentToolResult({
                serverName,
                toolName: tool.name,
                result,
              });
            },
          });
        }
      } catch (error) {
        logWarn(
          `bundle-mcp: failed to start server "${serverName}" (${resolved.description}): ${String(error)}`,
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
