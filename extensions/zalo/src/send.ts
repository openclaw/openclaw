import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { stripChannelTargetPrefix, stripTargetKindPrefix } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveZaloAccount } from "./accounts.js";
import type { ZaloFetch } from "./api.js";
import { sendMessage, sendPhoto } from "./api.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { resolveZaloToken } from "./token.js";

type ZaloSendOptions = {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  caption?: string;
  verbose?: boolean;
  proxy?: string;
  assertDirectAdapterHandoff?: () => void;
};

type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  receipt: MessageReceipt;
  error?: string;
};

function createZaloSendReceipt(params: {
  messageId?: string;
  chatId: string;
  kind: MessageReceiptPartKind;
}): MessageReceipt {
  const messageId = params.messageId?.trim();
  return createMessageReceiptFromOutboundResults({
    results: messageId
      ? [
          {
            channel: "zalo",
            messageId,
            chatId: params.chatId,
          },
        ]
      : [],
    kind: params.kind,
  });
}

async function runZaloSend(
  failureMessage: string,
  params: { chatId: string; kind: MessageReceiptPartKind },
  assertDirectAdapterHandoff: (() => void) | undefined,
  send: (assertCurrent: (() => void) | undefined) => Promise<{
    ok?: boolean;
    result?: { message_id?: string };
  }>,
): Promise<ZaloSendResult> {
  let handoffRejected = false;
  let handoffError: unknown;
  const assertCurrent = assertDirectAdapterHandoff
    ? () => {
        try {
          assertDirectAdapterHandoff();
        } catch (error) {
          handoffRejected = true;
          handoffError = error;
          throw error;
        }
      }
    : undefined;
  try {
    const response = await send(assertCurrent);
    const messageId = response.ok && response.result ? response.result.message_id : undefined;
    const receipt = createZaloSendReceipt({ ...params, messageId });
    return response.ok && response.result
      ? { ok: true, messageId, receipt }
      : { ok: false, error: failureMessage, receipt };
  } catch (err) {
    if (handoffRejected && Object.is(handoffError, err)) {
      throw err;
    }
    return {
      ok: false,
      error: formatErrorMessage(err),
      receipt: createZaloSendReceipt({ chatId: params.chatId, kind: params.kind }),
    };
  }
}

function resolveSendContext(options: ZaloSendOptions): {
  token: string;
  fetcher?: ZaloFetch;
} {
  if (options.cfg) {
    const account = resolveZaloAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
    const token = options.token || account.token;
    const proxy = options.proxy ?? account.config.proxy;
    return { token, fetcher: resolveZaloProxyFetch(proxy) };
  }

  const token = options.token ?? resolveZaloToken(undefined, options.accountId).token;
  const proxy = options.proxy;
  return { token, fetcher: resolveZaloProxyFetch(proxy) };
}

export async function sendMessageZalo(
  chatId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const { token, fetcher } = resolveSendContext(options);
  const normalizedChatId = token
    ? stripTargetKindPrefix(stripChannelTargetPrefix(chatId, "zalo", "zl"))
    : "";
  if (!token || !normalizedChatId) {
    return {
      ok: false,
      error: token ? "No chat_id provided" : "No Zalo bot token configured",
      receipt: createZaloSendReceipt({ chatId, kind: "unknown" }),
    };
  }

  if (options.mediaUrl && (options.mediaUrl.trim() || !text)) {
    const photoUrl = options.mediaUrl.trim();
    if (!photoUrl) {
      return {
        ok: false,
        error: "No photo URL provided",
        receipt: createZaloSendReceipt({ chatId: normalizedChatId, kind: "media" }),
      };
    }
    const caption = text || options.caption;
    return await runZaloSend(
      "Failed to send photo",
      { chatId: normalizedChatId, kind: "media" },
      options.assertDirectAdapterHandoff,
      (assertCurrent) =>
        sendPhoto(
          token,
          {
            chat_id: normalizedChatId,
            photo: photoUrl,
            caption,
          },
          fetcher,
          assertCurrent,
        ),
    );
  }

  return await runZaloSend(
    "Failed to send message",
    { chatId: normalizedChatId, kind: "text" },
    options.assertDirectAdapterHandoff,
    (assertCurrent) =>
      sendMessage(
        token,
        {
          chat_id: normalizedChatId,
          text: truncateUtf16Safe(text, 2000),
        },
        fetcher,
        assertCurrent,
      ),
  );
}
