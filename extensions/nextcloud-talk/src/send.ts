import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readNextcloudTalkErrorBody } from "./guarded-response.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import {
  convertMarkdownTables,
  fetchWithSsrFGuard,
  generateNextcloudTalkSignature,
  getOptionalNextcloudTalkRuntime,
  requireRuntimeConfig,
  resolveMarkdownTableMode,
  resolveNextcloudTalkAccount,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "./send.runtime.js";
import type { CoreConfig, NextcloudTalkSendResult } from "./types.js";

const NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS = 200;
const NEXTCLOUD_TALK_SEND_TIMEOUT_MS = 30_000;

/** Collapses and caps an already-redacted error body for display. */
function collapseErrorSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length > NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS) {
    return `${truncateUtf16Safe(collapsed, NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS)}…`;
  }
  return collapsed;
}

type NextcloudTalkSendOpts = {
  cfg: CoreConfig;
  secret?: string;
  accountId?: string;
  replyTo?: string;
  timeoutMs?: number;
};

function resolveNextcloudTalkSendContext(opts: NextcloudTalkSendOpts) {
  const cfg = requireRuntimeConfig(opts.cfg, "Nextcloud Talk send") as CoreConfig;
  const account = resolveNextcloudTalkAccount({ cfg, accountId: opts.accountId });
  const baseUrl = account.baseUrl;
  const secret = opts.secret?.trim() ?? account.secret;

  if (!baseUrl) {
    throw new Error(
      `Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk.baseUrl).`,
    );
  }
  if (!secret) {
    throw new Error(
      account.tokenStatus === "configured_unavailable"
        ? `Nextcloud Talk bot secret is configured but unavailable for account "${account.accountId}" (check the configured channels.nextcloud-talk.botSecret/botSecretFile).`
        : `Nextcloud Talk bot secret missing for account "${account.accountId}" (set channels.nextcloud-talk.botSecret/botSecretFile or NEXTCLOUD_TALK_BOT_SECRET for default).`,
    );
  }

  return { cfg, account, baseUrl, secret };
}

function normalizeRoomToken(to: string): string {
  const normalized = stripNextcloudTalkTargetPrefix(to);
  if (!normalized) {
    throw new Error("Room token is required for Nextcloud Talk sends");
  }
  return normalized;
}

async function postNextcloudTalkBot(params: {
  context: ReturnType<typeof resolveNextcloudTalkSendContext>;
  path: string;
  payload: object;
  signedValue: string;
  auditContext: string;
  timeoutMs?: number;
  beforeRequest?: () => void;
}) {
  const { account, baseUrl, secret } = params.context;
  // Talk signs the extracted message/reaction value, not the JSON envelope.
  const { random, signature } = generateNextcloudTalkSignature({
    body: params.signedValue,
    secret,
  });
  const guarded = await fetchWithSsrFGuard({
    url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${params.path}`,
    beforeRequest: params.beforeRequest,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: JSON.stringify(params.payload),
    },
    auditContext: params.auditContext,
    policy: ssrfPolicyFromPrivateNetworkOptIn(
      account.config.network?.dangerouslyAllowPrivateNetwork,
    ),
    timeoutMs: params.timeoutMs ?? NEXTCLOUD_TALK_SEND_TIMEOUT_MS,
  });
  return { ...guarded, signature };
}

export async function sendMessageNextcloudTalk(
  to: string,
  text: string,
  opts: NextcloudTalkSendOpts & {
    onPlatformSendDispatch?: () => Promise<void>;
    assertDirectAdapterHandoff?: () => void;
  },
): Promise<NextcloudTalkSendResult> {
  const context = resolveNextcloudTalkSendContext(opts);
  const { cfg, account } = context;
  const roomToken = normalizeRoomToken(to);

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });
  const message = convertMarkdownTables(text.trim(), tableMode);

  await opts.onPlatformSendDispatch?.();
  const { response, release, signature } = await postNextcloudTalkBot({
    context,
    path: `${roomToken}/message`,
    payload: { message, replyTo: opts.replyTo || undefined },
    signedValue: message,
    beforeRequest: opts.assertDirectAdapterHandoff,
    auditContext: "nextcloud-talk-send",
    timeoutMs: opts.timeoutMs,
  });

  try {
    if (!response.ok) {
      const errorBody = collapseErrorSnippet(await readNextcloudTalkErrorBody(response, signature));
      const status = response.status;
      let errorMsg = `Nextcloud Talk send failed (${status})`;

      if (status === 400) {
        errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
      } else if (status === 401) {
        errorMsg =
          "Nextcloud Talk: bot send was rejected - check the bot secret and check that the bot was installed with --feature response";
      } else if (status === 403) {
        errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";
      } else if (status === 404) {
        errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;
      } else if (errorBody) {
        errorMsg = `Nextcloud Talk send failed: ${errorBody}`;
      }

      throw new Error(errorMsg);
    }

    let messageId = "unknown";
    let timestamp: number | undefined;
    try {
      const data = await readProviderJsonResponse<{
        ocs?: {
          data?: {
            id?: number | string;
            timestamp?: number;
          };
        };
      }>(response, "Nextcloud Talk send");
      if (data.ocs?.data?.id != null) {
        messageId = String(data.ocs.data.id);
      }
      if (typeof data.ocs?.data?.timestamp === "number") {
        timestamp = data.ocs.data.timestamp;
      }
    } catch {
      // Response parsing failed (including an over-limit body), but the message
      // was already accepted by the server, so keep the "unknown" receipt.
    }

    getOptionalNextcloudTalkRuntime()?.channel.activity.record({
      channel: "nextcloud-talk",
      accountId: account.accountId,
      direction: "outbound",
    });

    const receiptMessageId = messageId.trim();
    return {
      messageId,
      roomToken,
      receipt: createMessageReceiptFromOutboundResults({
        results:
          receiptMessageId && receiptMessageId !== "unknown"
            ? [
                {
                  channel: "nextcloud-talk",
                  messageId: receiptMessageId,
                  conversationId: roomToken,
                },
              ]
            : [],
        kind: "text",
        ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
      }),
      timestamp,
    };
  } finally {
    await release();
  }
}

export async function sendReactionNextcloudTalk(
  roomToken: string,
  messageId: string,
  reaction: string,
  opts: Omit<NextcloudTalkSendOpts, "replyTo">,
): Promise<{ ok: true }> {
  const context = resolveNextcloudTalkSendContext(opts);
  const normalizedToken = normalizeRoomToken(roomToken);

  const { response, release, signature } = await postNextcloudTalkBot({
    context,
    path: `${normalizedToken}/reaction/${messageId}`,
    payload: { reaction },
    signedValue: reaction,
    auditContext: "nextcloud-talk-reaction",
    timeoutMs: opts.timeoutMs,
  });

  try {
    if (!response.ok) {
      const errorBody = collapseErrorSnippet(await readNextcloudTalkErrorBody(response, signature));
      throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
    }

    return { ok: true };
  } finally {
    await release();
  }
}
