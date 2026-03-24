import {
  createChannelReplyPipeline,
  logTypingFailure,
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
  type MSTeamsReplyStyle,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  buildConversationReference,
  type MSTeamsAdapter,
  type MSTeamsRenderedMessage,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export function createMSTeamsReplyDispatcher(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: MSTeamsMonitorLogger;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context: MSTeamsTurnContext;
  replyStyle: MSTeamsReplyStyle;
  textLimit: number;
  onSentMessageIds?: (ids: string[]) => void;
  /** Token provider for OneDrive/SharePoint uploads in group chats/channels */
  tokenProvider?: MSTeamsAccessTokenProvider;
  /** SharePoint site ID for file uploads in group chats/channels */
  sharePointSiteId?: string;
}) {
  const core = getMSTeamsRuntime();

  /**
   * Send a typing indicator.
   *
   * First tries the live turn context (cheapest path).  When the context has
   * been revoked (debounced messages) we fall back to proactive messaging via
   * the stored conversation reference so the user still sees the "…" bubble.
   */
  const sendTypingIndicator = async () => {
    await withRevokedProxyFallback({
      run: async () => {
        await params.context.sendActivity({ type: "typing" });
      },
      onRevoked: async () => {
        const baseRef = buildConversationReference(params.conversationRef);
        await params.adapter.continueConversation(
          params.appId,
          { ...baseRef, activityId: undefined },
          async (ctx) => {
            await ctx.sendActivity({ type: "typing" });
          },
        );
      },
      onRevokedLog: () => {
        params.log.debug?.("turn context revoked, sending typing via proactive messaging");
      },
    });
  };

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    typing: {
      start: sendTypingIndicator,
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => params.log.debug?.(message),
          channel: "msteams",
          action: "start",
          error: err,
        });
      },
    },
  });
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "msteams",
  });
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb,
  });

  // Accumulate rendered messages from all deliver() calls so the entire turn's
  // reply is sent in a single sendMSTeamsMessages() call. This avoids Teams
  // silently dropping blocks 2+ when each deliver() opened its own independent
  // continueConversation() call — only the first proactive send per turn context
  // window succeeds. (#29379)
  const pendingMessages: MSTeamsRenderedMessage[] = [];

  const sendMessages = async (messages: MSTeamsRenderedMessage[]): Promise<string[]> => {
    return sendMSTeamsMessages({
      replyStyle: params.replyStyle,
      adapter: params.adapter,
      appId: params.appId,
      conversationRef: params.conversationRef,
      context: params.context,
      messages,
      // Enable default retry/backoff for throttling/transient failures.
      retry: {},
      onRetry: (event) => {
        params.log.debug?.("retrying send", {
          replyStyle: params.replyStyle,
          ...event,
        });
      },
      tokenProvider: params.tokenProvider,
      sharePointSiteId: params.sharePointSiteId,
      mediaMaxBytes,
    });
  };

  const flushPendingMessages = async () => {
    if (pendingMessages.length === 0) {
      return;
    }
    // Copy the buffer before draining so we have a reference for per-message
    // retry if the batch send fails.
    const toSend = pendingMessages.splice(0);
    const total = toSend.length;
    let ids: string[];
    try {
      ids = await sendMessages(toSend);
    } catch {
      // Batch send failed (e.g. bad attachment on one message); retry each
      // message individually so trailing blocks are not silently lost.
      ids = [];
      let failed = 0;
      for (const msg of toSend) {
        try {
          const msgIds = await sendMessages([msg]);
          ids.push(...msgIds);
        } catch {
          failed += 1;
          params.log.debug?.("individual message send failed, continuing with remaining blocks");
        }
      }
      if (failed > 0) {
        params.log.warn?.(`failed to deliver ${failed} of ${total} message blocks`, {
          failed,
          total,
        });
      }
    }
    if (ids.length > 0) {
      params.onSentMessageIds?.(ids);
    }
  };

  const {
    dispatcher,
    replyOptions,
    markDispatchIdle: baseMarkDispatchIdle,
  } = core.channel.reply.createReplyDispatcherWithTyping({
    ...replyPipeline,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
    typingCallbacks,
    deliver: async (payload) => {
      // Render the payload to messages and accumulate them. All messages from
      // this turn are flushed together in markDispatchIdle() so they go out
      // in a single continueConversation() call.
      const messages = renderReplyPayloadsToMessages([payload], {
        textChunkLimit: params.textLimit,
        chunkText: true,
        mediaMode: "split",
        tableMode,
        chunkMode,
      });
      pendingMessages.push(...messages);
    },
    onError: (err, info) => {
      const errMsg = formatUnknownError(err);
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      params.runtime.error?.(
        `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`,
      );
      params.log.error("reply failed", {
        kind: info.kind,
        error: errMsg,
        classification,
        hint,
      });
    },
  });

  // Wrap markDispatchIdle to flush all accumulated messages before signalling idle.
  // Returns a promise so callers (e.g. onSettled) can await completion.
  const markDispatchIdle = (): Promise<void> => {
    return flushPendingMessages()
      .catch((err) => {
        const errMsg = formatUnknownError(err);
        const classification = classifyMSTeamsSendError(err);
        const hint = formatMSTeamsSendErrorHint(classification);
        params.runtime.error?.(`msteams flush reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
        params.log.error("flush reply failed", {
          error: errMsg,
          classification,
          hint,
        });
      })
      .finally(() => {
        baseMarkDispatchIdle();
      });
  };

  return {
    dispatcher,
    replyOptions: { ...replyOptions, onModelSelected },
    markDispatchIdle,
  };
}
