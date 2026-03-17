import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
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
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-mcp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;

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
        detachStderr: attachStderrLogging(serverName, transport),
      };

      try {
        await client.connect(transport);
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
              `Provided by bundle MCP server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}).`,
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
