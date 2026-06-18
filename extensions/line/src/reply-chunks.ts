// Line plugin module implements reply chunks behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

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
  pushMessagesLine: (
    to: string,
    messages: messagingApi.Message[],
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
  const hasQuickReplies = Boolean(params.quickReplies?.length);
  let replyTokenUsed = Boolean(params.replyTokenUsed);

  if (params.chunks.length === 0) {
    return { replyTokenUsed };
  }

  // Push remaining chunks in batches of 5 to reduce LINE API calls.
  // The last chunk is special-cased when quick replies are present.
  // openclaw/openclaw#86012
  async function pushRemainingChunks(chunks: string[]): Promise<void> {
    if (chunks.length === 0) return;
    const needsQuickReplyLast = hasQuickReplies;

    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5);
      const isLastBatch = i + batch.length >= chunks.length;

      if (isLastBatch && needsQuickReplyLast) {
        // Last chunk carries quick replies; send earlier chunks batched
        const plainChunks = batch.slice(0, -1);
        const lastChunk = batch[batch.length - 1];

        if (plainChunks.length > 0) {
          await params.pushMessagesLine(
            params.to,
            plainChunks.map((c) => ({ type: "text" as const, text: c })),
            { cfg: params.cfg, accountId: params.accountId },
          );
        }
        await params.pushTextMessageWithQuickReplies(params.to, lastChunk, params.quickReplies!, {
          cfg: params.cfg,
          accountId: params.accountId,
        });
      } else {
        await params.pushMessagesLine(
          params.to,
          batch.map((c) => ({ type: "text" as const, text: c })),
          { cfg: params.cfg, accountId: params.accountId },
        );
      }
    }
  }

  if (params.replyToken && !replyTokenUsed) {
    try {
      const replyBatch = params.chunks.slice(0, 5);
      const remaining = params.chunks.slice(replyBatch.length);

      const replyMessages: LineReplyMessage[] = replyBatch.map((chunk) => ({
        type: "text",
        text: chunk,
      }));

      if (hasQuickReplies && remaining.length === 0 && replyMessages.length > 0) {
        const lastIndex = replyMessages.length - 1;
        replyMessages[lastIndex] = params.createTextMessageWithQuickReplies(
          replyBatch[lastIndex],
          params.quickReplies!,
        );
      }

      await params.replyMessageLine(params.replyToken, replyMessages, {
        cfg: params.cfg,
        accountId: params.accountId,
      });
      replyTokenUsed = true;

      await pushRemainingChunks(remaining);
      return { replyTokenUsed };
    } catch (err) {
      params.onReplyError?.(err);
      replyTokenUsed = true;
    }
  }

  await pushRemainingChunks(params.chunks);
  return { replyTokenUsed };
}
