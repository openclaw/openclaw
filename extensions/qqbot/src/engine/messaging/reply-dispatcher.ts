/**
 * Reply dispatcher — structured payload handling and text routing.
 *
 * Migrated from `src/reply-dispatcher.ts` with these changes:
 * 1. API calls → `core/api/facade.js`
 * 2. `getQQBotRuntime().tts` → injected `ReplyDispatcherDeps.tts`
 * 3. audio-convert functions → injected `ReplyDispatcherDeps.audio`
 * 4. `ResolvedQQBotAccount` → `GatewayAccount`
 * 5. `type OpenClawConfig` → `unknown` (opaque to core/)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getAccessToken,
  sendC2CMessage,
  sendChannelMessage,
  sendDmMessage,
  sendGroupMessage,
  clearTokenCache,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendC2CVoiceMessage,
  sendGroupVoiceMessage,
  sendC2CVideoMessage,
  sendGroupVideoMessage,
  sendC2CFileMessage,
  sendGroupFileMessage,
} from "../api/facade.js";
import type { GatewayAccount } from "../gateway/types.js";
import { MAX_UPLOAD_SIZE, formatFileSize } from "../utils/file-utils.js";
import {
  parseQQBotPayload,
  encodePayloadForCron,
  isCronReminderPayload,
  isMediaPayload,
  type MediaPayload,
} from "../utils/payload.js";
import { normalizePath, resolveQQBotPayloadLocalFilePath } from "../utils/platform.js";
import { normalizeLowercaseStringOrEmpty } from "../utils/string-normalize.js";
import { sanitizeFileName } from "../utils/string-normalize.js";

// ---- Injected dependencies ----

/** TTS provider interface — injected from the outer layer. */
export interface TTSProvider {
  /** Framework TTS: text → audio file path. */
  textToSpeech(params: { text: string; cfg: unknown; channel: string }): Promise<{
    success: boolean;
    audioPath?: string;
    provider?: string;
    outputFormat?: string;
    error?: string;
  }>;
  /** Convert any audio file to SILK base64. */
  audioFileToSilkBase64(audioPath: string): Promise<string | undefined>;
}

/** Dependencies injected into reply-dispatcher functions. */
export interface ReplyDispatcherDeps {
  tts: TTSProvider;
}

// ---- Exported types ----

export interface MessageTarget {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
}

export interface ReplyContext {
  target: MessageTarget;
  account: GatewayAccount;
  cfg: unknown;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// ---- Token retry ----

/** Send a message and retry once if the token appears to have expired. */
export async function sendWithTokenRetry<T>(
  appId: string,
  clientSecret: string,
  sendFn: (token: string) => Promise<T>,
  log?: ReplyContext["log"],
  accountId?: string,
): Promise<T> {
  try {
    const token = await getAccessToken(appId, clientSecret);
    return await sendFn(token);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
      log?.info(`[qqbot:${accountId}] Token may be expired, refreshing...`);
      clearTokenCache(appId);
      const newToken = await getAccessToken(appId, clientSecret);
      return await sendFn(newToken);
    } else {
      throw err;
    }
  }
}

// ---- Text routing ----

/** Route a text message to the correct QQ target type. */
export async function sendTextToTarget(
  ctx: ReplyContext,
  text: string,
  refIdx?: string,
): Promise<void> {
  const { target, account } = ctx;
  await sendWithTokenRetry(
    account.appId,
    account.clientSecret,
    async (token) => {
      if (target.type === "c2c") {
        await sendC2CMessage(account.appId, token, target.senderId, text, target.messageId, refIdx);
      } else if (target.type === "group" && target.groupOpenid) {
        await sendGroupMessage(account.appId, token, target.groupOpenid, text, target.messageId);
      } else if (target.channelId) {
        await sendChannelMessage(token, target.channelId, text, target.messageId);
      } else if (target.type === "dm" && target.guildId) {
        await sendDmMessage(token, target.guildId, text, target.messageId);
      }
    },
    ctx.log,
    account.accountId,
  );
}

