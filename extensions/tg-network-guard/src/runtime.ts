import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type AnyObject = Record<string, unknown>;
type TelegramEndpointKind = "file" | "bot" | "other";
type TelegramEndpoint = { kind: TelegramEndpointKind; method: string };
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// We only retry operations that are safe to replay.
// Retrying generic sendMessage can duplicate outbound user messages, so we avoid that.
const RETRY_SAFE_BOT_METHODS = new Set([
  "getupdates",
  "getfile",
  "sendchataction",
  "answercallbackquery",
]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_ERROR_TEXT =
  /(fetch failed|socket hang up|networkerror|timeout|temporar|connection reset|tls|econnreset|etimedout|eai_again|enotfound)/i;

const GLOBAL_INSTALL_KEY = Symbol.for("openclaw.tg_network_guard.installed");

function asObject(value: unknown): AnyObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyObject) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  jitter: number,
): number {
  const base = Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt));
  const spread = Math.floor(base * clampNumber(jitter, 0, 1));
  const randomized =
    spread > 0 ? base - spread + Math.floor(Math.random() * (spread * 2 + 1)) : base;
  return clampNumber(randomized, minDelayMs, maxDelayMs);
}

function parseTelegramEndpoint(rawUrl: unknown): TelegramEndpoint | null {
  try {
    const u = new URL(String(rawUrl || ""));
    if (u.hostname !== "api.telegram.org") return null;

    // File download endpoint:
    //   /file/bot<TOKEN>/<file_path>
    if (/^\/file\/bot[^/]+\//.test(u.pathname)) return { kind: "file", method: "download-file" };

    // Bot API endpoint:
    //   /bot<TOKEN>/<method>
    const methodMatch = u.pathname.match(/^\/bot[^/]+\/([^/?#]+)/);
    if (!methodMatch) return { kind: "other", method: "" };
    return { kind: "bot", method: String(methodMatch[1] || "").toLowerCase() };
  } catch {
    return null;
  }
}

function isRetrySafeEndpoint(endpoint: TelegramEndpoint | null): boolean {
  if (!endpoint) return false;
  if (endpoint.kind === "file") return true;
  if (endpoint.kind === "bot" && RETRY_SAFE_BOT_METHODS.has(endpoint.method)) return true;
  return false;
}

function isRetryableResponse(response: Response): boolean {
  // Telegram can rate-limit transiently (429) or fail upstream (5xx).
  return response.status === 429 || (response.status >= 500 && response.status <= 599);
}

function isRetryableError(error: unknown): boolean {
  const errObj = error as
    | { code?: unknown; cause?: { code?: unknown }; message?: unknown }
    | undefined;
  const code = asString(errObj?.code ?? errObj?.cause?.code).toUpperCase();
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const text = String(errObj?.message ?? error ?? "");
  return RETRYABLE_ERROR_TEXT.test(text);
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfterRaw = asString(response.headers.get("retry-after"));
  if (!retryAfterRaw) return null;
  const seconds = Number(retryAfterRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds * 1000);
}

function resolveConfigPath(): string {
  const fromEnv = asString(process.env.OPENCLAW_CONFIG_PATH).trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function resolveTelegramBotToken(): string {
  const envToken = asString(process.env.OPENCLAW_TELEGRAM_BOT_TOKEN).trim();
  if (envToken) return envToken;

  try {
    const raw = fs.readFileSync(resolveConfigPath(), "utf8");
    const cfg = JSON.parse(raw) as { channels?: { telegram?: { botToken?: string } } };
    const token = asString(cfg?.channels?.telegram?.botToken).trim();
    return token || "";
  } catch {
    return "";
  }
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeText(value: unknown): string {
  return asString(value).trim();
}

function parseMediaPathFromContent(content: unknown): string {
  const text = asString(content);
  if (!text) return "";

  // Typical OpenClaw payload:
  // [media attached: /path/file.ogg (audio/ogg; codecs=opus) | /path/file.ogg]
  const directMatch = text.match(
    /\[media attached:\s*([^\n|]+?)\s*(?:\([^)]+\)\s*\|\s*[^\]]+|\([^)]+\)|\])/i,
  );
  if (directMatch?.[1]) return directMatch[1].trim();

  // Multi-file payload variant:
  // [media attached 1/2: /path/file.jpg (...)]
  const multiMatch = text.match(/\[media attached\s+\d+\/\d+:\s*([^\n|]+?)\s*(?:\([^)]+\)|\])/i);
  if (multiMatch?.[1]) return multiMatch[1].trim();

  return "";
}

function pathLooksAudioFile(filePath: string): boolean {
  const ext = path.extname(asString(filePath).trim()).toLowerCase();
  return (
    ext === ".ogg" ||
    ext === ".oga" ||
    ext === ".opus" ||
    ext === ".mp3" ||
    ext === ".m4a" ||
    ext === ".wav" ||
    ext === ".webm" ||
    ext === ".aac" ||
    ext === ".mp4"
  );
}

function collectMediaPathCandidatesFromEvent(event: AnyObject): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const v = asString(value).trim();
    if (!v || !v.includes("/")) return;
    out.push(v);
  };

  const tryFromObj = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const source = obj as AnyObject;
    push(source.path);
    push(source.filePath);
    push(source.file_path);
    push(source.localPath);
    push(source.local_path);
    push(source.mediaPath);
    push(source.media_path);
    push(source.downloadPath);
    push(source.download_path);
    push(source.storagePath);
    push(source.storage_path);
    push(source.tempPath);
    push(source.temp_path);
  };

  push(event.path);
  push(event.filePath);
  push(event.file_path);
  push(event.localPath);
  push(event.local_path);
  push(event.mediaPath);
  push(event.media_path);
  push(event.downloadPath);
  push(event.download_path);
  push(event.storagePath);
  push(event.storage_path);
  push(event.tempPath);
  push(event.temp_path);

  const metadata = asObject(event.metadata);
  const meta = asObject(event.meta);
  const raw = asObject(event.raw);

  push(metadata.mediaPath);
  push(metadata.media_path);
  push(meta.mediaPath);
  push(meta.media_path);
  push(raw.mediaPath);
  push(raw.media_path);

  const arrayBuckets = [
    event.media,
    event.attachments,
    event.files,
    event.audio,
    event.voice,
    event.documents,
    raw.media,
    raw.attachments,
    raw.files,
  ];
  for (const bucket of arrayBuckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) tryFromObj(entry);
  }

  const nestedBuckets = [event.media, event.attachment, event.file, raw, meta, metadata];
  for (const bucket of nestedBuckets) tryFromObj(bucket);

  return [...new Set(out)];
}

