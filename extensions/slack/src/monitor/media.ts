// Slack plugin module implements media behavior.
import fs from "node:fs/promises";
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeHostname } from "openclaw/plugin-sdk/host-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReference } from "../file-reference.js";
import type { SlackAttachment, SlackFile } from "../types.js";
export { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "./media-types.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "./media-types.js";
import { type FetchLike, fetchWithRuntimeDispatcher, saveRemoteMedia } from "./media.runtime.js";
import { logVerbose } from "./thread.runtime.js";
export {
  resetSlackThreadStarterCacheForTest,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
  type SlackThreadMessage,
  type SlackThreadStarter,
} from "./thread.js";

function isSlackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  // Slack-hosted files typically come from *.slack.com and redirect to Slack CDN domains.
  // Include a small allowlist of known Slack domains to avoid leaking tokens if a file URL
  // is ever spoofed or mishandled.
  const allowedSuffixes = ["slack.com", "slack-edge.com", "slack-files.com"];
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Slack file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!isSlackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to send Slack token to non-Slack host "${parsed.hostname}" (url: ${rawUrl})`,
    );
  }
  return parsed;
}

function createSlackAuthHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function createSlackMediaRequest(
  url: string,
  token: string,
): {
  url: string;
  requestInit: RequestInit;
} {
  const parsed = assertSlackFileUrl(url);
  return {
    url: parsed.href,
    // Let the shared guarded-fetch redirect logic preserve auth on same-origin
    // Slack hops and strip it once the redirect crosses origins.
    requestInit: { headers: createSlackAuthHeaders(token) },
  };
}

function isMockedFetch(fetchImpl: typeof fetch | undefined): boolean {
  if (typeof fetchImpl !== "function") {
    return false;
  }
  const candidate = fetchImpl as typeof fetch & {
    mock?: unknown;
    _isMockFunction?: unknown;
  };
  return candidate.mock !== undefined || candidate["_isMockFunction"] === true;
}

function createSlackMediaFetch(): FetchLike {
  return async (input, init) => {
    const url = resolveRequestUrl(input);
    if (!url) {
      throw new Error("Unsupported fetch input: expected string, URL, or Request");
    }
    const parsed = assertSlackFileUrl(url);
    const fetchImpl =
      "dispatcher" in (init ?? {}) && !isMockedFetch(globalThis.fetch)
        ? fetchWithRuntimeDispatcher
        : globalThis.fetch;
    return fetchImpl(parsed.href, { ...init, redirect: "manual" });
  };
}

function resolveSlackFetchForRuntime(): typeof fetch {
  return isMockedFetch(globalThis.fetch) ? globalThis.fetch : fetchWithRuntimeDispatcher;
}

/**
 * Fetches a URL with Authorization header while keeping same-origin redirects
 * authenticated and dropping auth once the redirect crosses origins.
 */
export async function fetchWithSlackAuth(url: string, token: string): Promise<Response> {
  const parsed = assertSlackFileUrl(url);
  const authHeaders = createSlackAuthHeaders(token);
  const fetchImpl = resolveSlackFetchForRuntime();

  const initialRes = await fetchImpl(parsed.href, {
    headers: authHeaders,
    redirect: "manual",
  });

  if (initialRes.status < 300 || initialRes.status >= 400) {
    return initialRes;
  }

  const redirectUrl = initialRes.headers.get("location");
  if (!redirectUrl) {
    return initialRes;
  }

  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(redirectUrl, parsed.href);
  } catch {
    return initialRes;
  }
  if (resolvedUrl.protocol !== "https:") {
    return initialRes;
  }
  if (resolvedUrl.origin === parsed.origin) {
    return fetchImpl(resolvedUrl.toString(), {
      headers: authHeaders,
      redirect: "follow",
    });
  }
  return fetchImpl(resolvedUrl.toString(), { redirect: "follow" });
}

const SLACK_MEDIA_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  hostnameAllowlist: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};
export const SLACK_MEDIA_READ_IDLE_TIMEOUT_MS = 60_000;
export const SLACK_MEDIA_TOTAL_TIMEOUT_MS = 120_000;
type SlackSaveRemoteMediaOptions = Parameters<typeof saveRemoteMedia>[0];

function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
  }
  const abort = () => {
    controller.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abort);
    }
  };
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

async function saveSlackMedia(params: {
  options: SlackSaveRemoteMediaOptions;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): ReturnType<typeof saveRemoteMedia> {
  const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : undefined;
  const signal = mergeAbortSignals([
    params.abortSignal,
    params.options.requestInit?.signal ?? undefined,
    timeoutAbortController?.signal,
  ]);
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const savePromise = saveRemoteMedia({
    ...params.options,
    readIdleTimeoutMs: params.readIdleTimeoutMs ?? SLACK_MEDIA_READ_IDLE_TIMEOUT_MS,
    ...(signal
      ? {
          requestInit: {
            ...params.options.requestInit,
            signal,
          },
        }
      : {}),
  }).catch((error: unknown) => {
    if (timedOut) {
      return new Promise<never>(() => {});
    }
    throw error;
  });

  try {
    if (!params.totalTimeoutMs) {
      return await savePromise;
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAbortController?.abort();
        reject(new Error(`slack media download timed out after ${params.totalTimeoutMs}ms`));
      }, params.totalTimeoutMs);
      timeoutHandle.unref?.();
    });
    return await Promise.race([savePromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Slack voice messages (audio clips, huddle recordings) carry a `subtype` of
 * `"slack_audio"` but are served with a `video/*` MIME type (e.g. `video/mp4`,
 * `video/webm`).  Override the primary type to `audio/` so the
 * media-understanding pipeline routes them to transcription.
 */
function resolveSlackMediaMimetype(
  file: SlackFile,
  fetchedContentType?: string,
): string | undefined {
  const mime = fetchedContentType ?? file.mimetype;
  if (file.subtype === "slack_audio" && mime?.startsWith("video/")) {
    return mime.replace("video/", "audio/");
  }
  return mime;
}

function looksLikeHtmlBuffer(buffer: Buffer): boolean {
  const head = normalizeLowercaseStringOrEmpty(
    buffer.subarray(0, 512).toString("utf-8").replace(/^\s+/, ""),
  );
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function looksLikeHtmlFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return looksLikeHtmlBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const MAX_SLACK_MEDIA_CONCURRENCY = 3;
const MAX_SLACK_FORWARDED_ATTACHMENTS = 8;

async function fetchFreshSlackFileUrl(params: {
  file: SlackFile;
  client?: SlackWebClient;
}): Promise<string | null> {
  if (!params.file.id || !params.client) {
    return null;
  }
  try {
    const info = await params.client.files.info({ file: params.file.id });
    const freshFile = info.file as SlackFile | undefined;
    const freshUrl = freshFile?.url_private_download ?? freshFile?.url_private;
    if (freshUrl) {
      logVerbose(`slack: refreshed file URL via files.info for file id=${params.file.id}`);
      return freshUrl;
    }
    logVerbose(`slack: files.info returned no private URL for file id=${params.file.id}`);
    return null;
  } catch (error) {
    logVerbose(
      `slack: files.info failed for file id=${params.file.id}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

async function downloadSlackMediaFile(params: {
  file: SlackFile;
  url: string;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<SlackMediaResult | null> {
  const { url: slackUrl, requestInit } = createSlackMediaRequest(params.url, params.token);
  const fetchImpl = createSlackMediaFetch();
  const saved = await saveSlackMedia({
    options: {
      url: slackUrl,
      fetchImpl,
      requestInit,
      filePathHint: params.file.name,
      fallbackContentType: resolveSlackMediaMimetype(params.file, params.file.mimetype),
      maxBytes: params.maxBytes,
      ssrfPolicy: SLACK_MEDIA_SSRF_POLICY,
    },
    readIdleTimeoutMs: params.readIdleTimeoutMs,
    totalTimeoutMs: params.totalTimeoutMs ?? SLACK_MEDIA_TOTAL_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });

  // Guard against auth/login HTML pages returned instead of binary media.
  // Allow user-provided HTML files through.
  const fileMime = normalizeOptionalLowercaseString(params.file.mimetype);
  const fileName = normalizeLowercaseStringOrEmpty(params.file.name);
  const isExpectedHtml =
    fileMime === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm");
  if (!isExpectedHtml) {
    const detectedMime = normalizeOptionalLowercaseString(saved.contentType?.split(";")[0]);
    if (detectedMime === "text/html" || (await looksLikeHtmlFile(saved.path))) {
      await fs.rm(saved.path, { force: true }).catch(() => undefined);
      return null;
    }
  }

  const effectiveMime = resolveSlackMediaMimetype(params.file, saved.contentType);
  const label = saved.fileName ?? params.file.name;
  const contentType = effectiveMime ?? saved.contentType;
  return {
    path: saved.path,
    ...(contentType ? { contentType } : {}),
    placeholder: `[Slack file: ${formatSlackFileReference({ ...params.file, name: label })}]`,
  };
}

function isForwardedSlackAttachment(attachment: SlackAttachment): boolean {
  // Narrow this parser to Slack's explicit "shared/forwarded" attachment payloads.
  return attachment.is_share === true;
}

function resolveForwardedAttachmentImageUrl(attachment: SlackAttachment): string | null {
  const rawUrl = attachment.image_url?.trim();
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || !isSlackHostname(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) {
          return;
        }
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}

/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  client?: SlackWebClient;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<SlackMediaResult[] | null> {
  const files = params.files ?? [];
  const limitedFiles =
    files.length > MAX_SLACK_MEDIA_FILES ? files.slice(0, MAX_SLACK_MEDIA_FILES) : files;

  const resolved = await mapLimit<SlackFile, SlackMediaResult | null>(
    limitedFiles,
    MAX_SLACK_MEDIA_CONCURRENCY,
    async (file) => {
      const eventUrl = file.url_private_download ?? file.url_private;
      const url = eventUrl ?? (await fetchFreshSlackFileUrl({ file, client: params.client }));
      if (!url) {
        return null;
      }
      const result = await downloadSlackMediaFile({
        file,
        url,
        token: params.token,
        maxBytes: params.maxBytes,
        readIdleTimeoutMs: params.readIdleTimeoutMs,
        totalTimeoutMs: params.totalTimeoutMs,
        abortSignal: params.abortSignal,
      }).catch(() => null);
      if (result || !eventUrl) {
        return result;
      }

      const freshUrl = await fetchFreshSlackFileUrl({ file, client: params.client });
      if (!freshUrl) {
        return null;
      }
      return await downloadSlackMediaFile({
        file,
        url: freshUrl,
        token: params.token,
        maxBytes: params.maxBytes,
        readIdleTimeoutMs: params.readIdleTimeoutMs,
        totalTimeoutMs: params.totalTimeoutMs,
        abortSignal: params.abortSignal,
      }).catch(() => null);
    },
  );

  const results = resolved.filter((entry): entry is SlackMediaResult => Boolean(entry));
  return results.length > 0 ? results : null;
}

/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
export async function resolveSlackAttachmentContent(params: {
  attachments?: SlackAttachment[];
  client?: SlackWebClient;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; media: SlackMediaResult[] } | null> {
  const attachments = params.attachments;
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const forwardedAttachments = attachments
    .filter((attachment) => isForwardedSlackAttachment(attachment))
    .slice(0, MAX_SLACK_FORWARDED_ATTACHMENTS);
  if (forwardedAttachments.length === 0) {
    return null;
  }

  const textBlocks: string[] = [];
  const allMedia: SlackMediaResult[] = [];

  for (const att of forwardedAttachments) {
    const text = att.text?.trim() || att.fallback?.trim();
    if (text) {
      const author = att.author_name;
      const heading = author ? `[Forwarded message from ${author}]` : "[Forwarded message]";
      textBlocks.push(`${heading}\n${text}`);
    }

    const imageUrl = resolveForwardedAttachmentImageUrl(att);
    if (imageUrl) {
      try {
        const { url: slackUrl, requestInit } = createSlackMediaRequest(imageUrl, params.token);
        const fetchImpl = createSlackMediaFetch();
        const saved = await saveSlackMedia({
          options: {
            url: slackUrl,
            fetchImpl,
            requestInit,
            maxBytes: params.maxBytes,
            ssrfPolicy: SLACK_MEDIA_SSRF_POLICY,
          },
          readIdleTimeoutMs: params.readIdleTimeoutMs,
          totalTimeoutMs: params.totalTimeoutMs ?? SLACK_MEDIA_TOTAL_TIMEOUT_MS,
          abortSignal: params.abortSignal,
        });
        const label = saved.fileName ?? "forwarded image";
        allMedia.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: `[Forwarded image: ${label}]`,
        });
      } catch {
        // Skip images that fail to download
      }
    }

    if (att.files && att.files.length > 0) {
      const fileMedia = await resolveSlackMedia({
        files: att.files,
        client: params.client,
        token: params.token,
        maxBytes: params.maxBytes,
        readIdleTimeoutMs: params.readIdleTimeoutMs,
        totalTimeoutMs: params.totalTimeoutMs,
        abortSignal: params.abortSignal,
      });
      if (fileMedia) {
        allMedia.push(...fileMedia);
      }
    }
  }

  const combinedText = textBlocks.join("\n\n");
  if (!combinedText && allMedia.length === 0) {
    return null;
  }
  return { text: combinedText, media: allMedia };
}

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackThreadStarterCacheEntry = {
  value: SlackThreadStarter;
  cachedAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (now - entry.cachedAt > THREAD_STARTER_CACHE_TTL_MS) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  if (THREAD_STARTER_CACHE.size <= THREAD_STARTER_CACHE_MAX) {
    return;
  }
  const excess = THREAD_STARTER_CACHE.size - THREAD_STARTER_CACHE_MAX;
  let removed = 0;
  for (const cacheKey of THREAD_STARTER_CACHE.keys()) {
    THREAD_STARTER_CACHE.delete(cacheKey);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= THREAD_STARTER_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached) {
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as {
      messages?: Array<{
        text?: string;
        user?: string;
        bot_id?: string;
        ts?: string;
        files?: SlackFile[];
      }>;
    };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
    if (!message || !text) {
      return null;
    }
    const starter: SlackThreadStarter = {
      text,
      userId: message.user,
      botId: message.bot_id,
      ts: message.ts,
      files: message.files,
    };
    if (THREAD_STARTER_CACHE.has(cacheKey)) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
    THREAD_STARTER_CACHE.set(cacheKey, {
      value: starter,
      cachedAt: Date.now(),
    });
    evictThreadStarterCache();
    return starter;
  } catch {
    return null;
  }
}

export function resetSlackThreadStarterCacheForTest(): void {
  THREAD_STARTER_CACHE.clear();
}

export type SlackThreadMessage = {
  text: string;
  userId?: string;
  ts?: string;
  botId?: string;
  files?: SlackFile[];
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

type SlackHistoryPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

function normalizeSlackHistoryMessage(msg: SlackRepliesPageMessage): SlackThreadMessage {
  return {
    text: msg.text?.trim()
      ? msg.text
      : `[attached: ${msg.files?.map((f) => f.name ?? "file").join(", ")}]`,
    userId: msg.user,
    botId: msg.bot_id,
    ts: msg.ts,
    files: msg.files,
  };
}

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages so long threads
 * still produce up-to-date context without unbounded memory growth.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        // Keep messages with text OR file attachments
        if (!msg.text?.trim() && !msg.files?.length) {
          continue;
        }
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        retained.push(msg);
        if (retained.length > maxMessages) {
          retained.shift();
        }
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
    } while (cursor);

    return retained.map((msg) => normalizeSlackHistoryMessage(msg));
  } catch {
    return [];
  }
}

/**
 * Fetches recent non-thread Slack conversation history in chronological order.
 * Used to hydrate top-level direct-message turns when the live session alone
 * is not enough to recover short follow-up context.
 */
export async function resolveSlackConversationHistory(params: {
  channelId: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  const fetchLimit = Math.min(200, Math.max(maxMessages, 50));
  const retained: SlackRepliesPageMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = (await params.client.conversations.history({
        channel: params.channelId,
        limit: fetchLimit,
        inclusive: false,
        ...(params.currentMessageTs ? { latest: params.currentMessageTs } : {}),
        ...(cursor ? { cursor } : {}),
      })) as SlackHistoryPage;

      for (const msg of response.messages ?? []) {
        if (!msg.text?.trim() && !msg.files?.length) {
          continue;
        }
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        retained.push(msg);
        if (retained.length >= maxMessages) {
          return retained.reverse().map((entry) => normalizeSlackHistoryMessage(entry));
        }
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
    } while (cursor);

    return retained.reverse().map((entry) => normalizeSlackHistoryMessage(entry));
  } catch {
    return [];
  }
}