/** Best-effort delivery for error text back to the user. */
export async function sendErrorToTarget(ctx: ReplyContext, errorText: string): Promise<void> {
  try {
    await sendTextToTarget(ctx, errorText);
  } catch (sendErr) {
    ctx.log?.error(
      `[qqbot:${ctx.account.accountId}] Failed to send error message: ${String(sendErr)}`,
    );
  }
}

// ---- Structured payload handling ----

/**
 * Handle a structured payload prefixed with `QQBOT_PAYLOAD:`.
 * Returns true when the reply was handled here, otherwise false.
 */
export async function handleStructuredPayload(
  ctx: ReplyContext,
  replyText: string,
  recordActivity: () => void,
  deps?: ReplyDispatcherDeps,
): Promise<boolean> {
  const { account, log } = ctx;
  const payloadResult = parseQQBotPayload(replyText);

  if (!payloadResult.isPayload) {
    return false;
  }

  if (payloadResult.error) {
    log?.error(`[qqbot:${account.accountId}] Payload parse error: ${payloadResult.error}`);
    return true;
  }

  if (!payloadResult.payload) {
    return true;
  }

  const parsedPayload = payloadResult.payload;
  const unknownPayload = payloadResult.payload as unknown;
  log?.info(
    `[qqbot:${account.accountId}] Detected structured payload, type: ${parsedPayload.type}`,
  );

  if (isCronReminderPayload(parsedPayload)) {
    log?.info(`[qqbot:${account.accountId}] Processing cron_reminder payload`);
    const cronMessage = encodePayloadForCron(parsedPayload);
    const confirmText = `⏰ Reminder scheduled. It will be sent at the configured time: "${parsedPayload.content}"`;
    try {
      await sendTextToTarget(ctx, confirmText);
      log?.info(
        `[qqbot:${account.accountId}] Cron reminder confirmation sent, cronMessage: ${cronMessage}`,
      );
    } catch (err) {
      log?.error(
        `[qqbot:${account.accountId}] Failed to send cron confirmation: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`,
      );
    }
    recordActivity();
    return true;
  }

  if (isMediaPayload(parsedPayload)) {
    log?.info(
      `[qqbot:${account.accountId}] Processing media payload, mediaType: ${parsedPayload.mediaType}`,
    );

    if (parsedPayload.mediaType === "image") {
      await handleImagePayload(ctx, parsedPayload);
    } else if (parsedPayload.mediaType === "audio") {
      await handleAudioPayload(ctx, parsedPayload, deps);
    } else if (parsedPayload.mediaType === "video") {
      await handleVideoPayload(ctx, parsedPayload);
    } else if (parsedPayload.mediaType === "file") {
      await handleFilePayload(ctx, parsedPayload);
    } else {
      log?.error(
        `[qqbot:${account.accountId}] Unknown media type: ${JSON.stringify(parsedPayload.mediaType)}`,
      );
    }
    recordActivity();
    return true;
  }

  const payloadType =
    typeof unknownPayload === "object" &&
    unknownPayload !== null &&
    "type" in unknownPayload &&
    typeof unknownPayload.type === "string"
      ? unknownPayload.type
      : "unknown";
  log?.error(`[qqbot:${account.accountId}] Unknown payload type: ${payloadType}`);
  return true;
}

// ---- Media payload handlers ----

type StructuredPayloadMediaType = "image" | "video" | "file";

function formatMediaTypeLabel(mediaType: StructuredPayloadMediaType): string {
  return mediaType[0].toUpperCase() + mediaType.slice(1);
}

function validateStructuredPayloadLocalPath(
  ctx: ReplyContext,
  payloadPath: string,
  mediaType: StructuredPayloadMediaType,
): string | null {
  const allowedPath = resolveQQBotPayloadLocalFilePath(payloadPath);
  if (allowedPath) {
    return allowedPath;
  }

  ctx.log?.error(
    `[qqbot:${ctx.account.accountId}] Blocked ${mediaType} payload local path outside QQ Bot media storage`,
  );
  return null;
}

function isRemoteHttpUrl(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
}

function isInlineImageDataUrl(p: string): boolean {
  return /^data:image\/[^;]+;base64,/i.test(p);
}