function findMostRecentInboundAudioFile(cfg: AnyObject, nowMs: number, lookbackMs: number): string {
  const inboundDir =
    normalizeText(cfg.inboundMediaDir) || path.join(os.homedir(), ".openclaw", "media", "inbound");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(inboundDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const minMtime = nowMs - lookbackMs;
  let bestPath = "";
  let bestMtime = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(inboundDir, ent.name);
    if (!pathLooksAudioFile(full)) continue;
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(full);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) continue;
    if (st.mtimeMs < minMtime) continue;
    if (st.mtimeMs >= bestMtime) {
      bestMtime = st.mtimeMs;
      bestPath = full;
    }
  }
  return bestPath;
}

async function resolveMediaPathWithRetry(
  initialPath: string,
  event: AnyObject,
  cfg: AnyObject,
): Promise<string> {
  const timeoutMs = clampNumber(
    Math.floor(toFiniteNumber(cfg.mediaPathResolveTimeoutMs, 8000)),
    0,
    30000,
  );
  const pollMs = clampNumber(Math.floor(toFiniteNumber(cfg.mediaPathPollMs, 250)), 50, 2000);
  const lookbackMs = clampNumber(
    Math.floor(toFiniteNumber(cfg.mediaPathLookbackMs, 120000)),
    10_000,
    10 * 60_000,
  );

  const start = Date.now();
  const deadline = start + timeoutMs;
  const staticCandidates = [initialPath, ...collectMediaPathCandidatesFromEvent(event)];

  while (true) {
    for (const candidate of staticCandidates) {
      const p = asString(candidate).trim();
      if (!p) continue;
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        // Keep polling while the file is still being materialized by the channel adapter.
      }
    }

    const recentFallback = findMostRecentInboundAudioFile(cfg, Date.now(), lookbackMs);
    if (recentFallback) return recentFallback;

    if (Date.now() >= deadline) return "";
    await sleepMs(pollMs);
  }
}

