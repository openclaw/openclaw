import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { mediaKindFromMime, maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { logWarn } from "../logger.js";
import { resolveOutboundAttachmentFromBuffer } from "../media/outbound-attachment.js";

type McpRelayMediaAttachment = {
  type: "image" | "audio" | "resource";
  mediaUrl: string;
  mimeType?: string;
  uri?: string;
};

export type McpRelayMedia = {
  source: "mcp";
  hostOwned: true;
  attachments: McpRelayMediaAttachment[];
};

type McpRelayMediaBudget = {
  attachmentCount: number;
  decodedBytes: number;
};

const MAX_MCP_RELAY_MEDIA_ATTACHMENTS_PER_RESULT = 8;
const MAX_MCP_RELAY_MEDIA_BYTES_PER_RESULT = 32 * 1024 * 1024;
const MAX_HOST_OWNED_MCP_MEDIA_PATHS = 2_000;
const hostOwnedMcpMediaPaths: string[] = [];
const hostOwnedMcpMediaPathSet = new Set<string>();

function registerHostOwnedMcpMediaPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed || hostOwnedMcpMediaPathSet.has(trimmed)) {
    return;
  }
  hostOwnedMcpMediaPaths.push(trimmed);
  hostOwnedMcpMediaPathSet.add(trimmed);
  while (hostOwnedMcpMediaPaths.length > MAX_HOST_OWNED_MCP_MEDIA_PATHS) {
    const oldest = hostOwnedMcpMediaPaths.shift();
    if (oldest) {
      hostOwnedMcpMediaPathSet.delete(oldest);
    }
  }
}

export function isHostOwnedMcpMediaPath(path: string): boolean {
  return hostOwnedMcpMediaPathSet.has(path.trim());
}

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
  canonicalBase64: string;
  maxBytes: number;
  estimatedBytes: number;
}): Buffer {
  if (params.estimatedBytes > params.maxBytes) {
    throw new Error(
      `MCP content too large: ${params.estimatedBytes} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
  const buffer = Buffer.from(params.canonicalBase64, "base64");
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

function releaseMcpRelayMediaBudget(params: {
  budget: McpRelayMediaBudget;
  estimatedBytes: number;
}) {
  params.budget.attachmentCount = Math.max(0, params.budget.attachmentCount - 1);
  params.budget.decodedBytes = Math.max(0, params.budget.decodedBytes - params.estimatedBytes);
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
  let reservedEstimatedBytes: number | undefined;
  try {
    const estimatedBytes = estimateBoundedBase64DataBytes(params.data, maxBytes);
    if (estimatedBytes === undefined) {
      return undefined;
    }
    const canonicalBase64 = canonicalizeMcpBase64Data(params.data);
    if (!canonicalBase64) {
      throw new Error("MCP content has invalid base64 data");
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
    reservedEstimatedBytes = estimatedBytes;
    const buffer = decodeBoundedBase64Data({
      canonicalBase64,
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
    if (reservedEstimatedBytes !== undefined) {
      releaseMcpRelayMediaBudget({
        budget: params.budget,
        estimatedBytes: reservedEstimatedBytes,
      });
    }
    logWarn(
      `bundle-mcp: could not stage ${params.type} content from ${params.serverName}/${params.toolName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

async function stageMcpContentBlock(params: {
  serverName: string;
  toolName: string;
  block: ContentBlock;
  index: number;
  budget: McpRelayMediaBudget;
}): Promise<McpRelayMediaAttachment | undefined> {
  const { block } = params;
  switch (block.type) {
    case "image":
      return block.data && block.mimeType
        ? stageMcpBinaryAttachment({
            serverName: params.serverName,
            toolName: params.toolName,
            index: params.index,
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
            budget: params.budget,
          })
        : undefined;
    case "audio":
      return block.data
        ? stageMcpBinaryAttachment({
            serverName: params.serverName,
            toolName: params.toolName,
            index: params.index,
            type: "audio",
            data: block.data,
            mimeType: block.mimeType,
            budget: params.budget,
          })
        : undefined;
    case "resource": {
      const resource = block.resource;
      if (!("blob" in resource) || typeof resource.blob !== "string") {
        return undefined;
      }
      const mimeType =
        "mimeType" in resource && typeof resource.mimeType === "string"
          ? resource.mimeType
          : undefined;
      return stageMcpBinaryAttachment({
        serverName: params.serverName,
        toolName: params.toolName,
        index: params.index,
        type: "resource",
        data: resource.blob,
        mimeType,
        uri: resource.uri,
        budget: params.budget,
      });
    }
    default:
      return undefined;
  }
}

export async function stageMcpRelayMediaAttachments(params: {
  serverName: string;
  toolName: string;
  content: readonly ContentBlock[];
}): Promise<McpRelayMediaAttachment[]> {
  const attachments: McpRelayMediaAttachment[] = [];
  const budget: McpRelayMediaBudget = { attachmentCount: 0, decodedBytes: 0 };
  for (const [index, block] of params.content.entries()) {
    const attachment = await stageMcpContentBlock({
      serverName: params.serverName,
      toolName: params.toolName,
      block,
      index,
      budget,
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }
  return attachments;
}
