/**
 * Outbound send helpers for the MAX channel. Shared between the outbound
 * adapter (agent → channel reply path) and the inbound dispatcher's deliver
 * callback (pairing replies, agent reply chunks).
 *
 * Issues `POST /messages?chat_id=<n>` through the same `pollingHttpRequest`
 * wrapper the supervisor uses, so outbound inherits Retry-After honoring,
 * 401 classification, and per-request timeout — per
 * docs/max-plugin/plan.md §6.1.6 ("Reused for non-polling MAX API calls").
 */

import { resolveMaxAccount } from "./account-resolver.js";
import { pollingHttpRequest, UnauthorizedError } from "./polling/polling-http.js";
import type { CoreConfig } from "./types.js";

const SEND_REQUEST_TIMEOUT_MS = 30_000;

type SendMessageResponse = {
  message?: {
    body?: {
      mid?: string;
    };
  };
};

/** Strip optional `max:` / `max-messenger:` prefix and parse to integer chat_id. */
export function parseChatId(to: string): number {
  const trimmed = to.trim().replace(/^max(-messenger)?:/iu, "");
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `MAX Messenger: outbound target "${to}" is not a valid chat_id (expected integer).`,
    );
  }
  return parsed;
}

export type SendMaxTextParams = {
  cfg: CoreConfig;
  to: string;
  accountId?: string | null;
  text: string;
  /** Optional reply-to message id for native quote threading (Phase 3 wires this). */
  replyToId?: string | null;
};

/** Resolve account, parse target, send `POST /messages`, return the new mid. */
export async function sendMaxText(params: SendMaxTextParams): Promise<{ messageId: string }> {
  const account = resolveMaxAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? null,
  });
  if (!account.token) {
    throw new Error(
      `MAX Messenger: no token available for account "${account.accountId}"; ` +
        "configure channels.max-messenger.token / tokenFile / MAX_BOT_TOKEN.",
    );
  }
  const chatId = parseChatId(params.to);

  const body: { text: string; link?: { type: "reply"; mid: string } } = { text: params.text };
  if (params.replyToId && params.replyToId.trim() !== "") {
    body.link = { type: "reply", mid: params.replyToId };
  }

  try {
    const response = await pollingHttpRequest<SendMessageResponse>({
      apiRoot: account.apiRoot,
      path: "/messages",
      method: "POST",
      token: account.token,
      query: { chat_id: chatId },
      body,
      requestTimeoutMs: SEND_REQUEST_TIMEOUT_MS,
    });
    const mid = response.message?.body?.mid;
    return {
      messageId: typeof mid === "string" && mid !== "" ? mid : `max-send-${Date.now()}`,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw new Error(
        `MAX Messenger: token for account "${account.accountId}" was rejected by the API (HTTP 401).`,
        { cause: err },
      );
    }
    throw err;
  }
}
