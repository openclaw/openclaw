import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createFeishuClient } from "./client.js";
import { extractFeishuApiErrorMeta } from "./comment-shared.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuPermissionError = {
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

function extractPermissionError(feishuErr: FeishuApiError | null): FeishuPermissionError | null {
  if (feishuErr?.code !== 99991672) {
    return null;
  }
  const urlMatch = feishuErr.message.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
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
  if (cached && cached.expireAt > Date.now()) {
    return cached.kind === "resolved" ? { name: cached.name } : {};
  }
  if (cached) {
    senderNameCache.delete(cacheKey);
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = normalizedSenderId.startsWith("ou_")
      ? "open_id"
      : normalizedSenderId.startsWith("on_")
        ? "union_id"
        : "user_id";
    const res = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;

    if (name) {
      writeSenderNameCache(cacheKey, {
        kind: "resolved",
        name,
        expireAt: Date.now() + SENDER_NAME_TTL_MS,
      });
      return { name };
    }
    return {};
  } catch (err) {
    const { feishuCode: code, feishuMsg: message = "" } = extractFeishuApiErrorMeta(err);
    const feishuErr = typeof code === "number" ? { code, message } : null;
    const permErr = extractPermissionError(feishuErr);
    if (permErr) {
      if (normalizeLowercaseStringOrEmpty(message).includes(STALE_CONTACT_SCOPE)) {
        log(`feishu: ignoring stale permission scope error: ${message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${code}`);
      return { permissionError: permErr };
    }
    if (feishuErr?.code === FEISHU_USER_LOOKUP_UNAUTHORIZED_CODE) {
      // 41050 means this app cannot see the user. Cache the account-scoped miss
      // so later messages avoid repeating the same failing API request and SDK log.
      writeSenderNameCache(cacheKey, {
        kind: "unavailable",
        expireAt: Date.now() + SENDER_NAME_NEGATIVE_TTL_MS,
      });
      return {};
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
