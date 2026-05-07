import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./pi-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./pi-bundle-mcp-types.js";
import type { AnyAgentTool } from "./tools/common.js";

type CachedBundleMcpToolDescriptor = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  serverName: string;
  toolName: string;
};

type CachedBundleMcpToolMaterialization = {
  descriptors: CachedBundleMcpToolDescriptor[];
  warnings: string[];
};

type BundleMcpToolMaterializationCacheStats = {
  bypass: number;
  hit: number;
  miss: number;
  store: number;
};

let bundleMcpToolMaterializationCache = new WeakMap<
  SessionMcpRuntime,
  Map<string, CachedBundleMcpToolMaterialization>
>();

const bundleMcpToolMaterializationCacheStats: BundleMcpToolMaterializationCacheStats = {
  bypass: 0,
  hit: 0,
  miss: 0,
  store: 0,
};

function isBundleMcpToolMaterializationCacheEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE !== "0";
}

function buildReservedToolNamesCacheKey(reservedNames: ReadonlySet<string>): string {
  return JSON.stringify([...reservedNames].toSorted());
}

function cloneSchemaValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function readCachedBundleMcpToolMaterialization(params: {
  runtime: SessionMcpRuntime;
  cacheKey: string;
}): CachedBundleMcpToolMaterialization | undefined {
  return bundleMcpToolMaterializationCache.get(params.runtime)?.get(params.cacheKey);
}

function writeCachedBundleMcpToolMaterialization(params: {
  runtime: SessionMcpRuntime;
  cacheKey: string;
  materialization: CachedBundleMcpToolMaterialization;
}): void {
  let runtimeCache = bundleMcpToolMaterializationCache.get(params.runtime);
  if (!runtimeCache) {
    runtimeCache = new Map();
    bundleMcpToolMaterializationCache.set(params.runtime, runtimeCache);
  }
  runtimeCache.set(params.cacheKey, {
    warnings: [...params.materialization.warnings],
    descriptors: params.materialization.descriptors.map((descriptor) => ({
      ...descriptor,
      parameters: cloneSchemaValue(descriptor.parameters),
    })),
  });
  bundleMcpToolMaterializationCacheStats.store += 1;
}

function createBundleMcpToolFromDescriptor(params: {
  descriptor: CachedBundleMcpToolDescriptor;
  runtime: SessionMcpRuntime;
}): AnyAgentTool {
  const { descriptor } = params;
  const agentTool: AnyAgentTool = {
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    parameters: cloneSchemaValue(descriptor.parameters) as never,
    execute: async (_toolCallId: string, input: unknown) => {
      params.runtime.markUsed();
      const result = await params.runtime.callTool(
        descriptor.serverName,
        descriptor.toolName,
        input,
      );
      return toAgentToolResult({
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        result,
      });
    },
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
  });
  return agentTool;
}

function createBundleMcpRuntimeFromCachedMaterialization(params: {
  materialization: CachedBundleMcpToolMaterialization;
  runtime: SessionMcpRuntime;
  releaseLease?: () => void;
  disposeRuntime?: () => Promise<void>;
}): BundleMcpToolRuntime {
  let disposed = false;
  for (const warning of params.materialization.warnings) {
    logWarn(warning);
  }
  return {
    tools: params.materialization.descriptors.map((descriptor) =>
      createBundleMcpToolFromDescriptor({
        descriptor,
        runtime: params.runtime,
      }),
    ),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      params.releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export function resetBundleMcpToolMaterializationCacheForTest(): void {
  bundleMcpToolMaterializationCache = new WeakMap();
  bundleMcpToolMaterializationCacheStats.bypass = 0;
  bundleMcpToolMaterializationCacheStats.hit = 0;
  bundleMcpToolMaterializationCacheStats.miss = 0;
  bundleMcpToolMaterializationCacheStats.store = 0;
}

export function getBundleMcpToolMaterializationCacheStatsForTest(): BundleMcpToolMaterializationCacheStats {
  return { ...bundleMcpToolMaterializationCacheStats };
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

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const cacheEnabled = isBundleMcpToolMaterializationCacheEnabled(process.env);
  const cacheKey = buildReservedToolNamesCacheKey(reservedNames);
  if (cacheEnabled) {
    const cached = readCachedBundleMcpToolMaterialization({
      runtime: params.runtime,
      cacheKey,
    });
    if (cached) {
      bundleMcpToolMaterializationCacheStats.hit += 1;
      return createBundleMcpRuntimeFromCachedMaterialization({
        materialization: cached,
        runtime: params.runtime,
        releaseLease,
        disposeRuntime: params.disposeRuntime,
      });
    }
    bundleMcpToolMaterializationCacheStats.miss += 1;
  } else {
    bundleMcpToolMaterializationCacheStats.bypass += 1;
  }

  let catalog: McpToolCatalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }

  const descriptors: CachedBundleMcpToolDescriptor[] = [];
  const warnings: string[] = [];
  const sortedCatalogTools = [...catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
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
      warnings.push(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    descriptors.push({
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: cloneSchemaValue(tool.inputSchema),
      serverName: tool.serverName,
      toolName: tool.toolName,
    });
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  descriptors.sort((a, b) => a.name.localeCompare(b.name));

  for (const warning of warnings) {
    logWarn(warning);
  }

  const materialization = { descriptors, warnings };
  if (cacheEnabled) {
    writeCachedBundleMcpToolMaterialization({
      runtime: params.runtime,
      cacheKey,
      materialization,
    });
  }

  return {
    tools: descriptors.map((descriptor) =>
      createBundleMcpToolFromDescriptor({
        descriptor,
        runtime: params.runtime,
      }),
    ),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./pi-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
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
