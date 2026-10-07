import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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

type FeishuLogger = (...args: unknown[]) => void;

type FeishuApiError = {
  code: number;
  message: string;
};

type SenderNameCacheEntry =
  | { kind: "resolved"; name: string; expireAt: number }
  | { kind: "unavailable"; expireAt: number };

const STALE_CONTACT_SCOPE = "contact:contact.base:readonly";
const FEISHU_USER_LOOKUP_UNAUTHORIZED_CODE = 41050;
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const SENDER_NAME_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const SENDER_NAME_CACHE_MAX_SIZE = 500;
const senderNameCache = new Map<string, SenderNameCacheEntry>();

function extractFeishuApiError(err: unknown): FeishuApiError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: unknown; msg?: unknown };
  if (typeof feishuErr.code !== "number") {
    return null;
  }
  return {
    code: feishuErr.code,
    message: typeof feishuErr.msg === "string" ? feishuErr.msg : "",
  };
}

function extractPermissionError(feishuErr: FeishuApiError | null): FeishuPermissionError | null {
  if (feishuErr?.code !== 99991672) {
    return null;
  }
  const urlMatch = feishuErr.message.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: feishuErr.message,
    grantUrl: urlMatch?.[0]
      ?.replaceAll(
        encodeURIComponent(STALE_CONTACT_SCOPE),
        encodeURIComponent("contact:user.base:readonly"),
      )
      .replaceAll(STALE_CONTACT_SCOPE, "contact:user.base:readonly"),
  };
}

function writeSenderNameCache(key: string, entry: SenderNameCacheEntry): void {
  senderNameCache.delete(key);
  senderNameCache.set(key, entry);
  pruneMapToMaxSize(senderNameCache, SENDER_NAME_CACHE_MAX_SIZE);
}

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  if (senderId.startsWith("ou_")) {
    return "open_id";
  }
  if (senderId.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
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

  const cacheKey = `${account.accountId}:${normalizedSenderId}`;
  const cached = senderNameCache.get(cacheKey);
  const now = asDateTimestampMs(Date.now());
  const cachedExpireAt = cached ? asDateTimestampMs(cached.expireAt) : undefined;
  if (cached && now !== undefined && cachedExpireAt !== undefined && cachedExpireAt > now) {
    return cached.kind === "resolved" ? { name: cached.name } : {};
  }
  if (cached) {
    senderNameCache.delete(cacheKey);
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;

    if (name) {
      const expireAt = resolveExpiresAtMsFromDurationMs(SENDER_NAME_TTL_MS);
      if (expireAt !== undefined) {
        writeSenderNameCache(cacheKey, { kind: "resolved", name, expireAt });
      }
      return { name };
    }
    return {};
  } catch (err) {
    const feishuErr = extractFeishuApiError(err);
    const permErr = extractPermissionError(feishuErr);
    if (permErr) {
      if (normalizeLowercaseStringOrEmpty(permErr.message).includes(STALE_CONTACT_SCOPE)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    if (feishuErr?.code === FEISHU_USER_LOOKUP_UNAUTHORIZED_CODE) {
      // 41050 means this app cannot see the user. Cache the account-scoped miss
      // so later messages avoid repeating the same failing API request and SDK log.
      const expireAt = resolveExpiresAtMsFromDurationMs(SENDER_NAME_NEGATIVE_TTL_MS);
      if (expireAt !== undefined) {
        writeSenderNameCache(cacheKey, { kind: "unavailable", expireAt });
      }
      return {};
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
