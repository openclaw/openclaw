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

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const GROUP_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
const groupNameCache = new Map<string, { name?: string; expireAt: number }>();

function buildSenderCacheKey(accountId: string, senderId: string): string {
  return `${accountId}:${senderId}`;
}

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
  const maybeAxios = err as { response?: { data?: unknown } };
  const data = maybeAxios.response?.data ?? err;
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

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  senderUserId?: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { account, senderId, senderUserId, log } = params;
  if (!account.configured) {
    return {};
  }

  const candidateIds = [senderUserId?.trim(), senderId.trim()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (candidateIds.length === 0) {
    return {};
  }

  const now = Date.now();
  for (const candidateId of candidateIds) {
    const cached = senderNameCache.get(buildSenderCacheKey(account.accountId, candidateId));
    if (cached && cached.expireAt > now) {
      return { name: cached.name };
    }
  }

  try {
    const client = createFeishuClient(account);
    for (const candidateId of candidateIds) {
      const userIdType = resolveSenderLookupIdType(candidateId);
      const res: any = await client.contact.user.get({
        path: { user_id: candidateId },
        params: { user_id_type: userIdType },
      });
      if (res?.code != null && res.code !== 0) {
        const permErr = extractPermissionError(res);
        if (permErr) {
          if (shouldSuppressPermissionErrorNotice(permErr)) {
            log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
            return {};
          }
          log(`feishu: permission error resolving sender name: code=${permErr.code}`);
          return { permissionError: permErr };
        }
        log(
          `feishu: sender name lookup failed for ${candidateId}: code=${String(res.code)} msg=${String(res?.msg ?? "")}`,
        );
        continue;
      }

      const name: string | undefined =
        res?.data?.user?.name ||
        res?.data?.user?.display_name ||
        res?.data?.user?.nickname ||
        res?.data?.user?.en_name;
      if (name && typeof name === "string") {
        for (const idForCache of candidateIds) {
          senderNameCache.set(buildSenderCacheKey(account.accountId, idForCache), {
            name,
            expireAt: now + SENDER_NAME_TTL_MS,
          });
        }
        return { name };
      }
    }
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve sender name for ${candidateIds.join(",")}: ${String(err)}`);
    return {};
  }
}

export async function resolveFeishuGroupName(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log: (...args: any[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, log } = params;
  if (!account.configured) {
    return undefined;
  }

  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) {
    return undefined;
  }

  const cacheKey = `${account.accountId}:${normalizedChatId}`;
  const cached = groupNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  const cacheMiss = () => {
    groupNameCache.set(cacheKey, { name: undefined, expireAt: now + GROUP_NAME_TTL_MS });
    return undefined;
  };

  try {
    const client = createFeishuClient(account) as any;
    const getChat = client?.im?.chat?.get;
    if (typeof getChat !== "function") {
      return undefined;
    }

    const res: any = await getChat({ path: { chat_id: normalizedChatId } });
    if (res?.code !== 0) {
      log(
        `feishu: failed to resolve group name for ${normalizedChatId}: code=${String(res?.code)} msg=${String(res?.msg ?? "")}`,
      );
      return cacheMiss();
    }

    const name =
      typeof res?.data?.name === "string" && res.data.name.trim().length > 0
        ? res.data.name.trim()
        : undefined;
    groupNameCache.set(cacheKey, { name, expireAt: now + GROUP_NAME_TTL_MS });
    return name;
  } catch (err) {
    log(`feishu: failed to resolve group name for ${normalizedChatId}: ${String(err)}`);
    return cacheMiss();
  }
}

export async function resolveFeishuDirectNameFromChatMember(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  senderOpenId: string;
  log: (...args: any[]) => void;
}): Promise<string | undefined> {
  const { account, chatId, senderOpenId, log } = params;
  if (!account.configured) {
    return undefined;
  }

  const normalizedSenderOpenId = senderOpenId.trim();
  const normalizedChatId = chatId.trim();
  if (!normalizedSenderOpenId || !normalizedChatId) {
    return undefined;
  }

  const cached = senderNameCache.get(
    buildSenderCacheKey(account.accountId, normalizedSenderOpenId),
  );
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  try {
    const client = createFeishuClient(account) as any;
    const getChatMembers = client?.im?.chatMembers?.get ?? client?.im?.chat?.members?.get;
    if (typeof getChatMembers !== "function") {
      return undefined;
    }

    const res: any = await getChatMembers({
      path: { chat_id: normalizedChatId },
      params: { member_id_type: "open_id", page_size: 50 },
    });
    if (res?.code !== 0) {
      log(
        `feishu: failed to resolve direct member name for ${normalizedSenderOpenId} in ${normalizedChatId}: code=${String(res?.code)} msg=${String(res?.msg ?? "")}`,
      );
      return undefined;
    }

    const item = Array.isArray(res?.data?.items)
      ? res.data.items.find(
          (entry: any) =>
            typeof entry?.member_id === "string" && entry.member_id === normalizedSenderOpenId,
        )
      : undefined;
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (name) {
      senderNameCache.set(buildSenderCacheKey(account.accountId, normalizedSenderOpenId), {
        name,
        expireAt: now + SENDER_NAME_TTL_MS,
      });
      return name;
    }
  } catch (err) {
    log(
      `feishu: failed to resolve direct member name for ${normalizedSenderOpenId} in ${normalizedChatId}: ${String(err)}`,
    );
  }

  return undefined;
}
