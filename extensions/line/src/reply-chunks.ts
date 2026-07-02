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

      for (let i = 0; i < remaining.length; i += 5) {
        const batch = remaining.slice(i, Math.min(i + 5, remaining.length));
        const isLastBatch = i + batch.length >= remaining.length;

        if (isLastBatch && hasQuickReplies) {
          const nonLast = batch.slice(0, -1);
          if (nonLast.length > 0) {
            await params.pushMessagesLine(
              params.to,
              nonLast.map((c) => ({ type: "text", text: c }) as messagingApi.Message),
              { cfg: params.cfg, accountId: params.accountId },
            );
          }
          await params.pushTextMessageWithQuickReplies(
            params.to,
            batch[batch.length - 1],
            params.quickReplies!,
            { cfg: params.cfg, accountId: params.accountId },
          );
        } else {
          await params.pushMessagesLine(
            params.to,
            batch.map((c) => ({ type: "text", text: c }) as messagingApi.Message),
            { cfg: params.cfg, accountId: params.accountId },
          );
        }
      }

      return { replyTokenUsed };
    } catch (err) {
      params.onReplyError?.(err);
      replyTokenUsed = true;
    }
  }

  for (let i = 0; i < params.chunks.length; i += 5) {
    const batch = params.chunks.slice(i, Math.min(i + 5, params.chunks.length));
    const isLastBatch = i + batch.length >= params.chunks.length;

    if (isLastBatch && hasQuickReplies) {
      const nonLast = batch.slice(0, -1);
      if (nonLast.length > 0) {
        await params.pushMessagesLine(
          params.to,
          nonLast.map((c) => ({ type: "text", text: c }) as messagingApi.Message),
          { cfg: params.cfg, accountId: params.accountId },
        );
      }
      await params.pushTextMessageWithQuickReplies(
        params.to,
        batch[batch.length - 1],
        params.quickReplies!,
        { cfg: params.cfg, accountId: params.accountId },
      );
    } else {
      await params.pushMessagesLine(
        params.to,
        batch.map((c) => ({ type: "text", text: c }) as messagingApi.Message),
        { cfg: params.cfg, accountId: params.accountId },
      );
    }
  }

  return { replyTokenUsed };
}
