import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ContextVisibilityMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import {
  readSessionUpdatedAt,
  resolveChannelResetConfig,
} from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackUserAllowed } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackMediaResult } from "../media-types.js";
import { resolveSlackThreadHistory, type SlackThreadStarter } from "../thread.js";
import { formatSlackUnavailableMedia } from "./prepare-content.js";
import { isSlackThreadAuthorCurrentBot } from "./prepare-thread-context-root.js";
import { resolveSlackTimestampMs } from "./timestamp.js";

const loadSlackMediaModule = createLazyRuntimeModule(() => import("../media.js"));

type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  shouldSeedInitialThreadContext: boolean;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

const SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY = 4;

function formatSlackThreadLabelSnippet(text: string): string {
  return truncateUtf16Safe(text.replace(/\s+/g, " "), 80);
}

type SlackSessionResetFreshness =
  | {
      state: "missing";
      entry: undefined;
    }
  | {
      state: "fresh" | "stale";
      entry: {
        lastInteractionAt?: number;
        updatedAt?: number;
      };
    };

type SlackSessionFreshnessRuntime = {
  session?: {
    resolveEntryResetFreshness?: (params: {
      agentId: string;
      storePath?: string;
      sessionKey: string;
      sessionCfg?: OpenClawConfig["session"];
      resetType: "thread";
      resetOverride?: ReturnType<typeof resolveChannelResetConfig>;
    }) => SlackSessionResetFreshness;
  };
};

function resolveSlackThreadSessionFreshness(params: {
  ctx: SlackMonitorContext;
  agentId: string;
  storePath: string;
  sessionKey: string;
}): SlackSessionResetFreshness | undefined {
  // Gateway startup supplies the full channel runtime, but the public surface
  // intentionally keeps non-context helpers untyped for external plugins.
  const runtime = params.ctx.channelRuntime as SlackSessionFreshnessRuntime | undefined;
  return runtime?.session?.resolveEntryResetFreshness?.({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    sessionCfg: params.ctx.cfg.session,
    resetType: "thread",
    resetOverride: resolveChannelResetConfig({
      sessionCfg: params.ctx.cfg.session,
      channel: "slack",
    }),
  });
}

