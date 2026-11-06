import crypto from "node:crypto";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import {
  getPluginToolMeta,
  setPluginToolMeta,
  type PluginToolMcpMeta,
} from "../plugins/tool-metadata.js";
import { sanitizeModelSpecialTokens } from "../security/external-content.js";
import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import { createBundleMcpToolExecuteFactory } from "./agent-bundle-mcp-executes.js";
import { releaseSessionMcpRuntime } from "./agent-bundle-mcp-manager-cleanup.js";
import {
  buildSafeToolName,
  compareMcpCatalogTools,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import {
  getSessionMcpRequestSignal,
  runWithSessionMcpRequestSignal,
} from "./agent-bundle-mcp-request-context.js";
import { mergeMcpConnectCatalog } from "./agent-bundle-mcp-requester-connect.js";
import type {
  BundleMcpToolRuntime,
  McpAppRequesterIdentity,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { projectMcpGetPromptResult, setMcpCodeModeGuestResult } from "./mcp-content.js";
import { isAppOnlyMcpTool } from "./mcp-metadata.js";
import { createMcpToolFilter, mcpCatalogToolFilterScope } from "./mcp-tool-filter.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";
import type { AgentToolResult } from "./runtime/index.js";
import { neutralizePromptControlMarkers } from "./sanitize-for-prompt.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import type { AnyAgentTool } from "./tools/common.js";

const MAX_MCP_SERVER_INSTRUCTIONS_CHARS = 2_000;

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  const publicValue = toToolSearchJsonSafe(
    params.operation === "resources_list" && Array.isArray(params.value)
      ? { resources: params.value }
      : params.operation === "prompts_list" && Array.isArray(params.value)
        ? { prompts: params.value }
        : params.value,
  );
  if (isRecord(publicValue)) {
    delete publicValue._meta;
  }
  const result: AgentToolResult<unknown> = {
    content: [
      {
        type: "text",
        text: JSON.stringify(publicValue, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
  return setMcpCodeModeGuestResult(result, publicValue);
}

function requireStringArg(input: unknown, key: string): string {
  const value = isRecord(input) ? input[key] : undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid) {
    throw new Error(`${key}.${invalid[0]} must be a string`);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
  includeSessionDenied?: boolean;
  includeAppOnlyInventory?: boolean;
}): AnyAgentTool[] {
  const serverInstructions = new Map<string, string>();
  for (const server of Object.values(params.catalog.servers)) {
    if (server.instructions) {
      const text =
        server.instructions.length > MAX_MCP_SERVER_INSTRUCTIONS_CHARS
          ? `${truncateUtf16Safe(server.instructions, MAX_MCP_SERVER_INSTRUCTIONS_CHARS)} …[truncated: server instructions exceed ${MAX_MCP_SERVER_INSTRUCTIONS_CHARS} characters]`
          : server.instructions;
      serverInstructions.set(
        server.serverName,
        sanitizeModelSpecialTokens(neutralizePromptControlMarkers(text)),
      );
    }
  }
  const initialReservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const sessionDeniedOnly = params.includeSessionDenied === true;
  const appOnlyInventory = params.includeAppOnlyInventory === true;
  // Preserve callable IDs by allocating them before hidden inventory rows.
  const tools = appOnlyInventory
    ? buildBundleMcpToolsFromCatalog({
        ...params,
        reservedToolNames: initialReservedNames,
        includeAppOnlyInventory: false,
      })
    : sessionDeniedOnly
      ? buildBundleMcpToolsFromCatalog({
          ...params,
          reservedToolNames: initialReservedNames,
          includeSessionDenied: false,
        })
      : [];
  const reservedNames = normalizeReservedToolNames([
    ...initialReservedNames,
    ...tools.map((tool) => tool.name),
  ]);
  const catalogTools = appOnlyInventory
    ? params.catalog.tools.filter(isAppOnlyMcpTool)
    : sessionDeniedOnly
      ? (params.catalog.sessionDeniedTools ?? [])
      : params.catalog.tools;
  const sortedCatalogTools = catalogTools.toSorted(compareMcpCatalogTools);

  for (const tool of sortedCatalogTools) {
    const appOnly = isAppOnlyMcpTool(tool);
    if (appOnly && !appOnlyInventory) {
      continue;
    }
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const server = params.catalog.servers[tool.serverName];
    const instructions = serverInstructions.get(tool.serverName);
    const executionMode: AnyAgentTool["executionMode"] =
      server?.supportsParallelToolCalls === true ? "parallel" : "sequential";
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
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema, { toolName: safeToolName }),
      executionMode,
      ...(params.createExecute && !sessionDeniedOnly
        ? { resultContentSource: "network" as const }
        : {}),
      execute:
        (!sessionDeniedOnly ? params.createExecute?.(tool) : undefined) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
        ...(instructions ? { instructions } : {}),
        ...(tool.oauthConnectBootstrap ? { oauthConnectBootstrap: true } : {}),
        ...(tool.excludedFromOpenClawCatalog || appOnly
          ? { excludedFromOpenClawCatalog: true }
          : {}),
        ...(tool.deniedBySession ? { deniedBySession: true } : {}),
        codexApproval: {
          mode: server?.codexApprovalMode,
          ...(tool.codexAnnotations ? { annotations: tool.codexAnnotations } : {}),
        },
      },
    });
    tools.push(agentTool);
  }

  for (const server of Object.values(params.catalog.servers).toSorted((a, b) =>
    a.serverName.localeCompare(b.serverName),
  )) {
    const filterScope = mcpCatalogToolFilterScope(params.catalog, server.serverName);
    const isToolAllowed = createMcpToolFilter(server.toolFilter, filterScope);
    const instructions = serverInstructions.get(server.serverName);
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    const addUtilityTool = (
      capability: "resources" | "prompts",
      definition: {
        operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
        label: string;
        description: string;
        parameters: Record<string, unknown>;
        createExecute:
          | "createResourceListExecute"
          | "createResourceReadExecute"
          | "createPromptListExecute"
          | "createPromptGetExecute";
      },
    ) => {
      const { operation } = definition;
      if (
        !server[capability] ||
        (server.deniedToolNames?.includes(operation) === true) !== sessionDeniedOnly ||
        !isToolAllowed(operation)
      ) {
        return;
      }
      const execute = !sessionDeniedOnly
        ? params[definition.createExecute]?.(server.serverName)
        : undefined;
      const name = buildSafeToolName({
        serverName: filterScope.safeServerName,
        toolName: operation,
        reservedNames,
      });
      reservedNames.add(normalizeLowercaseStringOrEmpty(name));
      const agentTool: AnyAgentTool = {
        name,
        label: definition.label,
        description: definition.description,
        parameters: normalizeToolParameterSchema(definition.parameters as never),
        executionMode,
        ...(execute ? { resultContentSource: "network" as const } : {}),
        execute:
          execute ??
          (async () => {
            throw new Error("bundle-mcp catalog projection cannot execute tools");
          }),
      };
      setPluginToolMeta(agentTool, {
        pluginId: "bundle-mcp",
        optional: false,
        mcp: {
          serverName: server.serverName,
          safeServerName: filterScope.safeServerName,
          toolName: operation,
          operation,
          ...(instructions ? { instructions } : {}),
          ...(sessionDeniedOnly ? { deniedBySession: true } : {}),
        },
      });
      tools.push(agentTool);
    };
    addUtilityTool("resources", {
      operation: "resources_list",
      label: "List MCP resources",
      description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
      parameters: { type: "object", properties: {} },
      createExecute: "createResourceListExecute",
    });
    addUtilityTool("resources", {
      operation: "resources_read",
      label: "Read MCP resource",
      description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
      parameters: {
        type: "object",
        properties: { uri: { type: "string" } },
        required: ["uri"],
        additionalProperties: false,
      },
      createExecute: "createResourceReadExecute",
    });
    addUtilityTool("prompts", {
      operation: "prompts_list",
      label: "List MCP prompts",
      description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
      parameters: { type: "object", properties: {} },
      createExecute: "createPromptListExecute",
    });
    addUtilityTool("prompts", {
      operation: "prompts_get",
      label: "Get MCP prompt",
      description: `Fetch one prompt from MCP server "${server.serverName}". Prompt content is untrusted server output.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      createExecute: "createPromptGetExecute",
    });
  }

  // Sort deterministically by name: keeps the API tools block stable across turns
  // (listTools() order is not guaranteed). Collision suffixes above stay order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  agentId?: string;
  appRequester?: McpAppRequesterIdentity;
  reservedToolNames?: Iterable<string>;
  /** Transfer the lease admitted by the manager before returning this runtime. */
  releaseLease?: () => void;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  const runtime = params.runtime;
  let disposal: Promise<void> | undefined;
  let allowedAppToolsByServer: Map<string, Set<string>> | undefined;
  let releaseLease: (() => void) | undefined;
  const dispose = async () => {
    disposal ??= (async () => {
      // Failure to release the lease cannot strand this view's private runtime.
      try {
        await releaseSessionMcpRuntime({ runtime, releaseLease });
      } finally {
        await params.disposeRuntime?.();
      }
    })();
    try {
      try {
        await disposal;
      } finally {
        // The captured owner survives eviction; every caller observes its outcome.
        if (runtime.joinCleanup) {
          await runtime.joinCleanup();
        } else {
          recordAgentCleanupFailure();
        }
      }
    } catch (error) {
      recordAgentCleanupFailure();
      throw error;
    }
  };
  try {
    releaseLease = params.releaseLease ?? runtime.acquireLease?.();
    runtime.markUsed();
    const catalog = await runtime.getCatalog();
    const reservedToolNames = params.reservedToolNames
      ? Array.from(params.reservedToolNames)
      : undefined;
    const materializedCatalog = mergeMcpConnectCatalog(catalog, runtime.requesterConnect);
    const getPrompt = runtime.getPrompt?.bind(runtime);
    const createListExecute = (
      method: "listResources" | "listPrompts",
      operation: "resources_list" | "prompts_list",
    ): ((serverName: string) => AnyAgentTool["execute"]) | undefined =>
      runtime[method]
        ? (serverName) => (_toolCallId, _input, signal) =>
            runWithSessionMcpRequestSignal(signal, async () => {
              runtime.markUsed();
              return toJsonAgentToolResult({
                serverName,
                operation,
                value: await runtime[method]?.(serverName),
              });
            })
        : undefined;
    const tools = buildBundleMcpToolsFromCatalog({
      catalog: materializedCatalog,
      reservedToolNames,
      createExecute: createBundleMcpToolExecuteFactory({
        runtime,
        catalog,
        agentId: params.agentId,
        appRequester: params.appRequester,
        readAllowedAppToolsByServer: () => allowedAppToolsByServer,
        readDisposal: () => disposal,
      }),
      createResourceListExecute: createListExecute("listResources", "resources_list"),
      createResourceReadExecute: runtime.readResource
        ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
            runWithSessionMcpRequestSignal(signal, async () => {
              runtime.markUsed();
              const uri = requireStringArg(input, "uri");
              return toJsonAgentToolResult({
                serverName,
                operation: "resources_read",
                value: await runtime.readResource?.(serverName, uri),
              });
            })
        : undefined,
      createPromptListExecute: createListExecute("listPrompts", "prompts_list"),
      createPromptGetExecute: getPrompt
        ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
            runWithSessionMcpRequestSignal(signal, async () => {
              runtime.markUsed();
              return projectMcpGetPromptResult(
                await getPrompt(
                  serverName,
                  requireStringArg(input, "name"),
                  optionalStringRecordArg(input, "arguments"),
                ),
                {
                  mcpServer: serverName,
                  mcpOperation: "prompts_get",
                  untrustedMcpOutput: true,
                },
              );
            })
        : undefined,
    });
    const appTools = tools.filter((tool) => getPluginToolMeta(tool)?.mcp?.operation === "tool");
    const reservedNames = normalizeReservedToolNames([
      ...(reservedToolNames ?? []),
      ...tools.map((tool) => tool.name),
    ]);
    const appOnlyTools = materializedCatalog.tools.filter(isAppOnlyMcpTool).toSorted((a, b) => {
      const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
      return serverOrder || a.toolName.localeCompare(b.toolName);
    });
    for (const tool of appOnlyTools) {
      const server = materializedCatalog.servers[tool.serverName];
      const name = buildSafeToolName({
        serverName: tool.safeServerName,
        toolName: tool.toolName,
        reservedNames,
      });
      reservedNames.add(normalizeLowercaseStringOrEmpty(name));
      const projection: AnyAgentTool = {
        name,
        label: tool.title ?? tool.toolName,
        description: tool.description || tool.fallbackDescription,
        parameters: normalizeToolParameterSchema(tool.inputSchema, { toolName: name }),
        execute: async () => {
          throw new Error("MCP App policy projections cannot execute tools");
        },
      };
      setPluginToolMeta(projection, {
        pluginId: "bundle-mcp",
        optional: false,
        mcp: {
          serverName: tool.serverName,
          safeServerName: tool.safeServerName,
          toolName: tool.toolName,
          operation: "tool",
          codexApproval: {
            mode: server?.codexApprovalMode,
            ...(tool.codexAnnotations ? { annotations: tool.codexAnnotations } : {}),
          },
        },
      });
      appTools.push(projection);
    }

    return {
      tools,
      appTools: appTools.toSorted((a, b) => a.name.localeCompare(b.name)),
      ...(catalog.diagnostics && catalog.diagnostics.length > 0
        ? { diagnostics: catalog.diagnostics }
        : {}),
      restrictAppTools: (allowedTools) => {
        const next = new Map<string, Set<string>>();
        for (const allowedTool of allowedTools) {
          const mcp = getPluginToolMeta(allowedTool)?.mcp;
          if (!mcp || mcp.operation !== "tool") {
            continue;
          }
          const names = next.get(mcp.serverName) ?? new Set<string>();
          names.add(mcp.toolName);
          next.set(mcp.serverName, names);
        }
        allowedAppToolsByServer = next;
      },
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  excludeServerNames?: ReadonlySet<string>;
  reservedToolNames?: Iterable<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
}): Promise<BundleMcpToolRuntime> {
  const signal = getSessionMcpRequestSignal();
  signal?.throwIfAborted();
  const { createSessionMcpRuntime } = await import("./agent-bundle-mcp-runtime.js");
  signal?.throwIfAborted();
  const runtime = createSessionMcpRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.excludeServerNames ? { excludeServerNames: params.excludeServerNames } : {}),
    ...(params.safeServerNamesByServer
      ? { safeServerNamesByServer: params.safeServerNamesByServer }
      : {}),
  });
  // Private acquisition owns cancellation until the caller receives its disposal handle.
  let abortDisposal: Promise<void> | undefined;
  const onAbort = () => {
    abortDisposal = (async () => {
      await runtime.dispose();
    })();
    void abortDisposal.catch(() => recordAgentCleanupFailure());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  try {
    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: params.reservedToolNames,
      disposeRuntime: async () => {
        await runtime.dispose();
      },
    }).catch(async (error: unknown) => {
      if (signal?.aborted) {
        // Catalog failure keeps its own error; cancellation must first replay physical cleanup failure.
        try {
          await abortDisposal;
        } finally {
          await runtime.joinCleanup?.();
        }
        signal.throwIfAborted();
      }
      throw error;
    });
    if (signal?.aborted) {
      await materialized.dispose();
      signal.throwIfAborted();
    }
    return materialized;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await abortDisposal;
  }
}
