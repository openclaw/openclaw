import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import {
  NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS,
} from "../infra/node-commands.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { sanitizeNodeIdFragment, sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import {
  projectMcpCallToolResult,
  setMcpCodeModeGuestResultFromAgentResult,
} from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const NODE_PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_PLUGIN_TOOL_NAME_MAX_LENGTH = 64;
const NODE_MCP_PLUGIN_ID = "node-mcp";

type MaterializedNodeToolEntry = ReturnType<typeof listConnectedNodePluginTools>[number] & {
  command: string;
  normalizedName: string;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isRecord(value) && Array.isArray(value.content);
}

export function createNodePluginTools(params: {
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  agentSessionKey?: string;
}): AnyAgentTool[] {
  const existingNormalized = new Set(
    [...(params.existingToolNames ?? [])].map((name) => normalizeToolPolicyName(name)),
  );
  const allowlist = createPluginToolAllowlist(params.toolAllowlist);
  const denylist = compileGlobPatterns({
    raw: params.toolDenylist,
    normalize: normalizeToolPolicyName,
  });
  const entries: MaterializedNodeToolEntry[] = [];
  const nameCounts = new Map<string, number>();
  for (const entry of listConnectedNodePluginTools()) {
    const descriptor = entry.descriptor;
    const command = descriptor.command?.trim();
    const normalizedName = normalizeToolPolicyName(descriptor.name);
    if (!command || !normalizedName) {
      continue;
    }
    entries.push({ ...entry, command, normalizedName });
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  const tools: AnyAgentTool[] = [];
  for (const entry of entries) {
    const descriptor = entry.descriptor;
    let toolName: string | undefined = descriptor.name;
    if (
      (nameCounts.get(entry.normalizedName) ?? 1) !== 1 ||
      existingNormalized.has(entry.normalizedName)
    ) {
      toolName = undefined;
      const prefix = `${sanitizeNodeIdFragment(entry.nodeId)}_`;
      for (let index = 0; index < 100; index += 1) {
        const suffix = index === 0 ? "" : `_${index + 1}`;
        const maxBaseLength = Math.max(
          1,
          NODE_PLUGIN_TOOL_NAME_MAX_LENGTH - prefix.length - suffix.length,
        );
        const candidate = `${prefix}${descriptor.name.slice(0, maxBaseLength)}${suffix}`;
        const normalized = normalizeToolPolicyName(candidate);
        if (
          NODE_PLUGIN_TOOL_NAME_RE.test(candidate) &&
          normalized &&
          !existingNormalized.has(normalized)
        ) {
          toolName = candidate;
          break;
        }
      }
    }
    if (!toolName) {
      continue;
    }
    const pluginId = normalizeToolPolicyName(descriptor.pluginId);
    const originalToolName = normalizeToolPolicyName(descriptor.name);
    const exposedToolName = normalizeToolPolicyName(toolName);
    if (
      matchesAnyGlobPattern(pluginId, denylist) ||
      matchesAnyGlobPattern(originalToolName, denylist) ||
      matchesAnyGlobPattern(exposedToolName, denylist) ||
      matchesAnyGlobPattern("group:plugins", denylist)
    ) {
      continue;
    }
    // Unregistered nodes cannot grant themselves plugin-scoped access by
    // claiming another plugin's ID. Only the reserved node-mcp ID is trusted.
    const pluginIdTrusted = entry.registered || pluginId === NODE_MCP_PLUGIN_ID;
    if (
      !allowlist.includesDefaults &&
      !(
        (pluginIdTrusted && allowlist.allowsPlugin(pluginId)) ||
        allowlist.allowsToolName(originalToolName) ||
        allowlist.allowsToolName(exposedToolName)
      )
    ) {
      continue;
    }
    existingNormalized.add(normalizeToolPolicyName(toolName));
    const mcpTool = descriptor.command === NODE_MCP_TOOLS_CALL_COMMAND ? descriptor.mcp : undefined;
    const tool: AnyAgentTool = {
      name: toolName,
      label: toolName,
      description: `${descriptor.description} (node: ${entry.displayName?.trim() || entry.nodeId})`,
      parameters: descriptor.parameters as never,
      ...(mcpTool
        ? { executionMode: "sequential" as const, resultContentSource: "network" as const }
        : {}),
      execute: async (toolCallId, toolParams, signal) => {
        const assistantTurnId = getAgentToolAssistantTurnId();
        const raw = await callGatewayTool(
          "node.invoke",
          {
            timeoutMs: mcpTool
              ? NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS
              : NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS,
          },
          {
            nodeId: entry.nodeId,
            command: entry.command,
            params: mcpTool
              ? {
                  server: mcpTool.server,
                  tool: mcpTool.tool,
                  arguments: toolParams,
                }
              : toolParams,
            timeoutMs: mcpTool ? NODE_MCP_TOOL_CALL_TIMEOUT_MS : NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS,
            idempotencyKey: assistantTurnId ? `${assistantTurnId}:${toolCallId}` : toolCallId,
            ...(params.agentSessionKey ? { sessionKey: params.agentSessionKey } : {}),
          },
          { scopes: ["operator.write"], ...(signal ? { signal } : {}) },
        );
        const payload = isRecord(raw) && "payload" in raw ? raw.payload : raw;
        if (mcpTool) {
          return isRecord(payload)
            ? projectMcpCallToolResult(payload, {
                mcpServer: mcpTool.server,
                mcpTool: mcpTool.tool,
              })
            : jsonResult(payload);
        }
        const result = isAgentToolResult(payload) ? payload : jsonResult(payload);
        return descriptor.mcp ? setMcpCodeModeGuestResultFromAgentResult(result) : result;
      },
    };
    setPluginToolMeta(tool, {
      pluginId: descriptor.pluginId,
      optional: false,
      ...(descriptor.mcp
        ? {
            mcp: {
              serverName: descriptor.mcp.server,
              safeServerName: sanitizeServerName(descriptor.mcp.server, new Set<string>()),
              toolName: descriptor.mcp.tool,
              operation: "tool",
              ...(descriptor.pluginId === NODE_MCP_PLUGIN_ID && mcpTool
                ? {
                    node: {
                      id: entry.nodeId,
                      ...(entry.displayName?.trim()
                        ? { displayName: entry.displayName.trim() }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
    tools.push(tool);
  }
  return tools;
}
