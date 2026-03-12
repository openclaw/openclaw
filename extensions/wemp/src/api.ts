import { logWarn } from "./log.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import type { ResolvedWempAccount } from "./types.js";

interface TokenCacheEntry {
  token: string;
  expireAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();
const tokenRefreshInFlight = new Map<string, Promise<string>>();
const rateLimitedUntil = new Map<string, number>();
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const ACCESS_TOKEN_CACHE_FILE = "access-token-cache.json";
let tokenCacheLoaded = false;

// --- 48-hour customer service message window tracking ---
const CUSTOMER_SERVICE_WINDOW_MS = 48 * 60 * 60 * 1_000;
const lastInteractionByUser = new Map<string, number>();
const MAX_INTERACTION_ENTRIES = 10_000;

function interactionKey(accountId: string, openId: string): string {
  return `${accountId}\u0000${openId}`;
}

/** Record that a user interacted (sent a message) — resets the 48h window. */
export function recordUserInteraction(accountId: string, openId: string, now = Date.now()): void {
  const key = interactionKey(accountId, openId);
  lastInteractionByUser.set(key, now);
  // Evict oldest entries when map grows too large.
  if (lastInteractionByUser.size > MAX_INTERACTION_ENTRIES) {
    let oldest = Infinity;
    let oldestKey = "";
    for (const [k, v] of lastInteractionByUser) {
      if (v < oldest) {
        oldest = v;
        oldestKey = k;
      }
    }
    if (oldestKey) lastInteractionByUser.delete(oldestKey);
  }
}

/** Check whether the 48h customer service window is still open for a user. */
export function isCustomerServiceWindowOpen(
  accountId: string,
  openId: string,
  now = Date.now(),
): boolean {
  const key = interactionKey(accountId, openId);
  const lastAt = lastInteractionByUser.get(key);
  if (!lastAt) return false;
  return now - lastAt < CUSTOMER_SERVICE_WINDOW_MS;
}

/** errcode 45015 = user interaction window expired */
export function isWindowExpiredCode(code?: number): boolean {
  return code === 45015;
}

function parseExpireAt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function loadTokenCacheFromDisk(now = Date.now()): void {
  if (tokenCacheLoaded) return;
  tokenCacheLoaded = true;
  const persisted = readJsonFile<Record<string, { token?: unknown; expireAt?: unknown }>>(
    ACCESS_TOKEN_CACHE_FILE,
    {},
  );
  for (const [accountId, value] of Object.entries(persisted)) {
    if (!value || typeof value !== "object") continue;
    if (typeof value.token !== "string") continue;
    const expireAt = parseExpireAt(value.expireAt);
    if (expireAt === null || expireAt <= now) continue;
    tokenCache.set(accountId, { token: value.token, expireAt });
  }
}

function persistTokenCache(now = Date.now()): void {
  const payload: Record<string, TokenCacheEntry> = {};
  for (const [accountId, value] of tokenCache.entries()) {
    if (value.expireAt <= now) continue;
    payload[accountId] = value;
  }
  writeJsonFile(ACCESS_TOKEN_CACHE_FILE, payload);
}

function setCachedToken(accountId: string, token: string, expireAt: number): void {
  tokenCache.set(accountId, { token, expireAt });
  persistTokenCache();
}

function dropExpiredCachedToken(accountId: string, now = Date.now()): void {
  const cached = tokenCache.get(accountId);
  if (!cached) return;
  if (cached.expireAt > now) return;
  tokenCache.delete(accountId);
  persistTokenCache(now);
}

export interface WechatApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  errcode?: number;
  errmsg?: string;
  retried?: boolean;
}

export type WechatTempMediaType = "image" | "voice" | "video" | "thumb" | "file" | string;

export interface WechatUploadedTempMedia {
  type?: string;
  media_id?: string;
  created_at?: number;
  [key: string]: unknown;
}

export interface WechatDownloadedMedia {
  bytes?: Uint8Array;
  contentType: string;
  contentDisposition?: string;
  data?: Record<string, unknown>;
}

export function isTokenExpiredCode(code?: number): boolean {
  return code === 40001 || code === 42001 || code === 40014;
}

function isRateLimitCode(code?: number): boolean {
  return code === 45009 || code === 45011 || code === 45047 || code === 45056;
}

function readRateLimitUntil(accountId: string): number {
  return rateLimitedUntil.get(accountId) || 0;
}

function isRateLimited(accountId: string, now = Date.now()): boolean {
  const until = readRateLimitUntil(accountId);
  return until > now;
}

function markRateLimited(accountId: string, cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS): number {
  const until = Date.now() + Math.max(1_000, cooldownMs);
  rateLimitedUntil.set(accountId, until);
  return until;
}

