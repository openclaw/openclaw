import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./pi-bundle-mcp-names.js";
import { createSessionMcpRuntime } from "./pi-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

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
    dispose: async () => {},
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
  });
  return {
    tools: materialized.tools,
    dispose: async () => {
      await runtime.dispose();
    },
  };
}
