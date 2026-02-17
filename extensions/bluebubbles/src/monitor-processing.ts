import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  logAckFailure,
  logInboundDrop,
  logTypingFailure,
  resolveAckReaction,
  resolveControlCommandGate,
} from "openclaw/plugin-sdk";
import type {
  BlueBubblesCoreRuntime,
  BlueBubblesRuntimeEnv,
  WebhookTarget,
} from "./monitor-shared.js";
import { downloadBlueBubblesAttachment } from "./attachments.js";
import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import {
  buildMessagePlaceholder,
  formatGroupAllowlistEntry,
  formatGroupMembers,
  formatReplyTag,
  parseTapbackText,
  resolveGroupFlagFromChatGuid,
  resolveTapbackContext,
  type NormalizedWebhookMessage,
  type NormalizedWebhookReaction,
} from "./monitor-normalize.js";
import {
  getShortIdForUuid,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
  resolveReplyContextFromCache,
} from "./monitor-reply-cache.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { normalizeBlueBubblesReactionInput, sendBlueBubblesReaction } from "./reactions.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import { formatBlueBubblesChatTarget, isAllowedBlueBubblesSender } from "./targets.js";

const DEFAULT_TEXT_LIMIT = 4000;
const invalidAckReactions = new Set<string>();
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;

