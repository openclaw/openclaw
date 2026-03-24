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
import { TeamsHttpStream } from "./streaming-message.js";

const INFORMATIVE_STATUS_TEXTS = [
  "Thinking...",
  "Working on that...",
  "Checking the details...",
  "Putting an answer together...",
];

export function pickInformativeStatusText(random = Math.random): string {
  const index = Math.floor(random() * INFORMATIVE_STATUS_TEXTS.length);
  return INFORMATIVE_STATUS_TEXTS[index] ?? INFORMATIVE_STATUS_TEXTS[0]!;
}

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

  // Determine conversation type to decide typing vs streaming behavior:
  // - personal (1:1): typing bubble + streaming (typing shows immediately,
  //   streaming takes over once tokens arrive)
  // - groupChat: typing bubble only, no streaming
  // - channel: neither (Teams doesn't support typing or streaming in channels)
  const conversationType = params.conversationRef.conversation?.conversationType?.toLowerCase();
  const isPersonal = conversationType === "personal";
  const isGroupChat = conversationType === "groupchat";
  const isChannel = conversationType === "channel";

  /**
   * Send a typing indicator.
   * Sent for personal and group chats so users see immediate feedback.
   * Channels don't support typing indicators.
   */
  const sendTypingIndicator =
    isPersonal || isGroupChat
      ? async () => {
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
        }
      : async () => {
          // No-op for channels (not supported)
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
  const feedbackLoopEnabled = params.cfg.channels?.msteams?.feedbackEnabled !== false;

  // Streaming for personal (1:1) chats using the Teams streaminfo protocol.
  let stream: TeamsHttpStream | undefined;
  // Track whether onPartialReply was ever called — if so, the stream
  // owns the text delivery and deliver should skip text payloads.
  let streamReceivedTokens = false;
  let informativeUpdateSent = false;

  if (isPersonal) {
    stream = new TeamsHttpStream({
      sendActivity: (activity) => params.context.sendActivity(activity),
      feedbackLoopEnabled,
      onError: (err) => {
        params.log.debug?.(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  }

  // Accumulate rendered messages from all deliver() calls so the entire turn's
  // reply is sent in a single sendMSTeamsMessages() call. (#29379)
  const pendingMessages: MSTeamsRenderedMessage[] = [];

  const sendMessages = async (messages: MSTeamsRenderedMessage[]): Promise<string[]> => {
    return sendMSTeamsMessages({
      replyStyle: params.replyStyle,
      adapter: params.adapter,
      appId: params.appId,
      conversationRef: params.conversationRef,
      context: params.context,
      messages,
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
      feedbackLoopEnabled,
    });
  };

  const flushPendingMessages = async () => {
    if (pendingMessages.length === 0) {
      return;
    }
    const toSend = pendingMessages.splice(0);
    const total = toSend.length;
    let ids: string[];
    try {
      ids = await sendMessages(toSend);
    } catch {
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
    onReplyStart: async () => {
      if (stream && !informativeUpdateSent) {
        informativeUpdateSent = true;
        await stream.sendInformativeUpdate(pickInformativeStatusText());
      }
      await typingCallbacks?.onReplyStart?.();
    },
    typingCallbacks,
    deliver: async (payload) => {
      // When streaming received tokens AND hasn't failed, skip text delivery —
      // finalize() handles the final message. If streaming failed (>4000 chars),
      // fall through so deliver sends the complete response.
      // For payloads with media, strip the text and send media only.
      if (stream && streamReceivedTokens && stream.hasContent) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        if (!hasMedia) {
          return;
        }
        payload = { ...payload, text: undefined };
      }

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

  // Wrap markDispatchIdle to flush accumulated messages and finalize stream.
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
      .then(() => {
        if (stream) {
          return stream.finalize().catch((err) => {
            params.log.debug?.("stream finalize failed", { error: String(err) });
          });
        }
      })
      .finally(() => {
        baseMarkDispatchIdle();
      });
  };

  // Build reply options with onPartialReply for streaming.
  const streamingReplyOptions = stream
    ? {
        onPartialReply: (payload: { text?: string }) => {
          if (payload.text) {
            streamReceivedTokens = true;
            stream!.update(payload.text);
          }
        },
      }
    : {};

  return {
    dispatcher,
    replyOptions: { ...replyOptions, ...streamingReplyOptions, onModelSelected },
    markDispatchIdle,
  };
}
