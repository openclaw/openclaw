import type { ContentBlock, ImageContent, ToolKind } from "@agentclientprotocol/sdk";

export type GatewayAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

const INLINE_CONTROL_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "\0": "\\0",
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
  "\v": "\\v",
  "\f": "\\f",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeInlineControlChars(value: string): string {
  let escaped = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      escaped += char;
      continue;
    }

    const isInlineControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (!isInlineControl) {
      escaped += char;
      continue;
    }

    const mapped = INLINE_CONTROL_ESCAPE_MAP[char];
    if (mapped) {
      escaped += mapped;
      continue;
    }

    // Keep escaped control bytes readable and stable in logs/prompts.
    escaped +=
      codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return escaped;
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
