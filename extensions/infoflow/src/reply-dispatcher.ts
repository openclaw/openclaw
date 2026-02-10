import { createReplyPrefixOptions, type OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./channel.js";
import { recordSentMessageId } from "./infoflow_req_parse.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowPrivateMessage, sendInfoflowGroupMessage } from "./send.js";
import type { InfoflowAtOptions } from "./types.js";

export type CreateInfoflowReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  fromuser: string;
  chatType: "direct" | "group";
  groupId?: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** AT 选项，用于在群消息中 @成员 */
  atOptions?: InfoflowAtOptions;
};

/**
 * Builds dispatcherOptions and replyOptions for dispatchReplyWithBufferedBlockDispatcher.
 * Encapsulates prefix options, chunked deliver (send via Infoflow API + statusSink), and onError.
 */
export function createInfoflowReplyDispatcher(params: CreateInfoflowReplyDispatcherParams) {
  const { cfg, agentId, accountId, fromuser, chatType, groupId, statusSink, atOptions } = params;
  const core = getInfoflowRuntime();
  const verbose = core.logging.shouldLogVerbose();
  const account = resolveInfoflowAccount({ cfg, accountId });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "infoflow",
    accountId,
  });

  const deliver = async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
    const { apiHost, appKey, appSecret } = account.config;

    if (!appKey || !appSecret) {
      console.error(`[infoflow] Missing appKey or appSecret for account ${accountId}`);
      return;
    }

    if (payload.text) {
      // Chunk text to 4000 chars max (Infoflow limit)
      const chunks = core.channel.text.chunkText(payload.text, 4000);

      for (const chunk of chunks) {
        let result: { ok: boolean; error?: string; messageid?: string; msgkey?: string };

        if (chatType === "group" && groupId) {
          // Send to group
          if (verbose) {
            console.log(`[infoflow] Delivering group message to ${groupId}`);
          }
          result = await sendInfoflowGroupMessage({
            apiHost,
            appKey,
            appSecret,
            groupId,
            content: chunk,
            atOptions,
          });
        } else {
          // Send private message (DM)
          if (verbose) {
            console.log(`[infoflow] Delivering private message to ${fromuser}`);
          }
          result = await sendInfoflowPrivateMessage({
            apiHost,
            appKey,
            appSecret,
            touser: fromuser,
            content: chunk,
          });
        }

        if (result.ok) {
          statusSink?.({ lastOutboundAt: Date.now() });
          // Record sent message ID for dedup (prevent echo)
          const sentId = result.messageid ?? result.msgkey;
          if (sentId) {
            recordSentMessageId(sentId);
          }
        } else if (result.error) {
          console.error(`[infoflow] Failed to send message: ${result.error}`);
        }
      }
    }

    // TODO: Handle media attachments if needed
    if (payload.mediaUrl || payload.mediaUrls?.length) {
      if (verbose) {
        console.log(`[infoflow] Media attachments not yet supported`);
      }
    }
  };

  const onError = (err: unknown) => {
    console.error(`[infoflow] reply failed: ${String(err)}`);
  };

  return {
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError,
    },
    replyOptions: {
      onModelSelected,
    },
  };
}
