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

/** Informative status messages shown while the LLM is processing. */
const THINKING_MESSAGES = [
  "Scuttling through ideas...",
  "Clawing through the details...",
  "Diving deep...",
  "Snapping neurons together...",
  "Mulling it over in my shell...",
  "Surfacing an answer...",
  "Pinching together some thoughts...",
  "Crawling through possibilities...",
];

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
  // - personal (1:1): streaming only, no typing bubble (streaming uses its own typing activities)
  // - groupChat: typing bubble only, no streaming
  // - channel: neither (Teams doesn't support typing or streaming in channels)
  const conversationType = params.conversationRef.conversation?.conversationType?.toLowerCase();
  const isPersonal = conversationType === "personal";
  const isGroupChat = conversationType === "groupchat";

  /**
   * Send a typing indicator.
   * Only sends the visible "..." bubble for group chats.
   * Personal chats use streaming instead; channels don't support typing.
   */
  const sendTypingIndicator = isGroupChat
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
        // No-op for personal (streaming handles UX) and channels (not supported)
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
  if (isPersonal) {
    stream = new TeamsHttpStream({
      sendActivity: (activity) => params.context.sendActivity(activity),
      feedbackLoopEnabled,
      onError: (err) => {
        params.log.debug?.(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    // Send an informative update immediately so the user sees a progress bar
    // while the LLM is processing (before any tokens arrive).
    const msg =
      THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)] ?? "Thinking...";
    stream.sendInformativeUpdate(msg).catch(() => {
      // Best effort — don't block the reply pipeline
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
    typingCallbacks,
    deliver: async (payload) => {
      // When streaming is active and has sent content, skip delivery —
      // the stream's finalize() handles the final message.
      if (stream?.hasContent && !payload.mediaUrl && !payload.mediaUrls?.length) {
        return;
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

  // Build reply options with onPartialReply for streaming
  const streamingReplyOptions = stream
    ? {
        onPartialReply: (payload: { text?: string }) => {
          if (payload.text) {
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
