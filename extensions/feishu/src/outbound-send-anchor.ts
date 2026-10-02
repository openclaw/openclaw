import type { ChannelOutboundAdapter, ClawdbotConfig } from "../runtime-api.js";
import { withFeishuSendContext } from "./send-context.js";
import { resolveFeishuReplyAnchorMessageId } from "./send.js";

/**
 * A channel target identifies a conversation by its topic (`omt_…`), but a Feishu reply addresses
 * a message. Sends resolve that topic once per target so every part — text, media, payload and
 * fanout — replies inside the topic instead of starting a new top-level topic. Targets that
 * already name a message pass through without a lookup.
 */
async function resolveReplyAnchorThreadId(ctx: {
  cfg: ClawdbotConfig;
  threadId?: string | number | null;
  accountId?: string | null;
}): Promise<string | null | undefined> {
  return await resolveFeishuReplyAnchorMessageId({
    cfg: ctx.cfg,
    threadId: typeof ctx.threadId === "number" ? String(ctx.threadId) : ctx.threadId,
    accountId: ctx.accountId ?? undefined,
  });
}

/**
 * Wraps an outbound adapter so each send resolves its topic target to a reply anchor before
 * running inside the Feishu send context.
 */
export function withFeishuOutboundSendAnchor(
  adapter: ChannelOutboundAdapter,
): ChannelOutboundAdapter {
  const { sendText, sendMedia, sendPayload } = adapter;
  return {
    ...adapter,
    ...(sendText
      ? {
          sendText: async (ctx) => {
            const threadId = await resolveReplyAnchorThreadId(ctx);
            const anchored = threadId === ctx.threadId ? ctx : { ...ctx, threadId };
            return await withFeishuSendContext(anchored, () => sendText(anchored));
          },
        }
      : {}),
    ...(sendMedia
      ? {
          sendMedia: async (ctx) => {
            const threadId = await resolveReplyAnchorThreadId(ctx);
            const anchored = threadId === ctx.threadId ? ctx : { ...ctx, threadId };
            return await withFeishuSendContext(anchored, () => sendMedia(anchored));
          },
        }
      : {}),
    ...(sendPayload
      ? {
          sendPayload: async (ctx) => {
            const threadId = await resolveReplyAnchorThreadId(ctx);
            const anchored = threadId === ctx.threadId ? ctx : { ...ctx, threadId };
            return await withFeishuSendContext(anchored, () => sendPayload(anchored));
          },
        }
      : {}),
  };
}
