import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveWeComAccount } from "./accounts.js";
import { getWeComRuntime } from "./runtime.js";
import { sendMessageWeCom, sendGroupMessageWeCom } from "./send.js";

export type CreateWeComReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  userId?: string;
  chatId?: string;
  isGroupChat: boolean;
  accountId?: string;
};

export function createWeComReplyDispatcher(params: CreateWeComReplyDispatcherParams) {
  const core = getWeComRuntime();
  const { cfg, agentId, userId, chatId, isGroupChat, accountId } = params;
  const account = resolveWeComAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "wecom", accountId, {
    fallbackLimit: 2000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "wecom");

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }

        for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
          if (isGroupChat && chatId) {
            await sendGroupMessageWeCom({
              cfg,
              chatId,
              text: chunk,
              accountId,
            });
          } else if (userId) {
            await sendMessageWeCom({
              cfg,
              to: userId,
              text: chunk,
              accountId,
            });
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `wecom[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
      },
      onIdle: async () => {},
      onCleanup: () => {},
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
