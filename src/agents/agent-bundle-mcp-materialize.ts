/** Materializes configured MCP catalog entries into agent tools and runtime helpers. */
import crypto from "node:crypto";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { mediaKindFromMime, maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { resolveOutboundAttachmentFromBuffer } from "../media/outbound-attachment.js";
import { setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { registerHostOwnedMcpMediaPath } from "./mcp-tool-result-media.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

type ToolResultContentBlock = AgentToolResult<unknown>["content"][number];
type McpRelayMediaAttachment = {
  type: "image" | "audio" | "resource";
  mediaUrl: string;
  mimeType?: string;
  uri?: string;
};
type McpRelayMedia = {
  source: "mcp";
  hostOwned: true;
  attachments: McpRelayMediaAttachment[];
};
type McpContentBlockMaterialization = {
  content: ToolResultContentBlock;
  attachments: McpRelayMediaAttachment[];
};
type McpRelayMediaBudget = {
  attachmentCount: number;
  decodedBytes: number;
};

const MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT = 8;
const MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT = 32 * 1024 * 1024;

function estimateBoundedBase64DataBytes(data: string, maxBytes: number): number | undefined {
  const estimatedBytes = estimateBase64DecodedBytes(data);
  if (estimatedBytes === 0) {
    return undefined;
  }
  if (estimatedBytes > maxBytes) {
    throw new Error(`MCP content too large: ${estimatedBytes} bytes (limit: ${maxBytes} bytes)`);
  }
  return estimatedBytes;
}

function canonicalizeMcpBase64Data(data: string): string | undefined {
  const canonicalBase64 = canonicalizeBase64(data);
  if (canonicalBase64) {
    return canonicalBase64;
  }

  let cleaned = "";
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f
    ) {
      cleaned += data[i];
      continue;
    }
    return undefined;
  }

  if (!cleaned) {
    return undefined;
  }
  const remainder = cleaned.length % 4;
  if (remainder === 1) {
    return undefined;
  }
  if (remainder === 2) {
    return `${cleaned}==`;
  }
  if (remainder === 3) {
    return `${cleaned}=`;
  }
  return cleaned;
}

