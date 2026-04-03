import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export type McpServerCatalog = {
  serverName: string;
  launchSummary: string;
  toolCount: number;
};

export type McpCatalogTool = {
  serverName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  fallbackDescription: string;
};

export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
};

export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  dispose: () => Promise<void>;
};

export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  listSessionIds: () => string[];
};

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function listAllTools(client: Client) {
  const tools: ListedTool[] = [];
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

function normalizeReservedToolNames(names?: Iterable<string>): Set<string> {
  return new Set(Array.from(names ?? [], (name) => name.trim().toLowerCase()).filter(Boolean));
}

function createCatalogFingerprint(servers: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): SessionMcpRuntime {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  const configFingerprint = createCatalogFingerprint(loaded.mcpServers);
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const sessions = new Map<string, BundleMcpSession>();

  const getCatalog = async (): Promise<McpToolCatalog> => {
    if (disposed) {
      throw new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`);
    }
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    catalogInFlight = (async () => {
      if (Object.keys(loaded.mcpServers).length === 0) {
        return {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
        };
      }

      const servers: Record<string, McpServerCatalog> = {};
      const tools: McpCatalogTool[] = [];

      try {
        for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
          const launch = resolveStdioMcpServerLaunchConfig(rawServer);
          if (!launch.ok) {
            logWarn(`bundle-mcp: skipped server "${serverName}" because ${launch.reason}.`);
            continue;
          }
          const launchConfig = launch.config;
          const launchSummary = describeStdioMcpServerLaunchConfig(launchConfig);
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
            sessions.set(serverName, session);
            servers[serverName] = {
              serverName,
              launchSummary,
              toolCount: listedTools.length,
            };
            for (const tool of listedTools) {
              const toolName = tool.name.trim();
              if (!toolName) {
                continue;
              }
              tools.push({
                serverName,
                toolName,
                title: tool.title,
                description: tool.description?.trim() || undefined,
                inputSchema: tool.inputSchema,
                fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchSummary}).`,
              });
            }
          } catch (error) {
            logWarn(
              `bundle-mcp: failed to start server "${serverName}" (${launchSummary}): ${String(error)}`,
            );
            await disposeSession(session);
          }
        }

        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();

    try {
      catalog = await catalogInFlight;
      return catalog;
    } finally {
      catalogInFlight = undefined;
    }
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    getCatalog,
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      if (disposed) {
        throw new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`);
      }
      await getCatalog();
      const session = sessions.get(serverName);
      if (!session) {
        throw new Error(`bundle-mcp server "${serverName}" is not connected`);
      }
      return (await session.client.callTool({
        name: toolName,
        arguments: isRecord(input) ? input : {},
      })) as CallToolResult;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      catalog = null;
      catalogInFlight = undefined;
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
    },
  };
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  params.runtime.markUsed();
  const catalog = await params.runtime.getCatalog();
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];

  for (const tool of catalog.tools) {
    const normalizedName = tool.toolName.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    if (reservedNames.has(normalizedName)) {
      logWarn(
        `bundle-mcp: skipped tool "${tool.toolName}" from server "${tool.serverName}" because the name already exists.`,
      );
      continue;
    }
    reservedNames.add(normalizedName);
    tools.push({
      name: tool.toolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: tool.inputSchema,
      execute: async (_toolCallId, input) => {
        const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
        return toAgentToolResult({
          serverName: tool.serverName,
          toolName: tool.toolName,
          result,
        });
      },
    });
  }

  return {
    tools,
    dispose: async () => {},
  };
}

function createSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  const runtimesBySessionId = new Map<string, SessionMcpRuntime>();
  const sessionIdBySessionKey = new Map<string, string>();
  const createInFlight = new Map<string, Promise<SessionMcpRuntime>>();

  return {
    async getOrCreate(params) {
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const existing = runtimesBySessionId.get(params.sessionId);
      if (existing) {
        existing.markUsed();
        return existing;
      }
      const inFlight = createInFlight.get(params.sessionId);
      if (inFlight) {
        return inFlight;
      }
      const created = Promise.resolve(
        createSessionMcpRuntime({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
        }),
      ).then((runtime) => {
        runtime.markUsed();
        runtimesBySessionId.set(params.sessionId, runtime);
        return runtime;
      });
      createInFlight.set(params.sessionId, created);
      try {
        return await created;
      } finally {
        createInFlight.delete(params.sessionId);
      }
    },
    bindSessionKey(sessionKey, sessionId) {
      sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return sessionIdBySessionKey.get(sessionKey);
    },
    async disposeSession(sessionId) {
      createInFlight.delete(sessionId);
      const runtime = runtimesBySessionId.get(sessionId);
      if (!runtime) {
        for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
          if (mappedSessionId === sessionId) {
            sessionIdBySessionKey.delete(sessionKey);
          }
        }
        return;
      }
      runtimesBySessionId.delete(sessionId);
      for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
        if (mappedSessionId === sessionId) {
          sessionIdBySessionKey.delete(sessionKey);
        }
      }
      await runtime.dispose();
    },
    async disposeAll() {
      createInFlight.clear();
      const runtimes = Array.from(runtimesBySessionId.values());
      runtimesBySessionId.clear();
      sessionIdBySessionKey.clear();
      await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
    },
    listSessionIds() {
      return Array.from(runtimesBySessionId.keys());
    },
  };
}

export function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

export async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  const runtime = createSessionMcpRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
  });
  return {
    tools: materialized.tools,
    dispose: async () => {
      await runtime.dispose();
    },
  };
}

export const __testing = {
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
};
