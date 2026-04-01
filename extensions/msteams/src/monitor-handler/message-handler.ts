import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  dispatchReplyFromConfigWithSettledDispatcher,
  DEFAULT_GROUP_HISTORY_LIMIT,
  logInboundDrop,
  evaluateSenderGroupAccessForPolicy,
  recordPendingHistoryEntryIfEnabled,
  resolveDualTextControlCommandGate,
  resolveMentionGating,
  resolveInboundSessionEnvelopeContext,
  formatAllowlistMatchMeta,
  type HistoryEntry,
} from "../../runtime-api.js";
import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsMediaPayload,
  type MSTeamsAttachmentLike,
  summarizeMSTeamsHtmlAttachments,
} from "../attachments.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import {
  fetchChannelMessage,
  fetchThreadReplies,
  formatThreadContext,
  resolveTeamGroupId,
} from "../graph-thread.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsAllowlistMatch,
  resolveMSTeamsReplyPolicy,
} from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { recordMSTeamsSentMessage, wasMSTeamsMessageSent } from "../sent-message-cache.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    runtime,
    appId,
    adapter,
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
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "msteams",
  });

  type MSTeamsDebounceEntry = {
    context: MSTeamsTurnContext;
    rawText: string;
    text: string;
    attachments: MSTeamsAttachmentLike[];
    wasMentioned: boolean;
    implicitMention: boolean;
  };

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const context = params.context;
    const activity = context.activity;
    const rawText = params.rawText;
    const text = params.text;
    const attachments = params.attachments;
    const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments);
    const rawBody = text || attachmentPlaceholder;
    const quoteInfo = extractMSTeamsQuoteInfo(attachments);
    const from = activity.from;
    const conversation = activity.conversation;

    const attachmentTypes = attachments
      .map((att) => (typeof att.contentType === "string" ? att.contentType : undefined))
      .filter(Boolean)
      .slice(0, 3);
    const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);

    log.info("received message", {
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
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

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key.
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const teamId = activity.channelData?.team?.id;

    const {
      dmPolicy,
      senderId,
      senderName,
      pairing,
      isDirectMessage,
      channelGate,
      access,
      configuredDmAllowFrom,
      effectiveDmAllowFrom,
      effectiveGroupAllowFrom,
      allowNameMatching,
      groupPolicy,
    } = await resolveMSTeamsSenderAccess({
      cfg,
      activity,
    });
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const isChannel = conversationType === "channel";

    if (isDirectMessage && msteamsCfg && access.decision !== "allow") {
      if (access.reason === "dmPolicy=disabled") {
        log.info("dropping dm (dms disabled)", {
          sender: senderId,
          label: senderName,
        });
        log.debug?.("dropping dm (dms disabled)");
        return;
      }
      const allowMatch = resolveMSTeamsAllowlistMatch({
        allowFrom: effectiveDmAllowFrom,
        senderId,
        senderName,
        allowNameMatching,
      });
      if (access.decision === "pairing") {
        const request = await pairing.upsertPairingRequest({
          id: senderId,
          meta: { name: senderName },
        });
        if (request) {
          log.info("msteams pairing request created", {
            sender: senderId,
            label: senderName,
          });
        }
      }
      log.debug?.("dropping dm (not allowlisted)", {
        sender: senderId,
        label: senderName,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      log.info("dropping dm (not allowlisted)", {
        sender: senderId,
        label: senderName,
        dmPolicy,
        reason: access.reason,
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
      });
      return;
    }

    if (!isDirectMessage && msteamsCfg) {
      if (channelGate.allowlistConfigured && !channelGate.allowed) {
        log.info("dropping group message (not in team/channel allowlist)", {
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
        });
        log.debug?.("dropping group message (not in team/channel allowlist)", {
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
        });
        return;
      }
      const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
        groupPolicy,
        groupAllowFrom: effectiveGroupAllowFrom,
        senderId,
        isSenderAllowed: (_senderId, allowFrom) =>
          resolveMSTeamsAllowlistMatch({
            allowFrom,
            senderId,
            senderName,
            allowNameMatching,
          }).allowed,
      });

      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
        log.info("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
        log.info("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
        const allowMatch = resolveMSTeamsAllowlistMatch({
          allowFrom: effectiveGroupAllowFrom,
          senderId,
          senderName,
          allowNameMatching,
        });
        log.debug?.("dropping group message (not in groupAllowFrom)", {
          sender: senderId,
          label: senderName,
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        });
        log.info("dropping group message (not in groupAllowFrom)", {
          sender: senderId,
          label: senderName,
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        });
        return;
      }
    }

    const commandDmAllowFrom = isDirectMessage ? effectiveDmAllowFrom : configuredDmAllowFrom;
    const ownerAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: commandDmAllowFrom,
      senderId,
      senderName,
      allowNameMatching,
    });
    const groupAllowedForCommands = isMSTeamsGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: effectiveGroupAllowFrom,
      senderId,
      senderName,
      allowNameMatching,
    });
    const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
      useAccessGroups,
      primaryConfigured: commandDmAllowFrom.length > 0,
      primaryAllowed: ownerAllowedForCommands,
      secondaryConfigured: effectiveGroupAllowFrom.length > 0,
      secondaryAllowed: groupAllowedForCommands,
      hasControlCommand: core.channel.text.hasControlCommand(text, cfg),
    });
    if (shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "msteams",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    // Extract clientInfo entity (Teams sends this on every activity with timezone, locale, etc.)
    const clientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
      | { timezone?: string; locale?: string; country?: string; platform?: string }
      | undefined;

    // Build conversation reference for proactive replies.
    const agent = activity.recipient;
    const conversationRef: StoredConversationReference = {
      activityId: activity.id,
      user: { id: from.id, name: from.name, aadObjectId: from.aadObjectId },
      agent,
      bot: agent ? { id: agent.id, name: agent.name } : undefined,
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: conversation?.tenantId,
      },
      teamId,
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
      locale: activity.locale,
      // Only set timezone if present (preserve previously stored value on next upsert)
      ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    };
    conversationStore.upsert(conversationId, conversationRef).catch((err) => {
      log.debug?.("failed to save conversation reference", {
        error: formatUnknownError(err),
      });
    });

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

    if (!rawBody) {
      log.debug?.("skipping empty message after stripping mentions");
      return;
    }

    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`;
    const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      teamId,
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
    });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      isDirectMessage,
      globalConfig: msteamsCfg,
      teamConfig,
      channelConfig,
    });
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);

    if (!isDirectMessage) {
      const mentionGate = resolveMentionGating({
        requireMention: Boolean(requireMention),
        canDetectMention: true,
        wasMentioned: params.wasMentioned,
        implicitMention: params.implicitMention,
        shouldBypassMention: false,
      });
      const mentioned = mentionGate.effectiveWasMentioned;
      if (requireMention && mentionGate.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          teamId,
          channelId,
          requireMention,
          mentioned,
        });
        recordPendingHistoryEntryIfEnabled({
          historyMap: conversationHistories,
          historyKey: conversationId,
          limit: historyLimit,
          entry: {
            sender: senderName,
            body: rawBody,
            timestamp: timestamp?.getTime(),
            messageId: activity.id ?? undefined,
          },
        });
        return;
      }
    }
    const mediaList = await resolveMSTeamsInboundMedia({
      attachments,
      htmlSummary: htmlSummary ?? undefined,
      maxBytes: mediaMaxBytes,
      tokenProvider,
      allowHosts: msteamsCfg?.mediaAllowHosts,
      authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
      conversationType,
      conversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      activity: {
        id: activity.id,
        replyToId: activity.replyToId,
        channelData: activity.channelData,
      },
      log,
      preserveFilenames: (cfg as { media?: { preserveFilenames?: boolean } }).media
        ?.preserveFilenames,
    });

    const mediaPayload = buildMSTeamsMediaPayload(mediaList);

    // Fetch thread history when the message is a reply inside a Teams channel thread.
    // This is a best-effort enhancement; errors are logged and do not block the reply.
    let threadContext: string | undefined;
    if (activity.replyToId && isChannel && teamId) {
      try {
        const graphToken = await tokenProvider.getAccessToken("https://graph.microsoft.com");
        const groupId = await resolveTeamGroupId(graphToken, teamId);
        const [parentMsg, replies] = await Promise.all([
          fetchChannelMessage(graphToken, groupId, conversationId, activity.replyToId),
          fetchThreadReplies(graphToken, groupId, conversationId, activity.replyToId),
        ]);
        const allMessages = parentMsg ? [parentMsg, ...replies] : replies;
        const threadMessages =
          groupPolicy === "allowlist"
            ? allMessages.filter((msg) => {
                return resolveMSTeamsAllowlistMatch({
                  allowFrom: effectiveGroupAllowFrom,
                  senderId: msg.from?.user?.id ?? "",
                  senderName: msg.from?.user?.displayName,
                  allowNameMatching,
                }).allowed;
              })
            : allMessages;
        const formatted = formatThreadContext(threadMessages, activity.id);
        if (formatted) {
          threadContext = formatted;
        }
      } catch (err) {
        log.debug?.("failed to fetch thread history", { error: String(err) });
        // Graceful degradation: thread history is an optional enhancement.
      }
    }

    const envelopeFrom = isDirectMessage ? senderName : conversationType;
    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Teams",
      from: envelopeFrom,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: conversationHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Teams",
            from: conversationType,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? (conversationHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const commandBody = text.trim();

    // Prepend thread history to the agent body so the agent has full thread context.
    const bodyForAgent = threadContext
      ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${rawBody}`
      : rawBody;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      InboundHistory: inboundHistory,
      RawBody: rawBody,
      CommandBody: commandBody,
      BodyForCommands: commandBody,
      From: teamsFrom,
      To: teamsTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      ConversationLabel: envelopeFrom,
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "msteams" as const,
      Surface: "msteams" as const,
      MessageSid: activity.id,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      WasMentioned: isDirectMessage || params.wasMentioned || params.implicitMention,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
      ReplyToId: activity.replyToId ?? undefined,
      ReplyToBody: quoteInfo?.body,
      ReplyToSender: quoteInfo?.sender,
      ReplyToIsQuote: quoteInfo ? true : undefined,
      ...mediaPayload,
    });

    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        logVerboseMessage(`msteams: failed updating session meta: ${String(err)}`);
      },
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
      cfg,
      agentId: route.agentId,
      accountId: route.accountId,
      runtime,
      log,
      adapter,
      appId,
      conversationRef,
      context,
      replyStyle,
      textLimit,
      onSentMessageIds: (ids) => {
        for (const id of ids) {
          recordMSTeamsSentMessage(conversationId, id);
        }
      },
      tokenProvider,
      sharePointSiteId,
    });

    // Use Teams clientInfo timezone if no explicit userTimezone is configured.
    // This ensures the agent knows the sender's timezone for time-aware responses
    // and proactive sends within the same session.
    // Apply Teams clientInfo timezone if no explicit userTimezone is configured.
    const senderTimezone = clientInfo?.timezone || conversationRef.timezone;
    const configOverride =
      senderTimezone && !cfg.agents?.defaults?.userTimezone
        ? {
            agents: {
              defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : undefined;

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
        cfg,
        ctxPayload,
        dispatcher,
        onSettled: () => markDispatchIdle(),
        replyOptions,
        configOverride,
      });

      log.info("dispatch complete", { queuedFinal, counts });

      if (!queuedFinal) {
        if (isRoomish && historyKey) {
          clearHistoryEntriesIfEnabled({
            historyMap: conversationHistories,
            historyKey,
            limit: historyLimit,
          });
        }
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
      );
      if (isRoomish && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: conversationHistories,
          historyKey,
          limit: historyLimit,
        });
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(`msteams dispatch failed: ${String(err)}`);
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
      } catch {
        // Best effort.
      }
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = normalizeMSTeamsConversationId(
        entry.context.activity.conversation?.id ?? "",
      );
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) {
        return null;
      }
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.text.hasControlCommand(entry.text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleTeamsMessageNow(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const combinedRawText = entries
        .map((entry) => entry.rawText)
        .filter(Boolean)
        .join("\n");
      const wasMentioned = entries.some((entry) => entry.wasMentioned);
      const implicitMention = entries.some((entry) => entry.implicitMention);
      await handleTeamsMessageNow({
        context: last.context,
        rawText: combinedRawText,
        text: combinedText,
        attachments: [],
        wasMentioned,
        implicitMention,
      });
    },
    onError: (err) => {
      runtime.error?.(`msteams debounce flush failed: ${String(err)}`);
    },
  });

  return async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const activity = context.activity;
    const rawText = activity.text?.trim() ?? "";
    const text = stripMSTeamsMentionTags(rawText);
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const wasMentioned = wasMSTeamsBotMentioned(activity);
    const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    const replyToId = activity.replyToId ?? undefined;
    const implicitMention = Boolean(
      conversationId && replyToId && wasMSTeamsMessageSent(conversationId, replyToId),
    );

    await inboundDebouncer.enqueue({
      context,
      rawText,
      text,
      attachments,
      wasMentioned,
      implicitMention,
    });
  };
}
