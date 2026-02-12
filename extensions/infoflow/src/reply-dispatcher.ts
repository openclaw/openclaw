import {
  createReplyPrefixOptions,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import type { InfoflowAtOptions, InfoflowMessageContentItem } from "./types.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";

export type CreateInfoflowReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  /** Target: "group:<id>" for group chat, username for private chat */
  to: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** AT options for @mentioning members in group messages */
  atOptions?: InfoflowAtOptions;
};

/**
 * Builds dispatcherOptions and replyOptions for dispatchReplyWithBufferedBlockDispatcher.
 * Encapsulates prefix options, chunked deliver (send via Infoflow API + statusSink), and onError.
 */
export function createInfoflowReplyDispatcher(params: CreateInfoflowReplyDispatcherParams) {
  const { cfg, agentId, accountId, to, statusSink, atOptions } = params;
  const core = getInfoflowRuntime();

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "infoflow",
    accountId,
  });

  // Check if target is a group (format: group:<id>)
  const isGroup = /^group:\d+$/i.test(to);

  const deliver = async (payload: ReplyPayload) => {
    const text = payload.text ?? "";
    if (!text.trim()) {
      return;
    }

    // Chunk text to 4000 chars max (Infoflow limit)
    const chunks = core.channel.text.chunkText(text, 4000);
    // Only include @mentions in the first chunk (avoid duplicate @s)
    let isFirstChunk = true;

    for (const chunk of chunks) {
      const contents: InfoflowMessageContentItem[] = [{ type: "markdown", content: chunk }];

      // Add AT content for group messages (first chunk only)
      if (isFirstChunk && isGroup && atOptions) {
        if (atOptions.atAll) {
          contents.push({ type: "at", content: "all" });
        } else if (atOptions.atUserIds?.length) {
          contents.push({ type: "at", content: atOptions.atUserIds.join(",") });
        }
      }
      isFirstChunk = false;

      const result = await sendInfoflowMessage({ cfg, to, contents, accountId });

      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
      } else if (result.error) {
        console.error(`[infoflow] Failed to send message: ${result.error}`);
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
