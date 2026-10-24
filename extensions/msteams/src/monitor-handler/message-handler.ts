import { resolveAllowlistMatchSimple } from "openclaw/plugin-sdk/allow-from";
import {
  createChannelInboundEnvelopeBuilderAsync,
  formatMediaPlaceholderText,
  resolveInboundMentionDecision,
  resolveInboundSupplementalSenderAllowed,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveMSTeamsAccountConfig } from "../accounts.js";
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
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import {
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSentWithPersistence,
} from "../sent-message-cache.js";
import { admitMSTeamsMessage, resolveMSTeamsSenderAccess } from "./access.js";
import { createMSTeamsHandlerConfigReader } from "./config.js";
import { prepareMSTeamsInboundContent } from "./inbound-content.js";
import {
  assembleMSTeamsInboundFacts,
  prepareMSTeamsDebounceEntry,
  type MSTeamsDebounceEntry,
} from "./inbound-facts.js";
import { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    accountPolicyCfg = cfg,
    accountId,
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
  const msteamsCfg = cfg.channels?.msteams
    ? resolveMSTeamsAccountConfig(cfg, accountId)
    : undefined;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
    accountId,
  });
  const historyLimit = resolvePromptHistoryLimit(
    msteamsCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const readFullConfig = createRuntimeConfigReader(accountPolicyCfg);
  const readConfig = deps.readConfig ?? createMSTeamsHandlerConfigReader(deps);
  const resolveDebounceMs = () =>
    core.channel.debounce.resolveInboundDebounceMs({ cfg: readConfig(), channel: "msteams" });

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const facts = assembleMSTeamsInboundFacts(params);
    const {
      context,
      activity,
      text,
      advertisedMedia,
      rawBody,
      quoteInfo,
      from,
      htmlSummary,
      conversationId,
      conversationMessageId,
      conversationType,
      isChannel,
      teamId,
      graphChannelId,
      conversationRef,
    } = facts;
    const historyBody = [text, formatMediaPlaceholderText(advertisedMedia)]
      .filter(Boolean)
      .join("\n");
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
          accountId,
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
      accountId,
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
      msteamsCfg: admittedMSTeamsCfg,
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
      accountId,
      context,
      isDirectMessage,
      isChannel,
      senderId,
      conversationId,
      conversationMessageId,
      teamId,
      log,
    });
    const { route } = threadRouting;

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
              messageId: activity.id,
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
      htmlSummary,
      conversationType,
      conversationId,
      conversationMessageId,
      teamAadGroupId: threadRouting.getTeamAadGroupId(),
      resolveTeamAadGroupId: threadRouting.resolveTeamAadGroupId,
      mediaMaxBytes,
      tokenProvider,
      mediaAllowHosts: currentMSTeamsCfg?.mediaAllowHosts,
      mediaAuthAllowHosts: currentMSTeamsCfg?.mediaAuthAllowHosts,
      graphMediaFallback: currentMSTeamsCfg?.graphMediaFallback,
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

    const dispatchAccountPolicyCfg = readFullConfig();
    const dispatchCore = getMSTeamsRuntime();
    const { agentBody, inboundMedia } = content;
    const { teamAadGroupId, quoteBodyFull, quoteSenderId, quoteSenderName, threadContext } = thread;
    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;
    const envelopeFrom = isDirectMessage ? senderName : conversationType;
    const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
      cfg: currentCfg,
      route,
    });
    const body = buildEnvelope({
      channel: "Teams",
      from: envelopeFrom,
      timestamp,
      body: agentBody,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? facts.historyKey : undefined;
    if (isRoomish && historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: conversationHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          buildEnvelope({
            channel: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            previousTimestamp: null,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          }),
      });
    }

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: conversationHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;
    const commandBody = text.trim();
    const quoteSenderAllowed =
      quoteInfo && quoteInfo.sender
        ? resolveInboundSupplementalSenderAllowed({
            isGroup: !isDirectMessage,
            groupPolicy,
            allowFrom: effectiveGroupAllowFrom,
            isSenderAllowed: (allowFrom) =>
              resolveAllowlistMatchSimple({
                allowFrom,
                senderId: quoteSenderId ?? "",
                senderName: quoteSenderName,
                allowNameMatching,
              }).allowed,
          })
        : true;
    // Teams channel actions need both the AAD group and Graph channel ids.
    const nativeChannelId =
      isChannel && teamAadGroupId ? `${teamAadGroupId}/${graphChannelId}` : undefined;
    // The listener config is intentionally account-scoped. If routing ever crosses
    // accounts, re-read policy from the full config or sibling authorization can leak.
    const senderAccessCfg = route.accountId === accountId ? readConfig() : dispatchAccountPolicyCfg;
    // Thread routing owns the final session key, so mint the bound result at dispatch preparation.
    const boundIngress = await resolveMSTeamsSenderAccess({
      cfg: senderAccessCfg,
      accountId: route.accountId,
      activity,
      hasControlCommand: admission.isControlCommand,
      conversationThreadId: facts.threadId,
      contextBinding: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        ...(activity.id ? { messageId: activity.id } : {}),
        ...(nativeChannelId ? { nativeChannelId } : {}),
        inboundEventKind: "user_request",
      },
    });
    if (
      !boundIngress.senderAccess.allowed ||
      boundIngress.hasConflictingConversationScope ||
      boundIngress.msteamsCfg?.enabled === false ||
      boundIngress.commandAccess.shouldBlockControlCommand
    ) {
      log.info("dropping message (dispatch-time account authorization changed)");
      return;
    }
    const ctxPayload = dispatchCore.channel.inbound.buildContext({
      channelIngress: boundIngress.channelIngress,
      channel: "msteams",
      contextVisibility: contextVisibilityMode,
      supplemental: {
        // The capped Graph thread slice supplements the pending channel backlog;
        // it cannot claim to replace that history or become sender command text.
        channelStructuredContext: threadContext.length
          ? [
              {
                label: "Thread history",
                source: "msteams",
                type: "chat_window",
                sessionTranscriptMode: "preserve",
                payload: { order: "chronological", messages: threadContext },
              },
            ]
          : undefined,
        quote: quoteInfo
          ? {
              id: quoteInfo.id ?? activity.replyToId,
              body: quoteBodyFull ?? quoteInfo.body,
              sender: quoteInfo.sender,
              senderAllowed: quoteSenderAllowed,
              isQuote: true,
            }
          : undefined,
      },
      media: await toInboundMediaFactsWithMetadata(inboundMedia),
      messageId: activity.id,
      timestamp: timestamp?.getTime() ?? Date.now(),
      from: teamsFrom,
      sender: {
        id: senderId,
        name: senderName,
      },
      conversation: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: conversationId,
        label: envelopeFrom,
        spaceId: teamId,
        nativeChannelId,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: teamsTo,
        // A user target is a mutable lookup alias; the conversation id is the
        // authoritative route for message-tool reply suppression.
        originatingTo: `conversation:${conversationId}`,
        // Channel-only thread root (facts.threadId) so messaging-tool evidence matches
        // session/origin thread ids; keep replyToId as parent. Undefined for DM/group.
        messageThreadId: facts.threadId,
        replyToId: activity.replyToId,
        nativeChannelId,
      },
      message: {
        body: combinedBody,
        bodyForAgent: agentBody,
        inboundHistory,
        rawBody,
        commandBody,
      },
      sessionTranscript: { historyLimit: isRoomish ? historyLimit : 0 },
      access: {
        mentions: {
          canDetectMention: !isDirectMessage,
          wasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
        },
        commands: {
          authorized: commandAuthorized === true,
        },
      },
      extra: {
        GroupSubject: !isDirectMessage ? conversationType : undefined,
        ReplyToIsQuote: quoteInfo ? true : undefined,
      },
    });

    const { dispatcherOptions, delivery, replyOptions } = createMSTeamsReplyDispatcher({
      cfg: currentCfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
      log,
      app,
      conversationRef,
      context,
      replyStyle,
      textLimit,
      onSentMessageIds: (ids) => {
        for (const id of ids) {
          recordMSTeamsSentMessage(conversationId, id, { accountId: route.accountId });
        }
      },
      tokenProvider,
      sharePointSiteId: admittedMSTeamsCfg?.sharePointSiteId,
    });

    const senderTimezone = conversationRef.timezone;
    const turnConfig =
      senderTimezone && !currentCfg.agents?.defaults?.userTimezone
        ? {
            ...currentCfg,
            agents: {
              ...currentCfg.agents,
              defaults: { ...currentCfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : currentCfg;
    try {
      await dispatchCore.channel.inbound.run({
        channel: "msteams",
        accountId: route.accountId,
        raw: context,
        adapter: {
          ingest: () => ({
            id: activity.id ?? `${teamsFrom}:${Date.now()}`,
            timestamp: timestamp?.getTime(),
            rawText: rawBody,
            textForAgent: agentBody,
            textForCommands: commandBody,
            raw: activity,
          }),
          resolveTurn: () => ({
            cfg: turnConfig,
            channel: "msteams",
            accountId: route.accountId,
            route: { agentId: route.agentId, sessionKey: route.sessionKey },
            ctxPayload,
            record: {
              onRecordError: (err) => {
                logVerboseMessage(
                  `msteams: failed updating session meta: ${formatUnknownError(err)}`,
                );
              },
            },
            history: {
              isGroup: isRoomish,
              historyKey,
              historyMap: conversationHistories,
              limit: historyLimit,
            },
            dispatcherOptions,
            delivery,
            replyOptions: {
              ...replyOptions,
              ...(facts.turnAdoptionLifecycle
                ? bindIngressLifecycleToReplyOptions(facts.turnAdoptionLifecycle)
                : {}),
            },
          }),
        },
      });
    } catch (err) {
      runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
      if (facts.turnAdoptionLifecycle) {
        throw err;
      }
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
      } catch {
        // Best effort.
      }
    }
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
      accountId,
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
