import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  resolveInboundSessionEnvelopeContextAsync,
  toInboundMediaFactsWithMetadata,
  type ChannelBotLoopProtectionFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  resolveChannelGroups,
  resolveChannelGroupsConfigPath,
} from "openclaw/plugin-sdk/channel-policy";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { MattermostPostSchema } from "./client.js";
import { normalizeMattermostAllowEntry } from "./ingress-identity.js";
import {
  formatMattermostDirectMessageDropLog,
  resolveMattermostMonitorInboundAccess,
  shouldRetainMattermostSenderHistory,
} from "./monitor-auth.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import {
  matchesMattermostBotMention,
  normalizeMention,
  shouldDropEmptyMattermostBody,
} from "./monitor-helpers.js";
import type { MattermostIngressLifecycle, MattermostIngressPost } from "./monitor-ingress.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import {
  formatMattermostInboundMediaText,
  formatMattermostPendingMediaText,
} from "./monitor-resources.js";
import { createMattermostThreadBackfill } from "./monitor-thread-backfill.js";
import { dispatchMattermostInboundTurn } from "./monitor-turn.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  logInboundDrop,
  type HistoryEntry,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { hasMattermostThreadParticipationWithPersistence } from "./thread-participation.js";

export function createMattermostPostHandler(monitor: MattermostMonitorContext) {
  const { account, botUserId, botUsername, cfg, core, groupPolicy, pairing, resources } = monitor;
  const groups = resolveChannelGroups(cfg, "mattermost", account.accountId);
  const groupsConfigPath = resolveChannelGroupsConfigPath({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    groups,
  });
  const { resolveMattermostMedia, resolveUserInfo } = resources;
  const channelHistories = new Map<string, HistoryEntry[]>();
  const historyLimit = resolvePromptHistoryLimit(
    account.config.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
    DEFAULT_GROUP_HISTORY_LIMIT,
  );

  const recoverThread = createMattermostThreadBackfill({ monitor, channelHistories, historyLimit });

  return async (
    post: MattermostIngressPost,
    payload: MattermostEventPayload,
    turnAdoptionLifecycle?: MattermostIngressLifecycle,
    messageIds?: string[],
  ) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      monitor.logVerboseMessage("mattermost: drop post (missing channel id)");
      return;
    }
    if (!post.id) {
      monitor.logVerboseMessage("mattermost: drop post (missing message id)");
      return;
    }
    const allMessageIds = messageIds?.length ? messageIds : [post.id];
    const senderId = post.user_id;
    if (senderId === botUserId) {
      monitor.logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
      return;
    }
    if (normalizeOptionalString(post.type) !== undefined) {
      monitor.logVerboseMessage(
        `mattermost: drop post (system post type=${post.type ?? "unknown"})`,
      );
      return;
    }

    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId,
      senderId,
      postId: post.id,
      threadRootId: normalizeOptionalString(post.root_id),
      channelTypeFallback: payload.data?.channel_type,
      teamId: payload.data?.team_id,
      channelName: payload.data?.channel_name,
      channelDisplay: payload.data?.channel_display_name,
      dropLabel: "post",
    });
    if (!eventPlan) {
      return;
    }
    const { channelDisplay, kind, roomLabel, route, thread } = eventPlan;
    // The server stamps from_bot on every post created by a bot account.
    const isBotPost = post.props?.from_bot === "true";
    const channelBotConfig = kind === "direct" ? undefined : account.config.groups?.[channelId];
    const wildcardBotConfig = kind === "direct" ? undefined : account.config.groups?.["*"];
    const allowBots =
      channelBotConfig?.allowBots ??
      wildcardBotConfig?.allowBots ??
      account.config.allowBots ??
      true;
    if (isBotPost && allowBots === false) {
      monitor.logVerboseMessage(`mattermost: drop bot post (allowBots=false sender=${senderId})`);
      return;
    }
    const senderName =
      normalizeOptionalString(payload.data?.sender_name) ??
      normalizeOptionalString((await resolveUserInfo(senderId))?.username) ??
      senderId;
    const rawPostText = post.message ?? "";
    const rawText = normalizeOptionalString(rawPostText) ?? "";
    // "@bot /new" addresses the bot, then issues a command: strip the mention before
    // detection and CommandBody, or the leading-slash check fails and the model gets prose.
    const commandBody = normalizeMention(rawText, botUsername).trim();
    const { effectiveReplyToId, sessionKey } = thread;
    const { envelopeOptions, previousTimestamp } = await resolveInboundSessionEnvelopeContextAsync({
      cfg,
      agentId: route.agentId,
      sessionKey,
    });
    // Flat DMs dispatch immediately. Opted-in threads have an independent session
    // and need a recoverable context window just like room threads.
    const historyKey = kind === "direct" && !effectiveReplyToId ? null : sessionKey;
    const fileIds = uniqueStrings(normalizeTrimmedStringList(post.file_ids ?? []));
    const nativeMedia = fileIds.map(() => ({}));
    const pendingBody = formatMattermostPendingMediaText({ body: rawText, media: nativeMedia });
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      createChannelHistoryWindow({ historyMap: channelHistories }).record({
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: senderName,
                body: trimmed,
                timestamp: post.create_at ?? undefined,
                messageId: post.id,
              }
            : null,
      });
    };
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const isControlCommand =
      allowTextCommands && core.channel.commands.isControlCommandMessage(commandBody, cfg);
    const accessDecision = await resolveMattermostMonitorInboundAccess({
      account,
      cfg,
      senderId,
      senderName,
      channelId,
      threadId: effectiveReplyToId,
      kind,
      groupPolicy,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands,
      hasControlCommand: isControlCommand,
      eventKind: "message",
      mayPair: true,
      contextBinding: {
        agentId: route.agentId,
        sessionKey,
        messageId: post.id,
        nativeChannelId: channelId,
        inboundEventKind: "user_request",
      },
    });
    const commandAuthorized = accessDecision.commandAccess.authorized;

    if (accessDecision.ingress.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.ingress.reasonCode === "dm_policy_disabled") {
          monitor.logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.ingress.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          monitor.logVerboseMessage(
            `mattermost: pairing request sender=${senderId} created=${created}`,
          );
          if (created) {
            try {
              await sendMessageMattermost(
                `channel:${channelId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "mattermost",
                  idLine: `Your Mattermost user id: ${senderId}`,
                  code,
                }),
                { cfg, accountId: account.accountId },
              );
              monitor.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              monitor.logVerboseMessage(
                `mattermost: pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
          return;
        }
        monitor.logVerboseMessage(
          formatMattermostDirectMessageDropLog({
            senderId,
            dmPolicy: account.config.dmPolicy ?? "pairing",
            reasonCode: accessDecision.senderAccess.reasonCode,
          }),
        );
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_disabled") {
        monitor.logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_empty_allowlist") {
        monitor.logVerboseMessage("mattermost: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.ingress.reasonCode === "group_policy_not_allowlisted") {
        // Trigger allowlists do not hide history unless context visibility opts in.
        // Denied senders must still return before commands, sessions, or replies.
        if (
          shouldRetainMattermostSenderHistory({
            cfg,
            accountId: account.accountId,
            kind,
            ingress: accessDecision.ingress,
          })
        ) {
          recordPendingHistory();
        }
        monitor.logVerboseMessage(
          `mattermost: drop group sender=${senderId} (not in groupAllowFrom)`,
        );
        return;
      }
      monitor.logVerboseMessage(
        `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.senderAccess.reasonCode})`,
      );
      return;
    }

    if (kind !== "direct" && accessDecision.commandAccess.shouldBlockControlCommand) {
      logInboundDrop({
        log: monitor.logVerboseMessage,
        channel: "mattermost",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" &&
      (matchesMattermostBotMention(rawText, botUsername) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    // Threads the bot already replied in auto-engage: follow-ups resume without
    // a re-mention even under requireMention. Keyed by the thread root id.
    const threadAlreadyEngaged =
      kind !== "direct" && effectiveReplyToId
        ? await hasMattermostThreadParticipationWithPersistence({
            accountId: account.accountId,
            channelId,
            threadRootId: effectiveReplyToId,
          })
        : false;
    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "mattermost",
        accountId: account.accountId,
        groupId: channelId,
        requireMentionOverride: account.requireMention,
      });
    const requireMentionInBotThreads =
      groups?.[channelId]?.requireMentionInBotThreads ??
      groups?.["*"]?.requireMentionInBotThreads ??
      account.config.requireMentionInBotThreads;
    const nativeThreadRootId = normalizeOptionalString(post.root_id);
    let isBotOwnedThread = false;
    if (kind !== "direct" && nativeThreadRootId && requireMentionInBotThreads !== undefined) {
      try {
        const root = MattermostPostSchema.safeParse(
          await monitor.client.request<unknown>(`/posts/${encodeURIComponent(nativeThreadRootId)}`),
        );
        isBotOwnedThread =
          root.success &&
          root.data.id === nativeThreadRootId &&
          root.data.channel_id === channelId &&
          root.data.user_id === botUserId &&
          !root.data.delete_at &&
          !normalizeOptionalString(root.data.root_id);
      } catch (err) {
        monitor.logVerboseMessage(
          `mattermost: failed resolving thread owner channel=${channelId} root=${nativeThreadRootId}: ${String(err)}`,
        );
      }
    }
    const botThreadPolicy = resolveBotThreadMentionPolicy({
      isBotOwnedThread,
      requireMentionInBotThreads,
      requireMention: shouldRequireMention || oncharEnabled,
      implicitMentionKinds: implicitMentionKindWhen("bot_thread_participant", threadAlreadyEngaged),
    });
    const botThreadMentionRequired = isBotOwnedThread && requireMentionInBotThreads === true;
    const implicitMentions = resolveChannelImplicitMentions({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
    });
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        // Explicit bot-thread requirements stay closed when no mention detector is available.
        canDetectMention: canDetectMention || oncharEnabled || botThreadMentionRequired,
        wasMentioned: wasMentioned || oncharTriggered,
        implicitMentionKinds: botThreadPolicy.implicitMentionKinds,
      },
      policy: {
        isGroup: kind !== "direct",
        requireMention: botThreadPolicy.requireMention,
        implicitMentions,
        allowTextCommands,
        hasControlCommand: isControlCommand,
        commandAuthorized,
      },
    });
    const { shouldBypassMention } = mentionDecision;

    if (
      mentionDecision.shouldSkip &&
      oncharEnabled &&
      !oncharTriggered &&
      !wasMentioned &&
      !shouldBypassMention
    ) {
      monitor.logVerboseMessage(
        `mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`,
      );
      recordPendingHistory();
      return;
    }
    if (mentionDecision.shouldSkip) {
      logInboundDrop({
        log: monitor.runtime.log,
        channel: "mattermost",
        reason: "no mention",
        target: channelId,
        onceKey: JSON.stringify([account.accountId, channelId]),
        hint: `Mention patterns can be derived from the agent identity name. Set ${groupsConfigPath}[${JSON.stringify(channelId)}].${botThreadMentionRequired ? "requireMentionInBotThreads" : "requireMention"}=false to process messages without a mention. Preserve existing groups entries; when adding the first groups map, include "*": {} to keep other chats admitted.`,
      });
      recordPendingHistory();
      return;
    }
    // Thread participation and implicit mentions do not count here: two bots that both
    // replied in one thread would otherwise keep waking each other.
    if (
      isBotPost &&
      allowBots === "mentions" &&
      kind !== "direct" &&
      !wasMentioned &&
      !oncharTriggered
    ) {
      monitor.logVerboseMessage(
        `mattermost: drop bot post (allowBots=mentions, missing mention channel=${channelId} sender=${senderId})`,
      );
      recordPendingHistory();
      return;
    }

    const mediaList = await resolveMattermostMedia(fileIds);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = formatMattermostInboundMediaText({
      body: bodySource,
      nativeMedia,
      materializedMedia: mediaList,
    });
    const bodyText = normalizeMention(baseText, botUsername);
    if (
      mediaList.length === 0 &&
      shouldDropEmptyMattermostBody({ bodyText, rawText: rawPostText, botUsername })
    ) {
      monitor.logVerboseMessage(
        `mattermost: drop message (empty body after normalization channel=${channelId} sender=${senderId} wasMentioned=${wasMentioned})`,
      );
      return;
    }
    // Mention-only turns need non-empty agent text; the shared reply runner rejects empty
    // bodies before model invocation. The guard above ensures this fallback is a bot mention.
    const bodyForAgent = bodyText || rawText;
    core.channel.activity.record({
      channel: "mattermost",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: channelDisplay || roomLabel,
      groupId: channelId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId,
    });
    const textWithId = `${bodyText}\n[mattermost message id: ${post.id} channel: ${channelId}]`;
    const body = formatInboundEnvelope({
      channel: "Mattermost",
      from: fromLabel,
      timestamp: post.create_at ?? undefined,
      body: textWithId,
      chatType: kind,
      sender: { name: senderName, id: senderId },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    const backfill =
      historyKey && effectiveReplyToId
        ? await recoverThread({
            historyKey,
            threadRootId: effectiveReplyToId,
            currentPostId: post.id,
            currentPostTimestamp: post.create_at ?? 0,
            agentId: route.agentId,
            channelId,
            kind,
          })
        : undefined;
    // Preserve concurrent live posts in the shared window, but do not render the
    // trigger or a later post into this older turn's supplemental context.
    const turnHistories = new Map<string, HistoryEntry[]>(
      historyKey
        ? [
            [
              historyKey,
              (backfill?.history ?? channelHistories.get(historyKey) ?? [])
                .filter(
                  (entry) =>
                    !allMessageIds.includes(entry.messageId ?? "") &&
                    (entry.timestamp === undefined ||
                      post.create_at == null ||
                      entry.timestamp <= post.create_at),
                )
                .slice(-historyLimit),
            ],
          ]
        : [],
    );
    let combinedBody = body;
    if (historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: turnHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatInboundEnvelope({
            channel: "Mattermost",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
            }`,
            chatType: kind,
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      historyKey && historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: turnHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;
    const ctxPayload = core.channel.inbound.buildContext({
      channel: "mattermost",
      accountId: route.accountId,
      channelIngress: accessDecision,
      from: eventPlan.from,
      messageId: post.id,
      timestamp: post.create_at ?? undefined,
      sender: { id: senderId, name: senderName, isBot: isBotPost || undefined },
      conversation: {
        kind,
        id: channelId,
        nativeChannelId: channelId,
        routePeer: { kind, id: kind === "direct" ? senderId : channelId },
        label: fromLabel,
        spaceId: eventPlan.teamId,
        threadId: effectiveReplyToId,
      },
      route: {
        ...route,
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: sessionKey,
        parentSessionKey: thread.parentSessionKey,
      },
      reply: {
        to: eventPlan.to,
        replyToId: effectiveReplyToId,
        messageThreadId: effectiveReplyToId,
      },
      message: {
        body: combinedBody,
        bodyForAgent,
        rawBody: commandBody,
        commandBody,
        inboundHistory,
      },
      access: {
        commands: accessDecision.commandAccess,
      },
      media: await toInboundMediaFactsWithMetadata(mediaList),
      extra: {
        GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
        GroupChannel: eventPlan.channelName ? `#${eventPlan.channelName}` : undefined,
        WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : undefined,
        MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
        MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
        MessageSidLast:
          allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
        // Typed slash commands retain their explicit-command acknowledgment behavior.
        CommandSource: commandAuthorized && isControlCommand ? ("text" as const) : undefined,
      },
    });
    const pinnedMainDmOwner =
      kind === "direct"
        ? resolvePinnedMainDmOwnerFromAllowlist({
            dmScope: cfg.session?.dmScope,
            allowFrom: account.config.allowFrom,
            normalizeEntry: normalizeMattermostAllowEntry,
          })
        : null;
    monitor.logVerboseMessage(
      `mattermost inbound: from=${ctxPayload.From} id=${post.id} len=${bodyText.length}`,
    );
    const botLoopProtection: ChannelBotLoopProtectionFacts | undefined = isBotPost
      ? {
          scopeId: account.accountId,
          conversationId: channelId,
          senderId,
          receiverId: botUserId,
          eventId: post.id,
          config: mergePairLoopGuardConfig(
            account.config.botLoopProtection,
            wildcardBotConfig?.botLoopProtection,
            channelBotConfig?.botLoopProtection,
          ),
          defaultsConfig: cfg.channels?.defaults?.botLoopProtection,
          defaultEnabled: true,
          nowMs: post.create_at ?? undefined,
        }
      : undefined;

    await dispatchMattermostInboundTurn(monitor, {
      post,
      rawText,
      ctxPayload,
      eventPlan,
      historyKey,
      historyLimit,
      channelHistories,
      pinnedMainDmOwner,
      botLoopProtection,
      turnAdoptionLifecycle,
    });
  };
}
