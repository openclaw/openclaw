import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
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
type FeishuChatMembersGetResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["im"]["chatMembers"]["get"]>
>;

type FeishuLogger = (...args: unknown[]) => void;

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
const directMemberNameCache = new Map<string, { name: string; expireAt: number }>();

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: FeishuPermissionError): boolean {
  const message = normalizeLowercaseStringOrEmpty(permissionError.message);
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): FeishuPermissionError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data ?? err;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: number; msg?: string; message?: string };
  if (feishuErr.code !== 99991672) {
    return null;
  }
  const msg = feishuErr.msg ?? feishuErr.message ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: msg,
    grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined,
  };
}

function normalizeName(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildAccountCachePrefix(account: ResolvedFeishuAccount): string {
  return `${account.accountId}:${account.appId ?? ""}`;
}

function buildSenderCacheKey(account: ResolvedFeishuAccount, senderId: string): string {
  return `${buildAccountCachePrefix(account)}:sender:${senderId}`;
}

function buildDirectMemberCacheKey(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  senderId: string;
}): string {
  return `${buildAccountCachePrefix(params.account)}:dm:${params.chatId}:${params.senderId}`;
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

async function resolveFeishuDirectMemberName(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  senderId: string;
  log: FeishuLogger;
}): Promise<SenderNameResult> {
  const { account, chatId, senderId, log } = params;
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) {
    return {};
  }

  const cacheKey = buildDirectMemberCacheKey({ account, chatId: normalizedChatId, senderId });
  const cached = directMemberNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return { name: cached.name };
  }

  try {
    const client = createFeishuClient(account);
    const getChatMembers = client.im?.chatMembers?.get;
    if (!getChatMembers) {
      return {};
    }
    const memberIdType = resolveSenderLookupIdType(senderId);
    const res: FeishuChatMembersGetResponse = await getChatMembers({
      path: { chat_id: normalizedChatId },
      params: { page_size: 10, member_id_type: memberIdType },
    });
    if (res.code !== undefined && res.code !== 0) {
      const permErr = extractPermissionError(res);
      if (permErr) {
        return { permissionError: permErr };
      }
      log(`feishu: failed to resolve direct member name: code=${res.code} msg=${res.msg ?? ""}`);
      return {};
    }

    const members = res.data?.items ?? [];
    const matchedMember =
      members.find((member) => member.member_id?.trim() === senderId) ??
      (members.length === 1 ? members[0] : undefined);
    const name = normalizeName(matchedMember?.name);
    if (!name) {
      return {};
    }

    directMemberNameCache.set(cacheKey, { name, expireAt: now + SENDER_NAME_TTL_MS });
    return { name };
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve direct member name for ${senderId}: ${String(err)}`);
    return {};
  }
}

export function clearFeishuSenderNameCache(): void {
  senderNameCache.clear();
  directMemberNameCache.clear();
}

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  chatId?: string;
  chatType?: "p2p" | "private" | "group" | "topic_group";
  log: FeishuLogger;
}): Promise<SenderNameResult> {
  const { account, senderId, chatId, chatType, log } = params;
  if (!account.configured) {
    return {};
  }

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) {
    return {};
  }

  let directPermissionError: FeishuPermissionError | undefined;
  if ((chatType === "p2p" || chatType === "private") && chatId) {
    const directResult = await resolveFeishuDirectMemberName({
      account,
      chatId,
      senderId: normalizedSenderId,
      log,
    });
    if (directResult.name) {
      return { name: directResult.name };
    }
    directPermissionError = directResult.permissionError;
  }

  const cacheKey = buildSenderCacheKey(account, normalizedSenderId);
  const cached = senderNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return { name: cached.name };
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res: FeishuContactUserGetResponse = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name =
      normalizeName(user?.name) ?? normalizeName(user?.nickname) ?? normalizeName(user?.en_name);

    if (name) {
      senderNameCache.set(cacheKey, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    return directPermissionError ? { permissionError: directPermissionError } : {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return directPermissionError ? { permissionError: directPermissionError } : {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return directPermissionError ? { permissionError: directPermissionError } : {};
  }
}