function resolveStructuredPayloadPath(
  ctx: ReplyContext,
  payload: MediaPayload,
  mediaType: StructuredPayloadMediaType,
): { path: string; isHttpUrl: boolean } | null {
  const originalPath = payload.path ?? "";
  const normalizedPath = normalizePath(originalPath);
  const isHttpUrl = isRemoteHttpUrl(normalizedPath);
  const resolvedPath = isHttpUrl
    ? normalizedPath
    : validateStructuredPayloadLocalPath(ctx, originalPath, mediaType);
  if (!resolvedPath) {
    return null;
  }
  if (!resolvedPath.trim()) {
    ctx.log?.error(
      `[qqbot:${ctx.account.accountId}] ${formatMediaTypeLabel(mediaType)} missing path`,
    );
    return null;
  }
  return { path: resolvedPath, isHttpUrl };
}

function logUnsupportedStructuredMediaTarget(
  ctx: ReplyContext,
  mediaType: Exclude<StructuredPayloadMediaType, "image">,
): void {
  const label = formatMediaTypeLabel(mediaType);
  if (ctx.target.type === "dm") {
    ctx.log?.error(`[qqbot:${ctx.account.accountId}] ${label} not supported in DM`);
  } else if (ctx.target.channelId) {
    ctx.log?.error(`[qqbot:${ctx.account.accountId}] ${label} not supported in channel`);
  }
}

function sanitizeForLog(value: string, maxLen = 200): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("\0", " ")
    .slice(0, maxLen);
}

function describeMediaTargetForLog(pathValue: string, isHttpUrl: boolean): string {
  if (!isHttpUrl) {
    return "<local-file>";
  }
  try {
    const url = new URL(pathValue);
    url.username = "";
    url.password = "";
    const urlId = crypto.createHash("sha256").update(url.toString()).digest("hex").slice(0, 12);
    return sanitizeForLog(`${url.protocol}//${url.host}#${urlId}`);
  } catch {
    return "<invalid-url>";
  }
}

async function readStructuredPayloadLocalFile(filePath: string): Promise<Buffer> {
  const openFlags =
    fs.constants.O_RDONLY | ("O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(filePath, openFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Path is not a regular file");
    }
    if (stat.size > MAX_UPLOAD_SIZE) {
      throw new Error(
        `File is too large (${formatFileSize(stat.size)}); QQ Bot API limit is ${formatFileSize(MAX_UPLOAD_SIZE)}`,
      );
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function handleImagePayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  const normalizedPath = normalizePath(payload.path);
  let imageUrl: string | null;
  if (payload.source === "file") {
    imageUrl = validateStructuredPayloadLocalPath(ctx, normalizedPath, "image");
  } else if (isRemoteHttpUrl(normalizedPath) || isInlineImageDataUrl(normalizedPath)) {
    imageUrl = normalizedPath;
  } else {
    log?.error(
      `[qqbot:${account.accountId}] Image payload URL must use http(s) or data:image/: ${sanitizeForLog(payload.path)}`,
    );
    return;
  }
  if (!imageUrl) {
    return;
  }
  const originalImagePath = payload.source === "file" ? imageUrl : undefined;

  if (payload.source === "file") {
    try {
      const fileBuffer = await readStructuredPayloadLocalFile(imageUrl);
      const base64Data = fileBuffer.toString("base64");
      const ext = normalizeLowercaseStringOrEmpty(path.extname(imageUrl));
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };
      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        log?.error(`[qqbot:${account.accountId}] Unsupported image format: ${ext}`);
        return;
      }
      imageUrl = `data:${mimeType};base64,${base64Data}`;
      log?.info(
        `[qqbot:${account.accountId}] Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`,
      );
    } catch (readErr) {
      log?.error(
        `[qqbot:${account.accountId}] Failed to read local image: ${
          readErr instanceof Error ? readErr.message : JSON.stringify(readErr)
        }`,
      );
      return;
    }
  }

  try {
    await sendWithTokenRetry(
      account.appId,
      account.clientSecret,
      async (token) => {
        if (target.type === "c2c") {
          await sendC2CImageMessage(
            account.appId,
            token,
            target.senderId,
            imageUrl,
            target.messageId,
            undefined,
            originalImagePath,
          );
        } else if (target.type === "group" && target.groupOpenid) {
          await sendGroupImageMessage(
            account.appId,
            token,
            target.groupOpenid,
            imageUrl,
            target.messageId,
          );
        } else if (target.type === "dm" && target.guildId) {
          await sendDmMessage(token, target.guildId, `![](${payload.path})`, target.messageId);
        } else if (target.channelId) {
          await sendChannelMessage(
            token,
            target.channelId,
            `![](${payload.path})`,
            target.messageId,
          );
        }
      },
      log,
      account.accountId,
    );
    log?.info(`[qqbot:${account.accountId}] Sent image via media payload`);

    if (payload.caption) {
      await sendTextToTarget(ctx, payload.caption);
    }
  } catch (err) {
    log?.error(
      `[qqbot:${account.accountId}] Failed to send image: ${
        err instanceof Error ? err.message : JSON.stringify(err)
      }`,
    );
  }
}

