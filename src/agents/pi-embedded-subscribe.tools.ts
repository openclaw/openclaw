import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { type MessagingToolSend } from "./pi-embedded-messaging.js";
import { normalizeToolName } from "./tool-policy.js";

/**
 * Media artifact declared by a tool in `details.media`.
 * Describes what the tool produced (files, audio) — not how to deliver it.
 * The consumer (block reply pipeline) decides delivery.
 */
export type ToolMediaArtifact = {
  mediaUrl?: string;
  mediaUrls?: string[];
  /** When true, audio should be sent as a voice bubble, not a file attachment. */
  audioAsVoice?: boolean;
};

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;
const HTTP_URL_RE = /^https?:\/\//i;
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
  "image_generate",
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

function normalizeMediaArtifact(value: unknown): ToolMediaArtifact | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl : undefined;
  const mediaUrls = Array.isArray(record.mediaUrls)
    ? record.mediaUrls.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : undefined;
  const audioAsVoice = record.audioAsVoice === true;
  if (!mediaUrl && !mediaUrls?.length && !audioAsVoice) {
    return undefined;
  }
  return {
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls?.length ? { mediaUrls } : {}),
    ...(audioAsVoice ? { audioAsVoice } : {}),
  };
}

function isToolResultMediaTrusted(toolName: string): boolean {
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalizeToolName(toolName));
}

function filterMediaArtifactUrls(
  toolName: string,
  artifact: ToolMediaArtifact,
): ToolMediaArtifact | undefined {
  const allowLocalPaths = isToolResultMediaTrusted(toolName);
  const mediaUrl =
    typeof artifact.mediaUrl === "string" &&
    (allowLocalPaths || HTTP_URL_RE.test(artifact.mediaUrl.trim()))
      ? artifact.mediaUrl
      : undefined;
  const mediaUrls = artifact.mediaUrls?.filter(
    (url) => allowLocalPaths || HTTP_URL_RE.test(url.trim()),
  );
  if (!mediaUrl && !mediaUrls?.length && !artifact.audioAsVoice) {
    return undefined;
  }
  return {
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls?.length ? { mediaUrls } : {}),
    ...(artifact.audioAsVoice ? { audioAsVoice: true } : {}),
  };
}

/**
 * Extract media artifacts from a tool result's `details.media` field.
 * Returns undefined when the tool did not produce any deliverable media.
 */
export function extractToolMediaArtifact(
  toolName: string,
  result: unknown,
): ToolMediaArtifact | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const raw =
    normalizeMediaArtifact(record.media) ??
    normalizeMediaArtifact(
      record.details && typeof record.details === "object"
        ? (record.details as Record<string, unknown>).media
        : undefined,
    );
  if (!raw) {
    return undefined;
  }
  return filterMediaArtifactUrls(toolName, raw);
}

/** Resolve all media URLs from a ToolMediaArtifact into a flat list. */
export function resolveMediaArtifactUrls(artifact: ToolMediaArtifact): string[] {
  const urls: string[] = [];
  if (artifact.mediaUrl) {
    urls.push(artifact.mediaUrl);
  }
  if (artifact.mediaUrls?.length) {
    urls.push(...artifact.mediaUrls);
  }
  return urls;
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
