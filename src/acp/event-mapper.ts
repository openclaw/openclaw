import type { ContentBlock, ImageContent, ToolKind } from "@agentclientprotocol/sdk";

export type GatewayAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

// Max length for resource link titles to prevent excessively long prompt content
const RESOURCE_TITLE_MAX_LENGTH = 200;

/**
 * Sanitizes a resource link title before it is interpolated into an agent prompt.
 * Prevents prompt injection via crafted title fields (CWE-74, CWE-20, GHSA-74xj-763f-264w).
 *
 * - Replaces newline and carriage return characters with a space to block multi-line injection
 * - Truncates the title to RESOURCE_TITLE_MAX_LENGTH characters
 */
export function sanitizeResourceTitle(title: string): string {
  // Strip control characters that allow injecting new prompt lines
  const stripped = title.replace(/[\r\n]/g, " ");
  // Truncate to prevent excessively long injections
  return stripped.length > RESOURCE_TITLE_MAX_LENGTH
    ? stripped.slice(0, RESOURCE_TITLE_MAX_LENGTH)
    : stripped;
}

export function extractTextFromPrompt(prompt: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource") {
      const resource = block.resource as { text?: string } | undefined;
      if (resource?.text) {
        parts.push(resource.text);
      }
      continue;
    }
    if (block.type === "resource_link") {
      const rawTitle = block.title ? sanitizeResourceTitle(block.title) : "";
      const title = rawTitle ? ` (${rawTitle})` : "";
      const uri = block.uri ?? "";
      const line = uri ? `[Resource link${title}] ${uri}` : `[Resource link${title}]`;
      parts.push(line);
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
