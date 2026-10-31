import { resolveAllowlistMatchSimple } from "openclaw/plugin-sdk/allow-from";
import { resolveInboundSupplementalSenderAllowed } from "openclaw/plugin-sdk/channel-inbound";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/context-visibility-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { formatUnknownError } from "../errors.js";
import {
  buildThreadContext,
  fetchChatMessageText,
  fetchThreadReplies,
  type GraphThreadMessage,
} from "../graph-thread.js";
import type { extractMSTeamsQuoteInfo } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import {
  createMSTeamsInboundEnrichmentDeadline,
  type MSTeamsRequestDeadline,
  withMSTeamsRequestDeadline,
} from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import {
  fetchParentMessageCached,
  formatParentContextEvent,
  markParentContextInjected,
  shouldInjectParentContext,
} from "../thread-parent-context.js";

export async function resolveMSTeamsThreadContext(params: {
  route: ResolvedAgentRoute;
  threadRootId?: string;
  resolveTeamAadGroupId: (deadline: MSTeamsRequestDeadline) => Promise<string | undefined>;
  context: MSTeamsTurnContext;
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  quoteInfo: ReturnType<typeof extractMSTeamsQuoteInfo>;
  isDirectMessage: boolean;
  isChannel: boolean;
  conversationId: string;
  contextVisibilityMode: "all" | "allowlist" | "allowlist_quote";
  groupPolicy: Parameters<typeof resolveInboundSupplementalSenderAllowed>[0]["groupPolicy"];
  effectiveGroupAllowFrom: readonly (string | number)[];
  allowNameMatching: boolean;
  log: MSTeamsMessageHandlerDeps["log"];
}) {
  const core = getMSTeamsRuntime();
  const activity = params.context.activity;
  const { route } = params;
  // Start the enrichment budget after media resolution so slow attachment
  // transfers do not starve quote and thread lookups.
  const deadline = createMSTeamsInboundEnrichmentDeadline();
  const teamAadGroupId = await params.resolveTeamAadGroupId(deadline);
  let quoteBodyFull: string | undefined;
  let quoteSenderId: string | undefined;
  let quoteSenderName: string | undefined;
  const quoteMessageId = params.quoteInfo?.id;
  if (quoteMessageId && params.isDirectMessage && params.conversationId.startsWith("19:")) {
    try {
      const graphToken = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams quote token",
        work: () => params.tokenProvider.getAccessToken("https://graph.microsoft.com"),
      });
      quoteBodyFull = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams quote lookup",
        work: () =>
          fetchChatMessageText(graphToken, params.conversationId, quoteMessageId, deadline),
      });
    } catch (err) {
      params.log.debug?.("failed to fetch full quoted message text", {
        error: formatUnknownError(err),
      });
    }
  }

  let threadContext: ReturnType<typeof buildThreadContext> = [];
  // Use the same root as session routing; Teams can omit replyToId on replies.
  const threadParentId = params.threadRootId;
  if (threadParentId && threadParentId !== activity.id && params.isChannel && teamAadGroupId) {
    try {
      const graphToken = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams thread token",
        work: () => params.tokenProvider.getAccessToken("https://graph.microsoft.com"),
      });
      // Keep successful parent context when the replies endpoint fails, and vice versa.
      const [parentResult, repliesResult] = await withMSTeamsRequestDeadline({
        deadline,
        label: "MS Teams thread history",
        work: () =>
          Promise.allSettled([
            fetchParentMessageCached(
              graphToken,
              teamAadGroupId,
              params.conversationId,
              threadParentId,
              deadline,
            ),
            fetchThreadReplies(
              graphToken,
              teamAadGroupId,
              params.conversationId,
              threadParentId,
              deadline,
            ),
          ]),
      });
      const parentMsg = parentResult.status === "fulfilled" ? parentResult.value : undefined;
      const replies = repliesResult.status === "fulfilled" ? repliesResult.value : [];
      if (parentResult.status === "rejected") {
        params.log.debug?.("failed to fetch parent message", {
          error: formatUnknownError(parentResult.reason),
        });
      }
      if (repliesResult.status === "rejected") {
        params.log.debug?.("failed to fetch thread replies", {
          error: formatUnknownError(repliesResult.reason),
        });
      }
      const isThreadSenderAllowed = (message: GraphThreadMessage) =>
        resolveInboundSupplementalSenderAllowed({
          isGroup: params.isChannel,
          groupPolicy: params.groupPolicy,
          allowFrom: params.effectiveGroupAllowFrom,
          isSenderAllowed: (allowFrom) =>
            resolveAllowlistMatchSimple({
              allowFrom,
              senderId: message.from?.user?.id ?? "",
              senderName: message.from?.user?.displayName,
              allowNameMatching: params.allowNameMatching,
            }).allowed,
        });
      const parentContextEvent = formatParentContextEvent(parentMsg);
      const { items: threadMessages } = filterSupplementalContextItems({
        items: parentMsg ? [parentMsg, ...replies] : replies,
        mode: params.contextVisibilityMode,
        kind: "thread",
        isSenderAllowed: isThreadSenderAllowed,
      });
      if (
        parentContextEvent &&
        parentMsg &&
        threadMessages.includes(parentMsg) &&
        shouldInjectParentContext(route.sessionKey, threadParentId)
      ) {
        core.system.enqueueSystemEvent(parentContextEvent, {
          sessionKey: route.sessionKey,
          contextKey: `msteams:thread-parent:${params.conversationId}:${threadParentId}`,
        });
        markParentContextInjected(route.sessionKey, threadParentId);
      }
      quoteSenderId = parentMsg?.from?.user?.id ?? parentMsg?.from?.application?.id;
      quoteSenderName =
        parentMsg?.from?.user?.displayName ??
        parentMsg?.from?.application?.displayName ??
        params.quoteInfo?.sender;
      threadContext = buildThreadContext(threadMessages, activity.id);
    } catch (err) {
      params.log.debug?.("failed to fetch thread history", {
        error: formatUnknownError(err),
      });
    }
  }
  quoteSenderName ??= params.quoteInfo?.sender;

  return {
    teamAadGroupId,
    quoteBodyFull,
    quoteSenderId,
    quoteSenderName,
    threadContext,
  };
}
