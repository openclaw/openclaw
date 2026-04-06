import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuPermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

type SenderNameResult = {
  name?: string;
  permissionError?: FeishuPermissionError;
};

type FeishuContactUserGetResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["contact"]["user"]["get"]>
>;

type FeishuLogger = {
  (...args: unknown[]): void;
};

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const SENDER_NAME_NOAUTH_BACKOFF_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
const senderLookupBackoff = new Map<string, number>();

const SENDER_NAME_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function cleanupExpiredSenderEntries(): void {
  const now = Date.now();
  for (const [key, entry] of senderNameCache) {
    if (entry.expireAt < now) {
      senderNameCache.delete(key);
    }
  }
  for (const [key, backoffUntil] of senderLookupBackoff) {
    if (backoffUntil < now) {
      senderLookupBackoff.delete(key);
    }
  }
}

const senderNameCleanupTimer = setInterval(
  cleanupExpiredSenderEntries,
  SENDER_NAME_CLEANUP_INTERVAL_MS,
);
senderNameCleanupTimer.unref();

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: FeishuPermissionError): boolean {
  const message = permissionError.message.toLowerCase();
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): FeishuPermissionError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: number; msg?: string };
  if (feishuErr.code !== 99991672) {
    return null;
  }
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: msg,
    grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined,
  };
}

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

function buildSenderLookupKey(account: ResolvedFeishuAccount, senderId: string): string {
  return `${account.appId ?? account.accountId}:${senderId}`;
}

function isNoUserAuthorityError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return false;
  }
  const feishuErr = data as { code?: number; msg?: string };
  return (
    feishuErr.code === 41050 || feishuErr.msg?.toLowerCase().includes("no user authority") === true
  );
}

export function resetFeishuSenderNameCacheForTests(): void {
  senderNameCache.clear();
  senderLookupBackoff.clear();
}

export function stopSenderNameCleanup(): void {
  clearInterval(senderNameCleanupTimer);
}

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  log: FeishuLogger;
}): Promise<SenderNameResult> {
  const { account, senderId, log } = params;
  if (!account.configured) {
    return {};
  }

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) {
    return {};
  }

  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return { name: cached.name };
  }
  const lookupKey = buildSenderLookupKey(account, normalizedSenderId);
  const backoffUntil = senderLookupBackoff.get(lookupKey) ?? 0;
  if (backoffUntil > now) {
    return {};
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res: FeishuContactUserGetResponse = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;

    if (name && typeof name === "string") {
      senderLookupBackoff.delete(lookupKey);
      senderNameCache.set(normalizedSenderId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    return {};
  } catch (err) {
    if (isNoUserAuthorityError(err)) {
      senderLookupBackoff.set(lookupKey, now + SENDER_NAME_NOAUTH_BACKOFF_MS);
      log(`feishu: backing off sender lookup for ${normalizedSenderId} after no user authority`);
      return {};
    }
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
