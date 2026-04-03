import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./pi-bundle-mcp-names.js";
import type { PersistentMcpManager } from "./persistent-mcp-manager.js";
import { createSessionMcpRuntime } from "./pi-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";
import type { AnyAgentTool } from "./tools/common.js";

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

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  params.runtime.markUsed();
  const catalog = await params.runtime.getCatalog();
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: BundleMcpToolRuntime["tools"] = [];

  for (const tool of catalog.tools) {
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(safeToolName.toLowerCase());
    tools.push({
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: tool.inputSchema,
      execute: async (_toolCallId: string, input: unknown) => {
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
    dispose: async () => {
      await params.disposeRuntime?.();
    },
  };
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
    disposeRuntime: async () => {
      await runtime.dispose();
    },
  });
  return materialized;
}

// ---------------------------------------------------------------------------
// PersistentMcpManager singleton — set by gateway on startup, null otherwise.
// ---------------------------------------------------------------------------

let _persistentMcpManager: PersistentMcpManager | null = null;

export function setPersistentMcpManager(manager: PersistentMcpManager | null): void {
  _persistentMcpManager = manager;
}

export function getPersistentMcpManager(): PersistentMcpManager | null {
  return _persistentMcpManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMcpInputSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }
  const { $schema: _, ...rest } = schema;
  return rest;
}

async function listAllToolsDirect(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function toPersistentAgentToolResult(params: {
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

/**
 * Lists tools from all persistent MCP servers that are ready, using the
 * gateway-level PersistentMcpManager connection. The returned runtime's
 * dispose() is a no-op — lifecycle is owned by the gateway.
 *
 * Returns empty tools if there is no manager or ensureReady() fails.
 */
async function createPersistentConfiguredMcpProjection(params: {
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<{ runtime: BundleMcpToolRuntime; ownedServerNames: Set<string> }> {
  const manager = _persistentMcpManager;
  if (!manager) {
    return { runtime: { tools: [], dispose: async () => {} }, ownedServerNames: new Set() };
  }

  try {
    await manager.ensureReady();
  } catch {
    logWarn("persistent-mcp: ensureReady() failed; skipping persistent projection for this run");
    return { runtime: { tools: [], dispose: async () => {} }, ownedServerNames: new Set() };
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const tools: AnyAgentTool[] = [];
  const ownedServerNames = new Set<string>();

  for (const serverName of manager.getPersistentServerNames()) {
    let client: Client | null;
    try {
      client = await manager.getReadyClient(serverName);
    } catch (err) {
      logWarn(`persistent-mcp: getReadyClient("${serverName}") failed: ${String(err)}`);
      client = null;
    }

    if (!client) {
      logWarn(`persistent-mcp: server "${serverName}" is not ready; skipping for this run`);
      // Still mark as owned so transient runtime does not spawn a duplicate process.
      ownedServerNames.add(serverName);
      continue;
    }

    let listedTools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    try {
      listedTools = await listAllToolsDirect(client);
    } catch (err) {
      logWarn(`persistent-mcp: listTools failed for "${serverName}": ${String(err)}`);
      // Still mark as owned so transient runtime does not spawn a duplicate process.
      ownedServerNames.add(serverName);
      continue;
    }

    // Server is successfully projected — add it to ownedServerNames to exclude from transient.
    ownedServerNames.add(serverName);

    for (const tool of listedTools) {
      const normalizedName = tool.name.trim().toLowerCase();
      if (!normalizedName) {
        continue;
      }
      if (reservedNames.has(normalizedName)) {
        logWarn(
          `persistent-mcp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
        );
        continue;
      }
      reservedNames.add(normalizedName);

      tools.push({
        name: tool.name,
        label: tool.title ?? tool.name,
        description:
          tool.description?.trim() || `Provided by persistent MCP server "${serverName}".`,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        execute: async (_toolCallId, input) => {
          // Re-fetch the client at call time so that reconnects after a crash
          // are transparent — the session runtime is long-lived but the underlying
          // MCP connection may have been replaced by PersistentMcpManager.
          const liveClient = await manager.getReadyClient(serverName);
          if (!liveClient) {
            return toPersistentAgentToolResult({
              serverName,
              toolName: tool.name,
              result: {
                content: [{ type: "text", text: `MCP server "${serverName}" is not available.` }],
                isError: true,
              } as CallToolResult,
            });
          }
          const result = (await liveClient.callTool({
            name: tool.name,
            arguments: isRecord(input) ? input : {},
          })) as CallToolResult;
          return toPersistentAgentToolResult({ serverName, toolName: tool.name, result });
        },
      });
    }
  }

  // dispose() is a no-op: the manager owns the lifecycle, not this runtime.
  return { runtime: { tools, dispose: async () => {} }, ownedServerNames };
}

/**
 * Creates the combined MCP tool runtime for an embedded agent run:
 * - Persistent configured servers: proxied via the gateway-level PersistentMcpManager (no-op dispose).
 * - All other servers (bundle + non-persistent configured): spawned transiently (disposed on run end).
 *
 * Callers switch to this instead of createBundleMcpToolRuntime() to get persistent semantics.
 */
export async function createEmbeddedBundleMcpRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  const { runtime: persistentRuntime, ownedServerNames } =
    await createPersistentConfiguredMcpProjection({
      cfg: params.cfg,
      reservedToolNames: params.reservedToolNames,
    });

  const transientReserved: string[] = [
    ...persistentRuntime.tools.map((t) => t.name),
    ...Array.from(params.reservedToolNames ?? []),
  ];

  // Use the session-based transient runtime for non-persistent servers.
  const transientRuntime = await createBundleMcpToolRuntime({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg
      ? {
          ...params.cfg,
          mcp: params.cfg.mcp
            ? {
                ...params.cfg.mcp,
                servers: params.cfg.mcp.servers
                  ? Object.fromEntries(
                      Object.entries(params.cfg.mcp.servers).filter(
                        ([name]) => !ownedServerNames.has(name),
                      ),
                    )
                  : params.cfg.mcp.servers,
              }
            : params.cfg.mcp,
        }
      : params.cfg,
    reservedToolNames: transientReserved,
  });

  return {
    tools: [...persistentRuntime.tools, ...transientRuntime.tools],
    dispose: () => transientRuntime.dispose(),
  };
}