function parseTelegramMessageId(event: AnyObject, content: unknown): number | null {
  const metadata = asObject(event.metadata);
  const meta = asObject(event.meta);
  const directCandidates = [
    event.messageId,
    event.message_id,
    metadata.messageId,
    metadata.message_id,
    meta.messageId,
    meta.message_id,
  ];
  for (const candidate of directCandidates) {
    const parsed = parsePositiveInt(candidate);
    if (parsed != null) return parsed;
  }

  const raw = asString(content);
  if (!raw) return null;

  const bracketMatch = raw.match(/\[message_id:\s*"?(\d{1,12})"?\s*\]/i);
  if (bracketMatch?.[1]) return parsePositiveInt(bracketMatch[1]);

  const jsonMatch = raw.match(/"message_id"\s*:\s*"?(\d{1,12})"?/i);
  if (jsonMatch?.[1]) return parsePositiveInt(jsonMatch[1]);

  return null;
}

function chunkText(text: unknown, maxChars: number): string[] {
  const t = asString(text);
  if (!t) return [];
  const maxLen = clampNumber(Math.floor(toFiniteNumber(maxChars, 3500)), 250, 3900);
  if (t.length <= maxLen) return [t];

  const chunks: string[] = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(t.length, i + maxLen);
    if (end < t.length) {
      const breakAt = t.lastIndexOf("\n", end);
      if (breakAt > i + 100) end = breakAt;
    }
    const piece = t.slice(i, end).trim();
    if (piece) chunks.push(piece);
    i = end;
  }
  return chunks;
}

async function telegramApiCall(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  payload: AnyObject,
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text().catch(() => "");
  let body: AnyObject | null = null;
  try {
    body = bodyText ? (JSON.parse(bodyText) as AnyObject) : null;
  } catch {
    body = null;
  }
  if (!res.ok || body?.ok !== true) {
    const description = asString(body?.description).trim() || bodyText || `http ${res.status}`;
    throw new Error(`telegram ${method} failed: ${description}`.slice(0, 500));
  }
  return body?.result ?? null;
}

async function sendTelegramMessage(
  fetchImpl: typeof fetch,
  token: string,
  payload: AnyObject,
): Promise<number | null> {
  const result = (await telegramApiCall(
    fetchImpl,
    token,
    "sendMessage",
    payload,
  )) as AnyObject | null;
  return parsePositiveInt(result?.message_id);
}

async function editTelegramMessage(
  fetchImpl: typeof fetch,
  token: string,
  payload: AnyObject,
): Promise<void> {
  await telegramApiCall(fetchImpl, token, "editMessageText", payload);
}

