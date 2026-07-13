// Line plugin module implements reply chunks behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { markLineVisibleDeliveryError } from "./delivery-error.js";

type LineReplyMessage = messagingApi.TextMessage;

export type SendLineReplyChunksParams = {
  to: string;
  chunks: string[];
  quickReplies?: string[];
  replyToken?: string | null;
  replyTokenUsed?: boolean;
  cfg: OpenClawConfig;
  accountId?: string;
  replyMessageLine: (
    replyToken: string,
    messages: messagingApi.Message[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  pushMessageLine: (
    to: string,
    text: string,
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  pushTextMessageWithQuickReplies: (
    to: string,
    text: string,
    quickReplies: string[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  createTextMessageWithQuickReplies: (text: string, quickReplies: string[]) => LineReplyMessage;
  onReplyError?: (err: unknown) => void;
};

export async function sendLineReplyChunks(
  params: SendLineReplyChunksParams,
): Promise<{ replyTokenUsed: boolean }> {
  const quickReplies = params.quickReplies?.length ? params.quickReplies : undefined;
  let replyTokenUsed = Boolean(params.replyTokenUsed);

  if (params.chunks.length === 0) {
    return { replyTokenUsed };
  }

  // Track whether any chunk reached the user. If a later send fails after that, the
  // error is tagged so the core suppresses a duplicate fallback delivery — the same
  // contract the rich/media partial path uses via markLineVisibleDeliveryError.
  let deliveredAny = false;
  const pushChunk = async (chunk: string, isLast: boolean): Promise<void> => {
    if (isLast && quickReplies) {
      await params.pushTextMessageWithQuickReplies(params.to, chunk, quickReplies, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
    } else {
      await params.pushMessageLine(params.to, chunk, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
    }
    deliveredAny = true;
  };

  try {
    if (params.replyToken && !replyTokenUsed) {
      const replyBatch = params.chunks.slice(0, 5);
      const remaining = params.chunks.slice(replyBatch.length);
      let replySent = false;
      try {
        const replyMessages: LineReplyMessage[] = replyBatch.map((chunk) => ({
          type: "text",
          text: chunk,
        }));

        if (quickReplies && remaining.length === 0 && replyMessages.length > 0) {
          const lastIndex = replyMessages.length - 1;
          replyMessages[lastIndex] = params.createTextMessageWithQuickReplies(
            expectDefined(replyBatch[lastIndex], "last non-empty LINE reply batch chunk"),
            quickReplies,
          );
        }

        await params.replyMessageLine(params.replyToken, replyMessages, {
          cfg: params.cfg,
          accountId: params.accountId,
        });
        replyTokenUsed = true;
        replySent = true;
        deliveredAny = true;
      } catch (err) {
        params.onReplyError?.(err);
        replyTokenUsed = true;
      }

      // Once the reply has delivered the first batch, only the remaining chunks may be
      // pushed. A failure here must not fall through to the push-all fallback below,
      // which would re-send the chunks the reply already delivered (duplicates).
      if (replySent) {
        for (const [i, chunk] of remaining.entries()) {
          await pushChunk(chunk, i === remaining.length - 1);
        }
        return { replyTokenUsed };
      }
    }

    for (const [i, chunk] of params.chunks.entries()) {
      await pushChunk(chunk, i === params.chunks.length - 1);
    }
    return { replyTokenUsed };
  } catch (err) {
    if (deliveredAny) {
      throw markLineVisibleDeliveryError(err);
    }
    throw err;
  }
}
