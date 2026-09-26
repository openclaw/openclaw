import {
  formatMediaPlaceholderText,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatUnknownError } from "../errors.js";
import {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
} from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import { resolveMSTeamsReplyPolicy, resolveMSTeamsRouteConfig } from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { wasMSTeamsMessageSentWithPersistence } from "../sent-message-cache.js";
import { admitMSTeamsMessage } from "./access.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";
import { dispatchMSTeamsInboundTurn } from "./inbound-dispatch.js";
import {
  assembleMSTeamsInboundFacts,
  prepareMSTeamsDebounceEntry,
  type MSTeamsDebounceEntry,
} from "./inbound-facts.js";
import { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    runtime,
    appId,
    app,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  } = deps;
  const core = getMSTeamsRuntime();
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      log.debug?.(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
  });
  const historyLimit = resolvePromptHistoryLimit(
    msteamsCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const readConfig = createRuntimeConfigReader(cfg);
  const resolveDebounceMs = () =>
    core.channel.debounce.resolveInboundDebounceMs({ cfg: readConfig(), channel: "msteams" });

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const facts = assembleMSTeamsInboundFacts(params);
    const {
      context,
      activity,
      rawText,
      text,
      attachments,
      advertisedMedia,
      rawBody,
      quoteInfo,
      from,
      conversation,
      attachmentTypes,
      htmlSummary,
      conversationId,
      conversationMessageId,
      conversationType,
      isChannel,
      teamId,
      conversationRef,
    } = facts;
    const historyBody = [text, formatMediaPlaceholderText(advertisedMedia)]
      .filter(Boolean)
      .join("\n");
    log.info("received message", {
      rawText: truncateUtf16Safe(rawText, 50),
      text: truncateUtf16Safe(text, 50),
      attachments: attachments.length,
      attachmentTypes,
      from: from?.id,
      conversation: conversation?.id,
    });
    if (htmlSummary) {
      log.debug?.("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug?.("skipping message without from.id");
      return;
    }

    let currentCfg = readConfig();
    let isBotOwnedThread = false;
    if (isChannel && facts.threadId && activity.recipient?.id) {
      const channelConfig = currentCfg.channels?.msteams;
      const routeConfig = resolveMSTeamsRouteConfig({
        cfg: channelConfig,
        teamId,
        teamName: activity.channelData?.team?.name,
        conversationId,
        channelName: activity.channelData?.channel?.name,
        allowNameMatching: channelConfig?.dangerouslyAllowNameMatching === true,
      });
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: channelConfig,
        ...routeConfig,
      });
      if (policy.requireMentionInBotThreads !== undefined) {
        isBotOwnedThread = await wasMSTeamsMessageSentWithPersistence({
          conversationId,
          messageId: facts.threadId,
          botId: activity.recipient.id,
        });
        currentCfg = readConfig();
      }
    }
    const currentMSTeamsCfg = currentCfg.channels?.msteams;
    if (
      currentMSTeamsCfg?.enabled === false ||
      (currentMSTeamsCfg?.appId && currentMSTeamsCfg.appId !== appId)
    ) {
      return;
    }

    const admission = await admitMSTeamsMessage({
      cfg: currentCfg,
      activity,
      text,
      conversationId,
      conversationRef,
      isChannel,
      conversationStore,
      log,
      logVerboseMessage,
    });
    if (!admission) {
      return;
    }
    const {
      senderId,
      senderName,
      isDirectMessage,
      channelGate,
      allowNameMatching,
      groupPolicy,
      commandAuthorized,
      effectiveGroupAllowFrom,
      allowTextCommands,
      isControlCommand,
    } = admission;

    const pollVote = extractMSTeamsPollVote(activity);
    if (pollVote) {
      try {
        const poll = await pollStore.recordVote({
          pollId: pollVote.pollId,
          voterId: senderId,
          selections: pollVote.selections,
        });
        if (!poll) {
          log.debug?.("poll vote ignored (poll not found)", {
            pollId: pollVote.pollId,
          });
        } else {
          log.info("recorded poll vote", {
            pollId: pollVote.pollId,
            voter: senderId,
            selections: pollVote.selections,
          });
        }
      } catch (err) {
        log.error("failed to record poll vote", {
          pollId: pollVote.pollId,
          error: formatUnknownError(err),
        });
      }
      return;
    }

    const threadRouting = prepareMSTeamsThreadRouting({
      cfg: currentCfg,
      context,
      isDirectMessage,
      isChannel,
      senderId,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamId,
      log,
    });
    const { route, deadline: preprocessingDeadline } = threadRouting;

    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    const enqueuePrimaryMessageSystemEvent = () =>
      core.system.enqueueSystemEvent(inboundLabel, {
        sessionKey: route.sessionKey,
        contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
      });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const replyPolicy = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: currentMSTeamsCfg,
      teamConfig,
      channelConfig,
    });
    const { requireMention, implicitMentionKinds } = resolveBotThreadMentionPolicy({
      isBotOwnedThread,
      requireMention: replyPolicy.requireMention,
      requireMentionInBotThreads: replyPolicy.requireMentionInBotThreads,
      implicitMentionKinds: params.implicitMentionKinds,
    });
    const { replyStyle } = replyPolicy;
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMentionKinds,
      },
      policy: {
        isGroup: !isDirectMessage,
        requireMention,
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized: commandAuthorized === true,
      },
    });

    if (!isDirectMessage) {
      const mentioned = mentionDecision.effectiveWasMentioned;
      if (requireMention && mentionDecision.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        if (historyBody) {
          enqueuePrimaryMessageSystemEvent();
          createChannelHistoryWindow({ historyMap: conversationHistories }).record({
            historyKey: facts.historyKey,
            limit: historyLimit,
            entry: {
              sender: senderName,
              body: historyBody,
              timestamp: timestamp?.getTime(),
              messageId: activity.id ?? undefined,
            },
          });
        }
        return;
      }
    }
    const content = await prepareMSTeamsInboundContent({
      entry: params,
      rawBody,
      advertisedMedia,
      htmlSummary: htmlSummary ?? undefined,
      conversationType,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      teamAadGroupId: threadRouting.getTeamAadGroupId(),
      resolveTeamAadGroupId: threadRouting.resolveTeamAadGroupId,
      mediaMaxBytes,
      tokenProvider,
      mediaAllowHosts: currentMSTeamsCfg?.mediaAllowHosts,
      mediaAuthAllowHosts: currentMSTeamsCfg?.mediaAuthAllowHosts,
      graphMediaFallback: currentMSTeamsCfg?.graphMediaFallback,
      deadline: preprocessingDeadline,
      log,
    });
    if (!content) {
      return;
    }
    enqueuePrimaryMessageSystemEvent();

    const thread = await resolveMSTeamsThreadContext({
      routing: threadRouting,
      context,
      tokenProvider,
      quoteInfo,
      isDirectMessage,
      isChannel,
      conversationId,
      contextVisibilityMode,
      groupPolicy,
      effectiveGroupAllowFrom,
      allowNameMatching,
      log,
    });

    await dispatchMSTeamsInboundTurn({
      cfg: currentCfg,
      runtime,
      appId,
      app,
      tokenProvider,
      textLimit,
      log,
      logVerboseMessage,
      facts,
      admission,
      content,
      routing: threadRouting,
      thread,
      replyStyle,
      timestamp,
      contextVisibilityMode,
      mentionWasEffective: mentionDecision.effectiveWasMentioned,
      conversationHistories,
      historyLimit,
    });
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    debounceMs: resolveDebounceMs(),
    resolveDebounceMs,
    buildKey: (entry) => {
      const activity = entry.context.activity;
      const rawConversationId = activity.conversation?.id ?? "";
      const conversationId = normalizeMSTeamsConversationId(rawConversationId);
      const threadId =
        activity.conversation?.conversationType === "channel"
          ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId)
          : undefined;
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) {
        return null;
      }
      return JSON.stringify(["msteams", appId, conversationId, threadId ?? null, senderId]);
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.commands.isControlCommandMessage(entry.text, cfg);
    },
    onFlush: (entries, createFlush) => {
      const last = entries.at(-1);
      const { lifecycle, settle } = fanInChannelIngressLifecycles(
        entries.map((entry) => entry.turnAdoptionLifecycle),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (!last) {
            return;
          }
          try {
            if (entries.length === 1) {
              await handleTeamsMessageNow({ ...last, turnAdoptionLifecycle: admissionLifecycle });
            } else {
              const combinedText = entries
                .map((entry) => entry.text)
                .filter(Boolean)
                .join("\n");
              if (combinedText.trim()) {
                const combinedRawText = entries
                  .map((entry) => entry.rawText)
                  .filter(Boolean)
                  .join("\n");
                const wasMentioned = entries.some((entry) => entry.wasMentioned);
                const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
                await handleTeamsMessageNow({
                  context: last.context,
                  rawText: combinedRawText,
                  text: combinedText,
                  attachments: [],
                  wasMentioned,
                  implicitMentionKinds,
                  turnAdoptionLifecycle: admissionLifecycle,
                });
              }
            }
            await settle();
          } catch (err) {
            await admissionLifecycle.onAbandoned();
            throw err;
          }
        },
      });
    },
    onError: (err) => {
      runtime.error(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
  });

  return async function handleTeamsMessage(
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle?: MSTeamsIngressLifecycle,
  ) {
    const entry = await prepareMSTeamsDebounceEntry({
      context,
      turnAdoptionLifecycle,
    });
    await inboundDebouncer.enqueue(entry);
    if (turnAdoptionLifecycle) {
      // Keep the durable claim held across the debounce window. The merged
      // flush completes it only when the reply lane adopts (or terminally skips).
      return { kind: "deferred" } as const;
    }
    return undefined;
  };
}
