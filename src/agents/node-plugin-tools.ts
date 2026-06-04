/** Materializes connected node-hosted plugin tools for agent runs. */
import { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { AgentToolResult } from "./runtime/index.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const NODE_PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_PLUGIN_TOOL_NAME_MAX_LENGTH = 64;

type MaterializedNodeToolEntry = ReturnType<typeof listConnectedNodePluginTools>[number] & {
  command: string;
  normalizedName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isRecord(value) && Array.isArray(value.content);
}

function readNodeInvokePayload(value: unknown): unknown {
  return isRecord(value) && "payload" in value ? value.payload : value;
}

function normalizePolicyNames(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeToolName(value)).filter(Boolean));
}

function toolPolicyAllows(params: {
  pluginId: string;
  toolName: string;
  exposedToolName?: string;
  allowlist: Set<string>;
  denylist: ReturnType<typeof compileGlobPatterns>;
}): boolean {
  const pluginId = normalizeToolName(params.pluginId);
  const toolName = normalizeToolName(params.toolName);
  const exposedToolName = normalizeToolName(params.exposedToolName ?? params.toolName);
  if (
    matchesAnyGlobPattern(pluginId, params.denylist) ||
    matchesAnyGlobPattern(toolName, params.denylist) ||
    matchesAnyGlobPattern(exposedToolName, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  ) {
    return false;
  }
  if (params.allowlist.size === 0 || params.allowlist.has(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY)) {
    return true;
  }
  return (
    params.allowlist.has("*") ||
    params.allowlist.has("group:plugins") ||
    params.allowlist.has(pluginId) ||
    params.allowlist.has(toolName) ||
    params.allowlist.has(exposedToolName)
  );
}

function describeNodeToolLocation(params: {
  description: string;
  displayName?: string;
  nodeId: string;
}): string {
  const label = params.displayName?.trim() || params.nodeId;
  return `${params.description} (node: ${label})`;
}

function sanitizeToolNameFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function isProviderSafeToolName(value: string): boolean {
  return NODE_PLUGIN_TOOL_NAME_RE.test(value);
}

function appendToolNameSuffix(baseName: string, suffix: string): string {
  const maxBaseLength = Math.max(1, NODE_PLUGIN_TOOL_NAME_MAX_LENGTH - suffix.length);
  return `${baseName.slice(0, maxBaseLength)}${suffix}`;
}

function resolveUniqueToolName(params: {
  baseName: string;
  normalizedName: string;
  duplicateCount: number;
  nodeId: string;
  existingNormalized: Set<string>;
}): string | null {
  if (params.duplicateCount === 1 && !params.existingNormalized.has(params.normalizedName)) {
    return params.baseName;
  }
  const nodeFragment = sanitizeToolNameFragment(params.nodeId);
  const nodeSuffix = nodeFragment ? `_${nodeFragment}` : "_node";
  const stem = appendToolNameSuffix(params.baseName, nodeSuffix);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `_${index + 1}`;
    const candidate = suffix ? appendToolNameSuffix(stem, suffix) : stem;
    const normalized = normalizeToolName(candidate);
    if (
      isProviderSafeToolName(candidate) &&
      normalized &&
      !params.existingNormalized.has(normalized)
    ) {
      return candidate;
    }
  }
  return null;
}

export function createNodePluginTools(params: {
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
}): AnyAgentTool[] {
  const existingNormalized = new Set(
    [...(params.existingToolNames ?? [])].map((name) => normalizeToolName(name)),
  );
  const allowlist = normalizePolicyNames(params.toolAllowlist);
  const denylist = compileGlobPatterns({
    raw: params.toolDenylist,
    normalize: normalizeToolName,
  });
  const entries: MaterializedNodeToolEntry[] = [];
  const nameCounts = new Map<string, number>();
  for (const entry of listConnectedNodePluginTools()) {
    const descriptor = entry.descriptor;
    const command = descriptor.command?.trim();
    const normalizedName = normalizeToolName(descriptor.name);
    if (!command || !normalizedName) {
      continue;
    }
    entries.push({ ...entry, command, normalizedName });
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  const tools: AnyAgentTool[] = [];
  for (const entry of entries) {
    const descriptor = entry.descriptor;
    const toolName = resolveUniqueToolName({
      baseName: descriptor.name,
      normalizedName: entry.normalizedName,
      duplicateCount: nameCounts.get(entry.normalizedName) ?? 1,
      nodeId: entry.nodeId,
      existingNormalized,
    });
    if (!toolName) {
      continue;
    }
    if (
      !toolPolicyAllows({
        pluginId: descriptor.pluginId,
        toolName: descriptor.name,
        exposedToolName: toolName,
        allowlist,
        denylist,
      })
    ) {
      continue;
    }
    existingNormalized.add(normalizeToolName(toolName));
    const tool: AnyAgentTool = {
      name: toolName,
      label: toolName,
      description: describeNodeToolLocation({
        description: descriptor.description,
        displayName: entry.displayName,
        nodeId: entry.nodeId,
      }),
      parameters: descriptor.parameters as never,
      execute: async (toolCallId, toolParams) => {
        const raw = await callGatewayTool(
          "node.invoke",
          {},
          {
            nodeId: entry.nodeId,
            command: entry.command,
            params: toolParams,
            idempotencyKey: toolCallId,
          },
          { scopes: ["operator.write"] },
        );
        const payload = readNodeInvokePayload(raw);
        return isAgentToolResult(payload) ? payload : jsonResult(payload);
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
            },
          }
        : {}),
    });
    tools.push(tool);
  }
  return tools;
}