function transcribeViaWhisper(
  filePath: string,
  cfg: AnyObject,
  logger: OpenClawPluginApi["logger"],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const whisperCommand = normalizeText(cfg.whisperCommand) || "whisper";
    const whisperModel = normalizeText(cfg.whisperModel) || "tiny";
    const whisperLanguage = normalizeText(cfg.whisperLanguage);
    const whisperPrompt = normalizeText(cfg.whisperPrompt);
    const timeoutMs = clampNumber(
      Math.floor(toFiniteNumber(cfg.whisperTimeoutMs, 180_000)),
      10_000,
      900_000,
    );

    const outDir =
      normalizeText(cfg.whisperOutputDir) || path.join(os.tmpdir(), "openclaw-tg-transcripts");
    fs.mkdirSync(outDir, { recursive: true });

    const fileBase = path.parse(filePath).name;
    const transcriptPath = path.join(outDir, `${fileBase}.txt`);

    const args = [
      filePath,
      "--model",
      whisperModel,
      "--output_format",
      "txt",
      "--output_dir",
      outDir,
    ];
    if (whisperLanguage) args.push("--language", whisperLanguage);
    if (whisperPrompt) args.push("--initial_prompt", whisperPrompt);

    let stderr = "";
    const child = spawn(whisperCommand, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr?.on("data", (buf: Buffer | string) => {
      stderr += String(buf || "");
    });
    child.on("error", (err: unknown) => {
      clearTimeout(timeout);
      reject(new Error(`whisper spawn failed: ${String(err)}`));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`whisper exited ${code}: ${stderr || "unknown error"}`.slice(0, 800)));
        return;
      }
      let text = "";
      try {
        text = fs.readFileSync(transcriptPath, "utf8");
      } catch (err) {
        reject(new Error(`transcript read failed: ${String(err)}`.slice(0, 500)));
        return;
      }
      const normalized = text.trim();
      if (!normalized) {
        reject(new Error("transcription returned empty text"));
        return;
      }
      resolve(normalized);
    });
  }).catch((err: unknown) => {
    logger?.warn?.(`tg-network-guard: transcription error: ${String(err)}`.slice(0, 500));
    throw err;
  });
}

