// Telegram plugin module implements audit membership runtime behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  AuditTelegramGroupMembershipParams,
  TelegramGroupMembershipAudit,
  TelegramGroupMembershipAuditEntry,
} from "./audit.types.js";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string };
type TelegramGroupMembershipAuditData = Omit<TelegramGroupMembershipAudit, "elapsedMs">;
// Telegram getChatMember responses are tiny (< 1 KiB). 4 MiB guards against hostile endpoints.
const TELEGRAM_BOT_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type TelegramChatMemberResult = { status?: string };

export async function auditTelegramGroupMembershipImpl(
  params: AuditTelegramGroupMembershipParams,
): Promise<TelegramGroupMembershipAuditData> {
  const proxyFetch = params.proxyUrl ? makeProxyFetch(params.proxyUrl) : undefined;
  const fetcher = resolveTelegramFetch(proxyFetch, {
    network: params.network,
  });
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const base = `${apiBase}/bot${params.token}`;
  const groups: TelegramGroupMembershipAuditEntry[] = [];

  for (const chatId of params.groupIds) {
    try {
      const url = `${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`;
      const res = await fetchWithTimeout(url, {}, params.timeoutMs, fetcher);
      const json = JSON.parse(
        (await readResponseWithLimit(res, TELEGRAM_BOT_API_MAX_RESPONSE_BYTES)).toString("utf8"),
      ) as TelegramApiOk<TelegramChatMemberResult> | TelegramApiErr;
      if (!res.ok || !isRecord(json) || !json.ok) {
        const desc =
          isRecord(json) && !json.ok && typeof json.description === "string"
            ? json.description
            : `getChatMember failed (${res.status})`;
        groups.push({
          chatId,
          ok: false,
          status: null,
          error: desc,
          matchKey: chatId,
          matchSource: "id",
        });
        continue;
      }
      const status =
        isRecord(json.result) && typeof json.result.status === "string" ? json.result.status : null;
      const ok = status === "creator" || status === "administrator" || status === "member";
      groups.push({
        chatId,
        ok,
        status,
        error: ok ? null : "bot not in group",
        matchKey: chatId,
        matchSource: "id",
      });
    } catch (err) {
      groups.push({
        chatId,
        ok: false,
        status: null,
        error: formatErrorMessage(err),
        matchKey: chatId,
        matchSource: "id",
      });
    }
  }

  return {
    ok: groups.every((g) => g.ok),
    checkedGroups: groups.length,
    unresolvedGroups: 0,
    hasWildcardUnmentionedGroups: false,
    groups,
  };
}
