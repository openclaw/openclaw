import { resolveHumanDelayConfig } from "../../../../src/agents/identity.js";
import { hasControlCommand } from "../../../../src/auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../../../../src/auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions
} from "../../../../src/auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled
} from "../../../../src/auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns
} from "../../../../src/auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../../../src/auto-reply/reply/reply-dispatcher.js";
import { resolveControlCommandGate } from "../../../../src/channels/command-gating.js";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound
} from "../../../../src/channels/inbound-debounce-policy.js";
import { logInboundDrop, logTypingFailure } from "../../../../src/channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../../../src/channels/mention-gating.js";
import { normalizeSignalMessagingTarget } from "../../../../src/channels/plugins/normalize/signal.js";
import { createReplyPrefixOptions } from "../../../../src/channels/reply-prefix.js";
import { recordInboundSession } from "../../../../src/channels/session.js";
import { createTypingCallbacks } from "../../../../src/channels/typing.js";
import { resolveChannelGroupRequireMention } from "../../../../src/config/group-policy.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../../../src/config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../../src/globals.js";
import { enqueueSystemEvent } from "../../../../src/infra/system-events.js";
import { kindFromMime } from "../../../../src/media/mime.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import {
  DM_GROUP_ACCESS_REASON,
  resolvePinnedMainDmOwnerFromAllowlist
} from "../../../../src/security/dm-policy-shared.js";
import { normalizeE164 } from "../../../../src/utils.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender
} from "../identity.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import { renderSignalMentions } from "./mentions.js";
function formatAttachmentKindCount(kind, count) {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}
function formatAttachmentSummaryPlaceholder(contentTypes) {
  const kindCounts = /* @__PURE__ */ new Map();
  for (const contentType of contentTypes) {
    const kind = kindFromMime(contentType) ?? "attachment";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(
    ([kind, count]) => formatAttachmentKindCount(kind, count)
  );
  return `[${parts.join(" + ")} attached]`;
}
function resolveSignalInboundRoute(params) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? params.groupId ?? "unknown" : params.senderPeerId
    }
  });
}
function createSignalEventHandler(deps) {
  async function handleSignalInboundMessage(entry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? void 0,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay
    });
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup: entry.isGroup,
      groupId: entry.groupId,
      senderPeerId: entry.senderPeerId
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey
    });
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? void 0,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : void 0;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) => formatInboundEnvelope({
          channel: "Signal",
          from: fromLabel,
          timestamp: historyEntry.timestamp,
          body: `${historyEntry.body}${historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""}`,
          chatType: "group",
          senderLabel: historyEntry.sender,
          envelope: envelopeOptions
        })
      });
    }
    const signalToRaw = entry.isGroup ? `group:${entry.groupId}` : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory = entry.isGroup && historyKey && deps.historyLimit > 0 ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
      sender: historyEntry.sender,
      body: historyEntry.body,
      timestamp: historyEntry.timestamp
    })) : void 0;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: entry.bodyText,
      InboundHistory: inboundHistory,
      RawBody: entry.bodyText,
      CommandBody: entry.commandBody,
      BodyForCommands: entry.commandBody,
      From: entry.isGroup ? `group:${entry.groupId ?? "unknown"}` : `signal:${entry.senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? entry.groupName ?? void 0 : void 0,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: "signal",
      Surface: "signal",
      MessageSid: entry.messageId,
      Timestamp: entry.timestamp ?? void 0,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaUrls: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : void 0,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "signal",
      OriginatingTo: signalTo
    });
    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup ? {
        sessionKey: route.mainSessionKey,
        channel: "signal",
        to: entry.senderRecipient,
        accountId: route.accountId,
        mainDmOwnerPin: (() => {
          const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
            dmScope: deps.cfg.session?.dmScope,
            allowFrom: deps.allowFrom,
            normalizeEntry: normalizeSignalAllowRecipient
          });
          if (!pinnedOwner) {
            return void 0;
          }
          return {
            ownerRecipient: pinnedOwner,
            senderRecipient: entry.senderRecipient,
            onSkip: ({ ownerRecipient, senderRecipient }) => {
              logVerbose(
                `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`
              );
            }
          };
        })()
      } : void 0,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      }
    });
    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: "signal",
      accountId: route.accountId
    });
    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        if (!ctxPayload.To) {
          return;
        }
        await sendTypingSignal(ctxPayload.To, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId
        });
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "signal",
          target: ctxPayload.To ?? void 0,
          error: err
        });
      }
    });
    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload) => {
        await deps.deliverReplies({
          replies: [payload],
          target: ctxPayload.To,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
          runtime: deps.runtime,
          maxBytes: deps.mediaMaxBytes,
          textLimit: deps.textLimit
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      }
    });
    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming: typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : void 0,
        onModelSelected
      }
    });
    markDispatchIdle();
    if (!queuedFinal) {
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: deps.groupHistories,
          historyKey,
          limit: deps.historyLimit
        });
      }
      return;
    }
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit
      });
    }
  }
  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer({
    cfg: deps.cfg,
    channel: "signal",
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? entry.groupId ?? "unknown" : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      return shouldDebounceTextInbound({
        text: entry.bodyText,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType || entry.mediaPaths?.length)
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries.map((entry) => entry.bodyText).filter(Boolean).join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: void 0,
        mediaType: void 0,
        mediaPaths: void 0,
        mediaTypes: void 0
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    }
  });
  function handleReactionOnlyInbound(params) {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove) {
      return true;
    }
    const emojiLabel = params.reaction.emoji?.trim() || "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? void 0;
    const groupName = params.reaction.groupInfo?.groupName ?? void 0;
    const isGroup = Boolean(groupId);
    const reactionAccess = params.resolveAccessDecision(isGroup);
    if (reactionAccess.decision !== "allow") {
      logVerbose(
        `Blocked signal reaction sender ${params.senderDisplay} (${reactionAccess.reason})`
      );
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist
    });
    if (!shouldNotify) {
      return true;
    }
    const senderPeerId = resolveSignalPeerId(params.sender);
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : void 0;
    const messageId = params.reaction.targetSentTimestamp ? String(params.reaction.targetSentTimestamp) : "unknown";
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      messageId,
      targetLabel: targets[0]?.display,
      groupLabel
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      "signal",
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? ""
    ].filter(Boolean).join(":");
    enqueueSystemEvent(text, { sessionKey: route.sessionKey, contextKey });
    return true;
  }
  return async (event) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }
    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }
    const normalizedAccount = deps.account ? normalizeE164(deps.account) : void 0;
    const isOwnMessage = sender.kind === "phone" && normalizedAccount != null && sender.e164 === normalizedAccount || sender.kind === "uuid" && deps.accountUuid != null && sender.raw === deps.accountUuid;
    if (isOwnMessage) {
      return;
    }
    if ("syncMessage" in envelope) {
      return;
    }
    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage) ? envelope.reactionMessage : deps.isSignalReactionMessage(dataMessage?.reaction) ? dataMessage?.reaction : null;
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();
    const quoteText = dataMessage?.quote?.text?.trim() ?? "";
    const hasBodyContent = Boolean(messageText || quoteText) || Boolean(!reaction && dataMessage?.attachments?.length);
    const senderDisplay = formatSignalSenderDisplay(sender);
    const { resolveAccessDecision, dmAccess, effectiveDmAllow, effectiveGroupAllow } = await resolveSignalAccessState({
      accountId: deps.accountId,
      dmPolicy: deps.dmPolicy,
      groupPolicy: deps.groupPolicy,
      allowFrom: deps.allowFrom,
      groupAllowFrom: deps.groupAllowFrom,
      sender
    });
    if (reaction && handleReactionOnlyInbound({
      envelope,
      sender,
      senderDisplay,
      reaction,
      hasBodyContent,
      resolveAccessDecision
    })) {
      return;
    }
    if (!dataMessage) {
      return;
    }
    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupId = dataMessage.groupInfo?.groupId ?? void 0;
    const groupName = dataMessage.groupInfo?.groupName ?? void 0;
    const isGroup = Boolean(groupId);
    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        dmPolicy: deps.dmPolicy,
        dmAccessDecision: dmAccess.decision,
        senderId: senderAllowId,
        senderIdLine,
        senderDisplay,
        senderName: envelope.sourceName ?? void 0,
        accountId: deps.accountId,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`signal:${senderRecipient}`, text, {
            baseUrl: deps.baseUrl,
            account: deps.account,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId
          });
        },
        log: logVerbose
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      const groupAccess = resolveAccessDecision(true);
      if (groupAccess.decision !== "allow") {
        if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }
    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const commandDmAllow = isGroup ? deps.allowFrom : effectiveDmAllow;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, commandDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands }
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage
    });
    const commandAuthorized = commandGate.commandAuthorized;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay
      });
      return;
    }
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention = isGroup && resolveChannelGroupRequireMention({
      cfg: deps.cfg,
      channel: "signal",
      groupId,
      accountId: deps.accountId
    });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      wasMentioned,
      implicitMention: false,
      hasAnyMention: false,
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized
    });
    const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay
      });
      const quoteText2 = dataMessage.quote?.text?.trim() || "";
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const attachmentTypes = (dataMessage.attachments ?? []).map(
          (attachment) => typeof attachment?.contentType === "string" ? attachment.contentType : void 0
        );
        if (attachmentTypes.length > 1) {
          return formatAttachmentSummaryPlaceholder(attachmentTypes);
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = kindFromMime(firstContentType ?? void 0);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || quoteText2;
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: pendingBodyText,
          timestamp: envelope.timestamp ?? void 0,
          messageId: typeof envelope.timestamp === "number" ? String(envelope.timestamp) : void 0
        }
      });
      return;
    }
    let mediaPath;
    let mediaType;
    const mediaPaths = [];
    const mediaTypes = [];
    let placeholder = "";
    const attachments = dataMessage.attachments ?? [];
    if (!deps.ignoreAttachments) {
      for (const attachment of attachments) {
        if (!attachment?.id) {
          continue;
        }
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            mediaTypes.push(
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream"
            );
            if (!mediaPath) {
              mediaPath = fetched.path;
              mediaType = fetched.contentType ?? attachment.contentType ?? void 0;
            }
          }
        } catch (err) {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
    }
    if (mediaPaths.length > 1) {
      placeholder = formatAttachmentSummaryPlaceholder(mediaTypes);
    } else {
      const kind = kindFromMime(mediaType ?? void 0);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (attachments.length) {
        placeholder = "<media:attachment>";
      }
    }
    const bodyText = messageText || placeholder || dataMessage.quote?.text?.trim() || "";
    if (!bodyText) {
      return;
    }
    const receiptTimestamp = typeof envelope.timestamp === "number" ? envelope.timestamp : typeof dataMessage.timestamp === "number" ? dataMessage.timestamp : void 0;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && !receiptTimestamp) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }
    const senderName = envelope.sourceName ?? senderDisplay;
    const messageId = typeof envelope.timestamp === "number" ? String(envelope.timestamp) : void 0;
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText,
      timestamp: envelope.timestamp ?? void 0,
      messageId,
      mediaPath,
      mediaType,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned
    });
  };
}
export {
  createSignalEventHandler
};
