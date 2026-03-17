import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  resolveChannelMediaMaxBytes
} from "openclaw/plugin-sdk/msteams";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError
} from "./errors.js";
import {
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages
} from "./messenger.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
function createMSTeamsReplyDispatcher(params) {
  const core = getMSTeamsRuntime();
  const sendTypingIndicator = async () => {
    await withRevokedProxyFallback({
      run: async () => {
        await params.context.sendActivity({ type: "typing" });
      },
      onRevoked: async () => {
        const baseRef = buildConversationReference(params.conversationRef);
        await params.adapter.continueConversation(
          params.appId,
          { ...baseRef, activityId: void 0 },
          async (ctx) => {
            await ctx.sendActivity({ type: "typing" });
          }
        );
      },
      onRevokedLog: () => {
        params.log.debug?.("turn context revoked, sending typing via proactive messaging");
      }
    });
  };
  const typingCallbacks = createTypingCallbacks({
    start: sendTypingIndicator,
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.log.debug?.(message),
        channel: "msteams",
        action: "start",
        error: err
      });
    }
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId
  });
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
    typingCallbacks,
    deliver: async (payload) => {
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: params.cfg,
        channel: "msteams"
      });
      const messages = renderReplyPayloadsToMessages([payload], {
        textChunkLimit: params.textLimit,
        chunkText: true,
        mediaMode: "split",
        tableMode,
        chunkMode
      });
      const mediaMaxBytes = resolveChannelMediaMaxBytes({
        cfg: params.cfg,
        resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb
      });
      const ids = await sendMSTeamsMessages({
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
            ...event
          });
        },
        tokenProvider: params.tokenProvider,
        sharePointSiteId: params.sharePointSiteId,
        mediaMaxBytes
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
        `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`
      );
      params.log.error("reply failed", {
        kind: info.kind,
        error: errMsg,
        classification,
        hint
      });
    }
  });
  return {
    dispatcher,
    replyOptions: { ...replyOptions, onModelSelected },
    markDispatchIdle
  };
}
export {
  createMSTeamsReplyDispatcher
};
