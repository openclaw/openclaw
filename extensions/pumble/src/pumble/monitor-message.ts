import type {
  ChannelAccountSnapshot,
  HistoryEntry,
  OpenClawConfig,
  PluginRuntime,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  DM_GROUP_ACCESS_REASON,
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  logAckFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveAckReaction,
} from "openclaw/plugin-sdk";
import { clearPumbleThreadContext, setPumbleThreadContext } from "../runtime.js";
import type { PumbleAccountConfig } from "../types.js";
import type { ResolvedPumbleAccount } from "./accounts.js";
import { toPumbleShortcode } from "./emoji.js";
import {
  buildPumbleAttachmentPlaceholder,
  resolvePumbleMedia,
  type PumbleNotificationMessageFile,
} from "./media.js";
import { isPumbleSenderAllowed, resolvePumbleAccessDecision } from "./monitor-auth.js";
import {
  channelChatType,
  channelKind,
  type createDedupeCache,
  formatInboundFromLabel,
  normalizeMention,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import { addPumbleReaction, removePumbleReaction } from "./reactions.js";
import { sendMessagePumble } from "./send.js";
import { getPumbleThreadBindingManager } from "./thread-bindings.manager.js";

// Re-export types that monitor.ts imports from here
export type { PumbleNotificationMessageFile } from "./media.js";

export type HandlePumbleMessageDeps = {
  core: PluginRuntime;
  account: ResolvedPumbleAccount;
  botToken: string;
  cfg: OpenClawConfig;
  runtime: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  groupPolicy: string;
  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  mediaMaxBytes: number | undefined;
  logVerboseMessage: (msg: string) => void;
  logger: { debug?: (msg: string) => void };
  resolveBotId: () => Promise<string | null>;
  resolveBotUsername: () => Promise<string | undefined>;
  pairing: {
    readStoreForDmPolicy: (
      provider: string,
      acctId: string,
    ) => ReturnType<PluginRuntime["channel"]["pairing"]["readAllowFromStore"]>;
    upsertPairingRequest: (input: {
      id: string;
      meta: { name: string };
    }) => Promise<{ code: string; created: boolean }>;
  };
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  recentInboundMessages: ReturnType<typeof createDedupeCache>;
};

export function createHandlePumbleMessage(deps: HandlePumbleMessageDeps) {
  const {
    core,
    account,
    botToken,
    cfg,
    runtime,
    groupPolicy,
    historyLimit,
    channelHistories,
    mediaMaxBytes,
    logVerboseMessage,
    logger,
    resolveBotId,
    resolveBotUsername,
    pairing,
    statusSink,
    recentInboundMessages,
  } = deps;

  // Pre-compute normalized channel allowlist (static config, no need to recalculate per message)
  const rawAllowlist = account.channelAllowlist ?? [];
  const normalizedChannelAllowlist = rawAllowlist.map((c) => c.trim().toLowerCase());

  return async (evt: {
    messageId: string;
    channelId: string;
    channelType?: string;
    senderId: string;
    senderName?: string;
    text: string;
    threadRootId?: string;
    timestamp?: number;
    isEphemeral?: boolean;
    isSystem?: boolean;
    files?: PumbleNotificationMessageFile[];
  }) => {
    if (evt.isEphemeral) {
      return;
    }

    // Note: system messages are pre-filtered by the SDK handler in monitor.ts
    // before this function is called. No need to check evt.isSystem here.

    // Dedupe check first — pure in-memory O(1) lookup, avoids async work on replays.
    const dedupeKey = `${account.accountId}:${evt.messageId}`;
    if (recentInboundMessages.check(dedupeKey)) {
      return;
    }

    // Skip bot's own messages to prevent echo loops.
    const botId = await resolveBotId();
    if (botId && evt.senderId === botId) {
      logVerboseMessage(`pumble: drop self-message from bot ${botId}`);
      return;
    }

    const kind = channelKind(evt.channelType);
    const chatType = channelChatType(kind);
    const senderId = evt.senderId;
    const senderName = evt.senderName || senderId;
    const rawText = evt.text?.trim() || "";
    const channelId = evt.channelId;
    const threadRootId = evt.threadRootId?.trim() || undefined;

    // Channel allowlist check
    if (normalizedChannelAllowlist.length > 0 && kind !== "direct") {
      if (!normalizedChannelAllowlist.includes(channelId.toLowerCase())) {
        logVerboseMessage(`pumble: drop message (channel ${channelId} not in allowlist)`);
        return;
      }
    }

    // DM/group policy enforcement
    const accessDecision = await resolvePumbleAccessDecision({
      accountConfig: account.config,
      accountId: account.accountId,
      readStoreForDmPolicy: pairing.readStoreForDmPolicy,
      kind,
      groupPolicy,
      senderId,
      senderName,
    });

    const { dmPolicy, normalizedAllowFrom, effectiveAllowFrom, effectiveGroupAllowFrom } =
      accessDecision;
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "pumble",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
    const senderAllowedForCommands = isPumbleSenderAllowed({
      senderId,
      senderName,
      allowFrom: commandDmAllowFrom,
    });
    const groupAllowedForCommands = isPumbleSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllowFrom.length > 0, allowed: senderAllowedForCommands },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized = commandGate.commandAuthorized;

    if (accessDecision.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
          logVerboseMessage(`pumble: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`pumble: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessagePumble(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "pumble",
                  idLine: `Your Pumble user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`pumble: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
          return;
        }
        logVerboseMessage(`pumble: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerboseMessage("pumble: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerboseMessage("pumble: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerboseMessage(`pumble: drop group sender=${senderId} (not in groupAllowFrom)`);
        return;
      }
      logVerboseMessage(
        `pumble: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`,
      );
      return;
    }

    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "pumble",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    // Mention detection
    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "pumble",
      accountId: account.accountId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : channelId,
      },
    });

    // Thread binding override: if this message is in a bound thread, route to bound subagent
    let isBoundThreadSession = false;
    let boundThreadLabel: string | undefined;
    if (threadRootId) {
      const manager = getPumbleThreadBindingManager(account.accountId);
      const binding = manager?.getByThreadRootId(threadRootId);
      if (binding) {
        // Self-correct channelId when the webhook provides the authoritative value
        // Self-correct channelId — direct mutation is safe here because the
        // binding record is the live reference from BINDINGS_BY_THREAD_ROOT_ID
        // and no derived indexes depend on channelId. The corrected value will
        // be persisted on the next saveBindingsToDisk() call.
        if (binding.channelId !== channelId) {
          binding.channelId = channelId;
        }
        route = { ...route, sessionKey: binding.targetSessionKey, agentId: binding.agentId };
        isBoundThreadSession = true;
        boundThreadLabel = binding.label;
      }
    }

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    // Detect Pumble-native <<@userId>> mention format in addition to generic mention patterns
    const pumbleMentionDetected =
      kind !== "direct" && botId ? rawText.includes(`<<@${botId}>>`) : false;
    const wasMentioned =
      pumbleMentionDetected ||
      (kind !== "direct" && core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    // Trigger prefix (onchar mode)
    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;

    const isControlCommand = allowTextCommands && hasControlCommand;
    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "pumble",
        accountId: account.accountId,
        groupId: channelId,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = mentionRegexes.length > 0 || Boolean(botId);

    const baseSessionKey = route.sessionKey;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      threadId: threadRootId,
      parentSessionKey: threadRootId ? baseSessionKey : undefined,
    });
    const sessionKey = threadKeys.sessionKey;
    const historyKey = kind === "direct" ? null : sessionKey;

    const recordPendingHistory = () => {
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && rawText
            ? {
                sender: senderName,
                body: rawText,
                timestamp: evt.timestamp,
                messageId: evt.messageId,
              }
            : null,
      });
    };

    if (
      kind !== "direct" &&
      shouldRequireMention &&
      (canDetectMention || oncharEnabled) &&
      !isBoundThreadSession
    ) {
      if (!effectiveWasMentioned) {
        recordPendingHistory();
        return;
      }
    }

    // Strip bot mention from message text (both <<@userId>> and @displayName formats)
    const botUsername = await resolveBotUsername();
    const baseText = oncharTriggered ? oncharResult.stripped : rawText;
    const bodyText = normalizeMention(baseText, botUsername, botId);
    if (!bodyText) {
      return;
    }

    // Resolve inbound media attachments
    const mediaList = await resolvePumbleMedia(evt.files, {
      botToken,
      appKey: account.appKey?.trim(),
      core,
      mediaMaxBytes,
      logVerboseMessage,
    });
    const mediaPlaceholder = buildPumbleAttachmentPlaceholder(mediaList);
    const mediaPayload = mediaList.length > 0 ? buildAgentMediaPayload(mediaList) : undefined;

    core.channel.activity.record({
      channel: "pumble",
      accountId: account.accountId,
      direction: "inbound",
    });

    // Ack reaction: react with 👀 (eyes) to acknowledge the message
    const ackReaction = resolveAckReaction(cfg, route.agentId, {
      channel: "pumble",
      accountId: account.accountId,
    });
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const shouldAck =
      ackReaction &&
      core.channel.reactions.shouldAckReaction({
        scope: ackReactionScope,
        isDirect: kind === "direct",
        isGroup: kind !== "direct",
        isMentionableGroup: kind !== "direct",
        requireMention: Boolean(shouldRequireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      });
    const ackEmojiName = shouldAck ? toPumbleShortcode(ackReaction) : null;
    const ackReactionPromise =
      shouldAck && ackEmojiName
        ? addPumbleReaction({
            cfg,
            messageId: evt.messageId,
            emojiName: ackEmojiName,
            accountId: account.accountId,
          })
            .then((r) => {
              runtime.log?.(
                `pumble: ack reaction ${r.ok ? "added" : "failed"} (emoji=${ackEmojiName} msg=${evt.messageId}${!r.ok && "error" in r ? ` err=${r.error}` : ""})`,
              );
              return r.ok;
            })
            .catch((err) => {
              logAckFailure({
                log: logVerboseMessage,
                channel: "pumble",
                target: `${channelId}/${evt.messageId}`,
                error: err,
              });
              return false;
            })
        : null;
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? true;

    const roomLabel = `#${channelId}`;
    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: roomLabel,
      groupId: channelId,
      groupFallback: roomLabel,
      directLabel: senderName,
      directId: senderId,
    });

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Pumble DM from ${senderName}`
        : `Pumble message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `pumble:message:${channelId}:${evt.messageId}`,
    });

    const bodyWithMedia = mediaPlaceholder ? `${bodyText}\n${mediaPlaceholder}` : bodyText;
    const textWithId = `${bodyWithMedia}\n[pumble message id: ${evt.messageId} channel: ${channelId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Pumble",
      from: fromLabel,
      timestamp: evt.timestamp,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderId },
    });
    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Pumble",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
            }`,
            chatType,
            senderLabel: entry.sender,
          }),
      });
    }

    const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
    // Store thread context so the before_tool_call hook can auto-inject
    // replyTo for agent message tool sends targeting this thread.
    // Clear when not in a thread so stale context doesn't leak.
    if (threadRootId) {
      setPumbleThreadContext(sessionKey, { to: to.toLowerCase(), threadRootId });
    } else {
      clearPumbleThreadContext(sessionKey);
    }
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From:
        kind === "direct"
          ? `pumble:${senderId}`
          : kind === "group"
            ? `pumble:group:${channelId}`
            : `pumble:channel:${channelId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: threadKeys.parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? roomLabel : undefined,
      GroupChannel: kind !== "direct" ? roomLabel : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "pumble" as const,
      Surface: "pumble" as const,
      MessageSid: evt.messageId,
      ReplyToId: threadRootId ?? evt.messageId,
      MessageThreadId: threadRootId ?? evt.messageId,
      Timestamp: evt.timestamp,
      WasMentioned: kind !== "direct" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "pumble" as const,
      OriginatingTo: to,
      ...mediaPayload,
    });

    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "pumble",
          to,
          accountId: route.accountId,
        },
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `pumble inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "pumble", account.accountId, {
      fallbackLimit: account.textChunkLimit ?? 9000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "pumble",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "pumble",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        // Pumble SDK doesn't expose a typing indicator API via REST;
        // the AddonWebsocketListener would need to handle this.
        // No-op for now.
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "pumble",
          target: channelId,
          error: err,
        });
      },
    });
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        typingCallbacks,
        deliver: async (payload: ReplyPayload) => {
          const replyToId = threadRootId ?? evt.messageId;
          const labelSuffix =
            isBoundThreadSession && boundThreadLabel ? ` [${boundThreadLabel}]` : "";

          // Handle media (images, files) from agent tool results
          const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          if (mediaList.length > 0) {
            for (let i = 0; i < mediaList.length; i++) {
              // Attach text caption to the first media item only
              let caption = i === 0 ? (payload.text ?? "") : "";
              // Append label suffix to the last media item
              if (labelSuffix && i === mediaList.length - 1) {
                caption += labelSuffix;
              }
              await sendMessagePumble(to, caption, {
                accountId: account.accountId,
                replyToId,
                mediaUrl: mediaList[i],
              });
            }
          } else {
            // Text-only reply (no media)
            const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "pumble", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            const resolved = chunks.length > 0 ? chunks : [text];
            for (let i = 0; i < resolved.length; i++) {
              let chunk = resolved[i];
              if (!chunk) {
                continue;
              }
              // Append label suffix to the last chunk
              if (labelSuffix && i === resolved.length - 1) {
                chunk += labelSuffix;
              }
              await sendMessagePumble(to, chunk, {
                accountId: account.accountId,
                replyToId,
              });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`pumble ${info.kind} reply failed: ${String(err)}`);
        },
      });

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
        // Remove ack reaction after reply is delivered
        runtime.log?.(
          `pumble: onSettled — removeAckAfterReply=${removeAckAfterReply} ackEmojiName=${ackEmojiName} hasPromise=${!!ackReactionPromise}`,
        );
        if (removeAckAfterReply && ackEmojiName) {
          core.channel.reactions.removeAckReactionAfterReply({
            removeAfterReply: removeAckAfterReply,
            ackReactionPromise,
            ackReactionValue: ackEmojiName,
            remove: async () => {
              runtime.log?.(`pumble: removing ack reaction ${ackEmojiName} from ${evt.messageId}`);
              const result = await removePumbleReaction({
                cfg,
                messageId: evt.messageId,
                emojiName: ackEmojiName,
                accountId: account.accountId,
              });
              runtime.log?.(`pumble: remove ack reaction result: ${JSON.stringify(result)}`);
            },
            onError: (err) => {
              runtime.log?.(
                `pumble: remove ack reaction failed for ${evt.messageId}: ${String(err)}`,
              );
            },
          });
        }
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        }),
    });
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };
}
