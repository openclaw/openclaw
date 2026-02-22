import type { ContentBlock, ImageContent, ToolKind } from "@agentclientprotocol/sdk";

export type GatewayAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

function escapeInlineControlChars(value: string): string {
  const withoutNull = value.replaceAll("\0", "\\0");
  return withoutNull.replace(/[\r\n\t\v\f\u2028\u2029]/g, (char) => {
    switch (char) {
      case "\r":
        return "\\r";
      case "\n":
        return "\\n";
      case "\t":
        return "\\t";
      case "\v":
        return "\\v";
      case "\f":
        return "\\f";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function escapeResourceTitle(value: string): string {
  // Keep title content, but escape characters that can break the resource-link annotation shape.
  return escapeInlineControlChars(value).replace(/[()[\]]/g, (char) => `\\${char}`);
}

export function extractTextFromPrompt(prompt: ContentBlock[], maxBytes?: number): string {
  const parts: string[] = [];
  // Track accumulated byte count per block to catch oversized prompts before full concatenation
  let totalBytes = 0;
  for (const block of prompt) {
    let blockText: string | undefined;
    if (block.type === "text") {
      blockText = block.text;
    } else if (block.type === "resource") {
      const resource = block.resource as { text?: string } | undefined;
      if (resource?.text) {
        blockText = resource.text;
      }
    } else if (block.type === "resource_link") {
      const title = block.title ? ` (${escapeResourceTitle(block.title)})` : "";
      const uri = block.uri ? escapeInlineControlChars(block.uri) : "";
      blockText = uri ? `[Resource link${title}] ${uri}` : `[Resource link${title}]`;
    }
    if (blockText !== undefined) {
      // Guard: reject before allocating the full concatenated string
      if (maxBytes !== undefined) {
        const separatorBytes = parts.length > 0 ? 1 : 0; // "\n" added by join() between blocks
        totalBytes += separatorBytes + Buffer.byteLength(blockText, "utf-8");
        if (totalBytes > maxBytes) {
          throw new Error(`Prompt exceeds maximum allowed size of ${maxBytes} bytes`);
        }
      }
      parts.push(blockText);
    }
  }
  return parts.join("\n");
}

export function extractAttachmentsFromPrompt(prompt: ContentBlock[]): GatewayAttachment[] {
  const attachments: GatewayAttachment[] = [];
  for (const block of prompt) {
    if (block.type !== "image") {
      continue;
    }
    const image = block as ImageContent;
    if (!image.data || !image.mimeType) {
      continue;
    }
    attachments.push({
      type: "image",
      mimeType: image.mimeType,
      content: image.data,
    });
  }
  return attachments;
}

export function formatToolTitle(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const base = name ?? "tool";
  if (!args || Object.keys(args).length === 0) {
    return base;
  }
  const parts = Object.entries(args).map(([key, value]) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const safe = raw.length > 100 ? `${raw.slice(0, 100)}...` : raw;
    return `${key}: ${safe}`;
  });
  return `${base}: ${parts.join(", ")}`;
}

export function inferToolKind(name?: string): ToolKind {
  if (!name) {
    return "other";
  }
  const normalized = name.toLowerCase();
  if (normalized.includes("read")) {
    return "read";
  }
  if (normalized.includes("write") || normalized.includes("edit")) {
    return "edit";
  }
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }
  if (normalized.includes("move") || normalized.includes("rename")) {
    return "move";
  }
  if (normalized.includes("search") || normalized.includes("find")) {
    return "search";
  }
  if (normalized.includes("exec") || normalized.includes("run") || normalized.includes("bash")) {
    return "execute";
  }
  if (normalized.includes("fetch") || normalized.includes("http")) {
    return "fetch";
  }
  return "other";
}
