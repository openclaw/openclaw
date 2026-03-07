import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { type MessagingToolSend } from "./pi-embedded-messaging.js";
import { normalizeToolName } from "./tool-policy.js";

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

function isErrorLikeStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

export function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

export function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const texts = collectTextContentBlocks(record.content)
    .map((item) => {
      const trimmed = item.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

// Core tool names that are allowed to emit local MEDIA: paths.
// Plugin/MCP tools are intentionally excluded to prevent untrusted file reads.
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "image",
  "memory_get",
  "memory_search",
  "message",
  "nodes",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "tts",
  "web_fetch",
  "web_search",
  "write",
]);
const HTTP_URL_RE = /^https?:\/\//i;

export function isToolResultMediaTrusted(toolName?: string): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalized);
}

export function filterToolResultMediaUrls(
  toolName: string | undefined,
  mediaUrls: string[],
): string[] {
  if (mediaUrls.length === 0) {
    return mediaUrls;
  }
  if (isToolResultMediaTrusted(toolName)) {
    return mediaUrls;
  }
  return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}

/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Parse `MEDIA:` tokens from text content blocks (all OpenClaw tools).
 * 2. Fall back to `details.path` when image content exists (OpenClaw imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
export function extractToolResultMediaPaths(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return [];
  }

  // Extract MEDIA: paths from text content blocks using the shared parser so
  // directive matching and validation stay in sync with outbound reply parsing.
  const paths: string[] = [];
  let hasImageContent = false;
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      hasImageContent = true;
      continue;
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      const parsed = splitMediaFromOutput(entry.text);
      if (parsed.mediaUrls?.length) {
        paths.push(...parsed.mediaUrls);
      }
    }
  }

  if (paths.length > 0) {
    return paths;
  }

  // Fall back to details.path when image content exists but no MEDIA: text.
  if (hasImageContent) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = typeof details?.path === "string" ? details.path.trim() : "";
    if (p) {
      return [p];
    }
  }

  return [];
}

type ImageContentBlock = {
  type: "image";
  data: string;
  mimeType: string;
};

function extractImageBlocks(content: unknown[]): ImageContentBlock[] {
  const images: ImageContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "image") {
      continue;
    }
    const data = typeof entry.data === "string" ? entry.data : undefined;
    const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : undefined;
    if (!data || !mimeType) {
      continue;
    }
    images.push({ type: "image", data, mimeType });
  }
  return images;
}

function mimeTypeToExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().trim();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
    case "image/tif":
      return ".tiff";
    case "image/svg+xml":
      return ".svg";
    default:
      // Fall back to first part after "image/"
      const match = normalized.match(/^image\/([a-z0-9+-]+)$/i);
      return match ? `.${match[1]}` : ".bin";
  }
}

/**
 * Extract media paths from tool result, saving base64 image data to temp files.
 * This is an async version that handles image content blocks that don't have
 * an associated file path by saving them to temporary files.
 *
 * Strategy (order of precedence):
 * 1. Parse `MEDIA:` tokens from text content blocks.
 * 2. Use `details.path` when image content exists.
 * 3. Save base64 image data to temp files when no path is available.
 */
export async function extractToolResultMediaPathsAsync(result: unknown): Promise<string[]> {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return [];
  }

  // First, try to extract paths from text and details.path
  const paths = extractToolResultMediaPaths(result);
  if (paths.length > 0) {
    return paths;
  }

  // If no paths found but we have image content blocks, save them to temp files
  const imageBlocks = extractImageBlocks(content);
  if (imageBlocks.length === 0) {
    return [];
  }

  // Use tmp directory under current working directory
  const tempRoot = path.join(process.cwd(), "tmp");
  const tempDir = path.join(
    tempRoot,
    `openclaw-tool-image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const savedPaths: string[] = [];

  try {
    await mkdir(tempDir, { recursive: true });

    for (let i = 0; i < imageBlocks.length; i++) {
      const block = imageBlocks[i];
      const ext = mimeTypeToExtension(block.mimeType);
      const fileName = `image-${i}${ext}`;
      const filePath = path.join(tempDir, fileName);

      // Decode base64 and write to file
      const buffer = Buffer.from(block.data, "base64");
      await writeFile(filePath, buffer);
      savedPaths.push(filePath);
    }

    return savedPaths;
  } catch (err) {
    // Clean up on failure
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

export function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as { details?: unknown };
  const details = record.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const status = (details as { status?: unknown }).status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "timeout";
}

export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to first-line text fallback.
  }
  return normalizeToolErrorText(text);
}

function resolveMessageToolTarget(args: Record<string, unknown>): string | undefined {
  const toRaw = typeof args.to === "string" ? args.to : undefined;
  if (toRaw) {
    return toRaw;
  }
  return typeof args.target === "string" ? args.target : undefined;
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const toRaw = resolveMessageToolTarget(args);
    if (!toRaw) {
      return undefined;
    }
    const providerRaw = typeof args.provider === "string" ? args.provider.trim() : "";
    const channelRaw = typeof args.channel === "string" ? args.channel.trim() : "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const provider = providerId ?? (providerHint ? providerHint.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}
