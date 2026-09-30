import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import type { getZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser } from "./send.js";

const ZALOUSER_TEXT_LIMIT = 2000;

function logVerbose(
  core: ReturnType<typeof getZalouserRuntime>,
  runtime: RuntimeEnv,
  message: string,
): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

export async function deliverZalouserReply(params: {
  mediaMaxBytes?: number;
  payload: OutboundReplyPayload;
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: ReturnType<typeof getZalouserRuntime>;
  config: OpenClawConfig;
  accountId?: string;
  tableMode?: MarkdownTableMode;
}): Promise<{ visibleReplySent: boolean }> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId } = params;
  const tableMode = params.tableMode ?? "code";
  let visibleReplySent = false;
  // message_sending runs after preparePayload, so this private transport boundary owns the final
  // sanitizer pass; moving it earlier lets hook rewrites reintroduce internal scaffolding.
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: core.channel.text.convertMarkdownTables(
      sanitizeAssistantVisibleText(payload.text ?? ""),
      tableMode,
    ),
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(config, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_LIMIT,
  });
  const accepted: Awaited<ReturnType<typeof sendMessageZalouser>>[] = [];
  const sendReplyPart = async (text: string, mediaUrl?: string) => {
    await sendMessageZalouser(chatId, text, {
      profile,
      mediaMaxBytes: params.mediaMaxBytes,
      ...(mediaUrl ? { mediaUrl } : {}),
      isGroup,
      textMode: "markdown",
      textChunkMode: chunkMode,
      textChunkLimit,
      onDeliveryResult: (result) => {
        accepted.push(result);
        visibleReplySent = true;
      },
    });
    visibleReplySent = true;
  };
  try {
    await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      sendText: sendReplyPart,
      sendMedia: async ({ mediaUrl, caption }) => {
        logVerbose(core, runtime, `Sending media to ${chatId}`);
        await sendReplyPart(caption ?? "", mediaUrl);
      },
    });
  } catch (error) {
    if (!visibleReplySent) {
      throw error;
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: accepted.map((result) => ({ receipt: result.receipt })),
      kind: reply.hasMedia ? "media" : "text",
    });
    throw createChannelPartialDeliveryError(error, {
      messageIds: listMessageReceiptPlatformIds(receipt),
      receipt,
      visibleReplySent: true,
    });
  }
  return { visibleReplySent };
}