function toErrorResult<T = unknown>(error: unknown): WechatApiResult<T> {
  if (error && typeof error === "object" && "message" in error) {
    return {
      ok: false,
      errcode: -1,
      errmsg: String((error as { message?: unknown }).message || "unknown_error"),
    };
  }
  return { ok: false, errcode: -1, errmsg: String(error || "unknown_error") };
}

async function parseJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getAccessToken(
  account: ResolvedWempAccount,
  forceRefresh = false,
): Promise<string> {
  loadTokenCacheFromDisk();
  dropExpiredCachedToken(account.accountId);
  const cached = tokenCache.get(account.accountId);
  if (!forceRefresh && cached && cached.expireAt > Date.now()) return cached.token;

  const inFlight = tokenRefreshInFlight.get(account.accountId);
  if (inFlight) return inFlight;

  let refreshPromise: Promise<string>;
  refreshPromise = (async () => {
    const appId = encodeURIComponent(account.appId);
    const secret = encodeURIComponent(account.appSecret);
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${secret}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch access token: ${res.status}`);
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errmsg?: string;
    };
    if (!data.access_token) throw new Error(data.errmsg || "access_token missing");
    setCachedToken(
      account.accountId,
      data.access_token,
      Date.now() + Math.max(60, (data.expires_in || 7200) - 120) * 1000,
    );
    return data.access_token;
  })().finally(() => {
    if (tokenRefreshInFlight.get(account.accountId) === refreshPromise) {
      tokenRefreshInFlight.delete(account.accountId);
    }
  });

  tokenRefreshInFlight.set(account.accountId, refreshPromise);
  return refreshPromise;
}

async function withTokenRetry<T>(
  account: ResolvedWempAccount,
  caller: (token: string) => Promise<WechatApiResult<T>>,
): Promise<WechatApiResult<T>> {
  if (isRateLimited(account.accountId)) {
    const until = readRateLimitUntil(account.accountId);
    return {
      ok: false,
      errcode: 45009,
      errmsg: `rate_limited_local_cooldown_until_${until}`,
    };
  }
  try {
    let token = await getAccessToken(account, false);
    let result = await caller(token);
    if (!result.ok && isTokenExpiredCode(result.errcode)) {
      token = await getAccessToken(account, true);
      result = await caller(token);
      result.retried = true;
    }
    if (!result.ok && isRateLimitCode(result.errcode)) {
      const until = markRateLimited(account.accountId);
      logWarn("wechat_rate_limited", {
        accountId: account.accountId,
        errcode: result.errcode,
        errmsg: result.errmsg,
        localCooldownUntil: until,
      });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn("wechat_api_exception", {
      accountId: account.accountId,
      message,
    });
    return toErrorResult(error);
  }
}

async function callCustomSend(
  token: string,
  payload: Record<string, unknown>,
): Promise<WechatApiResult> {
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    return { ok: false, errcode: res.status, errmsg: `http_${res.status}` };
  }
  const data = await parseJson<{ errcode?: number; errmsg?: string }>(res);
  if (!data) return { ok: false, errcode: -1, errmsg: "invalid_json_response" };
  return {
    ok: !data.errcode,
    data,
    errcode: data.errcode,
    errmsg: data.errmsg,
  };
}

export async function sendCustomTextMessage(
  account: ResolvedWempAccount,
  openId: string,
  text: string,
): Promise<WechatApiResult> {
  return withTokenRetry(account, (token) =>
    callCustomSend(token, {
      touser: openId,
      msgtype: "text",
      text: { content: text },
    }),
  );
}

export async function sendCustomImageMessage(
  account: ResolvedWempAccount,
  openId: string,
  mediaId: string,
): Promise<WechatApiResult> {
  return withTokenRetry(account, (token) =>
    callCustomSend(token, {
      touser: openId,
      msgtype: "image",
      image: { media_id: mediaId },
    }),
  );
}

export async function sendCustomVoiceMessage(
  account: ResolvedWempAccount,
  openId: string,
  mediaId: string,
): Promise<WechatApiResult> {
  return withTokenRetry(account, (token) =>
    callCustomSend(token, {
      touser: openId,
      msgtype: "voice",
      voice: { media_id: mediaId },
    }),
  );
}

export async function sendCustomVideoMessage(
  account: ResolvedWempAccount,
  openId: string,
  mediaId: string,
): Promise<WechatApiResult> {
  return withTokenRetry(account, (token) =>
    callCustomSend(token, {
      touser: openId,
      msgtype: "video",
      video: { media_id: mediaId },
    }),
  );
}

export async function sendCustomFileMessage(
  account: ResolvedWempAccount,
  openId: string,
  mediaId: string,
): Promise<WechatApiResult> {
  return withTokenRetry(account, (token) =>
    callCustomSend(token, {
      touser: openId,
      msgtype: "file",
      file: { media_id: mediaId },
    }),
  );
}

function toBlob(content: Blob | ArrayBuffer | Uint8Array): Blob {
  if (content instanceof Blob) return content;
  if (content instanceof Uint8Array) {
    const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    const copied = new Uint8Array(bytes).buffer;
    return new Blob([copied]);
  }
  return new Blob([content]);
}

async function callUploadTempMedia(
  token: string,
  type: WechatTempMediaType,
  media: Blob,
  filename: string,
): Promise<WechatApiResult<WechatUploadedTempMedia>> {
  const form = new FormData();
  form.append("media", media, filename);
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    const data = await parseJson<{ errcode?: number; errmsg?: string }>(res);
    return {
      ok: false,
      errcode: data?.errcode ?? res.status,
      errmsg: data?.errmsg ?? `http_${res.status}`,
    };
  }
  const data = await parseJson<WechatUploadedTempMedia & { errcode?: number; errmsg?: string }>(
    res,
  );
  if (!data) return { ok: false, errcode: -1, errmsg: "invalid_json_response" };
  return {
    ok: !data.errcode,
    data,
    errcode: data.errcode,
    errmsg: data.errmsg,
  };
}

export async function uploadTempMedia(
  account: ResolvedWempAccount,
  type: WechatTempMediaType,
  content: Blob | ArrayBuffer | Uint8Array,
  filename = "media",
): Promise<WechatApiResult<WechatUploadedTempMedia>> {
  const media = toBlob(content);
  return withTokenRetry(account, (token) => callUploadTempMedia(token, type, media, filename));
}

async function callDownloadMedia(
  token: string,
  mediaId: string,
): Promise<WechatApiResult<WechatDownloadedMedia>> {
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`,
  );
  const contentType = res.headers.get("content-type") || "";
  const contentDisposition = res.headers.get("content-disposition") || undefined;
  if (!res.ok) {
    const data = contentType.includes("application/json")
      ? await parseJson<{ errcode?: number; errmsg?: string }>(res)
      : null;
    return {
      ok: false,
      errcode: data?.errcode ?? res.status,
      errmsg: data?.errmsg ?? `http_${res.status}`,
    };
  }

  if (contentType.includes("application/json")) {
    const data = await parseJson<Record<string, unknown> & { errcode?: number; errmsg?: string }>(
      res,
    );
    if (!data) return { ok: false, errcode: -1, errmsg: "invalid_json_response" };
    if (data.errcode) return { ok: false, errcode: data.errcode, errmsg: data.errmsg };
    return {
      ok: true,
      data: {
        contentType,
        contentDisposition,
        data,
      },
    };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    ok: true,
    data: {
      bytes,
      contentType,
      contentDisposition,
    },
  };
}

export async function downloadMedia(
  account: ResolvedWempAccount,
  mediaId: string,
): Promise<WechatApiResult<WechatDownloadedMedia>> {
  return withTokenRetry(account, (token) => callDownloadMedia(token, mediaId));
}

// --- Template message API ---

export interface TemplateMessageMiniprogram {
  appid: string;
  pagepath?: string;
}

export interface TemplateMessageDataValue {
  value: string;
  color?: string;
}

async function callSendTemplateMessage(
  token: string,
  openId: string,
  templateId: string,
  data: Record<string, TemplateMessageDataValue>,
  url?: string,
  miniprogram?: TemplateMessageMiniprogram,
): Promise<WechatApiResult<{ msgid?: number }>> {
  const payload: Record<string, unknown> = {
    touser: openId,
    template_id: templateId,
    data,
  };
  if (url) payload.url = url;
  if (miniprogram) payload.miniprogram = miniprogram;

  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    return { ok: false, errcode: res.status, errmsg: `http_${res.status}` };
  }
  const result = await parseJson<{ errcode?: number; errmsg?: string; msgid?: number }>(res);
  if (!result) return { ok: false, errcode: -1, errmsg: "invalid_json_response" };
  return {
    ok: !result.errcode,
    data: { msgid: result.msgid },
    errcode: result.errcode,
    errmsg: result.errmsg,
  };
}

export async function sendTemplateMessage(
  account: ResolvedWempAccount,
  openId: string,
  templateId: string,
  data: Record<string, TemplateMessageDataValue>,
  url?: string,
  miniprogram?: TemplateMessageMiniprogram,
): Promise<WechatApiResult<{ msgid?: number }>> {
  return withTokenRetry(account, (token) =>
    callSendTemplateMessage(token, openId, templateId, data, url, miniprogram),
  );
}
