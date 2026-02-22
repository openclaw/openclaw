import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  resolveChannelMediaMaxBytes,
  type OpenClawConfig,
  type MSTeamsReplyStyle,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
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
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

/**
 * Drain any pending adaptive cards from the global queue.
 * Plugins share state via globalThis within the same Node.js process,
 * allowing any plugin to enqueue cards for delivery through Teams.
 */
type PendingCardEntry = {
  cards: Array<{ contentType: string; content: unknown; name?: string }>;
  conversationId: string;
  text?: string;
  timestamp: number;
};

function drainPendingAdaptiveCards(): PendingCardEntry[] {
  const GLOBAL_KEY = "__openclaw_pending_adaptive_cards";
  const g = globalThis as unknown as Record<string, PendingCardEntry[] | undefined>;
  const store = g[GLOBAL_KEY];
  if (!store || store.length === 0) return [];
  const entries = store.splice(0, store.length);
  return entries;
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
  const typingRef = buildConversationReference(params.conversationRef);
  const sendTypingIndicator = async () => {
    await params.adapter.continueConversation(params.appId, typingRef, async (ctx) => {
      await ctx.sendActivity({ type: "typing" });
    });
  };
  const typingCallbacks = createTypingCallbacks({
    start: sendTypingIndicator,
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.log.debug?.(message),
        channel: "msteams",
        action: "start",
        error: err,
      });
    },
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
  });
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
      deliver: async (payload) => {
        // Send any pending adaptive cards as native Teams attachments.
        // These are enqueued by plugins (e.g. consent prompts, interactive forms).
        // Use proactive messaging to avoid depending on the short-lived webhook
        // TurnContext which Bot Framework revokes after the HTTP request completes.
        const pendingCards = drainPendingAdaptiveCards();
        if (pendingCards.length > 0) {
          const cardRef = buildConversationReference(params.conversationRef);
          for (const entry of pendingCards) {
            const attachments = entry.cards.map((card) => ({
              contentType: card.contentType,
              content: card.content,
              ...(card.name ? { name: card.name } : {}),
            }));
            try {
              await params.adapter.continueConversation(params.appId, cardRef, async (ctx) => {
                await ctx.sendActivity({
                  type: "message",
                  attachments,
                  ...(entry.text ? { text: entry.text } : {}),
                });
              });
              params.log.info("sent adaptive card(s)", {
                count: attachments.length,
                conversationId: entry.conversationId,
              });
            } catch (err) {
              params.log.error("failed to send adaptive card", {
                error: formatUnknownError(err),
                conversationId: entry.conversationId,
              });
            }
          }
        }

        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg: params.cfg,
          channel: "msteams",
        });
        const messages = renderReplyPayloadsToMessages([payload], {
          textChunkLimit: params.textLimit,
          chunkText: true,
          mediaMode: "split",
          tableMode,
          chunkMode,
        });
        const mediaMaxBytes = resolveChannelMediaMaxBytes({
          cfg: params.cfg,
          resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb,
        });
        const ids = await sendMSTeamsMessages({
          replyStyle: params.replyStyle,
          adapter: params.adapter,
          appId: params.appId,
          conversationRef: params.conversationRef,
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
        if (ids.length > 0) {
          params.onSentMessageIds?.(ids);
        }
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
      onReplyStart: typingCallbacks.onReplyStart,
    });

  return {
    dispatcher,
    replyOptions: { ...replyOptions, onModelSelected },
    markDispatchIdle,
  };
}