async function handleAudioPayload(
  ctx: ReplyContext,
  payload: MediaPayload,
  deps?: ReplyDispatcherDeps,
): Promise<void> {
  const { target, account, cfg, log } = ctx;
  if (!deps) {
    log?.error(`[qqbot:${account.accountId}] TTS deps not provided, cannot handle audio payload`);
    return;
  }
  try {
    const ttsText = payload.caption || payload.path;
    if (!ttsText?.trim()) {
      log?.error(`[qqbot:${account.accountId}] Voice missing text`);
      return;
    }

    log?.info(`[qqbot:${account.accountId}] TTS: "${ttsText.slice(0, 50)}..."`);
    const ttsResult = await deps.tts.textToSpeech({
      text: ttsText,
      cfg,
      channel: "qqbot",
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      log?.error(`[qqbot:${account.accountId}] TTS failed: ${ttsResult.error ?? "unknown"}`);
      return;
    }

    const providerLabel = ttsResult.provider ?? "unknown";
    log?.info(
      `[qqbot:${account.accountId}] TTS returned: provider=${providerLabel}, format=${ttsResult.outputFormat}, path=${ttsResult.audioPath}`,
    );

    const silkBase64 = await deps.tts.audioFileToSilkBase64(ttsResult.audioPath);
    if (!silkBase64) {
      log?.error(`[qqbot:${account.accountId}] Failed to convert TTS audio to SILK`);
      return;
    }
    const silkPath = ttsResult.audioPath;

    log?.info(`[qqbot:${account.accountId}] TTS done (${providerLabel}), file: ${silkPath}`);

    await sendWithTokenRetry(
      account.appId,
      account.clientSecret,
      async (token) => {
        if (target.type === "c2c") {
          await sendC2CVoiceMessage(
            account.appId,
            token,
            target.senderId,
            silkBase64,
            undefined,
            target.messageId,
            ttsText,
            silkPath,
          );
        } else if (target.type === "group" && target.groupOpenid) {
          await sendGroupVoiceMessage(
            account.appId,
            token,
            target.groupOpenid,
            silkBase64,
            undefined,
            target.messageId,
          );
        } else if (target.type === "dm" && target.guildId) {
          log?.error(
            `[qqbot:${account.accountId}] Voice not supported in DM, sending text fallback`,
          );
          await sendDmMessage(token, target.guildId, ttsText, target.messageId);
        } else if (target.channelId) {
          log?.error(
            `[qqbot:${account.accountId}] Voice not supported in channel, sending text fallback`,
          );
          await sendChannelMessage(token, target.channelId, ttsText, target.messageId);
        }
      },
      log,
      account.accountId,
    );
    log?.info(`[qqbot:${account.accountId}] Voice message sent`);
  } catch (err) {
    log?.error(
      `[qqbot:${account.accountId}] TTS/voice send failed: ${
        err instanceof Error ? err.message : JSON.stringify(err)
      }`,
    );
  }
}

async function handleVideoPayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  try {
    const resolved = resolveStructuredPayloadPath(ctx, payload, "video");
    if (!resolved) {
      return;
    }
    const videoPath = resolved.path;
    const isHttpUrl = resolved.isHttpUrl;

    log?.info(
      `[qqbot:${account.accountId}] Video send: ${describeMediaTargetForLog(videoPath, isHttpUrl)}`,
    );

    await sendWithTokenRetry(
      account.appId,
      account.clientSecret,
      async (token) => {
        if (isHttpUrl) {
          if (target.type === "c2c") {
            await sendC2CVideoMessage(
              account.appId,
              token,
              target.senderId,
              videoPath,
              undefined,
              target.messageId,
            );
          } else if (target.type === "group" && target.groupOpenid) {
            await sendGroupVideoMessage(
              account.appId,
              token,
              target.groupOpenid,
              videoPath,
              undefined,
              target.messageId,
            );
          } else {
            logUnsupportedStructuredMediaTarget(ctx, "video");
          }
        } else {
          const fileBuffer = await readStructuredPayloadLocalFile(videoPath);
          const videoBase64 = fileBuffer.toString("base64");
          log?.info(
            `[qqbot:${account.accountId}] Read local video (${formatFileSize(fileBuffer.length)}): ${describeMediaTargetForLog(videoPath, false)}`,
          );

          if (target.type === "c2c") {
            await sendC2CVideoMessage(
              account.appId,
              token,
              target.senderId,
              undefined,
              videoBase64,
              target.messageId,
              undefined,
              videoPath,
            );
          } else if (target.type === "group" && target.groupOpenid) {
            await sendGroupVideoMessage(
              account.appId,
              token,
              target.groupOpenid,
              undefined,
              videoBase64,
              target.messageId,
            );
          } else {
            logUnsupportedStructuredMediaTarget(ctx, "video");
          }
        }
      },
      log,
      account.accountId,
    );
    log?.info(`[qqbot:${account.accountId}] Video message sent`);

    if (payload.caption) {
      await sendTextToTarget(ctx, payload.caption);
    }
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    log?.error(`[qqbot:${account.accountId}] Video send failed: ${errMsg}`);
  }
}