async function resolveSlackThreadUserMap(params: {
  ctx: SlackMonitorContext;
  messages: SlackThreadStarter[];
  eventScope?: SlackEventScope;
}): Promise<Map<string, { name?: string }>> {
  const uniqueUserIds = [
    ...new Set(
      params.messages.map((item) => item.userId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const { results } = await runTasksWithConcurrency({
    tasks: uniqueUserIds.map((id) => async () => {
      const user = await params.ctx.resolveUserName(id, params.eventScope);
      return user ? ([id, user] as const) : null;
    }),
    limit: SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY,
  });
  return new Map(results.flatMap((result) => (result ? [result] : [])));
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  agentId: string;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isGroupDm: boolean;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  forceInitialHistory?: boolean;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
  eventScope?: SlackEventScope;
  historyLimit?: number;
  excludedMessageIds?: ReadonlySet<string>;
  assertHistoryCurrent?: () => void;
  abortSignal?: AbortSignal;
}): Promise<SlackThreadContextData> {
  const botIdentity = {
    botUserId: params.ctx.botUserId,
    botId: params.ctx.botId,
  };
  const isCurrentBotAuthor = (author: { userId?: string; botId?: string }): boolean =>
    isSlackThreadAuthorCurrentBot({ identity: botIdentity, author });

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;
  const threadSessionFreshness =
    params.isThreadReply && params.threadTs
      ? resolveSlackThreadSessionFreshness({
          ctx: params.ctx,
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const threadSessionPreviousTimestamp =
    params.isThreadReply && params.threadTs && !threadSessionFreshness
      ? readSessionUpdatedAt({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const isMissingThreadSession = threadSessionFreshness
    ? threadSessionFreshness.state === "missing"
    : threadSessionPreviousTimestamp === undefined;
  // A zero updatedAt is an explicit reset tombstone, not an outbound-created row.
  // Rehydrating it would resurrect history that the reset intentionally discarded.
  const isOutboundOnlyThreadSession =
    threadSessionFreshness !== undefined &&
    threadSessionFreshness.state !== "missing" &&
    threadSessionFreshness.entry.lastInteractionAt === undefined &&
    threadSessionFreshness.entry.updatedAt !== 0;
  const shouldSeedInitialThreadContext = Boolean(
    params.isThreadReply &&
    params.threadTs &&
    (threadSessionFreshness
      ? threadSessionFreshness.state !== "fresh" || isOutboundOnlyThreadSession
      : threadSessionPreviousTimestamp === undefined),
  );
  const shouldLoadInitialThreadHistory =
    shouldSeedInitialThreadContext || params.forceInitialHistory === true;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      shouldSeedInitialThreadContext,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && params.allowFromLower.length > 0 && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId, params.eventScope))?.name
      : undefined;
  params.assertHistoryCurrent?.();
  const starterIsCurrentBot = Boolean(starter && isCurrentBotAuthor(starter));
  const starterAllowed =
    !starter ||
    (!starterIsCurrentBot &&
      resolveSlackUserAllowed({
        allowList: params.allowFromLower,
        teamId: params.eventScope?.teamId ?? params.ctx.teamId,
        allowNameMatching: params.allowNameMatching,
        userId: starter.userId ?? starter.botId,
        userName: starterSenderName,
      }));
  const includeStarterContext =
    !starter ||
    (!starterIsCurrentBot &&
      shouldIncludeSupplementalContext({
        mode: params.contextVisibilityMode,
        kind: "thread",
        senderAllowed: starterAllowed,
      }));

  if (starter?.text && includeStarterContext) {
    threadStarterBody = starter.text;
    const snippet = formatSlackThreadLabelSnippet(starter.text);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    // Root media seeds a new thread session once. Rehydrating it later makes
    // old files look like current-turn uploads and repeats media processing.
    if (
      shouldSeedInitialThreadContext &&
      !params.effectiveDirectMedia &&
      starter.files &&
      starter.files.length > 0
    ) {
      const { resolveSlackAttachmentContent } = await loadSlackMediaModule();
      params.assertHistoryCurrent?.();
      const attachmentContent = await resolveSlackAttachmentContent({
        files: starter.files,
        client: params.eventScope?.client ?? params.ctx.app.client,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
        assertCurrent: params.assertHistoryCurrent,
        abortSignal: params.abortSignal,
      });
      params.assertHistoryCurrent?.();
      threadStarterMedia = attachmentContent?.media.length ? attachmentContent.media : null;
      if (attachmentContent) {
        threadStarterBody = formatSlackUnavailableMedia({
          body: threadStarterBody,
          files: attachmentContent.files,
          unavailableMediaCount: attachmentContent.unavailableMediaCount,
          // Prompt serialization truncates long starter bodies from the tail.
          prependUnavailable: true,
        });
      }
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  const includeBotStarterAsRootContext = Boolean(
    starter?.text && starterIsCurrentBot && shouldSeedInitialThreadContext,
  );

  if (starter?.text && starterIsCurrentBot && !includeBotStarterAsRootContext) {
    logVerbose("slack: omitted current-bot thread starter from context");
  } else if (starter?.text && !includeStarterContext && !starterIsCurrentBot) {
    logVerbose(
      `slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`,
    );
  } else if (includeBotStarterAsRootContext) {
    const snippet = formatSlackThreadLabelSnippet(starter?.text ?? "").trim();
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? ` (assistant root): ${snippet}` : ""}`;
    logVerbose("slack: retained current-bot thread starter as assistant root context");
  }

  const threadInitialHistoryLimit = Math.min(
    params.account.config?.thread?.initialHistoryLimit ?? 20,
    params.historyLimit ?? Number.POSITIVE_INFINITY,
  );

  if (threadInitialHistoryLimit > 0 && shouldLoadInitialThreadHistory) {
    const currentBotRootTs = starter?.ts ?? params.threadTs;
    let historyOmitted = false;
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.eventScope?.client ?? params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
      excludedMessageIds: params.excludedMessageIds,
      assertCurrent: params.assertHistoryCurrent,
      onOmission: (reason) => {
        historyOmitted = true;
        params.ctx.logger.warn(
          {
            channelId: params.message.channel,
            threadTs: params.threadTs,
            teamId: params.eventScope?.teamId ?? params.ctx.teamId,
            accountId: params.account.accountId,
            reason,
          },
          "Slack automatic thread history omitted",
        );
      },
    });
    if (historyOmitted) {
      return {
        threadStarterBody,
        threadHistoryBody,
        shouldSeedInitialThreadContext,
        threadLabel,
        threadStarterMedia,
      };
    }

    const enrichedStarter =
      starter && threadStarterBody && threadStarterBody !== starter.text
        ? { ...starter, text: threadStarterBody, ts: currentBotRootTs }
        : null;
    const threadHistoryWithEnrichedRoot =
      enrichedStarter && !threadHistory.some((entry) => entry.ts === currentBotRootTs)
        ? [
            enrichedStarter,
            ...(threadHistory.length >= threadInitialHistoryLimit
              ? threadHistory.slice(1)
              : threadHistory),
          ]
        : threadHistory;
    const threadHistoryWithBotRoot =
      includeBotStarterAsRootContext &&
      starter &&
      !threadHistoryWithEnrichedRoot.some((entry) => entry.ts === currentBotRootTs)
        ? [{ ...starter, ts: currentBotRootTs }, ...threadHistoryWithEnrichedRoot]
        : threadHistoryWithEnrichedRoot;

    if (threadHistoryWithBotRoot.length > 0) {
      // MPIM roots stay on the flat group session. Outbound delivery may create
      // the reply-thread session before its first inbound turn, so recover its replies.
      const retainCurrentBotHistory =
        params.isGroupDm && (isMissingThreadSession || isOutboundOnlyThreadSession);
      const threadHistoryWithoutCurrentBot = threadHistoryWithBotRoot.filter(
        (entry) =>
          !isCurrentBotAuthor(entry) ||
          retainCurrentBotHistory ||
          (includeBotStarterAsRootContext && entry.ts === currentBotRootTs),
      );
      const omittedCurrentBotHistoryCount =
        threadHistoryWithBotRoot.length - threadHistoryWithoutCurrentBot.length;

      const userMapForFilter =
        params.contextVisibilityMode !== "all" &&
        params.allowNameMatching &&
        params.allowFromLower.length > 0
          ? await resolveSlackThreadUserMap({
              ctx: params.ctx,
              messages: threadHistoryWithoutCurrentBot,
              eventScope: params.eventScope,
            })
          : new Map<string, { name?: string }>();
      params.assertHistoryCurrent?.();
      const { items: filteredThreadHistory, omitted: omittedHistoryCount } =
        params.contextVisibilityMode === "all"
          ? { items: threadHistoryWithoutCurrentBot, omitted: 0 }
          : filterSupplementalContextItems({
              items: threadHistoryWithoutCurrentBot,
              mode: params.contextVisibilityMode,
              kind: "thread",
              isSenderAllowed: (historyMsg) => {
                if (isCurrentBotAuthor(historyMsg)) {
                  return true;
                }
                const msgUser = historyMsg.userId ? userMapForFilter.get(historyMsg.userId) : null;
                return resolveSlackUserAllowed({
                  allowList: params.allowFromLower,
                  teamId: params.eventScope?.teamId ?? params.ctx.teamId,
                  allowNameMatching: params.allowNameMatching,
                  userId: historyMsg.userId ?? historyMsg.botId,
                  userName: msgUser?.name,
                });
              },
            });
      const userMap = await resolveSlackThreadUserMap({
        ctx: params.ctx,
        messages: filteredThreadHistory,
        eventScope: params.eventScope,
      });
      params.assertHistoryCurrent?.();
      if (omittedHistoryCount > 0 || omittedCurrentBotHistoryCount > 0) {
        logVerbose(
          `slack: omitted ${omittedHistoryCount + omittedCurrentBotHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`,
        );
      }

      const historyParts: string[] = [];
      for (const historyMsg of filteredThreadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const isCurrentBot = isCurrentBotAuthor(historyMsg);
        const role = isCurrentBot || historyMsg.botId ? "assistant" : "user";
        const msgSenderName = isCurrentBot
          ? "Bot (this assistant)"
          : (msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown"));
        const historyBody =
          historyMsg.ts === currentBotRootTs && threadStarterBody
            ? threadStarterBody
            : historyMsg.text;
        const msgWithId = `${historyBody}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: resolveSlackTimestampMs(historyMsg.ts),
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
        logVerbose(
          `slack: populated thread history with ${filteredThreadHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    shouldSeedInitialThreadContext,
    threadLabel,
    threadStarterMedia,
  };
}
