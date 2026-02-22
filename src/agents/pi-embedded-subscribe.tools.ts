import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { MEDIA_TOKEN_RE } from "../media/parse.js";
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

  // Extract MEDIA: paths from text content blocks.
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
      // Only parse lines that start with MEDIA: (after trimming) to avoid
      // false-matching placeholders like <media:audio> or mid-line mentions.
      // Mirrors the line-start guard in splitMediaFromOutput (media/parse.ts).
      for (const line of entry.text.split("\n")) {
        if (!line.trimStart().startsWith("MEDIA:")) {
          continue;
        }
        MEDIA_TOKEN_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = MEDIA_TOKEN_RE.exec(line)) !== null) {
          const p = match[1]
            ?.replace(/^[`"'[{(]+/, "")
            .replace(/[`"'\]})\\,]+$/, "")
            .trim();
          if (p && p.length <= 4096) {
            paths.push(p);
          }
        }
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
    const toRaw = typeof args.to === "string" ? args.to : undefined;
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
