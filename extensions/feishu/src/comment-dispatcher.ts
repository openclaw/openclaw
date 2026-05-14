import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { CommentFileType } from "./comment-target.js";
import { replyComment } from "./drive.js";
import { getFeishuRuntime } from "./runtime.js";

export type CreateFeishuCommentReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  accountId?: string;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
};

export function createFeishuCommentReplyDispatcher(
  params: CreateFeishuCommentReplyDispatcherParams,
) {
  const core = getFeishuRuntime();
  const prefixContext = createReplyPrefixContext({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
  });
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    "feishu",
    params.accountId,
    {
      fallbackLimit: 4000,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "feishu");

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
      deliver: async (payload: ReplyPayload, info) => {
        if (info.kind !== "final") {
          return;
        }
        const reply = resolveSendableOutboundReplyParts(payload);
        if (!reply.hasText) {
          if (reply.hasMedia) {
            params.runtime.log?.(
              `feishu[${params.accountId ?? "default"}]: comment reply ignored media-only payload for comment=${params.commentId}`,
            );
          }
          return;
        }
        const chunks = core.channel.text.chunkTextWithMode(reply.text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await replyComment(client, {
            file_token: params.fileToken,
            file_type: params.fileType,
            comment_id: params.commentId,
            content: chunk,
          });
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${params.accountId ?? "default"}]: comment dispatcher failed kind=${info.kind} comment=${params.commentId}: ${String(err)}`,
        );
      },
    });

  return { dispatcher, replyOptions, markDispatchIdle };
}