async function handleFilePayload(ctx: ReplyContext, payload: MediaPayload): Promise<void> {
  const { target, account, log } = ctx;
  try {
    const resolved = resolveStructuredPayloadPath(ctx, payload, "file");
    if (!resolved) {
      return;
    }
    const filePath = resolved.path;
    const isHttpUrl = resolved.isHttpUrl;

    const fileName = sanitizeFileName(path.basename(filePath));
    log?.info(
      `[qqbot:${account.accountId}] File send: ${describeMediaTargetForLog(filePath, isHttpUrl)} (${isHttpUrl ? "URL" : "local"})`,
    );

    await sendWithTokenRetry(
      account.appId,
      account.clientSecret,
      async (token) => {
        if (isHttpUrl) {
          if (target.type === "c2c") {
            await sendC2CFileMessage(
              account.appId,
              token,
              target.senderId,
              undefined,
              filePath,
              target.messageId,
              fileName,
            );
          } else if (target.type === "group" && target.groupOpenid) {
            await sendGroupFileMessage(
              account.appId,
              token,
              target.groupOpenid,
              undefined,
              filePath,
              target.messageId,
              fileName,
            );
          } else {
            logUnsupportedStructuredMediaTarget(ctx, "file");
          }
        } else {
          const fileBuffer = await readStructuredPayloadLocalFile(filePath);
          const fileBase64 = fileBuffer.toString("base64");
          if (target.type === "c2c") {
            await sendC2CFileMessage(
              account.appId,
              token,
              target.senderId,
              fileBase64,
              undefined,
              target.messageId,
              fileName,
              filePath,
            );
          } else if (target.type === "group" && target.groupOpenid) {
            await sendGroupFileMessage(
              account.appId,
              token,
              target.groupOpenid,
              fileBase64,
              undefined,
              target.messageId,
              fileName,
            );
          } else {
            logUnsupportedStructuredMediaTarget(ctx, "file");
          }
        }
      },
      log,
      account.accountId,
    );
    log?.info(`[qqbot:${account.accountId}] File message sent`);
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    log?.error(`[qqbot:${account.accountId}] File send failed: ${errMsg}`);
  }
}