export function logVerbose(
  core: BlueBubblesCoreRuntime,
  runtime: BlueBubblesRuntimeEnv,
  message: string,
): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[bluebubbles] ${message}`);
  }
}

function logGroupAllowlistHint(params: {
  runtime: BlueBubblesRuntimeEnv;
  reason: string;
  entry: string | null;
  chatName?: string;
  accountId?: string;
}): void {
  const log = params.runtime.log ?? console.log;
  const nameHint = params.chatName ? ` (group name: ${params.chatName})` : "";
  const accountHint = params.accountId
    ? ` (or channels.bluebubbles.accounts.${params.accountId}.groupAllowFrom)`
    : "";
  if (params.entry) {
    log(
      `[bluebubbles] group message blocked (${params.reason}). Allow this group by adding ` +
        `"${params.entry}" to channels.bluebubbles.groupAllowFrom${nameHint}.`,
    );
    log(
      `[bluebubbles] add to config: channels.bluebubbles.groupAllowFrom=["${params.entry}"]${accountHint}.`,
    );
    return;
  }
  log(
    `[bluebubbles] group message blocked (${params.reason}). Allow groups by setting ` +
      `channels.bluebubbles.groupPolicy="open" or adding a group id to ` +
      `channels.bluebubbles.groupAllowFrom${accountHint}${nameHint}.`,
  );
}

function resolveBlueBubblesAckReaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  core: BlueBubblesCoreRuntime;
  runtime: BlueBubblesRuntimeEnv;
}): string | null {
  const raw = resolveAckReaction(params.cfg, params.agentId).trim();
  if (!raw) {
    return null;
  }
  try {
    normalizeBlueBubblesReactionInput(raw);
    return raw;
  } catch {
    const key = raw.toLowerCase();
    if (!invalidAckReactions.has(key)) {
      invalidAckReactions.add(key);
      logVerbose(
        params.core,
        params.runtime,
        `ack reaction skipped (unsupported for BlueBubbles): ${raw}`,
      );
    }
    return null;
  }
}

export async function processMessage(
  message: NormalizedWebhookMessage,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;
  const privateApiEnabled = getCachedBlueBubblesPrivateApiStatus(account.accountId) !== false;

  const groupFlag = resolveGroupFlagFromChatGuid(message.chatGuid);
  const isGroup = typeof groupFlag === "boolean" ? groupFlag : message.isGroup;

  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  const placeholder = buildMessagePlaceholder(message);
  // Check if text is a tapback pattern (e.g., 'Loved "hello"') and transform to emoji format
  // For tapbacks, we'll append [[reply_to:N]] at the end; for regular messages, prepend it
  const tapbackContext = resolveTapbackContext(message);
  const tapbackParsed = parseTapbackText({
    text,
    emojiHint: tapbackContext?.emojiHint,
    actionHint: tapbackContext?.actionHint,
    requireQuoted: !tapbackContext,
  });
  const isTapbackMessage = Boolean(tapbackParsed);
  const rawBody = tapbackParsed
    ? tapbackParsed.action === "removed"
      ? `removed ${tapbackParsed.emoji} reaction`
      : `reacted with ${tapbackParsed.emoji}`
    : text || placeholder;

  const cacheMessageId = message.messageId?.trim();
  let messageShortId: string | undefined;
  const cacheInboundMessage = () => {
    if (!cacheMessageId) {
      return;
    }
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: cacheMessageId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId,
      senderLabel: message.fromMe ? "me" : message.senderId,
      body: rawBody,
      timestamp: message.timestamp ?? Date.now(),
    });
    messageShortId = cacheEntry.shortId;
  };

  if (message.fromMe) {
    // Cache from-me messages so reply context can resolve sender/body.
    cacheInboundMessage();
    return;
  }

  if (!rawBody) {
    logVerbose(core, runtime, `drop: empty text sender=${message.senderId}`);
    return;
  }
  logVerbose(
    core,
    runtime,
    `msg sender=${message.senderId} group=${isGroup} textLen=${text.length} attachments=${attachments.length} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
  );

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore("bluebubbles")
    .catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const effectiveGroupAllowFrom = [
    ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
    ...storeAllowFrom,
  ]
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const groupAllowEntry = formatGroupAllowlistEntry({
    chatGuid: message.chatGuid,
    chatId: message.chatId ?? undefined,
    chatIdentifier: message.chatIdentifier ?? undefined,
  });
  const groupName = message.chatName?.trim() || undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
      logGroupAllowlistHint({
        runtime,
        reason: "groupPolicy=disabled",
        entry: groupAllowEntry,
        chatName: groupName,
        accountId: account.accountId,
      });
      return;
    }
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        logVerbose(core, runtime, "Blocked BlueBubbles group message (no allowlist)");
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (empty allowlist)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId,
        });
        return;
      }
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveGroupAllowFrom,
        sender: message.senderId,
        chatId: message.chatId ?? undefined,
        chatGuid: message.chatGuid ?? undefined,
        chatIdentifier: message.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        logVerbose(
          core,
          runtime,
          `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`,
        );
        logVerbose(
          core,
          runtime,
          `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`,
        );
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (not allowlisted)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId,
        });
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
      logVerbose(core, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
      return;
    }
    if (dmPolicy !== "open") {
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveAllowFrom,
        sender: message.senderId,
        chatId: message.chatId ?? undefined,
        chatGuid: message.chatGuid ?? undefined,
        chatIdentifier: message.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "bluebubbles",
            id: message.senderId,
            meta: { name: message.senderName },
          });
          runtime.log?.(
            `[bluebubbles] pairing request sender=${message.senderId} created=${created}`,
          );
          if (created) {
            logVerbose(core, runtime, `bluebubbles pairing request sender=${message.senderId}`);
            try {
              await sendMessageBlueBubbles(
                message.senderId,
                core.channel.pairing.buildPairingReply({
                  channel: "bluebubbles",
                  idLine: `Your BlueBubbles sender id: ${message.senderId}`,
                  code,
                }),
                { cfg: config, accountId: account.accountId },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `bluebubbles pairing reply failed for ${message.senderId}: ${String(err)}`,
              );
              runtime.error?.(
                `[bluebubbles] pairing reply failed sender=${message.senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`,
          );
          logVerbose(
            core,
            runtime,
            `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`,
          );
        }
        return;
      }
    }
  }

  const chatId = message.chatId ?? undefined;
  const chatGuid = message.chatGuid ?? undefined;
  const chatIdentifier = message.chatIdentifier ?? undefined;
  const peerId = isGroup
    ? (chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group"))
    : message.senderId;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  // Mention gating for group chats (parity with iMessage/WhatsApp)
  const messageText = text;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionPatterns(messageText, mentionRegexes)
    : true;
  const canDetectMention = mentionRegexes.length > 0;
  const requireMention = core.channel.groups.resolveRequireMention({
    cfg: config,
    channel: "bluebubbles",
    groupId: peerId,
    accountId: account.accountId,
  });

  // Command gating (parity with iMessage/WhatsApp)
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const hasControlCmd = core.channel.text.hasControlCommand(messageText, config);
  const ownerAllowedForCommands =
    effectiveAllowFrom.length > 0
      ? isAllowedBlueBubblesSender({
          allowFrom: effectiveAllowFrom,
          sender: message.senderId,
          chatId: message.chatId ?? undefined,
          chatGuid: message.chatGuid ?? undefined,
          chatIdentifier: message.chatIdentifier ?? undefined,
        })
      : false;
  const groupAllowedForCommands =
    effectiveGroupAllowFrom.length > 0
      ? isAllowedBlueBubblesSender({
          allowFrom: effectiveGroupAllowFrom,
          sender: message.senderId,
          chatId: message.chatId ?? undefined,
          chatGuid: message.chatGuid ?? undefined,
          chatIdentifier: message.chatIdentifier ?? undefined,
        })
      : false;
  const dmAuthorized = dmPolicy === "open" || ownerAllowedForCommands;
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: effectiveAllowFrom.length > 0, allowed: ownerAllowedForCommands },
      { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCmd,
  });
  const commandAuthorized = isGroup ? commandGate.commandAuthorized : dmAuthorized;

  // Block control commands from unauthorized senders in groups
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (msg) => logVerbose(core, runtime, msg),
      channel: "bluebubbles",
      reason: "control command (unauthorized)",
      target: message.senderId,
    });
    return;
  }

  // Allow control commands to bypass mention gating when authorized (parity with iMessage)
  const shouldBypassMention =
    isGroup && requireMention && !wasMentioned && commandAuthorized && hasControlCmd;
  const effectiveWasMentioned = wasMentioned || shouldBypassMention;

  // Skip group messages that require mention but weren't mentioned
  if (isGroup && requireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
    logVerbose(core, runtime, `bluebubbles: skipping group message (no mention)`);
    return;
  }

  // Cache allowed inbound messages so later replies can resolve sender/body without
  // surfacing dropped content (allowlist/mention/command gating).
  cacheInboundMessage();

  const baseUrl = account.config.serverUrl?.trim();
  const password = account.config.password?.trim();
  const maxBytes =
    account.config.mediaMaxMb && account.config.mediaMaxMb > 0
      ? account.config.mediaMaxMb * 1024 * 1024
      : 8 * 1024 * 1024;

  let mediaUrls: string[] = [];
  let mediaPaths: string[] = [];
  let mediaTypes: string[] = [];
  if (attachments.length > 0) {
    if (!baseUrl || !password) {
      logVerbose(core, runtime, "attachment download skipped (missing serverUrl/password)");
    } else {
      for (const attachment of attachments) {
        if (!attachment.guid) {
          continue;
        }
        if (attachment.totalBytes && attachment.totalBytes > maxBytes) {
          logVerbose(
            core,
            runtime,
            `attachment too large guid=${attachment.guid} bytes=${attachment.totalBytes}`,
          );
          continue;
        }
        try {
          const downloaded = await downloadBlueBubblesAttachment(attachment, {
            cfg: config,
            accountId: account.accountId,
            maxBytes,
          });
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(downloaded.buffer),
            downloaded.contentType,
            "inbound",
            maxBytes,
          );
          mediaPaths.push(saved.path);
          mediaUrls.push(saved.path);
          if (saved.contentType) {
            mediaTypes.push(saved.contentType);
          }
        } catch (err) {
          logVerbose(
            core,
            runtime,
            `attachment download failed guid=${attachment.guid} err=${String(err)}`,
          );
        }
      }
    }
  }
  let replyToId = message.replyToId;
  let replyToBody = message.replyToBody;
  let replyToSender = message.replyToSender;
  let replyToShortId: string | undefined;

  if (isTapbackMessage && tapbackContext?.replyToId) {
    replyToId = tapbackContext.replyToId;
  }

  if (replyToId) {
    const cached = resolveReplyContextFromCache({
      accountId: account.accountId,
      replyToId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId,
    });
    if (cached) {
      if (!replyToBody && cached.body) {
        replyToBody = cached.body;
      }
      if (!replyToSender && cached.senderLabel) {
        replyToSender = cached.senderLabel;
      }
      replyToShortId = cached.shortId;
      if (core.logging.shouldLogVerbose()) {
        const preview = (cached.body ?? "").replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          core,
          runtime,
          `reply-context cache hit replyToId=${replyToId} sender=${replyToSender ?? ""} body="${preview}"`,
        );
      }
    }
  }

  // If no cached short ID, try to get one from the UUID directly
  if (replyToId && !replyToShortId) {
    replyToShortId = getShortIdForUuid(replyToId);
  }

  // Use inline [[reply_to:N]] tag format
  // For tapbacks/reactions: append at end (e.g., "reacted with ❤️ [[reply_to:4]]")
  // For regular replies: prepend at start (e.g., "[[reply_to:4]] Awesome")
  const replyTag = formatReplyTag({ replyToId, replyToShortId });
  const baseBody = replyTag
    ? isTapbackMessage
      ? `${rawBody} ${replyTag}`
      : `${replyTag} ${rawBody}`
    : rawBody;
  // Build fromLabel the same way as iMessage/Signal (formatInboundFromLabel):
  // group label + id for groups, sender for DMs.
  // The sender identity is included in the envelope body via formatInboundEnvelope.
  const senderLabel = message.senderName || `user:${message.senderId}`;
  const fromLabel = isGroup
    ? `${message.chatName?.trim() || "Group"} id:${peerId}`
    : senderLabel !== message.senderId
      ? `${senderLabel} id:${message.senderId}`
      : senderLabel;
  const groupSubject = isGroup ? message.chatName?.trim() || undefined : undefined;
  const groupMembers = isGroup
    ? formatGroupMembers({
        participants: message.participants,
        fallback: message.senderId ? { id: message.senderId, name: message.senderName } : undefined,
      })
    : undefined;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "BlueBubbles",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: baseBody,
    chatType: isGroup ? "group" : "direct",
    sender: { name: message.senderName || undefined, id: message.senderId },
  });
  let chatGuidForActions = chatGuid;
  if (!chatGuidForActions && baseUrl && password) {
    const resolveTarget =
      isGroup && (chatId || chatIdentifier)
        ? chatId
          ? ({ kind: "chat_id", chatId } as const)
          : ({ kind: "chat_identifier", chatIdentifier: chatIdentifier ?? "" } as const)
        : ({ kind: "handle", address: message.senderId } as const);
    if (resolveTarget.kind !== "chat_identifier" || resolveTarget.chatIdentifier) {
      chatGuidForActions =
        (await resolveChatGuidForTarget({
          baseUrl,
          password,
          target: resolveTarget,
        })) ?? undefined;
    }
  }

  const ackReactionScope = config.messages?.ackReactionScope ?? "group-mentions";
  const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;
  const ackReactionValue = resolveBlueBubblesAckReaction({
    cfg: config,
    agentId: route.agentId,
    core,
    runtime,
  });
  const shouldAckReaction = () =>
    Boolean(
      ackReactionValue &&
      core.channel.reactions.shouldAckReaction({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const ackMessageId = message.messageId?.trim() || "";
  const ackReactionPromise =
    shouldAckReaction() && ackMessageId && chatGuidForActions && ackReactionValue
      ? sendBlueBubblesReaction({
          chatGuid: chatGuidForActions,
          messageGuid: ackMessageId,
          emoji: ackReactionValue,
          opts: { cfg: config, accountId: account.accountId },
        }).then(
          () => true,
          (err) => {
            logVerbose(
              core,
              runtime,
              `ack reaction failed chatGuid=${chatGuidForActions} msg=${ackMessageId}: ${String(err)}`,
            );
            return false;
          },
        )
      : null;

  // Respect sendReadReceipts config (parity with WhatsApp)
  const sendReadReceipts = account.config.sendReadReceipts !== false;
  if (chatGuidForActions && baseUrl && password && sendReadReceipts) {
    try {
      await markBlueBubblesChatRead(chatGuidForActions, {
        cfg: config,
        accountId: account.accountId,
      });
      logVerbose(core, runtime, `marked read chatGuid=${chatGuidForActions}`);
    } catch (err) {
      runtime.error?.(`[bluebubbles] mark read failed: ${String(err)}`);
    }
  } else if (!sendReadReceipts) {
    logVerbose(core, runtime, "mark read skipped (sendReadReceipts=false)");
  } else {
    logVerbose(core, runtime, "mark read skipped (missing chatGuid or credentials)");
  }

  const outboundTarget = isGroup
    ? formatBlueBubblesChatTarget({
        chatId,
        chatGuid: chatGuidForActions ?? chatGuid,
        chatIdentifier,
      }) || peerId
    : chatGuidForActions
      ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions })
      : message.senderId;

  const maybeEnqueueOutboundMessageId = (messageId?: string, snippet?: string) => {
    const trimmed = messageId?.trim();
    if (!trimmed || trimmed === "ok" || trimmed === "unknown") {
      return;
    }
    // Cache outbound message to get short ID
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: trimmed,
      chatGuid: chatGuidForActions ?? chatGuid,
      chatIdentifier,
      chatId,
      senderLabel: "me",
      body: snippet ?? "",
      timestamp: Date.now(),
    });
    const displayId = cacheEntry.shortId || trimmed;
    const preview = snippet ? ` "${snippet.slice(0, 12)}${snippet.length > 12 ? "…" : ""}"` : "";
    core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
      sessionKey: route.sessionKey,
      contextKey: `bluebubbles:outbound:${outboundTarget}:${trimmed}`,
    });
  };
  const sanitizeReplyDirectiveText = (value: string): string => {
    if (privateApiEnabled) {
      return value;
    }
    return value
      .replace(REPLY_DIRECTIVE_TAG_RE, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  };

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    BodyForCommands: rawBody,
    MediaUrl: mediaUrls[0],
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    From: isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
    To: `bluebubbles:${outboundTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    // Use short ID for token savings (agent can use this to reference the message)
    ReplyToId: replyToShortId || replyToId,
    ReplyToIdFull: replyToId,
    ReplyToBody: replyToBody,
    ReplyToSender: replyToSender,
    GroupSubject: groupSubject,
    GroupMembers: groupMembers,
    SenderName: message.senderName || undefined,
    SenderId: message.senderId,
    Provider: "bluebubbles",
    Surface: "bluebubbles",
    // Use short ID for token savings (agent can use this to reference the message)
    MessageSid: messageShortId || message.messageId,
    MessageSidFull: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: "bluebubbles",
    OriginatingTo: `bluebubbles:${outboundTarget}`,
    WasMentioned: effectiveWasMentioned,
    CommandAuthorized: commandAuthorized,
  });

  let sentMessage = false;
  let streamingActive = false;
  let typingRestartTimer: NodeJS.Timeout | undefined;
  const typingRestartDelayMs = 150;
  const clearTypingRestartTimer = () => {
    if (typingRestartTimer) {
      clearTimeout(typingRestartTimer);
      typingRestartTimer = undefined;
    }
  };
  const restartTypingSoon = () => {
    if (!streamingActive || !chatGuidForActions || !baseUrl || !password) {
      return;
    }
    clearTypingRestartTimer();
    typingRestartTimer = setTimeout(() => {
      typingRestartTimer = undefined;
      if (!streamingActive) {
        return;
      }
      sendBlueBubblesTyping(chatGuidForActions, true, {
        cfg: config,
        accountId: account.accountId,
      }).catch((err) => {
        runtime.error?.(`[bluebubbles] typing restart failed: ${String(err)}`);
      });
    }, typingRestartDelayMs);
  };
  try {
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: config,
      agentId: route.agentId,
      channel: "bluebubbles",
      accountId: account.accountId,
    });
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          const rawReplyToId =
            privateApiEnabled && typeof payload.replyToId === "string"
              ? payload.replyToId.trim()
              : "";
          // Resolve short ID (e.g., "5") to full UUID
          const replyToMessageGuid = rawReplyToId
            ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true })
            : "";
          const mediaList = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
          if (mediaList.length > 0) {
            const tableMode = core.channel.text.resolveMarkdownTableMode({
              cfg: config,
              channel: "bluebubbles",
              accountId: account.accountId,
            });
            const text = sanitizeReplyDirectiveText(
              core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
            );
            let first = true;
            for (const mediaUrl of mediaList) {
              const caption = first ? text : undefined;
              first = false;
              const result = await sendBlueBubblesMedia({
                cfg: config,
                to: outboundTarget,
                mediaUrl,
                caption: caption ?? undefined,
                replyToId: replyToMessageGuid || null,
                accountId: account.accountId,
              });
              const cachedBody = (caption ?? "").trim() || "<media:attachment>";
              maybeEnqueueOutboundMessageId(result.messageId, cachedBody);
              sentMessage = true;
              statusSink?.({ lastOutboundAt: Date.now() });
              if (info.kind === "block") {
                restartTypingSoon();
              }
            }
            return;
          }

          const textLimit =
            account.config.textChunkLimit && account.config.textChunkLimit > 0
              ? account.config.textChunkLimit
              : DEFAULT_TEXT_LIMIT;
          const chunkMode = account.config.chunkMode ?? "length";
          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "bluebubbles",
            accountId: account.accountId,
          });
          const text = sanitizeReplyDirectiveText(
            core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
          );
          const chunks =
            chunkMode === "newline"
              ? core.channel.text.chunkTextWithMode(text, textLimit, chunkMode)
              : core.channel.text.chunkMarkdownText(text, textLimit);
          if (!chunks.length && text) {
            chunks.push(text);
          }
          if (!chunks.length) {
            return;
          }
          for (const chunk of chunks) {
            const result = await sendMessageBlueBubbles(outboundTarget, chunk, {
              cfg: config,
              accountId: account.accountId,
              replyToMessageGuid: replyToMessageGuid || undefined,
            });
            maybeEnqueueOutboundMessageId(result.messageId, chunk);
            sentMessage = true;
            statusSink?.({ lastOutboundAt: Date.now() });
            if (info.kind === "block") {
              restartTypingSoon();
            }
          }
        },
        onReplyStart: async () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
          streamingActive = true;
          clearTypingRestartTimer();
          try {
            await sendBlueBubblesTyping(chatGuidForActions, true, {
              cfg: config,
              accountId: account.accountId,
            });
          } catch (err) {
            runtime.error?.(`[bluebubbles] typing start failed: ${String(err)}`);
          }
        },
        onIdle: async () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
          // Intentionally no-op for block streaming. We stop typing in finally
          // after the run completes to avoid flicker between paragraph blocks.
        },
        onError: (err, info) => {
          runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyOptions: {
        onModelSelected,
        disableBlockStreaming:
          typeof account.config.blockStreaming === "boolean"
            ? !account.config.blockStreaming
            : undefined,
      },
    });
  } finally {
    const shouldStopTyping =
      Boolean(chatGuidForActions && baseUrl && password) && (streamingActive || !sentMessage);
    streamingActive = false;
    clearTypingRestartTimer();
    if (sentMessage && chatGuidForActions && ackMessageId) {
      core.channel.reactions.removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionValue ?? null,
        remove: () =>
          sendBlueBubblesReaction({
            chatGuid: chatGuidForActions,
            messageGuid: ackMessageId,
            emoji: ackReactionValue ?? "",
            remove: true,
            opts: { cfg: config, accountId: account.accountId },
          }),
        onError: (err) => {
          logAckFailure({
            log: (msg) => logVerbose(core, runtime, msg),
            channel: "bluebubbles",
            target: `${chatGuidForActions}/${ackMessageId}`,
            error: err,
          });
        },
      });
    }
    if (shouldStopTyping && chatGuidForActions) {
      // Stop typing after streaming completes to avoid a stuck indicator.
      sendBlueBubblesTyping(chatGuidForActions, false, {
        cfg: config,
        accountId: account.accountId,
      }).catch((err) => {
        logTypingFailure({
          log: (msg) => logVerbose(core, runtime, msg),
          channel: "bluebubbles",
          action: "stop",
          target: chatGuidForActions,
          error: err,
        });
      });
    }
  }
}

export async function processReaction(
  reaction: NormalizedWebhookReaction,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core } = target;
  if (reaction.fromMe) {
    return;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore("bluebubbles")
    .catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const effectiveGroupAllowFrom = [
    ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
    ...storeAllowFrom,
  ]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  if (reaction.isGroup) {
    if (groupPolicy === "disabled") {
      return;
    }
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        return;
      }
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveGroupAllowFrom,
        sender: reaction.senderId,
        chatId: reaction.chatId ?? undefined,
        chatGuid: reaction.chatGuid ?? undefined,
        chatIdentifier: reaction.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      return;
    }
    if (dmPolicy !== "open") {
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveAllowFrom,
        sender: reaction.senderId,
        chatId: reaction.chatId ?? undefined,
        chatGuid: reaction.chatGuid ?? undefined,
        chatIdentifier: reaction.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        return;
      }
    }
  }

  const chatId = reaction.chatId ?? undefined;
  const chatGuid = reaction.chatGuid ?? undefined;
  const chatIdentifier = reaction.chatIdentifier ?? undefined;
  const peerId = reaction.isGroup
    ? (chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group"))
    : reaction.senderId;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: reaction.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const senderLabel = reaction.senderName || reaction.senderId;
  const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
  // Use short ID for token savings
  const messageDisplayId = getShortIdForUuid(reaction.messageId) || reaction.messageId;
  // Format: "Tyler reacted with ❤️ [[reply_to:5]]" or "Tyler removed ❤️ reaction [[reply_to:5]]"
  const text =
    reaction.action === "removed"
      ? `${senderLabel} removed ${reaction.emoji} reaction [[reply_to:${messageDisplayId}]]${chatLabel}`
      : `${senderLabel} reacted with ${reaction.emoji} [[reply_to:${messageDisplayId}]]${chatLabel}`;
  core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`,
  });
  logVerbose(core, runtime, `reaction event enqueued: ${text}`);
}
