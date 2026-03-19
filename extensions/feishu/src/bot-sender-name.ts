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
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

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

export async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  senderUserId?: string;
  log: FeishuLogger;
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
    const cached = senderNameCache.get(candidateId);
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

      const user = res?.data?.user;
      const name = user?.name ?? user?.display_name ?? user?.nickname ?? user?.en_name;
      if (typeof name === "string" && name.trim().length > 0) {
        const normalizedName = name.trim();
        for (const idForCache of candidateIds) {
          senderNameCache.set(idForCache, { name: normalizedName, expireAt: now + SENDER_NAME_TTL_MS });
        }
        return { name: normalizedName };
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
