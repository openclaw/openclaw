/**
 * Phase 1B.1 outbound adapter.
 *
 * `sendText` issues `POST /messages?chat_id=<n>` against MAX through the same
 * polling-http wrapper the supervisor uses (per docs/max-plugin/plan.md
 * §6.1.6: the wrapper is reused for non-polling MAX API calls). This gives
 * outbound the same `Retry-After` honoring, per-request timeout, and 401
 * classification as polling.
 *
 * `sendMedia` / `sendPoll` still throw — attachments and polls land in
 * Phase 4 / future phases.
 *
 * Outbound runs without an external `AbortSignal` from the chat channel
 * delivery path; the wrapper's per-request timeout still bounds it.
 */

import { resolveMaxAccount } from "../account-resolver.js";
import { MAX_TEXT_CHUNK_LIMIT } from "../constants.js";
import { pollingHttpRequest, UnauthorizedError } from "../polling/polling-http.js";
import type { CoreConfig } from "../types.js";

const NOT_IMPLEMENTED_PHASE_1B = "not implemented in Phase 1B";

const SEND_REQUEST_TIMEOUT_MS = 30_000;

type SendMessageResponse = {
  message?: {
    body?: {
      mid?: string;
    };
  };
};

function parseChatId(to: string): number {
  const trimmed = to.trim().replace(/^max(-messenger)?:/iu, "");
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `MAX Messenger: outbound target "${to}" is not a valid chat_id (expected integer).`,
    );
  }
  return parsed;
}

async function sendMaxText(params: {
  cfg: CoreConfig;
  to: string;
  accountId?: string | null;
  text: string;
}): Promise<{ messageId: string }> {
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

  try {
    const response = await pollingHttpRequest<SendMessageResponse>({
      apiRoot: account.apiRoot,
      path: "/messages",
      method: "POST",
      token: account.token,
      query: { chat_id: chatId },
      body: { text: params.text },
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

export const maxMessengerOutboundAdapter = {
  base: {
    deliveryMode: "direct" as const,
    chunkerMode: "text" as const,
    textChunkLimit: MAX_TEXT_CHUNK_LIMIT,
  },
  attachedResults: {
    channel: "max-messenger",
    sendText: async ({
      cfg,
      to,
      accountId,
      text,
    }: {
      cfg: unknown;
      to: string;
      accountId?: string | null;
      text: string;
    }) => {
      return sendMaxText({
        cfg: cfg as CoreConfig,
        to,
        accountId: accountId ?? null,
        text,
      });
    },
    sendMedia: async () => {
      throw new Error(`max-messenger sendMedia: ${NOT_IMPLEMENTED_PHASE_1B}`);
    },
    sendPoll: async () => {
      throw new Error(`max-messenger sendPoll: ${NOT_IMPLEMENTED_PHASE_1B}`);
    },
  },
};