function decodeBoundedBase64Data(params: {
  data: string;
  maxBytes: number;
  estimatedBytes: number;
}): Buffer {
  if (params.estimatedBytes > params.maxBytes) {
    throw new Error(
      `MCP content too large: ${params.estimatedBytes} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
  const canonicalBase64 = canonicalizeMcpBase64Data(params.data);
  if (!canonicalBase64) {
    throw new Error("MCP content has invalid base64 data");
  }
  const buffer = Buffer.from(canonicalBase64, "base64");
  if (buffer.byteLength > params.maxBytes) {
    throw new Error(
      `MCP content too large: ${buffer.byteLength} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
  return buffer;
}

function maxBytesForMime(mimeType: string | undefined): number {
  const kind = mediaKindFromMime(mimeType) ?? "document";
  return maxBytesForKind(kind);
}

function mcpAttachmentFileName(params: {
  serverName: string;
  toolName: string;
  index: number;
  mimeType?: string;
}): string {
  const ext = extensionForMime(params.mimeType);
  return `${params.serverName}-${params.toolName}-${params.index}${ext ?? ""}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
}

function reserveMcpRelayMediaBudget(params: {
  budget: McpRelayMediaBudget;
  estimatedBytes: number;
  serverName: string;
  toolName: string;
  type: McpRelayMediaAttachment["type"];
}): boolean {
  if (params.budget.attachmentCount >= MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `MCP media attachment count limit reached (${MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT})`,
    );
    return false;
  }
  if (params.budget.decodedBytes + params.estimatedBytes > MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT) {
    logWarn(
      `bundle-mcp: skipping ${params.type} content from ${params.serverName}/${params.toolName}: ` +
        `MCP media decoded-byte limit reached (${MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT} bytes)`,
    );
    return false;
  }
  params.budget.attachmentCount += 1;
  params.budget.decodedBytes += params.estimatedBytes;
  return true;
}

async function stageMcpBinaryAttachment(params: {
  serverName: string;
  toolName: string;
  index: number;
  type: McpRelayMediaAttachment["type"];
  data: string;
  mimeType?: string;
  uri?: string;
  budget: McpRelayMediaBudget;
}): Promise<McpRelayMediaAttachment | undefined> {
  const mimeType = normalizeMimeType(params.mimeType);
  const maxBytes = maxBytesForMime(mimeType);
  try {
    const estimatedBytes = estimateBoundedBase64DataBytes(params.data, maxBytes);
    if (estimatedBytes === undefined) {
      return undefined;
    }
    if (
      !reserveMcpRelayMediaBudget({
        budget: params.budget,
        estimatedBytes,
        serverName: params.serverName,
        toolName: params.toolName,
        type: params.type,
      })
    ) {
      return undefined;
    }
    const buffer = decodeBoundedBase64Data({
      data: params.data,
      maxBytes,
      estimatedBytes,
    });
    const staged = await resolveOutboundAttachmentFromBuffer(buffer, maxBytes, {
      ...(mimeType ? { contentType: mimeType } : {}),
      filename: mcpAttachmentFileName({
        serverName: params.serverName,
        toolName: params.toolName,
        index: params.index,
        mimeType,
      }),
    });
    registerHostOwnedMcpMediaPath(staged.path);
    return {
      type: params.type,
      mediaUrl: staged.path,
      ...((staged.contentType ?? mimeType) ? { mimeType: staged.contentType ?? mimeType } : {}),
      ...(params.uri ? { uri: params.uri } : {}),
    };
  } catch (error) {
    logWarn(
      `bundle-mcp: could not stage ${params.type} content from ${params.serverName}/${params.toolName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// AgentToolResult only carries text/image, but an MCP CallToolResult can also
// return resource_link, resource, and audio blocks (MCP SDK ContentBlock union).
// Coercing those into the text/image contract here keeps the boundary honest so
// downstream provider converters never build an image block with undefined
// data/media_type, which makes Anthropic 400 and poisons the whole session
// history (every later turn replays the bad block and 400s too). See #90710.
async function mcpContentBlockToToolResult(params: {
  serverName: string;
  toolName: string;
  block: ContentBlock;
  index: number;
  budget: McpRelayMediaBudget;
}): Promise<McpContentBlockMaterialization> {
  const { block } = params;
  const attachments: McpRelayMediaAttachment[] = [];
  switch (block.type) {
    case "text":
      return { content: { type: "text", text: block.text }, attachments };
    case "image":
      // Only emit an image when the base64 source is actually present.
      if (block.data && block.mimeType) {
        const attachment = await stageMcpBinaryAttachment({
          serverName: params.serverName,
          toolName: params.toolName,
          index: params.index,
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
          budget: params.budget,
        });
        if (attachment) {
          attachments.push(attachment);
        }
        return {
          content: { type: "image", data: block.data, mimeType: block.mimeType },
          attachments,
        };
      }
      return { content: { type: "text", text: JSON.stringify(block) }, attachments };
    case "audio": {
      const attachment = block.data
        ? await stageMcpBinaryAttachment({
            serverName: params.serverName,
            toolName: params.toolName,
            index: params.index,
            type: "audio",
            data: block.data,
            mimeType: block.mimeType,
            budget: params.budget,
          })
        : undefined;
      if (attachment) {
        attachments.push(attachment);
      }
      return { content: { type: "text", text: `[audio ${block.mimeType}]` }, attachments };
    }
    case "resource_link": {
      const label = block.title ?? block.name;
      return {
        content: { type: "text", text: label ? `[${label}] ${block.uri}` : block.uri },
        attachments,
      };
    }
    case "resource": {
      const resource = block.resource;
      const text = "text" in resource ? resource.text : undefined;
      if ("blob" in resource && typeof resource.blob === "string") {
        const mimeType =
          "mimeType" in resource && typeof resource.mimeType === "string"
            ? resource.mimeType
            : undefined;
        const attachment = await stageMcpBinaryAttachment({
          serverName: params.serverName,
          toolName: params.toolName,
          index: params.index,
          type: "resource",
          data: resource.blob,
          mimeType,
          uri: resource.uri,
          budget: params.budget,
        });
        if (attachment) {
          attachments.push(attachment);
        }
      }
      return { content: { type: "text", text: text ?? resource.uri }, attachments };
    }
    default:
      // Forward-compat / untrusted-server guard: stringify any block type the
      // installed MCP SDK union does not cover instead of dropping it.
      return { content: { type: "text", text: JSON.stringify(block) }, attachments };
  }
}

async function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): Promise<AgentToolResult<unknown>> {
  const materializedBlocks: McpContentBlockMaterialization[] = [];
  const relayMediaBudget: McpRelayMediaBudget = { attachmentCount: 0, decodedBytes: 0 };
  if (Array.isArray(params.result.content)) {
    for (const [index, block] of params.result.content.entries()) {
      materializedBlocks.push(
        await mcpContentBlockToToolResult({
          serverName: params.serverName,
          toolName: params.toolName,
          block,
          index,
          budget: relayMediaBudget,
        }),
      );
    }
  }
  const content: AgentToolResult<unknown>["content"] = materializedBlocks.map(
    (block) => block.content,
  );
  const mediaAttachments: McpRelayMediaAttachment[] = materializedBlocks.flatMap(
    (block) => block.attachments,
  );
  const structuredContentBlock =
    params.result.structuredContent !== undefined
      ? ({
          type: "text",
          text: `structuredContent:\n${JSON.stringify(params.result.structuredContent, null, 2)}`,
        } as const)
      : null;
  // Structured MCP results are the canonical model payload here; replacing
  // mirrored content avoids duplicating large tool output in the prompt.
  const normalizedContent: AgentToolResult<unknown>["content"] = structuredContentBlock
    ? [structuredContentBlock]
    : content.length > 0
      ? content
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
  if (mediaAttachments.length > 0) {
    details.media = {
      source: "mcp",
      hostOwned: true,
      attachments: mediaAttachments,
    } satisfies McpRelayMedia;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(params.value, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
}

function requireStringArg(input: unknown, key: string): string {
  if (
    !input ||
    typeof input !== "object" ||
    typeof (input as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error(`${key} is required`);
  }
  return (input as Record<string, string>)[key];
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

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }
  return new RegExp(`^${trimmed.split("*").map(escapeRegex).join(".*")}$`).test(value);
}

function serverAllowsUtilityTool(
  server: McpToolCatalog["servers"][string],
  operation: string,
): boolean {
  const include = server.toolFilter?.include ?? [];
  const exclude = server.toolFilter?.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => globMatches(pattern, operation))) {
    return false;
  }
  return !exclude.some((pattern) => globMatches(pattern, operation));
}

function addMcpUtilityTool(params: {
  tools: AnyAgentTool[];
  reservedNames: Set<string>;
  serverName: string;
  safeServerName: string;
  executionMode: AnyAgentTool["executionMode"];
  operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: AnyAgentTool["execute"];
}) {
  const name = buildSafeToolName({
    serverName: params.safeServerName,
    toolName: params.operation,
    reservedNames: params.reservedNames,
  });
  params.reservedNames.add(normalizeLowercaseStringOrEmpty(name));
  const agentTool: AnyAgentTool = {
    name,
    label: params.label,
    description: params.description,
    parameters: normalizeToolParameterSchema(params.parameters as never),
    executionMode: params.executionMode,
    execute:
      params.execute ??
      (async () => {
        throw new Error("bundle-mcp catalog projection cannot execute tools");
      }),
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      toolName: params.operation,
      operation: params.operation,
    },
  });
  params.tools.push(agentTool);
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
}): AnyAgentTool[] {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const sortedCatalogTools = [...params.catalog.tools].toSorted((a, b) => {
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
    const server = params.catalog.servers[tool.serverName];
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
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      executionMode,
      execute:
        params.createExecute?.(tool) ??
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
      },
    });
    tools.push(agentTool);
  }

  for (const server of Object.values(params.catalog.servers).toSorted((a, b) =>
    a.serverName.localeCompare(b.serverName),
  )) {
    const safeServerName = server.safeServerName ?? server.serverName;
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    if (server.resources && serverAllowsUtilityTool(server, "resources_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_list",
        label: "List MCP resources",
        description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createResourceListExecute?.(server.serverName),
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_read",
        label: "Read MCP resource",
        description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
          additionalProperties: false,
        },
        execute: params.createResourceReadExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_list",
        label: "List MCP prompts",
        description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createPromptListExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
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
        execute: params.createPromptGetExecute?.(server.serverName),
      });
    }
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }
  const tools = buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames: params.reservedToolNames,
    createExecute: (tool) => async (_toolCallId: string, input: unknown) => {
      params.runtime.markUsed();
      const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
      return await toAgentToolResult({
        serverName: tool.serverName,
        toolName: tool.toolName,
        result,
      });
    },
    createResourceListExecute: params.runtime.listResources
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_list",
            value: await params.runtime.listResources?.(serverName),
          });
        }
      : undefined,
    createResourceReadExecute: params.runtime.readResource
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_read",
            value: await params.runtime.readResource?.(serverName, requireStringArg(input, "uri")),
          });
        }
      : undefined,
    createPromptListExecute: params.runtime.listPrompts
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_list",
            value: await params.runtime.listPrompts?.(serverName),
          });
        }
      : undefined,
    createPromptGetExecute: params.runtime.getPrompt
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_get",
            value: await params.runtime.getPrompt?.(
              serverName,
              requireStringArg(input, "name"),
              optionalStringRecordArg(input, "arguments"),
            ),
          });
        }
      : undefined,
  });

  return {
    tools,
    ...(catalog.diagnostics && catalog.diagnostics.length > 0
      ? { diagnostics: catalog.diagnostics }
      : {}),
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
    params.createRuntime ?? (await import("./agent-bundle-mcp-runtime.js")).createSessionMcpRuntime;
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
