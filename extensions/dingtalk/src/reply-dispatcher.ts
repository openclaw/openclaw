import {
  createReplyPrefixContext,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkAccount } from "./accounts.js";
import { getDingtalkRuntime } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";

export type CreateDingtalkReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  conversationId: string;
  sessionWebhook?: string;
  accountId?: string;
};

export function createDingtalkReplyDispatcher(params: CreateDingtalkReplyDispatcherParams) {
  const core = getDingtalkRuntime();
  const { cfg, agentId, conversationId, sessionWebhook, accountId } = params;

  const account = resolveDingtalkAccount({ cfg, accountId });

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Add null checks for core.channel methods with fallback defaults
  const textChunkLimit =
    core.channel?.text?.resolveTextChunkLimit?.({
      cfg,
      channel: "dingtalk",
      defaultLimit: 4000,
    }) ?? 4000;
  const chunkMode = core.channel?.text?.resolveChunkMode?.(cfg, "dingtalk") ?? "simple";
  const tableMode =
    core.channel?.text?.resolveMarkdownTableMode?.({ cfg, channel: "dingtalk" }) ?? "simple";

  const replyModule = core.channel?.reply;
  if (!replyModule) {
    throw new Error("DingTalk channel reply module is not available");
  }
  const createReplyDispatcherWithTyping = replyModule.createReplyDispatcherWithTyping;
  if (!createReplyDispatcherWithTyping) {
    throw new Error(
      "DingTalk channel reply module does not support createReplyDispatcherWithTyping",
    );
  }

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: replyModule.resolveHumanDelayConfig?.(cfg, agentId),
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) {
        params.runtime.log?.(`dingtalk[${account.accountId}] deliver: empty text, skipping`);
        return;
      }

      const convertTables = core.channel?.text?.convertMarkdownTables;
      const chunkText = core.channel?.text?.chunkTextWithMode;

      const converted = convertTables ? convertTables(text, tableMode) : text;
      const chunks = chunkText ? chunkText(converted, textChunkLimit, chunkMode) : [converted];

      params.runtime.log?.(
        `dingtalk[${account.accountId}] deliver: sending ${chunks.length} chunks`,
      );

      for (const chunk of chunks) {
        const dingtalkCfg = account.config ?? (cfg.channels?.dingtalk as Record<string, unknown>);
        await sendMessageDingtalk({
          cfg: dingtalkCfg as import("./types.js").DingtalkConfig,
          to: conversationId,
          text: chunk,
          chatType: sessionWebhook ? "direct" : "group",
        });
      }
    },
    onError: (err: unknown, info: { kind: string }) => {
      params.runtime.error?.(
        `dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
      );
    },
  });

  // replyOptions is typed as unknown because createReplyDispatcherWithTyping is accessed
  // dynamically from replyModule; cast to the expected shape to access its fields.
  const typedReplyOptions = replyOptions as {
    onReplyStart?: (...args: unknown[]) => unknown;
    onTypingController?: (...args: unknown[]) => unknown;
    onTypingCleanup?: (...args: unknown[]) => unknown;
  };

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: typedReplyOptions.onReplyStart,
      onTypingController: typedReplyOptions.onTypingController,
      onTypingCleanup: typedReplyOptions.onTypingCleanup,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