export default function register(api: OpenClawPluginApi): void {
  const cfg = asObject(api.pluginConfig);
  if (cfg.enabled === false) return;

  const globalState = asObject((globalThis as Record<PropertyKey, unknown>)[GLOBAL_INSTALL_KEY]);
  if (globalState.installed === true) return;

  const nativeFetch =
    typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  if (!nativeFetch) {
    api.logger?.warn?.("tg-network-guard: global fetch is unavailable; guard disabled");
    return;
  }

  const maxAttempts = clampNumber(Math.floor(toFiniteNumber(cfg.maxAttempts, 4)), 1, 8);
  const minDelayMs = clampNumber(Math.floor(toFiniteNumber(cfg.minDelayMs, 400)), 50, 10_000);
  const maxDelayMs = clampNumber(
    Math.floor(toFiniteNumber(cfg.maxDelayMs, Math.max(4000, minDelayMs))),
    minDelayMs,
    60_000,
  );
  const jitter = clampNumber(toFiniteNumber(cfg.jitter, 0.25), 0, 1);

  // Patch fetch once per process. This protects Telegram runtime calls that rely on global fetch:
  // file downloads for inbound media + transient sendChatAction calls.
  const guardedFetch: typeof fetch = async (input: FetchInput, init?: FetchInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : asString((input as { url?: unknown })?.url);

    const endpoint = parseTelegramEndpoint(url);
    if (!isRetrySafeEndpoint(endpoint) || maxAttempts <= 1) {
      return nativeFetch(input, init);
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await nativeFetch(input, init);
        if (!isRetryableResponse(res) || attempt >= maxAttempts - 1) return res;

        const retryAfterMs = parseRetryAfterMs(res);
        const delayMs =
          retryAfterMs != null
            ? clampNumber(retryAfterMs, minDelayMs, maxDelayMs)
            : computeBackoffMs(attempt, minDelayMs, maxDelayMs, jitter);
        await sleepMs(delayMs);
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt >= maxAttempts - 1) throw err;
        const delayMs = computeBackoffMs(attempt, minDelayMs, maxDelayMs, jitter);
        await sleepMs(delayMs);
      }
    }

    if (lastError) throw lastError;
    return nativeFetch(input, init);
  };

  globalThis.fetch = guardedFetch;
  (globalThis as Record<PropertyKey, unknown>)[GLOBAL_INSTALL_KEY] = {
    installed: true,
    installedAt: new Date().toISOString(),
    maxAttempts,
  };

  api.logger?.info?.(
    `tg-network-guard: installed (retry-safe endpoints only, maxAttempts=${maxAttempts})`,
  );

  const ackVoiceMessages = cfg.ackVoiceMessages !== false;
  const transcribeVoiceMessages = cfg.transcribeVoiceMessages !== false;
  if (!ackVoiceMessages && !transcribeVoiceMessages) return;

  const ownerChatId =
    asString(cfg.ownerChatId).trim() ||
    asString(process.env.OPENCLAW_OWNER_TELEGRAM_ID).trim() ||
    "1336356696";
  const voiceAckCooldownMs = clampNumber(
    Math.floor(toFiniteNumber(cfg.voiceAckCooldownMs, 15_000)),
    1_000,
    120_000,
  );
  const voiceAckText =
    asString(cfg.voiceAckText).trim() ||
    "Voice note received. Processing now, usually under a minute.";
  const transcribingText = asString(cfg.transcribingText).trim() || "Transcribing...";
  const transcribedText = asString(cfg.transcribedText).trim() || "Transcribed.";
  const transcriptPrefix = asString(cfg.transcriptPrefix).trim() || "Transcript:";
  const transcriptionFailedText =
    asString(cfg.transcriptionFailedText).trim() || "Transcription failed.";
  const transcriptMaxChars = clampNumber(
    Math.floor(toFiniteNumber(cfg.transcriptMaxChars, 3500)),
    250,
    3900,
  );

  const lastAckAtByConversation = new Map<string, number>();
  const transcribeInFlightByConversation = new Map<string, number>();
  let cachedToken = "";

  api.on("message_received", (event: unknown, ctx: unknown) => {
    const eventObj = asObject(event);
    const ctxObj = asObject(ctx);
    if (ctxObj.channelId !== "telegram") return;

    const from = asString(eventObj.from);
    if (!from.includes(ownerChatId)) return;

    const contentRaw = asString(eventObj.content);
    const content = contentRaw.trim().toLowerCase();
    // Primary shape is a bare placeholder, but some adapters can include extra wrapper text.
    const hasVoicePlaceholder =
      content === "<media:audio>" ||
      content === "<media:voice>" ||
      contentRaw.toLowerCase().includes("<media:audio>") ||
      contentRaw.toLowerCase().includes("<media:voice>");
    if (!hasVoicePlaceholder) return;

    const mediaPathHint = parseMediaPathFromContent(contentRaw);
    const conversationId = asString(ctxObj.conversationId || from || ownerChatId);
    const messageId = parseTelegramMessageId(eventObj, contentRaw);
    const dedupeKey =
      messageId != null
        ? `${conversationId}:${messageId}`
        : mediaPathHint
          ? `${conversationId}:${mediaPathHint}`
          : `${conversationId}:voice`;
    const now = Date.now();

    const inFlightUntil = toFiniteNumber(transcribeInFlightByConversation.get(dedupeKey), 0);
    if (inFlightUntil > now) return;
    transcribeInFlightByConversation.set(dedupeKey, now + 10 * 60 * 1000);

    if (!cachedToken) cachedToken = resolveTelegramBotToken();
    if (!cachedToken) {
      transcribeInFlightByConversation.delete(dedupeKey);
      return;
    }

    if (ackVoiceMessages) {
      const last = toFiniteNumber(lastAckAtByConversation.get(conversationId), 0);
      if (now - last >= voiceAckCooldownMs) {
        lastAckAtByConversation.set(conversationId, now);
        void sendTelegramMessage(guardedFetch, cachedToken, {
          chat_id: String(ownerChatId),
          text: voiceAckText,
          disable_web_page_preview: true,
          ...(messageId != null
            ? { reply_to_message_id: messageId, allow_sending_without_reply: true }
            : {}),
        }).catch((err: unknown) => {
          api.logger?.warn?.(
            `tg-network-guard: voice ack send error: ${String(err)}`.slice(0, 400),
          );
        });
      }
    }

    if (!transcribeVoiceMessages) {
      transcribeInFlightByConversation.delete(dedupeKey);
      return;
    }

    void (async () => {
      const startedAt = Date.now();
      let statusMessageId: number | null = null;
      let transcriptMessageId: number | null = null;
      try {
        api.logger?.info?.(
          `tg-network-guard: voice transcription start conversation=${conversationId} messageId=${messageId ?? "n/a"}`,
        );
        statusMessageId = await sendTelegramMessage(guardedFetch, cachedToken, {
          chat_id: String(ownerChatId),
          text: transcribingText,
          disable_web_page_preview: true,
          ...(messageId != null
            ? {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true,
              }
            : {}),
        });
      } catch (err) {
        api.logger?.warn?.(
          `tg-network-guard: failed to send transcribing status: ${String(err)}`.slice(0, 500),
        );
      }

      try {
        const mediaPath = await resolveMediaPathWithRetry(mediaPathHint, eventObj, cfg);
        if (!mediaPath) {
          throw new Error("media path missing");
        }

        const transcript = await transcribeViaWhisper(mediaPath, cfg, api.logger);
        const chunks = chunkText(transcript, transcriptMaxChars);
        if (chunks.length === 0) throw new Error("empty transcript chunks");

        const firstText = `${transcriptPrefix}\n${chunks[0]}`;
        try {
          transcriptMessageId = await sendTelegramMessage(guardedFetch, cachedToken, {
            chat_id: String(ownerChatId),
            text: firstText,
            disable_web_page_preview: true,
            ...(messageId != null
              ? {
                  reply_to_message_id: messageId,
                  allow_sending_without_reply: true,
                }
              : statusMessageId != null
                ? {
                    reply_to_message_id: statusMessageId,
                    allow_sending_without_reply: true,
                  }
                : {}),
          });
        } catch (sendErr) {
          // Fallback for compatibility with older clients: if send fails,
          // we still surface the transcript by editing the status message.
          if (statusMessageId != null) {
            await editTelegramMessage(guardedFetch, cachedToken, {
              chat_id: String(ownerChatId),
              message_id: statusMessageId,
              text: firstText,
              disable_web_page_preview: true,
            });
          } else {
            throw sendErr;
          }
        }

        if (statusMessageId != null) {
          await editTelegramMessage(guardedFetch, cachedToken, {
            chat_id: String(ownerChatId),
            message_id: statusMessageId,
            text: transcribedText,
            disable_web_page_preview: true,
          });
        }

        for (let i = 1; i < chunks.length; i += 1) {
          await sendTelegramMessage(guardedFetch, cachedToken, {
            chat_id: String(ownerChatId),
            text: chunks[i],
            disable_web_page_preview: true,
            ...(transcriptMessageId != null
              ? {
                  reply_to_message_id: transcriptMessageId,
                  allow_sending_without_reply: true,
                }
              : messageId != null
                ? {
                    reply_to_message_id: messageId,
                    allow_sending_without_reply: true,
                  }
                : {}),
          });
        }
        api.logger?.info?.(
          `tg-network-guard: voice transcription success conversation=${conversationId} messageId=${messageId ?? "n/a"} durationMs=${Date.now() - startedAt}`,
        );
      } catch (err) {
        api.logger?.warn?.(
          `tg-network-guard: voice transcription failed: ${String(err)}`.slice(0, 500),
        );
        if (statusMessageId != null) {
          try {
            await editTelegramMessage(guardedFetch, cachedToken, {
              chat_id: String(ownerChatId),
              message_id: statusMessageId,
              text: transcriptionFailedText,
              disable_web_page_preview: true,
            });
          } catch (editErr) {
            api.logger?.warn?.(
              `tg-network-guard: failed to edit status on transcription error: ${String(editErr)}`.slice(
                0,
                500,
              ),
            );
          }
        }
      } finally {
        setTimeout(() => {
          transcribeInFlightByConversation.delete(dedupeKey);
        }, 60_000);
      }
    })();
  });
}
